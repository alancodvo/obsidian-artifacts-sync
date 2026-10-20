/**
 * End-to-end check against a real Artifacts repository (opt-in; not part of `npm test`).
 *
 *   ARTIFACTS_REMOTE=https://<account>.artifacts.cloudflare.net/git/<ns>/<repo>.git \
 *   ARTIFACTS_TOKEN=art_… npm run e2e
 *
 * Simulates two vaults syncing the same repository: first sync adopts the remote, a new note and an
 * ignored `.obsidian` file are pushed from A, B receives the note only, then B edits while A deletes a
 * file and both converge. Uses throwaway folders under the OS temp directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactsGit } from "../src/git";
import { nodeFs, nodeHttp } from "../src/node-env";
import { defaultIgnore } from "../src/core";

const remoteUrl = process.env.ARTIFACTS_REMOTE ?? "";
const token = process.env.ARTIFACTS_TOKEN ?? "";
if (!remoteUrl || !token) {
  console.error("Set ARTIFACTS_REMOTE and ARTIFACTS_TOKEN (a write token).");
  process.exit(2);
}
const mask = (s: unknown) => String(s).replaceAll(token, "<token>");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-sync-e2e-"));
const mk = (dir: string) =>
  new ArtifactsGit({ dir, fs: nodeFs(), http: nodeHttp(), remoteUrl, token, branch: "main", ignore: defaultIgnore(".obsidian"), author: { name: "e2e", email: "e2e@example.com" } });
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "ok " : "NG "} ${label}`);
  if (!ok) process.exitCode = 1;
};

async function main(): Promise<void> {
  const a = path.join(root, "vault-a");
  const b = path.join(root, "vault-b");
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const stamp = Date.now();
  const note = path.join("E2E", `${stamp}.md`);

  const r1 = await mk(a).sync();
  check("A: first sync pushes/adopts", r1.pushed);

  fs.mkdirSync(path.join(a, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(a, ".obsidian", "workspace.json"), "{}");
  fs.mkdirSync(path.join(a, "E2E"), { recursive: true });
  fs.writeFileSync(path.join(a, note), `# e2e ${stamp}\n`);
  const r2 = await mk(a).sync();
  check("A: new note committed and pushed", r2.committed && r2.added === 1 && r2.pushed);

  const r3 = await mk(b).sync();
  check("B: first sync receives the note", r3.pulled && fs.existsSync(path.join(b, note)));
  check("B: ignored .obsidian not received", !fs.existsSync(path.join(b, ".obsidian")));

  // B edits the note while A adds another file: both sides changed, no overlap → merge commit.
  fs.appendFileSync(path.join(b, note), "edited in B\n");
  await mk(b).sync();
  fs.writeFileSync(path.join(a, "E2E", `${stamp}-a.md`), "from A\n");
  const r5 = await mk(a).sync();
  check("A: own add merged with B's edit", r5.committed && r5.pulled && r5.pushed && fs.readFileSync(path.join(a, note), "utf8").includes("edited in B"));
  const r6 = await mk(b).sync();
  check("B: converges (A's file present)", r6.pulled && fs.existsSync(path.join(b, "E2E", `${stamp}-a.md`)));

  // A real conflict (B edits, A deletes the same note) must stop without overwriting anything.
  fs.appendFileSync(path.join(b, note), "edited again in B\n");
  await mk(b).sync();
  fs.rmSync(path.join(a, note));
  let conflict = false;
  try { await mk(a).sync(); } catch (err) { conflict = err instanceof Error && err.name === "GitConflictError"; }
  check("A: modify/delete conflict is reported, not resolved silently", conflict);
  // Recover A by taking the remote state again (what a user would do with a Git client).
  fs.rmSync(path.join(a, ".git"), { recursive: true, force: true });
  fs.rmSync(path.join(a, "E2E"), { recursive: true, force: true });
  await mk(a).sync();

  // Clean the remote of this run's files so repeated runs stay small.
  fs.rmSync(path.join(a, "E2E"), { recursive: true, force: true });
  const r9 = await mk(a).sync();
  check("cleanup: this run's files removed from the remote", r9.pushed);
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("e2e failed:", mask(err instanceof Error ? err.stack : err));
  process.exit(1);
});
