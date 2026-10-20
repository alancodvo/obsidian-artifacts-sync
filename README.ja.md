# Cloudflare Artifacts Sync（日本語の導入と使い方）

Obsidian の保管庫（またはその中の 1 フォルダ）を、Cloudflare Artifacts のリポジトリと同期するプラグインです。Artifacts は Cloudflare の「Git として読み書きできる保存場所」で、ノートに履歴がつき、端末の外にも控えが残ります。GitHub のアカウントも Git の知識も要りません。設定を 1 度入れたら、あとは **Sync now** を押すだけです。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-%E2%98%95-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/koiyal)

> English: [README.md](README.md)

- 動く環境: PC（Windows / Mac / Linux）と スマホ（iOS / Android）の Obsidian
- 必要なもの: Cloudflare のアカウント（Artifacts が使えるプラン。2026 年 10 月時点では Workers Paid）。プラグインの作者に払うものはありません
- 通信先: 設定した Artifacts の URL（ノートの中身を送る）と、準備とトークン更新のときだけ使う `api.cloudflare.com` の 2 つ。計測や広告はありません

---

## 1. インストール

設定 → コミュニティプラグイン → 「閲覧」→ **Cloudflare Artifacts Sync** で検索 → インストール → 有効化。PC でもスマホでも同じです（Obsidian 1.13 以上）。

掲載ページ: https://community.obsidian.md/plugins/cloudflare-artifacts-sync

---

## 2. Cloudflare 側で用意するもの（1 回だけ）

### アカウント ID

Cloudflare ダッシュボードの **Workers & Pages** を開くと、右側に「アカウント ID」（32 文字）があります。コピーしておきます。

### API トークン（プラグインがリポジトリを作ったり、期限つきの鍵を発行したりするのに使う）

1. ダッシュボード右上のアイコン → **マイプロフィール** → 左の **API トークン** → **トークンを作成**
2. 一番下の **カスタムトークンを作成** の「使用する」
3. 名前: 例 `Obsidian Artifacts Sync`
4. 権限: **アカウント** / **Artifacts** / **編集** の 1 行だけ
5. アカウントリソース: **含める** / 自分のアカウント
6. 「概要に進む」→「トークンを作成」→ 表示されたトークンをコピー（**この画面を閉じると二度と見られません**。1Password などに保存）

このトークンは「Artifacts を作ったり消したりできる鍵」です。ノートそのものを読み書きする鍵（リポジトリトークン）はプラグインが別に発行し、30 日で切れ、期限前に自動で更新します。

---

## 3. 1 台目の設定

設定 → Cloudflare Artifacts Sync を開き、上から順に入れます。

| 項目 | 入れるもの |
|---|---|
| **Account ID** | 2 のアカウント ID |
| **API token** | 2 の API トークン |
| **Namespace** | `default` のまま |
| **Repository name** | 空欄（保管庫の名前が使われます）か、好きな名前 |

**Set up** を押します。名前空間とリポジトリができ、Remote URL と Repository token が自動で埋まります。**この時点ではノートはまだ送られません。**

続けて **Sync now** を押すと、最初の同期が走り、ノートがリポジトリに上がります。Sync now は次のどこからでも押せます。

- 設定画面の一番上のボタン
- 左の帯（リボン）の更新アイコン
- 画面下のステータスバーの「Artifacts: …」の表示
- コマンドパレットの「Cloudflare Artifacts Sync: Sync now」

---

## 4. 2 台目（スマホや別の PC）で同じ保管庫を使う

**2 台目では Set up を押さないでください。** 保管庫の名前が違うと別のリポジトリができてしまいます。

1. 2 台目にプラグインを入れ、**Account ID・API token・Namespace** を 1 台目と同じ値にする
2. **Choose repository**（「Connect to an existing repository」）を押し、1 台目が作ったリポジトリを選ぶ。Remote URL とトークンは自動で入ります
3. **Branch** と **Folder to sync** を 1 台目と同じにする（ふつうは `main` と空欄）
4. **Sync now**

2 台目の最初の同期では、**リポジトリ側を正として**ノートを取り込みます。2 台目にすでにあったノートは、

- リポジトリに無いもの → そのまま残り、リポジトリに追加されます
- リポジトリにもあって中身が同じもの → 何も起きません
- リポジトリにもあって中身が違うもの → リポジトリ版が置かれ、2 台目にあった版は `<名前>.local-<日時>.md` として隣に残ります（これも同期されます）。消えるものはありません

### 端末を切り替えるときの決めごと

使い終わる端末で **Sync now** → 次の端末で **Sync now**。これだけです。忘れそうなら、両方の端末で「Automatic sync interval (minutes)」に 5〜15 を入れておくと自動で回ります。

---

## 5. ふだんの操作と設定

