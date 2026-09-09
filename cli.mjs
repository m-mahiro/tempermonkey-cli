#!/usr/bin/env node
/**
 * tm — Tampermonkey ユーザースクリプト インストール CLI
 * https://github.com/m-mahiro/tempermonkey-cli
 *
 * コマンド:
 *   tm install <file...>   指定した .user.js をインストール導線に乗せる（ワイルドカード可）
 *   tm list                Tampermonkey の管理画面をブラウザで開く
 *
 * 仕組み:
 *   指定ファイルのメタデータブロックはそのまま、本体を
 *   `@require file:///絶対パス` に差し替えた「スタブ」を生成してブラウザで開く。
 *   Tampermonkey 純正のインストール/更新ダイアログが出るので手動でクリックする。
 *   @require は毎ページロードでファイルを読み直すため、保存すれば次のロードで即反映される。
 *
 * 前提条件:
 *   Tampermonkey 拡張の設定で「ファイル URL へのアクセスを許可」を有効化しておくこと。
 */

import { spawn }                      from 'child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, basename, join }    from 'path';
import { pathToFileURL }              from 'url';
import { tmpdir }                     from 'os';

// Tampermonkey（Chrome ウェブストア版）の固定拡張ID
const TM_DASHBOARD_URL = 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=tabs';

const STUB_DIR = join(tmpdir(), 'tempermonkey-cli-stubs');

// ── ユーティリティ ────────────────────────────────────────────────────────────

/** UserScript メタデータブロック（==UserScript==〜==/UserScript==）を丸ごと抜き出す */
function extractMetaBlock(src) {
  const m = src.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
  return m ? m[0] : null;
}

/** メタデータブロックから特定のディレクティブの値を1つ取り出す（例: name, namespace） */
function getMetaValue(metaBlock, key) {
  const m = metaBlock.match(new RegExp(`^//\\s*@${key}\\s+(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** ファイル名として安全な文字列に変換する */
function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/**
 * インストーラースタブの内容を生成する。
 * 元のメタデータブロックはそのまま維持し、`==/UserScript==` の直前に
 * 実体ファイルへの @require を1行差し込む。
 */
function buildStub(absPath, metaBlock) {
  const requireUrl = pathToFileURL(absPath).href;
  const injected = metaBlock.replace(
    /\/\/ ==\/UserScript==/,
    `// @require     ${requireUrl}\n// ==/UserScript==`
  );
  return injected + '\n';
}

/** スタブファイルを一時ディレクトリに書き出し、そのパスを返す */
function writeStub(name, content) {
  mkdirSync(STUB_DIR, { recursive: true });
  const stubPath = join(STUB_DIR, `${safeFileName(name)}.user.js`);
  writeFileSync(stubPath, content, 'utf8');
  return stubPath;
}

/** 指定URLを既定のブラウザで開く（OSごとに手段を切り替え） */
function openInBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  let child;
  if (process.platform === 'win32') {
    // `start` はコマンド解釈上、第一引数をウィンドウタイトルとして扱うため空文字を挟む
    child = spawn('cmd', ['/c', 'start', '""', url], opts);
  } else if (process.platform === 'darwin') {
    child = spawn('open', [url], opts);
  } else {
    child = spawn('xdg-open', [url], opts);
  }
  child.unref();
}

// ── コマンド実装 ─────────────────────────────────────────────────────────────

const commands = {

  /**
   * tm install <file...>
   * 各ファイルについてインストーラースタブを生成し、ブラウザで開く。
   */
  async install(args) {
    if (!args.length) {
      console.error('使い方: tm install <file...>');
      console.error('  例: tm install src/foo.user.js');
      console.error('  例: tm install src/*.user.js');
      process.exit(1);
    }

    let failed = 0;
    for (const filePath of args) {
      const absPath = resolve(filePath);

      let src;
      try {
        src = readFileSync(absPath, 'utf8');
      } catch {
        console.error(`❌ 読み込み失敗: ${filePath}`);
        failed++;
        continue;
      }

      const metaBlock = extractMetaBlock(src);
      if (!metaBlock) {
        console.error(`❌ UserScript メタデータブロックが見つかりません: ${filePath}`);
        failed++;
        continue;
      }

      const name     = getMetaValue(metaBlock, 'name') ?? basename(absPath, '.user.js');
      const stub     = buildStub(absPath, metaBlock);
      const stubPath = writeStub(name, stub);
      const stubUrl  = pathToFileURL(stubPath).href;

      console.log(`📦 ${name}`);
      console.log(`   ${stubUrl}`);
      openInBrowser(stubUrl);
    }

    if (failed) process.exit(1);
  },

  /**
   * tm list
   * Tampermonkey の管理画面をブラウザで開く。
   */
  async list() {
    console.log(`🔍 Tampermonkey 管理画面を開きます: ${TM_DASHBOARD_URL}`);
    openInBrowser(TM_DASHBOARD_URL);
  },
};

// ── エントリポイント ──────────────────────────────────────────────────────────

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
tm — Tampermonkey ユーザースクリプト インストール CLI

使い方:
  tm install <file...>   指定した .user.js をインストール導線に乗せる（ワイルドカード可）
  tm list                 Tampermonkey の管理画面をブラウザで開く

オプション:
  -h, --help              このヘルプを表示

前提条件:
  Tampermonkey 拡張の設定で「ファイル URL へのアクセスを許可」を有効化してください。

詳細: https://github.com/m-mahiro/tempermonkey-cli
    `);
    process.exit(0);
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`不明なコマンド: ${cmd}`);
    console.error('tm --help で使い方を確認してください');
    process.exit(1);
  }

  await handler(args);
}

main();
