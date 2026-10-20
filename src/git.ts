/**
 * Thin wrapper over isomorphic-git for one working tree (the vault or a folder inside it).
 * The file system and HTTP client are injected: Node's on desktop, Obsidian's adapter and
 * `requestUrl` on mobile (see vault-fs.ts and obsidian-http.ts). All network traffic goes to the
 * single Artifacts remote the user configured.
 */
import git from "isomorphic-git";
import { authFor, commitMessage, planChanges, type StatusRow } from "./core";

/** The parts of a file system isomorphic-git needs, in promise form. */
export interface GitFs {
  promises: {
    readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string>;
    writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: unknown): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: unknown): Promise<unknown>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
    chmod?(path: string, mode: number): Promise<void>;
  };
}

export interface GitHttp {
  request(req: unknown): Promise<unknown>;
}

export interface GitOptions {
  /** Working tree: an absolute path on desktop, a vault-relative path ("" = vault root) on mobile. */
  dir: string;
  fs: GitFs;
  http: GitHttp;
  remoteUrl: string;
  token: string;
  branch: string;
  ignore: readonly string[];
  author: { name: string; email: string };
}

export interface SyncResult {
  committed: boolean;
  added: number;
  removed: number;
  pulled: boolean;
  pushed: boolean;
  head: string | null;
  /** Local files renamed to `.local-<timestamp>` copies because the adopted repository had a different version. */
  setAside: string[];
}

export class GitConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitConflictError";
  }
}

const REMOTE_NAME = "origin";

/** The distinct messages inside an error, following `errors` (MultipleGitError, AggregateError) and `cause`. */
export function errorMessages(err: unknown, limit = 5): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (e: unknown, depth: number) => {
    if (out.length >= limit || depth > 4 || e === null || e === undefined) return;
    const inner = (e as { errors?: unknown }).errors;
    if (Array.isArray(inner) && inner.length) {
      for (const x of inner) walk(x, depth + 1);
      return;
    }
    const message = e instanceof Error ? e.message || e.name : typeof e === "string" ? e : typeof e === "number" || typeof e === "boolean" ? String(e) : `(${typeof e})`;
    if (!seen.has(message)) {
      seen.add(message);
      out.push(message);
    }
    const cause = (e as { cause?: unknown }).cause;
    if (cause && cause !== e) walk(cause, depth + 1);
  };
  walk(err, 0);
  return out;
}

/**
 * isomorphic-git reports a checkout where several files failed as one MultipleGitError whose text
 * only says to look at the "errors" property. Turn that into a message that names the first few
 * underlying failures (they are usually all the same one).
 */
export function unwrapGitError(err: unknown, doing: string): Error {
  const inner = (err as { errors?: unknown }).errors;
  if (!Array.isArray(inner) || inner.length === 0) return err instanceof Error ? err : new Error(String(err));
  const messages = errorMessages(err, 3);
  const more = inner.length > messages.length ? ` (and ${inner.length - messages.length} more)` : "";
  const out = new Error(`${inner.length} file operation${inner.length === 1 ? "" : "s"} failed while ${doing}: ${messages.join(" | ")}${more}`);
  out.name = "CheckoutFilesError";
  (out as { errors?: unknown }).errors = inner;
  return out;
}