| 設定 | 意味 |
|---|---|
| **Automatic sync interval (minutes)** | 何分ごとに自動で同期するか。0 で自動なし |
| **Sync shortly after a note changes** | ノートを保存してから 30 秒後に自動で同期する |
| **Folder to sync** | 空欄なら保管庫全体。1 つのフォルダ名を入れると、そのフォルダだけ同期します。**スマホで大きな保管庫を扱うときは、ここで 1 フォルダに絞るのがおすすめ**（速くなります） |
| **Ignore** | 同期しないもの。既定で `.obsidian/`（設定）と `.trash/`（ゴミ箱）が入っています |
| **Name / Email** | 履歴に記録される名前。何でも構いません |
| **Show a notice after each sync** | 同期のたびに右上の通知を出すか |
| **Check settings** | 入れた値に不備が無いかだけ確認します（通信はしません） |

コマンドパレットには **Sync now**（コミット → 取り込み → 送信）のほかに、**Pull from Artifacts**（取り込みだけ）と **Push to Artifacts**（送信だけ）があります。

同期の中身は「変更したファイルをすべて記録 → 他の端末が送ったものを取り込む → 送る」です。同じノートを両方の端末で同時に変えていて機械的に合わせられないときは、上書きせずに止まって通知します（下の「困ったとき」）。

---

## 6. 困ったとき

### 通知の読み方

通知は「Cloudflare Artifacts Sync 0.4.3: syncing failed: 〜」の形で、〜の部分に原因が入ります。あわせて、保管庫の中の `.obsidian/plugins/cloudflare-artifacts-sync/last-error.txt` に全文が残ります（スマホでも Obsidian で開けます）。問い合わせるときはこのファイルを添えてください。

| 通知に出る言葉 | 意味と対処 |
|---|---|
| `Unable to resolve host` / `Request Failed` | 通信ができていない。Wi-Fi やモバイル通信を確かめる。スマホで画面を消した直後や、アプリを裏に回した直後にも起きます。画面をつけて Obsidian を前面にしてからもう一度 |
| `401` / `token has expired` | リポジトリトークンの期限切れ。API token が入っていれば **Renew** を押す（自動更新がふつうは効きます）。手で入れている場合は新しいトークンを貼る |
| `enter your 32-character account ID` | Account ID が空か形が違う |
| `The remote has changes that conflict with yours` | 両方の端末で同じノートを変えた。下の「衝突したとき」 |
| `N file operations failed while checking out the repository: …` | 取り込み中にファイル操作が失敗。〜の部分に失敗した操作とファイル名が出ます。もう一度 Sync now で通ることが多いです。続くなら `last-error.txt` を添えて連絡 |

### 衝突したとき

リポジトリ側が変えたノートを、自分も同じ時期に変えていた場合、プラグインは送信前に止まります。いちばん簡単な直し方は、

1. 自分の版のノートを別名でコピーしておく（例: 末尾に「_自分」）
2. 設定の一番下 **Reset local history (keep notes)** → **Reset** を 2 回（確認のため 2 回押します）。ノートは消えず、履歴だけ消えます
3. **Sync now**。リポジトリ版が入り、違っていたノートは `.local-<日時>` として残ります
4. 2 つを見比べて 1 つにまとめる

### 間違ったリポジトリに同期してしまった

**Choose repository** で正しいリポジトリにつなぎ直す → **Reset local history (keep notes)** → **Sync now**。余分なリポジトリはダッシュボード（Storage & databases → Artifacts）で消せます。

### 2 台目で Set up を押してしまった

上と同じです。1 台目が作ったリポジトリを **Choose repository** で選び直し、Reset → Sync now。

---

## 7. 用語

| 言葉 | 意味 |
|---|---|
| 名前空間（Namespace） | リポジトリを入れる箱。`default` で十分です |
| リポジトリ（Repository） | 1 つの保管庫（またはフォルダ）の履歴つきの置き場。ダッシュボードの Storage & databases → Artifacts に並びます |
| API トークン | Cloudflare の設定を変える鍵。プラグインがリポジトリを作る・鍵を発行するときだけ使う |
| リポジトリトークン | ノートを読み書きする鍵。30 日で切れ、API トークンがあれば自動更新 |
| `.git` フォルダ | 同期するフォルダの中にできる履歴のフォルダ。Obsidian からは見えません。消しても履歴がやり直されるだけでノートは消えません |

---

不具合や要望は [Issues](https://github.com/alancodvo/obsidian-artifacts-sync/issues) へ（日本語で構いません）。

## ライセンス

[MIT](LICENSE)。自由に使えます。著作権表示だけ残してください。Git の処理には [isomorphic-git](https://isomorphic-git.org/)（MIT）を使っています。Cloudflare 社・Obsidian 社とは関係のない個人開発（[KOIYAL](https://koiyal.com)・荒川善大）です。
