# セットアップガイド

## 1. 前提条件のインストール

### Tampermonkey

[Tampermonkey 公式サイト](https://www.tampermonkey.net/) からブラウザに合ったバージョンをインストールします。

### Tampermonkey Editors

`tm` は Tampermonkey Editors 拡張を WebSocket ブリッジとして使います。

- [Chrome 版](https://chromewebstore.google.com/detail/tampermonkey-editors/aijkghbhbchojkjncojpfcdpjkkjkgfh)
- Firefox 版: Tampermonkey 公式サイトを参照

### tampermonkey-mcp

```bash
npm install -g tampermonkey-mcp@latest
```

---

## 2. tempermonkey-cli のインストール

```bash
git clone https://github.com/m-mahiro/tempermonkey-cli.git
cd tempermonkey-cli
npm link
```

`tm --help` でコマンド一覧が表示されれば成功です。

---

## 3. Tampermonkey Editors との初回接続

`tm` を初めて使う前に、Tampermonkey Editors との接続を確立する必要があります。

```bash
tm connect
```

ターミナルに表示される接続コードを、ブラウザの Tampermonkey Editors 拡張の接続フォームに入力してください。接続は一度確立すると維持されます。

---

## 4. 動作確認

```bash
# userscripts リポジトリを clone
git clone https://github.com/m-mahiro/userscripts.git
cd userscripts

# Tampermonkey と同期
tm sync

# 状態を確認
tm status
```

---

## コマンドリファレンス

| コマンド | 説明 |
|---------|------|
| `tm sync [dir]` | `src/` と Tampermonkey を同期。デフォルトは `../src` |
| `tm watch [dir]` | ファイルを監視してホットリロード。起動時に sync も実行 |
| `tm status [dir]` | `src/` と TM の状態を比較表示（synced / not installed / TM only） |
| `tm remove <name>` | 確認後に TM からスクリプトを削除 |

## 環境変数

| 変数 | 説明 |
|------|------|
| `TM_DEBUG=1` | MCP のデバッグログを stderr に表示 |