function joinPath(dir: string, name: string): string {
  if (!dir || dir === ".") return name;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export class ArtifactsGit {
  constructor(private readonly opts: GitOptions) {}

  private get onAuth() {
    const auth = authFor(this.opts.token);
    return () => auth;
  }

  private get base() {
    // isomorphic-git accepts any fs with a `promises` member.
    return { fs: this.opts.fs as unknown as Parameters<typeof git.init>[0]["fs"], dir: this.opts.dir || "." };
  }

  private get http() {
    return this.opts.http as unknown as Parameters<typeof git.fetch>[0]["http"];
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.opts.fs.promises.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Make sure the folder is a repository pointing at the configured remote and branch. */
  async ensureRepo(): Promise<void> {
    const { dir, branch, remoteUrl } = this.opts;
    if (dir && dir !== "." && !(await this.exists(dir))) {
      await this.opts.fs.promises.mkdir(dir, { recursive: true });
    }
    if (!(await this.exists(joinPath(dir, ".git")))) {
      await git.init({ ...this.base, defaultBranch: branch });
    }
    const remotes = await git.listRemotes(this.base);
    const origin = remotes.find((r) => r.remote === REMOTE_NAME);
    if (!origin) {
      await git.addRemote({ ...this.base, remote: REMOTE_NAME, url: remoteUrl });
    } else if (origin.url !== remoteUrl) {
      await git.deleteRemote({ ...this.base, remote: REMOTE_NAME });
      await git.addRemote({ ...this.base, remote: REMOTE_NAME, url: remoteUrl });
    }
    // Point HEAD at the configured branch. With no commits yet there is nothing to check out, so
    // only the symbolic ref changes; with commits, switch (creating the branch if needed).
    const current = await git.currentBranch({ ...this.base, fullname: false }).catch(() => undefined);
    if (current !== branch) {
      const head = await this.head();
      if (!head) {
        await this.opts.fs.promises.writeFile(joinPath(joinPath(dir, ".git"), "HEAD"), `ref: refs/heads/${branch}\n`);
      } else {
        const branches = await git.listBranches(this.base);
        if (!branches.includes(branch)) await git.branch({ ...this.base, ref: branch, checkout: true });
        else await git.checkout({ ...this.base, ref: branch });
      }
    }
  }

  async head(): Promise<string | null> {
    return git.resolveRef({ ...this.base, ref: "HEAD" }).catch(() => null);
  }

  /**
   * First sync into a folder that has no commits yet: take the remote branch as the starting point.
   * The repository wins: a file that exists both here and in the repository is overwritten with the
   * repository's version (force checkout), files that exist only here stay and are committed on
   * top. That is what a second device wants, and it is also the way out after "Reset local
   * history". Returns true when adopted.
   */
  async adoptRemoteIfEmpty(): Promise<boolean> {
    if (await this.head()) return false;
    if (!(await this.remoteHasBranch())) return false;
    await git.fetch({
      ...this.base,
      http: this.http,
      remote: REMOTE_NAME,
      ref: this.opts.branch,
      singleBranch: true,
      onAuth: this.onAuth,
    });
    const kept = await this.setAsideDifferingLocalCopies();
    try {
      await git.checkout({ ...this.base, ref: this.opts.branch, remote: REMOTE_NAME, force: true });
    } catch (err) {
      throw unwrapGitError(err, "checking out the repository");
    }
    this.lastAdoption = { setAside: kept };
    return true;
  }

  /** What the last adoption did, for the summary line. */
  lastAdoption: { setAside: string[] } | null = null;

  /**
   * Before the repository's files are written over this folder: any local file that the repository
   * also has, with different content, is renamed to `<name>.local-<timestamp>.<ext>` next to it.
   * Nothing is lost; the copy is then committed on top and reaches the other devices, where the
   * person decides. Identical files are left alone. Returns the paths that were set aside.
   */
  private async setAsideDifferingLocalCopies(): Promise<string[]> {
    const { dir } = this.opts;
    const fsp = this.opts.fs.promises;
    const ref = `refs/remotes/${REMOTE_NAME}/${this.opts.branch}`;
    const commitOid = await git.resolveRef({ ...this.base, ref });
    const remoteFiles = await git.listFiles({ ...this.base, ref: commitOid });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
    const setAside: string[] = [];
    for (const filepath of remoteFiles) {
      const local = joinPath(dir, filepath);
      let bytes: Uint8Array;
      try {
        const s = await fsp.lstat(local);
        if (!s.isFile()) continue;
        const data = await fsp.readFile(local);
        bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      } catch {
        continue; // not here: nothing to protect
      }
      const { oid: localOid } = await git.hashBlob({ object: bytes });
      const { oid: remoteOid } = await git.readBlob({ ...this.base, oid: commitOid, filepath });
      if (localOid === remoteOid) continue;
      const dot = filepath.lastIndexOf(".");
      const slash = filepath.lastIndexOf("/");
      const aside = dot > slash ? `${filepath.slice(0, dot)}.local-${stamp}${filepath.slice(dot)}` : `${filepath}.local-${stamp}`;
      await fsp.writeFile(joinPath(dir, aside), bytes);
      await fsp.unlink(local);
      setAside.push(aside);
    }
    return setAside;
  }

  /** Stage every change (respecting the ignore list) and commit. Returns counts; 0/0 means nothing to commit. */
  async commitAll(now = new Date()): Promise<{ added: number; removed: number; committed: boolean }> {
    const matrix = (await git.statusMatrix({ ...this.base })) as StatusRow[];
    const { add, remove } = planChanges(matrix, this.opts.ignore);
    for (const filepath of add) await git.add({ ...this.base, filepath });
    for (const filepath of remove) await git.remove({ ...this.base, filepath });
    if (add.length === 0 && remove.length === 0) return { added: 0, removed: 0, committed: false };
    await git.commit({
      ...this.base,
      message: commitMessage(add.length, remove.length, now),
      author: this.opts.author,
    });
    return { added: add.length, removed: remove.length, committed: true };
  }

  /** Does the remote have the branch at all? (A brand-new repository has no refs.) */
  private async remoteHasBranch(): Promise<boolean> {
    const refs = await git.listServerRefs({
      http: this.http,
      url: this.opts.remoteUrl,
      prefix: `refs/heads/${this.opts.branch}`,
      onAuth: this.onAuth,
    });
    return refs.some((r) => r.ref === `refs/heads/${this.opts.branch}`);
  }

  /** Fetch and merge the remote branch. Fast-forward when possible, otherwise a merge commit. */
  async pull(): Promise<boolean> {
    if (await this.adoptRemoteIfEmpty()) return true;
    if (!(await this.remoteHasBranch())) return false;
    const before = await this.head();
    if (!before) return false; // nothing local and nothing remote: a brand-new repository
    try {
      await git.pull({
        ...this.base,
        http: this.http,
        remote: REMOTE_NAME,
        ref: this.opts.branch,
        singleBranch: true,
        onAuth: this.onAuth,
        author: this.opts.author,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/merge|conflict/i.test(message)) {
        throw new GitConflictError(
          "The remote has changes that conflict with yours. Resolve them with a Git client, then sync again.",
        );
      }
      throw err;
    }
    const after = await this.head();
    return before !== after;
  }

  async push(): Promise<boolean> {
    const res = await git.push({
      ...this.base,
      http: this.http,
      remote: REMOTE_NAME,
      ref: this.opts.branch,
      onAuth: this.onAuth,
    });
    if (!res.ok) throw new Error(res.error ?? "Push failed");
    return true;
  }

  /**
   * Commit local changes, pull, then push. On the very first sync of a folder the remote branch is
   * adopted first, so existing notes land on top of the remote history instead of forming an
   * unrelated one.
   */
  async sync(now = new Date()): Promise<SyncResult> {
    await this.ensureRepo();
    const adopted = await this.adoptRemoteIfEmpty();
    const commit = await this.commitAll(now);
    const pulled = adopted || (await this.pull());
    const pushed = await this.push();
    return { ...commit, pulled, pushed, head: await this.head(), setAside: adopted ? (this.lastAdoption?.setAside ?? []) : [] };
  }
}
