/**
 * A DataAdapter look-alike backed by a folder on disk, mirroring Obsidian's path conventions
 * (vault-relative, forward slashes, "/" for the vault root, `list()` returns full relative paths).
 * Used by the unit tests and by the end-to-end scripts; never shipped in the plugin.
 *
 * `strict` imitates the phone's adapter, which is less forgiving than Node's fs: writing into a
 * folder that does not exist fails, creating a folder that exists fails, listing a missing folder
 * fails, and every call takes a little (random) time, so races between parallel operations show
 * up here instead of on a phone.
 */
import fs from "node:fs";
import path from "node:path";
import type { AdapterLike } from "../src/vault-fs";

export interface FakeAdapterOptions {
  strict?: boolean;
  /** Filled in by the adapter: how many calls were in flight at once, at most. */
  stats?: { inFlight: number; peak: number; calls: number };
}

export function fakeAdapter(root: string, opts: FakeAdapterOptions = {}): AdapterLike {
  const strict = opts.strict ?? false;
  const stats = opts.stats;
  const rel = (p: string) => (p === "/" ? "" : p.replace(/^\/+/, ""));
  const abs = (p: string) => path.join(root, rel(p));
  // Every call "crosses the bridge": count it as in flight until the delay has passed, so the
  // caller's concurrency limit is observable.
  const delay = async () => {
    if (stats) {
      stats.calls++;
      stats.inFlight++;
      stats.peak = Math.max(stats.peak, stats.inFlight);
    }
    if (strict) await new Promise<void>((r) => setTimeout(r, Math.random() * 3));
    if (stats) stats.inFlight--;
  };
  const fail = (message: string) => {
    // The phone's adapter throws plain Errors (or strings) without an errno code.
    throw new Error(message);
  };
  return {
    async exists(p) {
      await delay();
      return fs.existsSync(abs(p));
    },
    async stat(p) {
      await delay();
      try {
        const s = fs.statSync(abs(p));
        return { type: s.isDirectory() ? "folder" : "file", ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async list(p) {
      await delay();
      if (strict && !fs.existsSync(abs(p))) fail(`Folder does not exist: ${p}`);
      const entries = fs.readdirSync(abs(p), { withFileTypes: true });
      const prefix = rel(p) ? `${rel(p)}/` : "";
      return {
        files: entries.filter((e) => e.isFile()).map((e) => `${prefix}${e.name}`),
        folders: entries.filter((e) => e.isDirectory()).map((e) => `${prefix}${e.name}`),
      };
    },
    async readBinary(p) {
      await delay();
      if (strict && !fs.existsSync(abs(p))) fail(`File does not exist: ${p}`);
      const b = fs.readFileSync(abs(p));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    async writeBinary(p, data) {
      await delay();
      if (strict) {
        if (!fs.existsSync(path.dirname(abs(p)))) fail(`Parent folder does not exist: ${p}`);
      } else {
        fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
      }
      fs.writeFileSync(abs(p), new Uint8Array(data));
    },
    async mkdir(p) {
      await delay();
      if (strict && fs.existsSync(abs(p))) fail(`Folder already exists: ${p}`);
      fs.mkdirSync(abs(p));
    },
    async remove(p) {
      await delay();
      if (strict && !fs.existsSync(abs(p))) fail(`File does not exist: ${p}`);
      fs.unlinkSync(abs(p));
    },
    async rmdir(p, recursive) {
      await delay();
      if (recursive) fs.rmSync(abs(p), { recursive: true, force: false });
      else fs.rmdirSync(abs(p));
    },
  };
}
