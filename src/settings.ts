import { App, FuzzySuggestModal, Notice, PluginSettingTab, type Setting, type SettingDefinitionItem } from "obsidian";
import type { RepoInfo } from "./api";
import type ArtifactsSyncPlugin from "./main";
import { DEFAULT_IGNORE, tokenStatus, validateSettings } from "./core";

/** Pick one of the repositories in the namespace (second device, or after a mistaken Set up). */
class RepoPickerModal extends FuzzySuggestModal<RepoInfo> {
  constructor(app: App, private readonly repos: RepoInfo[], private readonly onPick: (repo: RepoInfo) => void) {
    super(app);
    this.setPlaceholder("Choose the repository this vault should sync with");
  }
  getItems(): RepoInfo[] {
    return this.repos;
  }
  getItemText(repo: RepoInfo): string {
    return repo.name;
  }
  onChooseItem(repo: RepoInfo): void {
    this.onPick(repo);
  }
}

export interface ArtifactsSyncSettings {
  /** Cloudflare account ID (32 hex characters). Used with the API token to set things up. */
  accountId: string;
  /** Cloudflare API token with the Artifacts permission. Only sent to api.cloudflare.com. Optional. */
  apiToken: string;
  /** Artifacts namespace the repository lives in. */
  namespace: string;
  /** Repository name inside the namespace. */
  repoName: string;
  /** Issue a fresh repository token automatically before it expires (needs the API token). */
  autoRenewToken: boolean;
  /** https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git */
  remoteUrl: string;
  /** Repository write token from the Cloudflare dashboard (art_…). Stored in this vault's plugin data. */
  token: string;
  branch: string;
  /** Vault-relative folder to sync. Empty = the whole vault. */
  syncFolder: string;
  /** Minutes between automatic syncs. 0 = manual only. */
  autoSyncMinutes: number;
  /** Also sync when a note changes (debounced). */
  syncOnChange: boolean;
  ignore: string[];
  authorName: string;
  authorEmail: string;
  showNotices: boolean;
}

export const DEFAULT_SETTINGS: ArtifactsSyncSettings = {
  accountId: "",
  apiToken: "",
  namespace: "default",
  repoName: "",
  autoRenewToken: true,
  remoteUrl: "",
  token: "",
  branch: "main",
  syncFolder: "",
  autoSyncMinutes: 0,
  syncOnChange: false,
  ignore: [...DEFAULT_IGNORE],
  authorName: "Obsidian",
  authorEmail: "obsidian@localhost",
  showNotices: true,
};

type Key = keyof ArtifactsSyncSettings;

/**
 * Declarative settings (Obsidian 1.13+): the controls are described as data, so they also show up
 * in the settings search. Buttons and the token status are rendered imperatively through `render`.
 */
export class ArtifactsSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ArtifactsSyncPlugin) {
    super(app, plugin);
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    if (key === "ignore") return s.ignore.join("\n");
    return s[key as Key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    switch (key as Key) {
      case "accountId":
        s.accountId = text.trim().toLowerCase();
        break;
      case "apiToken":
        s.apiToken = text.trim();
        break;
      case "namespace":
        s.namespace = text.trim() || "default";
        break;
      case "repoName":
        s.repoName = text.trim();
        break;
      case "remoteUrl":
        s.remoteUrl = text.trim();
        break;
      case "token":
        s.token = text.trim();
        break;
      case "branch":
        s.branch = text.trim() || "main";
        break;
      case "syncFolder":
        s.syncFolder = text.trim().replace(/^\/+|\/+$/g, "");
        break;
      case "autoSyncMinutes": {
        const n = Number(value);
        s.autoSyncMinutes = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
        break;
      }
      case "ignore":
        s.ignore = text.split("\n").map((l) => l.trim()).filter(Boolean);
        break;
      case "authorName":
        s.authorName = text.trim() || DEFAULT_SETTINGS.authorName;
        break;
      case "authorEmail":
        s.authorEmail = text.trim() || DEFAULT_SETTINGS.authorEmail;
        break;
      case "autoRenewToken":
      case "syncOnChange":
      case "showNotices":
        s[key as "autoRenewToken" | "syncOnChange" | "showNotices"] = Boolean(value);
        break;
    }
    await this.plugin.saveSettings();
    if (key === "autoSyncMinutes") this.plugin.scheduleAutoSync();
    if (key === "token") this.update();
  }

