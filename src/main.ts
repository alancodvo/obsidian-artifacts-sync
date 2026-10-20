import { FileSystemAdapter, Notice, Platform, Plugin, TAbstractFile, normalizePath, requestUrl } from "obsidian";
// The npm polyfill (not Node's built-in; the trailing slash makes that explicit for bundler and reviewer).
import { Buffer as BufferPolyfill } from "buffer/";
import { DEFAULT_IGNORE, parseArtifactsRemote, tokenStatus, validateSettings } from "./core";

// Phones have no global Buffer. The esbuild inject (src/shims/buffer-global.js) rewrites every bare
// `Buffer` inside this bundle, but code outside it (Obsidian's own requestUrl, anything reached
// through the window) still looks the global up at run time. Provide it once, before any sync runs.
const win = window as Window & { Buffer?: unknown };
if (typeof win.Buffer === "undefined") win.Buffer = BufferPolyfill;
import { ArtifactsApi, type RepoInfo, repoNameFromVault } from "./api";
import { ArtifactsGit, GitConflictError, errorMessages, type GitFs, type GitHttp } from "./git";
import { createRequestUrlFetch, createRequestUrlHttp } from "./obsidian-http";
import { createVaultFs } from "./vault-fs";

/** Renew automatically when less than this much lifetime is left. */
const RENEW_BEFORE_MS = 2 * 24 * 3_600_000;
import { ArtifactsSyncSettingTab, DEFAULT_SETTINGS, type ArtifactsSyncSettings } from "./settings";

const CHANGE_DEBOUNCE_MS = 30_000;

