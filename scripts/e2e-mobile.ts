/**
 * End-to-end check of the mobile code path without Obsidian: the vault-adapter file system (backed
 * by a temp folder through a DataAdapter look-alike) plus the `requestUrl` HTTP client (backed by
 * fetch), syncing with a real Artifacts repository.
 *
 *   ARTIFACTS_REMOTE=… ARTIFACTS_TOKEN=… npm run e2e:mobile
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactsGit } from "../src/git";
import { defaultIgnore } from "../src/core";
import { createVaultFs } from "../src/vault-fs";
import { createRequestUrlHttp, type RequestUrlLike } from "../src/obsidian-http";
import { fakeAdapter } from "./fake-adapter";

const remoteUrl = process.env.ARTIFACTS_REMOTE ?? "";
const token = process.env.ARTIFACTS_TOKEN ?? "";
if (!remoteUrl || !token) {
  console.error("Set ARTIFACTS_REMOTE and ARTIFACTS_TOKEN (a write token).");
  process.exit(2);
}
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "ok " : "NG "} ${label}`);
  if (!ok) process.exitCode = 1;
};

/** requestUrl as Obsidian provides it, emulated with fetch. */
const requestUrl: RequestUrlLike = async (params) => {
  const res = await fetch(params.url, { method: params.method, headers: params.headers, body: params.body });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, headers, arrayBuffer: await res.arrayBuffer() };
};

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-sync-mobile-"));
  const vfs = createVaultFs(fakeAdapter(root));
  const http = createRequestUrlHttp(requestUrl);
  // Sync one folder of the "vault", like the Folder to sync setting on a phone.
  const mk = () => new ArtifactsGit({ dir: "Knowledge", fs: vfs, http, remoteUrl, token, branch: "main", ignore: defaultIgnore(".obsidian"), author: { name: "mobile-e2e", email: "e2e@example.com" } });
  const stamp = Date.now().toString(36);

  const r1 = await mk().sync();
  check("mobile: first sync adopts the remote into the folder", r1.pushed && fs.existsSync(path.join(root, "Knowledge", ".git")));

  fs.mkdirSync(path.join(root, "Knowledge", "E2E"), { recursive: true });
  fs.writeFileSync(path.join(root, "Knowledge", "E2E", `${stamp}-mobile.md`), "# from mobile\n");
  fs.mkdirSync(path.join(root, "Knowledge", ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(root, "Knowledge", ".obsidian", "app.json"), "{}");
  const r2 = await mk().sync();
  check("mobile: note committed and pushed (ignored folder skipped)", r2.committed && r2.added === 1 && r2.pushed);

  const r3 = await mk().sync();
  check("mobile: second sync has nothing new", !r3.committed && r3.pushed);

  fs.rmSync(path.join(root, "Knowledge", "E2E"), { recursive: true, force: true });
  const r4 = await mk().sync();
  check("mobile: deletion pushed (cleanup)", r4.committed && r4.removed === 1 && r4.pushed);
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("e2e:mobile failed:", String(err instanceof Error ? err.stack : err).replaceAll(token, "<token>"));
  process.exit(1);
});
