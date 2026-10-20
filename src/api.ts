/**
 * Minimal client for the Cloudflare Artifacts REST API (control plane), used so people never need
 * a command line: create the namespace and repository, and issue repository tokens.
 *
 * Authentication: a Cloudflare API token with the "Artifacts" permission (Read and Edit) for the
 * account. It is only ever sent to api.cloudflare.com.
 */

export interface ApiClientOptions {
  accountId: string;
  apiToken: string;
  /** The HTTP function to use: the plugin passes one built on Obsidian's requestUrl; scripts and tests pass their own. */
  fetchImpl: typeof fetch;
  baseUrl?: string;
}

export interface RepoInfo {
  name: string;
  remote: string;
}

export interface IssuedToken {
  /** The secret, including the `?expires=` suffix when the API returns one. */
  token: string;
  expiresAt: number | null;
}

/** A JSON field as text: strings as they are, numbers and booleans spelled out, anything else empty. */
function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

export class ArtifactsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ArtifactsApiError";
  }
}

type Json = Record<string, unknown>;

/** Extract the token string from the several shapes the API and wrangler have used. */
export function pickToken(result: Json): string | null {
  for (const key of ["token", "plaintext", "value", "secret"]) {
    const v = result[key];
    if (typeof v === "string" && v.startsWith("art_")) return v;
  }
  return null;
}

/** Extract an expiry (unix ms) from a result object or from the token's `?expires=` suffix. */
export function pickExpiry(result: Json, token: string | null): number | null {
  const fromToken = token ? /\?expires=(\d+)$/.exec(token) : null;
  if (fromToken) return Number(fromToken[1]) * 1000;
  for (const key of ["expires_at", "expiresAt", "expires"]) {
    const v = result[key];
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string") {
      const n = Date.parse(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

export class ArtifactsApi {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: ApiClientOptions) {
    // The plugin passes a client built on Obsidian's requestUrl (works on mobile and is not bound to
    // a window); scripts and tests pass their own. There is no global default on purpose.
    this.fetchImpl = opts.fetchImpl;
    this.baseUrl = (opts.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  }

  private async call(method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
    const res = await this.fetchImpl(`${this.baseUrl}/accounts/${this.opts.accountId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.apiToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // keep empty
    }
    if (!res.ok || json.success === false) {
      const errors = Array.isArray(json.errors) ? (json.errors as Json[]).map((e) => `${str(e.code)} ${str(e.message)}`.trim()) : [];
      throw new ArtifactsApiError(errors.join("; ") || `HTTP ${res.status}`, res.status);
    }
    return (json.result as Json) ?? {};
  }

  /** Verify the token works for this account (cheap list call). */
  async listNamespaces(): Promise<string[]> {
    const result = await this.call("GET", "/artifacts/namespaces");
    const items = Array.isArray(result) ? (result as Json[]) : Array.isArray(result.namespaces) ? (result.namespaces as Json[]) : [];
    return items.map((n) => str(n.namespace) || str(n.name)).filter(Boolean);
  }

  async ensureNamespace(namespace: string): Promise<void> {
    try {
      await this.call("POST", "/artifacts/namespaces", { namespace });
    } catch (err) {
      // Already exists is fine.
      if (err instanceof ArtifactsApiError && (err.status === 409 || /exist/i.test(err.message))) return;
      throw err;
    }
  }

  /** Repositories in a namespace (so a second device can pick the one the first device created). */
  async listRepos(namespace: string): Promise<RepoInfo[]> {
    const result = await this.call("GET", `/artifacts/namespaces/${encodeURIComponent(namespace)}/repos`);
    const items = Array.isArray(result) ? (result as Json[]) : Array.isArray(result.repos) ? (result.repos as Json[]) : [];
    return items.map((r) => ({ name: str(r.name), remote: str(r.remote) })).filter((r) => r.name);
  }

  async getRepo(namespace: string, name: string): Promise<RepoInfo | null> {
    try {
      const result = await this.call("GET", `/artifacts/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(name)}`);
      return { name: str(result.name) || name, remote: str(result.remote) };
    } catch (err) {
      if (err instanceof ArtifactsApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Create the repository (idempotent: returns the existing one when it is already there). */
  async ensureRepo(namespace: string, name: string, defaultBranch = "main"): Promise<RepoInfo> {
    const existing = await this.getRepo(namespace, name);
    if (existing && existing.remote) return existing;
    const result = await this.call("POST", `/artifacts/namespaces/${encodeURIComponent(namespace)}/repos`, {
      name,
      "default-branch": defaultBranch,
    });
    return { name: str(result.name) || name, remote: str(result.remote) };
  }

  /** Issue a repository-scoped token. ttlSeconds defaults to 30 days. */
  async issueToken(namespace: string, repo: string, scope: "read" | "write" = "write", ttlSeconds = 30 * 24 * 3600): Promise<IssuedToken> {
    const result = await this.call("POST", `/artifacts/namespaces/${encodeURIComponent(namespace)}/tokens`, { repo, scope, ttl: ttlSeconds });
    const raw = pickToken(result);
    if (!raw) throw new ArtifactsApiError("The API did not return a token.", 200);
    const expiresAt = pickExpiry(result, raw);
    // The API returns the bare secret plus `expires_at`; wrangler appends `?expires=<unix>` so the
    // expiry travels with the token. Artifacts accepts both, so store the suffixed form.
    const token = raw.includes("?expires=") || expiresAt === null ? raw : `${raw}?expires=${Math.floor(expiresAt / 1000)}`;
    return { token, expiresAt };
  }
}

/** A repository name derived from a vault name: lowercase, letters, digits, dots, dashes and underscores. */
export function repoNameFromVault(vaultName: string): string {
  const slug = vaultName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 60);
  return slug || "obsidian-vault";
}
