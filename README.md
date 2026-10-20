# Cloudflare Artifacts Sync

Sync your Obsidian vault, or one folder of it, with a [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) repository. Artifacts is Cloudflare's versioned file store that speaks Git, so your notes get history and an off-device copy without a GitHub account.

One command (or a timer) does commit → pull → push. No Git knowledge is needed: paste a remote URL and a token, and press **Sync now**.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-%E2%98%95-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/koiyal)

> 日本語のドキュメントは [README.ja.md](README.ja.md) にあります（導入手順・使い方・困ったときの対処）。

Requires a Cloudflare account with Artifacts available (Workers Paid plan at the time of writing). Nothing else is required, and nothing is paid to the plugin author.

## What it does

- Commits every change in the chosen folder (new, modified and deleted files), pulls what others pushed, then pushes.
- Fast-forwards when it can and makes a merge commit otherwise. If the remote conflicts with your edits, it stops and tells you to resolve with a Git client (no data is overwritten).
- Optional automatic sync on a timer and shortly after a note changes.
- Ignores the `.obsidian` folder and trash by default (configurable).

## Network use

This plugin talks to two Cloudflare endpoints and nothing else:

- the Artifacts remote URL you configure (`https://<account>.artifacts.cloudflare.net/…`), where your note contents are pushed and pulled with the repository token;
- `https://api.cloudflare.com` with your Cloudflare API token, only when you press **Set up** or when a repository token is renewed.

There is no telemetry. Tokens are stored in this vault's plugin data (`.obsidian/plugins/cloudflare-artifacts-sync/data.json`), like other sync plugins store credentials.

## Setup (no command line needed)

1. Create a Cloudflare API token once: dashboard → **My profile → API tokens → Create token → Create custom token**, permission **Account / Artifacts / Edit**, scoped to your account. Copy the token. (Artifacts needs the Workers Paid plan; see Cloudflare's pricing.)
2. In Obsidian, install the plugin, open its settings and paste your **Account ID** and the **API token**. Leave the namespace as `default` and the repository name empty (the vault name is used), or choose your own.
3. Press **Set up**. The plugin creates the namespace and repository if needed, issues a 30-day write token and fills in the remote URL and token. Tokens are renewed automatically while the API token is present.
4. Press **Sync now** (the button at the top of the settings page, the refresh icon in the left ribbon, the **Artifacts** item in the status bar, or the command palette). Set up only prepares the repository; nothing is uploaded until the first sync. Optionally set an automatic sync interval.

If you prefer not to store an API token, you can instead paste a remote URL and a repository token by hand (from the dashboard or `wrangler artifacts repos issue-token`). You will then need to paste a new token when it expires.

## Using the same vault on a second device (phone or another computer)

Do **not** press Set up again: it would create a second repository when the vault names differ. Instead:

1. On the second device, enter the same **Account ID**, **API token** and **Namespace**.
2. Press **Choose repository** ("Connect to an existing repository") and pick the repository your first device created. The plugin issues a token for it and fills in the remote URL.
3. Set **Branch** and **Folder to sync** to the same values as on the first device (usually `main` and empty, or the one folder you chose).
4. Press **Sync now**. The notes come down from the repository; anything already on this device is committed on top. If a note exists on both sides with different content, the repository's version is put in place and the device's copy is kept next to it as `<name>.local-<timestamp>.md` (and synced too), so nothing is lost and you can merge by hand.

If a device has already synced to the wrong repository: connect it to the right one as above, press **Reset local history (keep notes)** in the Recovery section, then **Sync now**. The extra repository can be deleted in the dashboard (Storage & databases → Artifacts → the repository).

Rule of thumb: press Sync now before you leave a device and after you pick up the next one, or turn on the automatic sync interval on both.

## When two places edit the same note

If the remote changed a note that you also edited (or deleted) since your last sync, the plugin stops before pushing and shows a notice. Nothing is overwritten. Resolve it with any Git client (or copy the note aside, delete the folder's `.git`, sync again, and paste your version back). Automatic "keep both versions" handling is planned.

## When a sync fails

The notice names the underlying failure (not just "multiple errors"), and the full details, including every file operation that failed, are written to `.obsidian/plugins/cloudflare-artifacts-sync/last-error.txt` in the vault. On a phone, open that file in Obsidian (or any file manager) and send it along when reporting a problem.

## Desktop and mobile

- Desktop uses the vault's folder on disk with Node's file system (fast).
- Mobile (iOS and Android) uses Obsidian's own file access and `requestUrl`, so no Git client or Node is needed. The `.git` folder lives inside the synced folder; Obsidian hides it. Large vaults sync more slowly on a phone, so pick one folder to sync there.
- Both sides use the same Git engine (isomorphic-git), so a vault can be synced from a laptop and a phone alternately.

## Requirements and limits

- Repository size up to 1 GB and files up to 32 MB (Artifacts limits).
- Tokens expire; the settings page shows the remaining time, and they renew automatically when an API token is set.

## Development

```sh
npm install
npm run build     # type-check and bundle to main.js
npm test          # unit tests (pure logic, vault file system, requestUrl client, REST client)
# Opt-in checks against a real Artifacts repository:
ARTIFACTS_REMOTE=… ARTIFACTS_TOKEN=… npm run e2e          # desktop code path
ARTIFACTS_REMOTE=… ARTIFACTS_TOKEN=… npm run e2e:mobile   # mobile code path (adapter fs + requestUrl)
ARTIFACTS_REMOTE=… ARTIFACTS_TOKEN=… npm run e2e:bundle   # the built main.js in simulated desktop and mobile Obsidian
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run e2e:api   # REST client: namespace, repo, token, push
```

Issues and pull requests are welcome in English or Japanese.

## License

[MIT](LICENSE). In short: use it freely, keep the copyright notice. Built on
[isomorphic-git](https://isomorphic-git.org/) (MIT). Not affiliated with Cloudflare or Obsidian.
