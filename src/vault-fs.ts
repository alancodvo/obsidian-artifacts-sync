/**
 * A file system for isomorphic-git built on Obsidian's DataAdapter, so the plugin works on mobile
 * (no Node fs there). Paths are vault-relative with forward slashes; the `.git` folder lives inside
 * the synced folder like it does on desktop.
 *
 * Only the subset isomorphic-git uses is implemented: readFile, writeFile, unlink, readdir, mkdir,
 * rmdir, stat, lstat (same as stat), readlink and symlink (unsupported: ENOSYS).
 *
 * Two things the phone's adapter needs that a desktop file system does not:
 * - isomorphic-git fires hundreds of file operations at once during a checkout. Every one crosses
 *   the JavaScript ↔ native bridge on a phone, so they are funnelled through a small concurrency
 *   limit, and folder creation is de-duplicated so two parallel writers never create the same
 *   folder twice.
 * - Every error carries the operation and path, and the adapter's own error text, so a failure on a
 *   phone (where there is no console) can be read from the notice.
 */

/** The DataAdapter methods we rely on (a structural type, so tests can supply a fake). */
export interface AdapterLike {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface VaultStat {
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export class FsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FsError";
  }
}

/** Normalize to a vault-relative path: forward slashes, no leading "./" or "/", no trailing "/". */
export function vaultPath(p: string): string {
  let out = p.replace(/\\/g, "/");
  out = out.replace(/\/+/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  out = out.replace(/^\/+/, "").replace(/\/+$/, "");
  // Collapse "a/./b" and "a/x/../b".
  const parts: string[] = [];
  for (const seg of out.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** The vault root is "" after normalization; Obsidian's adapter wants "/" for it. */
function adapterPath(p: string): string {
  return p === "" ? "/" : p;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toUint8(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Run at most `max` jobs at once; the rest wait their turn in order. */
export function createLimiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(job: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        // Through a resolved promise, so a job that throws synchronously still releases its slot.
        Promise.resolve()
          .then(job)
          .then(resolve, reject)
          .finally(next);
      };
      if (active < max) run();
      else queue.push(run);
    });
}

/** How many adapter calls may be in flight at once (the phone's bridge does not like hundreds). */
export const ADAPTER_CONCURRENCY = 8;

export function createVaultFs(adapter: AdapterLike, concurrency = ADAPTER_CONCURRENCY) {
  const limit = createLimiter(concurrency);
  const exists = (p: string) => limit(() => adapter.exists(adapterPath(p)));
  const rawStat = (p: string) => limit(() => adapter.stat(adapterPath(p)));

  const statOf = async (p: string): Promise<VaultStat> => {
    let s: Awaited<ReturnType<AdapterLike["stat"]>>;
    try {
      s = await rawStat(p);
    } catch (err) {
      throw new FsError("EIO", `stat '${p}': ${describe(err)}`, err);
    }
    if (!s) throw new FsError("ENOENT", `ENOENT: no such file or directory, stat '${p}'`);
    const isDir = s.type === "folder";
    return {
      type: isDir ? "dir" : "file",
      mode: isDir ? 0o40755 : 0o100644,
      size: s.size ?? 0,
      ino: 0,
      mtimeMs: s.mtime ?? 0,
      ctimeMs: s.ctime ?? 0,
      uid: 0,
      gid: 0,
      dev: 0,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    };
  };

  // One creation per folder at a time: parallel writers into the same new folder share the promise
  // instead of both calling mkdir (the second call fails on the phone).
  const creating = new Map<string, Promise<void>>();
  const mkdirp = async (p: string): Promise<void> => {
    if (p === "") return;
    const pending = creating.get(p);
    if (pending) return pending;
    const job = (async () => {
      if (await exists(p)) return;
      await mkdirp(parentOf(p));
      try {
        await limit(() => adapter.mkdir(p));
      } catch (err) {
        // Lost a race with another creator, or the adapter reports "exists" as an error: fine either way.
        if (await exists(p)) return;
        throw new FsError("EIO", `mkdir '${p}': ${describe(err)}`, err);
      }
    })();
    creating.set(p, job);
    try {
      await job;
    } finally {
      creating.delete(p);
    }
  };

  const promises = {
    async readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> {
      const p = vaultPath(path);
      if (!(await exists(p))) throw new FsError("ENOENT", `ENOENT: no such file or directory, open '${p}'`);
      const s = await rawStat(p);
      if (s?.type === "folder") throw new FsError("EISDIR", `EISDIR: illegal operation on a directory, read '${p}'`);
      let buf: ArrayBuffer;
      try {
        buf = await limit(() => adapter.readBinary(p));
      } catch (err) {
        throw new FsError("EIO", `read '${p}': ${describe(err)}`, err);
      }
      const bytes = new Uint8Array(buf);
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? decoder.decode(bytes) : bytes;
    },

    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
      const p = vaultPath(path);
      if (p === "") throw new FsError("EISDIR", "EISDIR: illegal operation on a directory, write ''");
      const bytes = toArrayBuffer(toUint8(data));
      await mkdirp(parentOf(p));
      try {
        await limit(() => adapter.writeBinary(p, bytes));
      } catch {
        // The parent may have vanished or not been visible yet; make sure of it and try once more.
        await mkdirp(parentOf(p));
        try {
          await limit(() => adapter.writeBinary(p, bytes));
        } catch (again) {
          throw new FsError("EIO", `write '${p}': ${describe(again)}`, again);
        }
      }
    },

    async unlink(path: string): Promise<void> {
      const p = vaultPath(path);
      if (!(await exists(p))) throw new FsError("ENOENT", `ENOENT: no such file or directory, unlink '${p}'`);
      try {
        await limit(() => adapter.remove(p));
      } catch (err) {
        if (!(await exists(p))) return;
        throw new FsError("EIO", `unlink '${p}': ${describe(err)}`, err);
      }
    },

    async readdir(path: string): Promise<string[]> {
      const p = vaultPath(path);
      const s = await rawStat(p);
      if (!s && p !== "") throw new FsError("ENOENT", `ENOENT: no such file or directory, scandir '${p}'`);
      if (s && s.type !== "folder") throw new FsError("ENOTDIR", `ENOTDIR: not a directory, scandir '${p}'`);
      let listing: Awaited<ReturnType<AdapterLike["list"]>>;
      try {
        listing = await limit(() => adapter.list(adapterPath(p)));
      } catch (err) {
        throw new FsError("EIO", `scandir '${p}': ${describe(err)}`, err);
      }
      const names = [...(listing.files ?? []), ...(listing.folders ?? [])].map((full) => full.replace(/\/+$/, "").split("/").pop() ?? full);
      return names.filter((n) => n !== "");
    },

    async mkdir(path: string): Promise<void> {
      const p = vaultPath(path);
      if (p === "") return;
      if (await exists(p)) throw new FsError("EEXIST", `EEXIST: file already exists, mkdir '${p}'`);
      await mkdirp(p);
    },

    async rmdir(path: string): Promise<void> {
      const p = vaultPath(path);
      if (!(await exists(p))) throw new FsError("ENOENT", `ENOENT: no such file or directory, rmdir '${p}'`);
      try {
        await limit(() => adapter.rmdir(p, false));
      } catch (err) {
        if (!(await exists(p))) return;
        throw new FsError("ENOTEMPTY", `rmdir '${p}': ${describe(err)}`, err);
      }
    },

    async stat(path: string): Promise<VaultStat> {
      return statOf(vaultPath(path));
    },

    async lstat(path: string): Promise<VaultStat> {
      return statOf(vaultPath(path));
    },

    async readlink(path: string): Promise<string> {
      throw new FsError("ENOSYS", `ENOSYS: symbolic links are not supported, readlink '${path}'`);
    },

    async symlink(target: string, path: string): Promise<void> {
      throw new FsError("ENOSYS", `ENOSYS: symbolic links are not supported, symlink '${path}' -> '${target}'`);
    },

    async chmod(): Promise<void> {
      // File modes are not tracked by the adapter; nothing to do.
    },
  };

  return { promises };
}

export type VaultFs = ReturnType<typeof createVaultFs>;
