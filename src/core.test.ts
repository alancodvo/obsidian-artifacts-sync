import { describe, expect, it } from "vitest";
import {
  DEFAULT_IGNORE,
  defaultIgnore,
  authFor,
  commitMessage,
  inspectToken,
  isIgnored,
  parseArtifactsRemote,
  planChanges,
  tokenStatus,
  validateSettings,
  type StatusRow,
} from "./core";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const REMOTE = `https://${ACCOUNT}.artifacts.cloudflare.net/git/default/my-vault.git`;

describe("parseArtifactsRemote", () => {
  it("accepts the canonical remote and normalizes variants", () => {
    const parsed = parseArtifactsRemote(REMOTE);
    expect(parsed).toEqual({ accountId: ACCOUNT, namespace: "default", repo: "my-vault", url: REMOTE });
    expect(parseArtifactsRemote(` ${REMOTE.replace(/\.git$/, "")}/ `)?.url).toBe(REMOTE);
  });

  it("rejects other hosts and malformed paths", () => {
    expect(parseArtifactsRemote("https://github.com/x/y.git")).toBeNull();
    expect(parseArtifactsRemote(`https://${ACCOUNT}.artifacts.cloudflare.net/git/default`)).toBeNull();
    expect(parseArtifactsRemote("")).toBeNull();
  });
});

describe("tokens", () => {
  it("reads the expiry from the token suffix", () => {
    const t = inspectToken("art_v2_x_abc123?expires=1791714567");
    expect(t.looksValid).toBe(true);
    expect(t.expiresAt).toBe(1791714567000);
    expect(inspectToken("art_v1_abc").expiresAt).toBeNull();
    expect(inspectToken("ghp_notartifacts").looksValid).toBe(false);
  });

  it("reports expired and remaining time", () => {
    const token = "art_v2_x_abc?expires=1000";
    expect(tokenStatus(token, 999_000)).toEqual({ expired: false, remainingMs: 1000 });
    expect(tokenStatus(token, 1_000_000)).toEqual({ expired: true, remainingMs: 0 });
    expect(tokenStatus("art_v1_abc", 5)).toEqual({ expired: false, remainingMs: null });
  });

  it("uses basic auth with the token as the password", () => {
    expect(authFor(" art_v2_x_abc ")).toEqual({ username: "x", password: "art_v2_x_abc" });
  });
});

describe("isIgnored", () => {
  it("ignores the Obsidian config folder and trash anywhere", () => {
    expect(isIgnored(".obsidian/workspace.json", defaultIgnore(".obsidian"))).toBe(true);
    expect(isIgnored("notes/.trash/old.md", defaultIgnore(".obsidian"))).toBe(true);
    expect(isIgnored("notes/.DS_Store", defaultIgnore(".obsidian"))).toBe(true);
    expect(isIgnored("notes/today.md", defaultIgnore(".obsidian"))).toBe(false);
  });

  it("matches exact relative paths and plain names", () => {
    expect(isIgnored("secret/keys.md", ["secret/keys.md"])).toBe(true);
    expect(isIgnored("a/b/keys.md", ["keys.md"])).toBe(true);
    expect(isIgnored("a/b/notes.md", ["keys.md", ""])).toBe(false);
  });
});

describe("planChanges", () => {
  it("adds new and modified files, removes deleted ones, skips ignored", () => {
    const rows: StatusRow[] = [
      ["new.md", 0, 2, 0],
      ["modified.md", 1, 2, 1],
      ["unchanged.md", 1, 1, 1],
      ["deleted.md", 1, 0, 1],
      [".obsidian/app.json", 0, 2, 0],
    ];
    expect(planChanges(rows, defaultIgnore(".obsidian"))).toEqual({ add: ["new.md", "modified.md"], remove: ["deleted.md"] });
  });
});

describe("commitMessage and validateSettings", () => {
  it("writes a sentence-case summary", () => {
    expect(commitMessage(2, 1, new Date("2026-10-10T00:00:00Z"))).toBe("Vault sync: 2 changed, 1 removed (2026-10-10T00:00:00.000Z)");
    expect(commitMessage(0, 0, new Date("2026-10-10T00:00:00Z"))).toContain("no file changes");
  });

  it("lists every problem with the settings", () => {
    expect(validateSettings({ remoteUrl: REMOTE, token: "art_v2_x_abc?expires=1", branch: "main", syncFolder: "Knowledge" })).toEqual([]);
    const problems = validateSettings({ remoteUrl: "https://github.com/x/y", token: "nope", branch: "bad..", syncFolder: "../out" });
    expect(problems).toHaveLength(4);
  });
});
