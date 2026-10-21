import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactsGit, type GitFs } from "./git";

const ME = { name: "Me", email: "me@example.com" };
const OTHER = { name: "Ito", email: "ito@example.com" };

/** Writes a file and commits it as the given author; returns the commit id. */
async function commitFile(dir: string, filepath: string, text: string, author: { name: string; email: string }, parent?: string[]): Promise<string> {
  fs.mkdirSync(path.dirname(path.join(dir, filepath)), { recursive: true });
  fs.writeFileSync(path.join(dir, filepath), text);
  await git.add({ fs, dir, filepath });
  return git.commit({ fs, dir, message: `${author.name}: ${filepath}`, author, ...(parent ? { parent } : {}) });
}

describe("changesByOthers", () => {
  let dir: string;
  let client: ArtifactsGit;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-git-"));
    await git.init({ fs, dir, defaultBranch: "main" });
    client = new ArtifactsGit({
      dir,
      fs: fs as unknown as GitFs,
      http: { request: () => Promise.reject(new Error("no network in this test")) },
      remoteUrl: "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/default/x.git",
      token: "t",
      branch: "main",
      ignore: [],
      author: ME,
    });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists files from other authors' commits on a fast-forward and skips mine", async () => {
    const before = await commitFile(dir, "a.md", "a", ME);
    await commitFile(dir, "Meta/b.md", "b", OTHER);
    await commitFile(dir, "c.md", "c", ME);
    const incoming = await commitFile(dir, "Meta/b.md", "b2", OTHER);
    expect(await client.changesByOthers(before, incoming)).toEqual([{ path: "Meta/b.md", author: "Ito" }]);
    expect(await client.changesByOthers(incoming, incoming)).toEqual([]);
  });

  it("counts a deletion and lists each path once with its newest author", async () => {
    const before = await commitFile(dir, "a.md", "a", ME);
    await commitFile(dir, "b.md", "b", OTHER);
    const other2 = { name: "Sato", email: "sato@example.com" };
    fs.rmSync(path.join(dir, "a.md"));
    await git.remove({ fs, dir, filepath: "a.md" });
    await git.commit({ fs, dir, message: "remove a", author: other2 });
    const incoming = await commitFile(dir, "b.md", "b2", other2);
    expect(await client.changesByOthers(before, incoming)).toEqual([
      { path: "a.md", author: "Sato" },
      { path: "b.md", author: "Sato" },
    ]);
  });

  it("stops at the merge base and skips merge commits, so my side of a merge is not reported", async () => {
    const base = await commitFile(dir, "a.md", "a", ME);
    // Their branch: one change by the other person.
    const theirs = await commitFile(dir, "theirs.md", "t", OTHER);
    // My branch from the same base: a change of my own, then the merge commit that pull would make.
    const mine = await commitFile(dir, "mine.md", "m", ME, [base]);
    fs.writeFileSync(path.join(dir, "theirs.md"), "t");
    await git.add({ fs, dir, filepath: "theirs.md" });
    const merge = await git.commit({ fs, dir, message: "merge", author: OTHER, parent: [theirs, mine] });
    // Pulling from `mine` with `theirs` incoming reports only theirs.md.
    expect(await client.changesByOthers(mine, theirs)).toEqual([{ path: "theirs.md", author: "Ito" }]);
    // Even when the incoming tip is a merge commit by the other person, my own commit is not counted.
    expect(await client.changesByOthers(mine, merge)).toEqual([{ path: "theirs.md", author: "Ito" }]);
  });
});
