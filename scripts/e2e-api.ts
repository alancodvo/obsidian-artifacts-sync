/**
 * End-to-end check of the control-plane client against the real Cloudflare API (opt-in).
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run e2e:api
 *
 * Creates (or reuses) the namespace `artifacts-sync-e2e` and a repository, issues a short-lived
 * write token, and pushes one commit with it to prove the token works end to end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactsApi } from "../src/api";
import { ArtifactsGit } from "../src/git";
import { nodeFs, nodeHttp } from "../src/node-env";
import { DEFAULT_IGNORE, tokenStatus } from "../src/core";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
if (!/^[0-9a-f]{32}$/.test(accountId) || !apiToken) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID (32 hex) and CLOUDFLARE_API_TOKEN (Artifacts Edit).");
  process.exit(2);
}
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "ok " : "NG "} ${label}`);
  if (!ok) process.exitCode = 1;
};

async function main(): Promise<void> {
  const api = new ArtifactsApi({ accountId, apiToken, fetchImpl: (input, init) => fetch(input, init) });
  const namespace = "artifacts-sync-e2e";
  const repoName = `e2e-${Date.now().toString(36)}`;

  const namespaces = await api.listNamespaces();
  check("API token can list namespaces", Array.isArray(namespaces));
  await api.ensureNamespace(namespace);
  await api.ensureNamespace(namespace);
  check("namespace create is idempotent", true);

  const repo = await api.ensureRepo(namespace, repoName);
  check("repository created with a remote", repo.remote.includes(`/git/${namespace}/${repoName}.git`));
  const again = await api.ensureRepo(namespace, repoName);
  check("repository create is idempotent", again.remote === repo.remote);

  const issued = await api.issueToken(namespace, repoName, "write", 600);
  const status = tokenStatus(issued.token, Date.now());
  check("token issued with an expiry about 10 minutes out", !status.expired && status.remainingMs !== null && status.remainingMs > 8 * 60_000 && status.remainingMs <= 10 * 60_000 + 5_000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-sync-api-e2e-"));
  fs.writeFileSync(path.join(dir, "hello.md"), "# hello\n");
  const git = new ArtifactsGit({ dir, fs: nodeFs(), http: nodeHttp(), remoteUrl: repo.remote, token: issued.token, branch: "main", ignore: DEFAULT_IGNORE, author: { name: "e2e", email: "e2e@example.com" } });
  const result = await git.sync();
  check("push with the issued token works", result.pushed && result.committed);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`note: delete the test repository when done: wrangler artifacts repos delete ${repoName} --namespace ${namespace}`);
}

main().catch((err) => {
  console.error("e2e:api failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
