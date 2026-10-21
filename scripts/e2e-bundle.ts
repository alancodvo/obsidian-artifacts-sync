/**
 * Runs the built `main.js` inside a simulated Obsidian, once as desktop and once as mobile, and
 * performs a real sync against an Artifacts repository (opt-in; run `npm run build` first).
 *
 *   ARTIFACTS_REMOTE=… ARTIFACTS_TOKEN=… npm run e2e:bundle
 *   (or CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… to make a throwaway repository and token)
 *
 * The mobile pass makes every Node built-in throw, so it also proves the bundle loads and syncs
 * without them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";
import { fakeAdapter } from "./fake-adapter";
import { ADAPTER_CONCURRENCY } from "../src/vault-fs";

/** One stamp per run: the fixtures of the desktop pass are what the mobile pass adopts. */
const STAMP = Date.now().toString(36);

let remoteUrl = process.env.ARTIFACTS_REMOTE ?? "";
let token = process.env.ARTIFACTS_TOKEN ?? "";

/**
 * No repository token given: with API credentials, make a throwaway repository and a short-lived
 * write token (same namespace as e2e-api.ts), so the token never has to pass through a human.
 */
async function resolveTarget(): Promise<void> {
  if (remoteUrl && token) return;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    console.error("Set ARTIFACTS_REMOTE and ARTIFACTS_TOKEN (a write token), or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
    process.exit(2);
  }
  const { ArtifactsApi } = await import("../src/api");
  const api = new ArtifactsApi({ accountId, apiToken, fetchImpl: (input, init) => fetch(input, init) });
  const namespace = "artifacts-sync-e2e";
  const repoName = `bundle-${Math.random().toString(36).slice(2, 10)}`;
  await api.ensureNamespace(namespace);
  const repo = await api.ensureRepo(namespace, repoName);
  remoteUrl = repo.remote;
  token = (await api.issueToken(namespace, repoName, "write", 600)).token;
  console.log(`note: delete the test repository when done: wrangler artifacts repos delete ${repoName} --namespace ${namespace}`);
}
const mainJs = path.resolve("main.js");
if (!fs.existsSync(mainJs)) {
  console.error("main.js not found: run `npm run build` first.");
  process.exit(2);
}

type Mode = "desktop" | "mobile";
const NODE_ONLY = /^(node:)?(fs|path|http|https|url|querystring|crypto|zlib|stream|os|child_process)$/;

