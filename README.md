# tampermonkey-cli

手元のTampermonkeyユーザースクリプトを、`file://`によるホットリロードでインストールするためのCLI（`tm`コマンド）。個人用。

## 仕組み

`tm install` は、渡された `.user.js` のメタデータブロックをそのまま使い、本体を `@require file:///絶対パス` に差し替えた「スタブ」を生成してブラウザで開くだけ。Tampermonkey純正のインストール/更新ダイアログが出るので手動でクリックする。

`@require file://` は毎ページロードでファイルを読み直す。つまり**保存すれば次のロードで即反映される**。ウォッチプロセスもpushの仕組みも要らない。

スタブからは`@updateURL` / `@downloadURL`を取り除く。残すとTMの自動更新がリモート（GitHub）のファイルでスタブを丸ごと上書きし、`@require file://`が消えて即反映が黙って効かなくなるため。元ファイル側の記述はそのまま残す。

## 前提条件

Tampermonkeyの拡張機能設定で「ファイルURLへのアクセスを許可」を有効化しておくこと。

## コマンド

```bash
tm install <file...>   # 指定した .user.js をインストール導線に乗せる（ワイルドカード可）
tm pull [--dry-run]    # 上流をpullし、新規／メタデータ変更のあった.user.jsだけインストールする
tm list                # Tampermonkeyの管理画面をブラウザで開く
```

`tm pull` は`userscripts`のようなリポジトリ内で`git pull`の代わりに使う。`--dry-run`でpullせず、何が入れ直し対象かだけを見られる。再インストールが要るのは新規ファイルと、次のキーが変わったファイルのみ（`@version`や`@description`だけの変更、本体のみの変更では要らない）。削除されたスクリプトは`tm`では消せないので、一覧に出た名前をTMの管理画面から手動で削除する。

対象キー: `@name` `@namespace` `@match` `@include` `@exclude` `@grant` `@run-at` `@noframes` `@connect` `@sandbox` `@require` `@resource`

```bash
tm install src/foo.user.js     # 1本だけ
tm install src/*.user.js       # 複数本（シェルのワイルドカード展開に依存）
tm install --dev src/foo.user.js   # 開発用フラグ付き
```

同じ`@name`のファイルを`tm install`すると、後から入れた方が先のスタブを上書きする（スタブのファイル名は`@name`から決まり、元ファイルのパスからは決まらないため）。ブラウザ側でも、TMが同じ`@name`のスクリプトを既存の更新として扱うので、既に入っているスクリプトが上書きされる。別のworktreeや別のディレクトリで同名のファイルを入れるときは、元の版が置き換わることに注意する。

### `--dev`（デバッグログなどを開発者だけ有効にする）

スクリプト側でこう書いておく。

```js
const DEV_MODE = globalThis.__TM_DEV__ ?? false;
```

`tm install --dev`は、元ファイルの前に`globalThis.__TM_DEV__ = true`だけを実行する[dev-flag.js](dev-flag.js)を`@require`したスタブを作る。元ファイルは書き換えないので、`--dev`でも保存即反映は変わらない。`--dev`なしで入れ直せば本番（`DEV_MODE = false`）に戻る。`tm pull --dev`でも使える。

`dev-flag.js`は、ページを開くたびにTMが読みに行く。移動・削除すると`--dev`で入れたスクリプトが読み込みに失敗するので、`tampermonkey-cli`を動かしたら`npm link`とあわせて`--dev`のスクリプトも入れ直すこと。

## 持っていない機能とその理由

- **watch（自動反映）** → `@require file://` が保存即反映を担うので不要。
- **push型sync / remove（TMへの直接書き込み・削除）** → TMへの書き込みは常にTM純正のインストールダイアログを手動で通す設計にしたため、CLIから直接書き換える経路自体がない。削除はTMの管理画面（`tm list`で開ける）から手動で行う。
- **src⇔TMの内容diff** → 中身は`@require`が常に最新を読むので比較する意味がない。「TMに何が入っているか」を見たいだけなら`tm list`で管理画面を開けば足りる。
- **メタデータ変更の検知（状態管理）** → `@match` / `@grant` など、TM側のスタブに焼き付くメタデータを変更した場合は`tm install`を打ち直して再インストールしないと反映されない。これを自動検知する仕組みは意図的に持たせていない（新規追加が主な使い方であり、既存スクリプトのメタデータ変更は頻度が低いため投資対効果が低いと判断）。打ち忘れると`@match`のズレ等に気づきにくいので注意。

## 設計判断

- **MCPブリッジ（`tampermonkey-mcp` + Tampermonkey Editors拡張）は使わない** → `file://`方式なら書き込み経路そのものが不要で、拡張の追加インストールや接続コードの手順ごと消せるため。旧版はこの経路でpush/watch/syncをしていた。
- **GitHub上のファイルを真にしない** → リモートの`@require`はTMがキャッシュするので保存即反映が失われ、更新にはpushとTM側の再取得が要る。手元のファイルが真で、gitは履歴管理にすぎない。他人への配布が必要になったら、別モードとして後から足す。
- **AIエージェント向けの入口は持たない** → このCLIは人間専用。AIにTMを触らせたい場合は`tampermonkey-mcp`を直接使う（`claude mcp add --scope user`で登録済み）。
- **ブラウザはChrome/Edgeの実行ファイルを直接起動する** → `.user.js`にはWindowsのファイル関連付けがなく、`chrome-extension://`もOSのプロトコルとして登録されていないため、`start`にURLを渡すと「開けるアプリがありません」になる。

## セットアップ

```bash
npm link
```

`tm` コマンドがグローバルに使えるようになる。
