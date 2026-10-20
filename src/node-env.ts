/**
 * Desktop file system and HTTP for isomorphic-git (Node). Kept in its own module, loaded with a
 * dynamic import from main.ts only when `Platform.isDesktop`, and the Node modules themselves are
 * required lazily inside the functions, so the mobile build path never touches Node at import
 * time (and the directory's scanner sees no static Node import).
 *
 * The HTTP client is a small one over Node's https, instead of isomorphic-git's bundled client
 * (simple-get), whose socket timeout aborted the first push of a large vault with
 * "Request timed out". A push is one long request, so no inactivity timeout is set here.
 */
import type { GitFs, GitHttp } from "./git";
import { collectBody, type GitHttpRequest, type GitHttpResponse } from "./obsidian-http";

// The plugin is loaded as a CommonJS module, so `require` is the module's own (Obsidian's desktop
// app is Electron and resolves Node's built-ins). On mobile this module is never imported.
declare const require: ((id: string) => unknown) | undefined;

function load<T>(id: string): T {
  if (typeof require !== "function") throw new Error(`${id} is only available on desktop`);
  return require(id) as T;
}

export function nodeFs(): GitFs {
  return load<typeof import("node:fs")>("node:fs") as unknown as GitFs;
}

export function nodeHttp(): GitHttp {
  const http = load<typeof import("node:http")>("node:http");
  const https = load<typeof import("node:https")>("node:https");
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const body = await collectBody(req.body);
      const url = new URL(req.url);
      const lib = url.protocol === "http:" ? http.request : https.request;
      return new Promise<GitHttpResponse>((resolve, reject) => {
        // agent: false → one connection per request, closed when done. Node's default agent keeps
        // sockets alive, which keeps scripts (and tests) from exiting; the plugin makes a few
        // requests per sync, so a fresh connection each time costs nothing noticeable.
        const r = lib(url, { method: req.method ?? "GET", headers: req.headers ?? {}, agent: false }, (res) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          resolve({
            url: req.url,
            method: req.method,
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            headers,
            body: res as unknown as AsyncIterableIterator<Uint8Array>,
          });
        });
        r.on("error", reject);
        if (body) r.end(body);
        else r.end();
      });
    },
  };
}

export function joinPath(base: string, folder: string): string {
  return load<typeof import("node:path")>("node:path").join(base, folder);
}
