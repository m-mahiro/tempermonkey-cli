# tempermonkey-cli

Tampermonkey ユーザースクリプトをターミナルと AI エージェントから管理する CLI ツールです。

`tampermonkey-mcp`（Tampermonkey 公式）を介してブラウザ内の Tampermonkey と通信します。

---

## 前提条件

1. [Tampermonkey](https://www.tampermonkey.net/) をブラウザにインストール済み
2. [Tampermonkey Editors](https://chromewebstore.google.com/detail/tampermonkey-editors/aijkghbhbchojkjncojpfcdpjkkjkgfh) 拡張をインストール済み（WebSocket ブリッジ）
3. `tampermonkey-mcp` をインストール済み

```bash
npm install -g tampermonkey-mcp@latest
```

## インストール

```bash
git clone https://github.com/m-mahiro/tempermonkey-cli.git
cd tempermonkey-cli
npm link
```

## 初回接続

Tampermonkey Editors との接続を確立します。接続コードを取得して、Tampermonkey Editors 拡張の UI に入力してください。（接続は一度確立すると維持されます）

詳細は [docs/setup.md](docs/setup.md) を参照してください。

## コマンド

```bash
tm sync [dir]        # src/ と Tampermonkey を同期（新規インストール + 上書き更新）
tm watch [dir]       # ファイルを監視してホットリロード
tm status [dir]      # src/ と Tampermonkey の状態を比較表示
tm remove <name>     # Tampermonkey からスクリプトを削除
```

## 管理対象スクリプトの識別

`tm` は以下の条件を満たすスクリプトのみを操作対象とします。他所（Greasy Fork など）からインストールしたスクリプトには触れません。

- `@namespace` が `https://github.com/m-mahiro/userscripts` と一致する
- `@updateURL` が `https://raw.githubusercontent.com/m-mahiro/userscripts/` で始まる

## ライセンス

[MIT](LICENSE)