async function runMode(mode: Mode): Promise<boolean> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `artifacts-sync-bundle-${mode}-`));
  // A second vault in the mobile pass: "another person" who edits the shared repository.
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), `artifacts-sync-bundle-${mode}-other-`));
  const notices: string[] = [];
  // What the next plugin instance reads as its saved settings (see loadData below).
  let savedData: Record<string, unknown> = { remoteUrl, token, syncFolder: "Knowledge", showNotices: true };
  class FileSystemAdapter {
    constructor(private readonly base: string) {}
    getBasePath() {
      return this.base;
    }
  }
  const obsidianStub = {
    Plugin: class {
      manifest = { id: "cloudflare-artifacts-sync", version: "e2e", dir: ".obsidian/plugins/cloudflare-artifacts-sync" };
      addCommand() {}
      addSettingTab() {}
      addStatusBarItem() {
        return { setText() {}, addClass() {}, setAttr() {}, addEventListener() {} };
      }
      addRibbonIcon() {}
      registerEvent() {}
      registerInterval() {}
      async loadData() {
        return savedData;
      }
      async saveData() {}
    },
    PluginSettingTab: class {},
    FuzzySuggestModal: class {},
    FileSystemAdapter,
    Setting: class {},
    Notice: class {
      constructor(text: string) {
        notices.push(text);
      }
    },
    Platform: { isDesktop: mode === "desktop", isMobile: mode === "mobile", isIosApp: false, isAndroidApp: mode === "mobile" },
    normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
    requestUrl: async (params: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer }) => {
      const res = await fetch(params.url, { method: params.method, headers: params.headers, body: params.body });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return { status: res.status, headers, arrayBuffer: await res.arrayBuffer() };
    },
  };

  // The plugin reads `window` (the Buffer global, timers); in Node the global object stands in for it.
  (globalThis as { window?: unknown }).window ??= globalThis;
  const origLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
  (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (request: string, ...rest: unknown[]) {
    if (request === "obsidian") return obsidianStub;
    if (mode === "mobile" && NODE_ONLY.test(request)) throw new Error(`not available on mobile: ${request}`);
    return origLoad.call(this, request, ...rest);
  };
  // Phones have no global Buffer or process. Shadow both for the bundle only (Node's own fetch
  // still needs them), so a bare reference inside the bundle fails here instead of on a phone.
  let entry = mainJs;
  if (mode === "mobile") {
    entry = path.join(root, "main.mobile.js");
    fs.writeFileSync(entry, `(function (Buffer, process) {${fs.readFileSync(mainJs, "utf8")}\n})(undefined, undefined);`);
  }
  try {
    const require = createRequire(__filename);
    delete require.cache[entry];
    const mod = require(entry) as { default?: new () => PluginLike } & (new () => PluginLike);
    const PluginClass = mod.default ?? mod;
    const plugin = new PluginClass();
    // Mobile gets the strict adapter (fails like the phone's) plus a `write` for the error report.
    const stats = { inFlight: 0, peak: 0, calls: 0 };
    const base = mode === "mobile" ? fakeAdapter(root, { strict: true, stats }) : Object.assign(new FileSystemAdapter(root), fakeAdapter(root));
    const adapter = Object.assign(base, {
      async write(p: string, data: string) {
        fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
        fs.writeFileSync(path.join(root, p), data);
      },
    });
    plugin.app = { vault: { adapter, configDir: ".obsidian", getName: () => "bundle-vault", on: () => ({}) }, workspace: {} };
    await plugin.onload();
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    const read = (rel: string) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : null);
    const problems: string[] = [];
    // Fixtures live under one stamped folder, so a shared repository is left as it was found.
    const T = `Knowledge/E2E-${STAMP}`;
    const fixtures: Record<string, string> = {
      [`${T}/Guide/intro.md`]: "# intro (from desktop)\n",
      [`${T}/Meta/定義_指標.md`]: "# 指標 (repository version)\n",
      // Several new folders under one new parent: the mkdir stage runs them in parallel.
      [`${T}/Tree/A/B/x.md`]: "x\n",
      [`${T}/Tree/A/C/y.md`]: "y\n",
      [`${T}/Tree/A/z.md`]: "z\n",
      [`${T}/Tree/D/w.md`]: "w\n",
    };
    const fixtureCount = Object.keys(fixtures).length;
    if (mode === "desktop") {
      // First device: a nested tree goes up to the (empty) repository and stays there.
      for (const [rel, text] of Object.entries(fixtures)) write(rel, text);
      await plugin.runSync("manual");
      if (!notices.some((n) => new RegExp(`synced at .*${fixtureCount} changed`).test(n))) problems.push(`expected '${fixtureCount} changed'`);
    } else {
      // Second device, the phone: the folder already holds one of the files (a differing copy) and
      // one of its own. Adopting the repository must put the repository's version in place, keep
      // the differing copy as a .local-… file, keep and push the phone's own file, and bring the
      // rest of the tree in, through the strict adapter and within the concurrency limit.
      write(`${T}/Meta/定義_指標.md`, "# 指標 (phone copy, differing)\n");
      write(`${T}/Phone/memo.md`, "# memo (from phone)\n");
      await plugin.runSync("manual");
      if (!notices.some((n) => /synced at .*2 changed, 0 removed, pulled updates; 1 local copy kept/.test(n))) problems.push("expected '2 changed, 0 removed, pulled updates; 1 local copy kept'");
      if (read(`${T}/Meta/定義_指標.md`) !== "# 指標 (repository version)\n") problems.push("repository version did not replace the phone copy");
      const aside = fs.existsSync(path.join(root, T, "Meta")) ? fs.readdirSync(path.join(root, T, "Meta")).find((n) => /^定義_指標\.local-\d{8}-\d{4}\.md$/.test(n)) : undefined;
      if (!aside) problems.push("the differing phone copy was not kept as a .local-… file");
      else if (read(`${T}/Meta/${aside}`) !== "# 指標 (phone copy, differing)\n") problems.push("the .local-… copy does not hold the phone's content");
      for (const rel of Object.keys(fixtures)) if (rel !== `${T}/Meta/定義_指標.md` && read(rel) !== fixtures[rel]) problems.push(`${rel} did not arrive intact`);
      if (stats.peak > ADAPTER_CONCURRENCY) problems.push(`adapter calls in flight peaked at ${stats.peak} (limit ${ADAPTER_CONCURRENCY})`);
      // A second sync has nothing to do and must not fail either.
      await plugin.runSync("manual");
      if (!notices.some((n) => /synced at .*no local changes/.test(n))) problems.push("second sync did not report 'no local changes'");
      // Another person (own vault, own author name) adopts the repository, changes one note and adds
      // one, and pushes. The phone's next sync must name both notes and the person.
      savedData = { ...savedData, authorName: "Desk Person", authorEmail: "desk@example.com" };
      const other = new PluginClass();
      other.app = { vault: { adapter: fakeAdapter(otherRoot), configDir: ".obsidian", getName: () => "other-vault", on: () => ({}) }, workspace: {} };
      await other.onload();
      await other.runSync("manual");
      const writeOther = (rel: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(otherRoot, rel)), { recursive: true });
        fs.writeFileSync(path.join(otherRoot, rel), text);
      };
      writeOther(`${T}/Guide/intro.md`, "# intro (edited by Desk Person)\n");
      writeOther(`${T}/Guide/new.md`, "# new (from Desk Person)\n");
      const beforeOthers = notices.length;
      await other.runSync("manual");
      await plugin.runSync("manual");
      const since = notices.slice(beforeOthers);
      const expectOthers = new RegExp(`2 notes changed by others since your last sync\\nDesk Person: ${T}/Guide/intro.md\\nDesk Person: ${T}/Guide/new.md`);
      if (!since.some((n) => expectOthers.test(n))) problems.push("the phone was not told which notes Desk Person changed");
      if (!since.some((n) => /synced at .*no local changes, pulled updates; 2 notes changed by others\)/.test(n))) problems.push("the sync summary did not count the 2 notes changed by others");
      if (read(`${T}/Guide/intro.md`) !== "# intro (edited by Desk Person)\n") problems.push("Desk Person's edit did not arrive");
      // My own commits are never reported as other people's: a sync with only my change says nothing about others.
      const beforeMine = notices.length;
      write(`${T}/Phone/memo.md`, "# memo (from phone, edited)\n");
      await plugin.runSync("manual");
      if (notices.slice(beforeMine).some((n) => /changed by others/.test(n))) problems.push("my own change was reported as someone else's");
      // Leave the repository as it was found: remove the stamped folder and push the deletion.
      fs.rmSync(path.join(root, T), { recursive: true, force: true });
      await plugin.runSync("manual");
      if (!notices.some((n) => new RegExp(`synced at .*0 changed, ${fixtureCount + 3} removed`).test(n))) problems.push(`cleanup did not report '${fixtureCount + 3} removed'`);
      const report = read(".obsidian/plugins/cloudflare-artifacts-sync/last-error.txt");
      if (report) problems.push(`an error report was written:\n${report.slice(0, 1500)}`);
      console.log(`    adapter calls: ${stats.calls}, peak in flight: ${stats.peak}`);
    }
    const ok = problems.length === 0;
    console.log(`${ok ? "ok " : "NG "} ${mode}: ${notices.map((n) => n.replaceAll(token, "<token>")).join(" || ")}`);
    for (const p of problems) console.log(`    - ${p}`);
    return ok;
  } finally {
    (Module as unknown as { _load: unknown })._load = origLoad;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
}

interface PluginLike {
  app: unknown;
  onload(): Promise<void>;
  runSync(trigger: "manual"): Promise<void>;
}

async function main(): Promise<void> {
  await resolveTarget();
  // Desktop first: it seeds the repository the phone then adopts into a folder with existing files.
  const results = [await runMode("desktop"), await runMode("mobile")];
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e:bundle failed:", String(err instanceof Error ? err.stack : err).replaceAll(token, "<token>").slice(0, 800));
  process.exit(1);
});