export default class ArtifactsSyncPlugin extends Plugin {
  settings: ArtifactsSyncSettings = { ...DEFAULT_SETTINGS };
  private statusBar: HTMLElement | null = null;
  private autoSyncTimer: number | null = null;
  private changeTimer: number | null = null;
  private running = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ArtifactsSyncSettingTab(this.app, this));
    this.statusBar = this.addStatusBarItem();
    this.setStatus("Artifacts: idle");
    // Three ways to sync without the command palette: the ribbon icon, the status bar item, and a
    // button at the top of the settings page.
    this.addRibbonIcon("refresh-cw", "Sync with Cloudflare Artifacts", () => void this.runSync("manual"));
    this.statusBar.addClass("mod-clickable");
    this.statusBar.setAttr("aria-label", "Sync with Cloudflare Artifacts");
    this.statusBar.addEventListener("click", () => void this.runSync("manual"));

    this.addCommand({ id: "sync-now", name: "Sync now (commit, pull, push)", callback: () => void this.runSync("manual") });
    this.addCommand({ id: "pull", name: "Pull from Artifacts", callback: () => void this.runPull() });
    this.addCommand({ id: "push", name: "Push to Artifacts", callback: () => void this.runPush() });

    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("rename", (file) => this.onVaultChange(file)));
    this.scheduleAutoSync();
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ArtifactsSyncSettings> | null) };
    // The config folder is `.obsidian` by default but the user can rename it; ignore the real one.
    const configDir = `${this.app.vault.configDir}/`;
    const stock = DEFAULT_IGNORE[0]; // the usual config folder, as shipped in the defaults
    if (configDir !== stock && !this.settings.ignore.includes(configDir)) {
      this.settings.ignore = this.settings.ignore.map((p) => (p === stock ? configDir : p));
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  scheduleAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.autoSyncTimer = window.setInterval(() => void this.runSync("timer"), minutes * 60_000);
      this.registerInterval(this.autoSyncTimer);
    }
  }

  private onVaultChange(file: TAbstractFile): void {
    if (!this.settings.syncOnChange) return;
    const folder = this.settings.syncFolder;
    if (folder && !file.path.startsWith(`${folder}/`) && file.path !== folder) return;
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => void this.runSync("change"), CHANGE_DEBOUNCE_MS);
  }

  suggestedRepoName(): string {
    return repoNameFromVault(this.app.vault.getName());
  }

  private api(): ArtifactsApi | null {
    const { accountId, apiToken } = this.settings;
    if (!/^[0-9a-f]{32}$/.test(accountId)) {
      new Notice("Cloudflare Artifacts Sync: enter your 32-character account ID.");
      return null;
    }
    if (!apiToken) {
      new Notice("Cloudflare Artifacts Sync: enter a Cloudflare API token with the Artifacts permission.");
      return null;
    }
    // requestUrl: works on mobile and is not the window-bound global fetch (0.3.0 failed with "Illegal invocation")
    return new ArtifactsApi({ accountId, apiToken, fetchImpl: createRequestUrlFetch(requestUrl) });
  }

  /** Create namespace and repository as needed, issue a write token, and store remote and token. */
  async setupRepository(): Promise<void> {
    const api = this.api();
    if (!api) return;
    const namespace = this.settings.namespace || "default";
    const repoName = this.settings.repoName || this.suggestedRepoName();
    try {
      await api.ensureNamespace(namespace);
      const repo = await api.ensureRepo(namespace, repoName, this.settings.branch || "main");
      const issued = await api.issueToken(namespace, repoName, "write");
      this.settings.namespace = namespace;
      this.settings.repoName = repoName;
      this.settings.remoteUrl = repo.remote;
      this.settings.token = issued.token;
      await this.saveSettings();
      new Notice(`Cloudflare Artifacts Sync: repository ${namespace}/${repoName} is ready. Run Sync now when you like.`);
    } catch (err) {
      new Notice(`Cloudflare Artifacts Sync: setup failed: ${err instanceof Error ? err.message : String(err)}`, 10_000);
      console.error("[cloudflare-artifacts-sync] setup", err);
    }
  }

  /** Repositories in the configured namespace, for the "connect to an existing repository" picker. */
  async listRepositories(): Promise<RepoInfo[] | null> {
    const api = this.api();
    if (!api) return null;
    try {
      return await api.listRepos(this.settings.namespace || "default");
    } catch (err) {
      new Notice(`Cloudflare Artifacts Sync: could not list repositories: ${err instanceof Error ? err.message : String(err)}`, 10_000);
      return null;
    }
  }

  /** Point this vault at a repository another device created: store its remote and issue a token. */
  async connectToRepository(repo: RepoInfo): Promise<void> {
    const api = this.api();
    if (!api) return;
    const namespace = this.settings.namespace || "default";
    try {
      const issued = await api.issueToken(namespace, repo.name, "write");
      this.settings.repoName = repo.name;
      this.settings.remoteUrl = repo.remote;
      this.settings.token = issued.token;
      await this.saveSettings();
      new Notice(`Cloudflare Artifacts Sync: connected to ${namespace}/${repo.name}. Run Sync now to bring the notes in.`);
    } catch (err) {
      new Notice(`Cloudflare Artifacts Sync: connecting failed: ${err instanceof Error ? err.message : String(err)}`, 10_000);
    }
  }

  /**
   * Delete the local Git history (the hidden .git folder) and keep the notes. The next sync starts
   * from the remote branch, so this is the way out after syncing to the wrong repository.
   */
  async resetLocalHistory(): Promise<void> {
    if (this.running) {
      new Notice("Cloudflare Artifacts Sync: a sync is already running.");
      return;
    }
    const folder = this.settings.syncFolder ? normalizePath(this.settings.syncFolder) : "";
    const gitDir = normalizePath(folder ? `${folder}/.git` : ".git");
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(gitDir)) await adapter.rmdir(gitDir, true);
      new Notice("Cloudflare Artifacts Sync: local history removed. Notes are untouched. Run Sync now to start from the repository.");
    } catch (err) {
      new Notice(`Cloudflare Artifacts Sync: could not remove ${gitDir}: ${err instanceof Error ? err.message : String(err)}`, 10_000);
    }
  }

  /**
   * Issue a new repository token when the current one is close to expiry (or always, when forced).
   * Silent when the API token is not configured.
   */
  async renewToken(force = false): Promise<boolean> {
    if (!this.settings.apiToken || !this.settings.repoName) {
      if (force) new Notice("Cloudflare Artifacts Sync: set the API token and repository name first, or run Set up.");
      return false;
    }
    if (!force) {
      const status = tokenStatus(this.settings.token, Date.now());
      const soon = status.expired || (status.remainingMs !== null && status.remainingMs < RENEW_BEFORE_MS);
      if (!soon || !this.settings.autoRenewToken) return false;
    }
    const api = this.api();
    if (!api) return false;
    try {
      const issued = await api.issueToken(this.settings.namespace || "default", this.settings.repoName, "write");
      this.settings.token = issued.token;
      await this.saveSettings();
      if (force) new Notice("Cloudflare Artifacts Sync: issued a new repository token.");
      return true;
    } catch (err) {
      new Notice(`Cloudflare Artifacts Sync: could not renew the token: ${err instanceof Error ? err.message : String(err)}`, 10_000);
      return false;
    }
  }

  /**
   * Where and how to run git. Desktop: Node's fs and HTTP on the vault's real path (fast). Mobile:
   * Obsidian's adapter and `requestUrl`, with a vault-relative path. The desktop module is loaded
   * lazily so the mobile build never touches Node modules.
   */
  private async environment(): Promise<{ dir: string; fs: GitFs; http: GitHttp } | null> {
    const folder = this.settings.syncFolder ? normalizePath(this.settings.syncFolder) : "";
    const adapter = this.app.vault.adapter;
    if (Platform.isDesktop && adapter instanceof FileSystemAdapter) {
      const nodeEnv = await import("./node-env");
      const base = adapter.getBasePath();
      return { dir: folder ? nodeEnv.joinPath(base, folder) : base, fs: nodeEnv.nodeFs(), http: nodeEnv.nodeHttp() };
    }
    return { dir: folder, fs: createVaultFs(adapter), http: createRequestUrlHttp(requestUrl) };
  }

  private async client(): Promise<ArtifactsGit | null> {
    const problems = validateSettings(this.settings);
    if (problems.length) {
      new Notice(`Cloudflare Artifacts Sync: ${problems.join(" ")}`);
      return null;
    }
    const expiry = tokenStatus(this.settings.token, Date.now());
    if (expiry.expired) {
      new Notice("Cloudflare Artifacts Sync: the repository token has expired. Issue a new one in the Cloudflare dashboard.");
      return null;
    }
    const env = await this.environment();
    if (!env) return null;
    const remote = parseArtifactsRemote(this.settings.remoteUrl);
    if (!remote) return null;
    return new ArtifactsGit({
      ...env,
      remoteUrl: remote.url,
      token: this.settings.token,
      branch: this.settings.branch,
      ignore: this.settings.ignore,
      author: { name: this.settings.authorName, email: this.settings.authorEmail },
    });
  }

  private setStatus(text: string): void {
    this.statusBar?.setText(text);
  }

  /**
   * Write everything known about a failure to the plugin's folder in the vault, so a report from a
   * phone can be sent as one file. Returns the vault path, or null when even that failed.
   */
  private async writeErrorReport(label: string, err: unknown): Promise<string | null> {
    const dir = this.manifest.dir;
    if (!dir) return null;
    const path = normalizePath(`${dir}/last-error.txt`);
    const lines: string[] = [
      `Cloudflare Artifacts Sync ${this.manifest.version}`,
      `when: ${new Date().toISOString()}`,
      `platform: ${Platform.isMobile ? "mobile" : "desktop"}${Platform.isIosApp ? " ios" : ""}${Platform.isAndroidApp ? " android" : ""}`,
      `step: ${label}`,
      `folder: ${this.settings.syncFolder || "(vault root)"}  branch: ${this.settings.branch}`,
      "",
      `messages: ${errorMessages(err, 10).join(" | ")}`,
      "",
    ];
    const dump = (e: unknown, indent: string) => {
      if (e === null || e === undefined) {
        lines.push(`${indent}(rejected with ${String(e)})`);
        return;
      }
      if (e instanceof Error) {
        lines.push(`${indent}${e.name}: ${e.message}`);
        const code = (e as { code?: unknown }).code;
        if (typeof code === "string" || typeof code === "number") lines.push(`${indent}code: ${code}`);
        if (e.stack) lines.push(...e.stack.split("\n").slice(0, 12).map((l) => `${indent}  ${l.trim()}`));
      } else {
        lines.push(`${indent}${errorMessages(e, 1)[0] ?? typeof e}`);
      }
      const inner = (e as { errors?: unknown }).errors;
      if (Array.isArray(inner)) {
        lines.push(`${indent}errors (${inner.length}):`);
        inner.slice(0, 20).forEach((x, i) => {
          lines.push(`${indent}  [${i}]`);
          dump(x, `${indent}    `);
        });
      }
      const cause = (e as { cause?: unknown }).cause;
      if (cause && cause !== e) {
        lines.push(`${indent}cause:`);
        dump(cause, `${indent}  `);
      }
    };
    try {
      dump(err, "");
      await this.app.vault.adapter.write(path, lines.join("\n") + "\n");
      return path;
    } catch {
      return null;
    }
  }

  private notice(text: string): void {
    if (this.settings.showNotices) new Notice(text);
  }

  private async guarded(label: string, work: (client: ArtifactsGit) => Promise<string>): Promise<void> {
    if (this.running) {
      new Notice("Cloudflare Artifacts Sync: a sync is already running.");
      return;
    }
    await this.renewToken();
    const client = await this.client();
    if (!client) return;
    this.running = true;
    this.setStatus(`Artifacts: ${label}…`);
    try {
      const summary = await work(client);
      this.setStatus(`Artifacts: ${summary}`);
      this.notice(`Cloudflare Artifacts Sync: ${summary}`);
    } catch (err) {
      let message: string;
      if (err instanceof GitConflictError) {
        message = err.message;
      } else {
        // Name the underlying failures, not the wrapper: isomorphic-git's "multiple errors" text
        // says nothing, and a phone has no console to look the rest up in.
        message = `${label} failed: ${errorMessages(err, 3).join(" | ") || String(err)}`;
        // A ReferenceError means a missing global (phones have fewer than desktops): say which
        // module asked for it.
        if (err instanceof ReferenceError && err.stack) {
          const frame = err.stack.split("\n").map((l) => l.trim()).find((l) => l.startsWith("at ") || l.includes("@"));
          if (frame) message += ` (${frame.slice(0, 120)})`;
        }
      }
      this.setStatus("Artifacts: error");
      const report = await this.writeErrorReport(label, err);
      new Notice(`Cloudflare Artifacts Sync ${this.manifest.version}: ${message}${report ? `\nFull details: ${report}` : ""}`, 15_000);
      console.error("[cloudflare-artifacts-sync]", err);
    } finally {
      this.running = false;
    }
  }

  async runSync(trigger: "manual" | "timer" | "change"): Promise<void> {
    await this.guarded("syncing", async (client) => {
      const r = await client.sync();
      const when = new Date().toLocaleTimeString();
      const changes = r.committed ? `${r.added} changed, ${r.removed} removed` : "no local changes";
      const kept = r.setAside.length ? `; ${r.setAside.length} local cop${r.setAside.length === 1 ? "y" : "ies"} kept as .local-… files` : "";
      return `synced at ${when} (${changes}${r.pulled ? ", pulled updates" : ""}${kept})${trigger === "manual" ? "" : ""}`;
    });
  }

  async runPull(): Promise<void> {
    await this.guarded("pulling", async (client) => {
      await client.ensureRepo();
      const pulled = await client.pull();
      return pulled ? "pulled updates from Artifacts" : "already up to date";
    });
  }

  async runPush(): Promise<void> {
    await this.guarded("pushing", async (client) => {
      await client.ensureRepo();
      const commit = await client.commitAll();
      await client.push();
      return commit.committed ? `pushed ${commit.added} changed, ${commit.removed} removed` : "pushed (nothing new to commit)";
    });
  }
}
