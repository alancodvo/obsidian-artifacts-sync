/**
 * Pure logic shared by the plugin and its tests: nothing here touches Obsidian, the file system
 * or the network.
 */

/** A Cloudflare Artifacts remote, e.g. https://<account>.artifacts.cloudflare.net/git/<ns>/<repo>.git */
export interface ArtifactsRemote {
  accountId: string;
  namespace: string;
  repo: string;
  url: string;
}

const REMOTE_PATTERN =
  /^https:\/\/([0-9a-f]{32})\.artifacts\.cloudflare\.net\/git\/([A-Za-z0-9][A-Za-z0-9._-]{1,62})\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/;

/** Parse and normalize an Artifacts remote URL. Returns null when it is not an Artifacts remote. */
export function parseArtifactsRemote(input: string): ArtifactsRemote | null {
  const trimmed = input.trim();
  const m = REMOTE_PATTERN.exec(trimmed);
  if (!m) return null;
  const [, accountId, namespace, repo] = m;
  return {
    accountId,
    namespace,
    repo,
    url: `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`,
  };
}

/** Artifacts tokens look like `art_v2_x_<hex>?expires=<unix seconds>`. */
export interface TokenInfo {
  /** Unix milliseconds, or null when the token carries no expiry. */
  expiresAt: number | null;
  /** True when the string looks like an Artifacts token at all. */
  looksValid: boolean;
}

export function inspectToken(token: string): TokenInfo {
  const t = token.trim();
  const looksValid = /^art_v\d+_[A-Za-z0-9_-]+(\?expires=\d+)?$/.test(t);
  const m = /\?expires=(\d+)$/.exec(t);
  return { looksValid, expiresAt: m ? Number(m[1]) * 1000 : null };
}

/** Human-readable remaining lifetime of a token; null when it never expires. */
export function tokenStatus(token: string, now: number): { expired: boolean; remainingMs: number | null } {
  const { expiresAt } = inspectToken(token);
  if (expiresAt === null) return { expired: false, remainingMs: null };
  return { expired: expiresAt <= now, remainingMs: Math.max(0, expiresAt - now) };
}

/** Basic auth as Artifacts accepts it: any username, the token as password. */
export function authFor(token: string): { username: string; password: string } {
  return { username: "x", password: token.trim() };
}

/** Default paths never sent to the remote (vault-relative, forward slashes). */
/**
 * Ignored by default, besides the vault's config folder: that one is added at load time from
 * `vault.configDir` (the user can rename it), see `defaultIgnore`.
 */
export const DEFAULT_IGNORE = [".trash/", ".DS_Store", "node_modules/"];

/** The full default ignore list for a vault whose config folder is `configDir`. */
export function defaultIgnore(configDir: string): string[] {
  return [`${configDir.replace(/\/+$/, "")}/`, ...DEFAULT_IGNORE];
}

/**
 * Whether a vault-relative path is excluded. A pattern ending in "/" matches a directory and
 * everything under it; otherwise the pattern matches a file name anywhere in the tree or an
 * exact relative path.
 */
export function isIgnored(path: string, patterns: readonly string[]): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const name = p.split("/").pop() ?? p;
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\\/g, "/");
    if (!pattern) continue;
    if (pattern.endsWith("/")) {
      const dir = pattern.replace(/^\/+/, "");
      if (p === dir.slice(0, -1) || p.startsWith(dir)) return true;
      if (p.includes(`/${dir}`)) return true;
    } else if (p === pattern.replace(/^\/+/, "") || name === pattern) {
      return true;
    }
  }
  return false;
}

/** One row of isomorphic-git's statusMatrix: [filepath, HEAD, WORKDIR, STAGE]. */
export type StatusRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];

/** Files to `add` and to `remove` so the index mirrors the working tree. */
export function planChanges(rows: readonly StatusRow[], ignore: readonly string[]): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const [filepath, head, workdir, stage] of rows) {
    if (isIgnored(filepath, ignore)) continue;
    if (workdir === 0 && (head === 1 || stage !== 0)) {
      remove.push(filepath);
    } else if (workdir === 2 || (workdir === 1 && stage === 0) || (workdir === 1 && head === 0)) {
      add.push(filepath);
    }
  }
  return { add, remove };
}

/** Commit message for an automatic sync, in sentence case. */
export function commitMessage(added: number, removed: number, when: Date): string {
  const parts: string[] = [];
  if (added) parts.push(`${added} changed`);
  if (removed) parts.push(`${removed} removed`);
  const summary = parts.length ? parts.join(", ") : "no file changes";
  return `Vault sync: ${summary} (${when.toISOString()})`;
}

/** Validate settings before touching the network. Returns a list of problems (empty = ok). */
export function validateSettings(s: { remoteUrl: string; token: string; branch: string; syncFolder: string }): string[] {
  const problems: string[] = [];
  if (!parseArtifactsRemote(s.remoteUrl)) {
    problems.push("Remote URL must look like https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git");
  }
  const token = inspectToken(s.token);
  if (!token.looksValid) problems.push("Token must be an Artifacts repository token (art_…)");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s.branch) || s.branch.includes("..") || /[/.]$/.test(s.branch)) {
    problems.push("Branch name is not valid");
  }
  if (/^\.\.|\/\.\.|^\/|\\/.test(s.syncFolder)) problems.push("Sync folder must be a folder inside the vault");
  return problems;
}