  /** A row with one button; disabled while its work runs, and the tab re-rendered after it when asked. */
  private button(name: string, desc: string, label: string, work: () => Promise<void>, opts: { cta?: boolean; refresh?: boolean } = {}) {
    return {
      name,
      desc,
      render: (setting: Setting) => {
        setting.addButton((button) => {
          if (opts.cta) button.setCta();
          button.setButtonText(label).onClick(async () => {
            button.setDisabled(true);
            try {
              await work();
            } finally {
              button.setDisabled(false);
              if (opts.refresh) this.update();
            }
          });
        });
      },
    };
  }

  /** A password-type text input bound to one settings key (value stays in this vault's plugin data). */
  private passwordField(setting: Setting, key: "apiToken" | "token", placeholder = ""): void {
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      text
        .setPlaceholder(placeholder)
        .setValue(this.plugin.settings[key])
        .onChange((value) => void this.setControlValue(key, value));
    });
  }

  private tokenDescription(): string {
    const token = this.plugin.settings.token;
    if (!token) return "A write token for this repository. Tokens expire; issue a new one in the dashboard when this one does.";
    const status = tokenStatus(token, Date.now());
    if (status.expired) return "This token has expired. Issue a new write token in the Cloudflare dashboard.";
    if (status.remainingMs === null) return "Token set (no expiry found in it).";
    return `Token set. Expires in about ${Math.max(1, Math.round(status.remainingMs / 3_600_000))} hours.`;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const plugin = this.plugin;
    return [
      this.button(
        "Sync now",
        "Commit, pull and push. The same as the refresh icon in the left ribbon and the Artifacts item in the status bar.",
        "Sync now",
        () => plugin.runSync("manual"),
        { cta: true },
      ),
      {
        type: "group",
        heading: "Connect with a Cloudflare API token",
        items: [
          {
            name: "Before you start",
            desc:
              "Create an API token once (Cloudflare dashboard → My profile → API tokens → Create token → Custom token, " +
              "permission Account / Artifacts / Edit). The plugin then creates the repository and issues its own repository tokens.",
            searchable: false,
          },
          {
            name: "Account ID",
            desc: "32 characters, shown on the right of the Workers & Pages overview in the dashboard.",
            control: {
              type: "text",
              key: "accountId",
              placeholder: "0123456789abcdef0123456789abcdef",
              validate: (v: string) => (v.trim() === "" || /^[0-9a-f]{32}$/i.test(v.trim()) ? undefined : "The account ID is 32 hexadecimal characters."),
            },
          },
          {
            name: "API token",
            desc: "Stored in this vault's plugin data. Sent only to api.cloudflare.com when setting up or renewing tokens.",
            // A password field rendered by hand: the declarative `secret` control stores a reference into
            // Obsidian's secret storage rather than the value, and this plugin keeps tokens in data.json.
            render: (setting: Setting) => this.passwordField(setting, "apiToken"),
          },
          {
            name: "Namespace",
            desc: "Created if it does not exist. default is fine.",
            control: { type: "text", key: "namespace", placeholder: "default" },
          },
          {
            name: "Repository name",
            desc: "Created if it does not exist. Leave empty to use a name made from the vault name.",
            control: { type: "text", key: "repoName", placeholder: plugin.suggestedRepoName() },
          },
          this.button(
            "Set up a new repository (first device)",
            "Creates the namespace and repository if needed, issues a 30-day write token, and fills in the fields below. " +
              'Do this on one device only. On every other device use "Connect to an existing repository".',
            "Set up",
            () => plugin.setupRepository(),
            { cta: true, refresh: true },
          ),
          this.button(
            "Connect to an existing repository (other devices)",
            "Lists the repositories in the namespace so you can pick the one your first device created. Issues a token for it and fills in the fields below.",
            "Choose repository",
            async () => {
              const repos = await plugin.listRepositories();
              if (!repos) return;
              if (repos.length === 0) {
                new Notice("Cloudflare Artifacts Sync: no repositories in this namespace yet. Press Set up on your first device.");
                return;
              }
              new RepoPickerModal(this.app, repos, (repo) => {
                void plugin.connectToRepository(repo).then(() => this.update());
              }).open();
            },
          ),
          {
            name: "Renew the repository token automatically",
            desc: "Issues a new token shortly before the current one expires. Needs the API token above.",
            control: { type: "toggle", key: "autoRenewToken" },
          },
          this.button("Renew token now", "", "Renew", () => plugin.renewToken(true).then(() => undefined), { refresh: true }),
        ],
      },
      {
        type: "group",
        heading: "Repository (filled by Set up, or by hand)",
        items: [
          {
            name: "Remote URL",
            desc: "Copy it from the Cloudflare dashboard: Storage & databases → Artifacts → your repository.",
            control: { type: "text", key: "remoteUrl", placeholder: "https://<account>.artifacts.cloudflare.net/git/default/my-vault.git" },
          },
          {
            name: "Repository token",
            desc: this.tokenDescription(),
            render: (setting: Setting) => this.passwordField(setting, "token", "art_…"),
          },
          {
            name: "Branch",
            desc: "Leave it as main unless you created the repository with another default branch. It is shown on the repository page in the dashboard. Use the same value on every device.",
            control: { type: "text", key: "branch", placeholder: "main" },
          },
          {
            name: "Folder to sync",
            desc:
              "Leave empty to sync the whole vault. Otherwise type a folder name exactly as it appears in Obsidian's file list " +
              "(for example Knowledge, or Projects/Notes for a subfolder). Use the same value on every device. " +
              "A large vault syncs faster when you pick one folder.",
            control: { type: "text", key: "syncFolder" },
          },
          {
            name: "Automatic sync interval (minutes)",
            desc: "0 turns automatic sync off. You can always run Sync now from the command palette.",
            control: { type: "number", key: "autoSyncMinutes", min: 0, step: 1 },
          },
          {
            name: "Sync shortly after a note changes",
            control: { type: "toggle", key: "syncOnChange" },
          },
          {
            name: "Ignore",
            desc: `One pattern per line. A trailing slash means a folder. The Obsidian config folder (${this.app.vault.configDir}) is ignored by default.`,
            control: { type: "textarea", key: "ignore", rows: 4 },
          },
        ],
      },
      {
        type: "group",
        heading: "Sync behavior",
        items: [
          { name: "Name", desc: "Recorded in the history as the author.", control: { type: "text", key: "authorName" } },
          { name: "Email", control: { type: "text", key: "authorEmail" } },
          { name: "Show a notice after each sync", control: { type: "toggle", key: "showNotices" } },
          this.button("Check settings", "Validates the remote URL, token and branch without syncing.", "Check", async () => {
            const problems = validateSettings(plugin.settings);
            new Notice(problems.length ? problems.join("\n") : "Settings look good.");
          }),
        ],
      },
      {
        type: "group",
        heading: "Recovery",
        items: [
          {
            name: "Reset local history (keep notes)",
            desc:
              "Removes this folder's hidden Git history and nothing else. Use it after syncing to the wrong repository: " +
              "connect to the right one above, press this, then Sync now. The next sync starts from the repository's history.",
            render: (setting: Setting) => {
              let armed = false;
              setting.addButton((button) =>
                button
                  .setDestructive()
                  .setButtonText("Reset")
                  .onClick(async () => {
                    if (!armed) {
                      armed = true;
                      button.setButtonText("Press again to confirm");
                      window.setTimeout(() => {
                        armed = false;
                        button.setButtonText("Reset");
                      }, 8_000);
                      return;
                    }
                    armed = false;
                    button.setDisabled(true);
                    try {
                      await plugin.resetLocalHistory();
                    } finally {
                      button.setDisabled(false);
                      button.setButtonText("Reset");
                    }
                  }),
              );
            },
          },
        ],
      },
    ];
  }
}
