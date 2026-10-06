#!/usr/bin/env node
/**
 * tm — Tampermonkey ユーザースクリプト インストール CLI
 * https://github.com/m-mahiro/tampermonkey-cli
 *
 * コマンド:
 *   tm install [--dev] <file...>   指定した .user.js をインストール導線に乗せる（ワイルドカード可）
 *   tm pull [--dry-run] [--dev]    上流を pull し、新規／メタデータ変更のあった .user.js だけインストールする
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

import { spawn, spawnSync }           from 'child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, basename, join }    from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { tmpdir }                     from 'os';

// Tampermonkey（Chrome ウェブストア版）の固定拡張ID
const TM_DASHBOARD_URL = 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=tabs';

const STUB_DIR = join(tmpdir(), 'tampermonkey-cli-stubs');

// --dev 時にスタブへ足す、`globalThis.__TM_DEV__ = true` だけのファイル。
// ページを開くたびに読まれるため、掃除される一時ディレクトリではなくここに置く。
const DEV_FLAG_PATH = fileURLToPath(new URL('./dev-flag.js', import.meta.url));

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
 * 元のメタデータブロックを維持し、`==/UserScript==` の直前に
 * 実体ファイルへの @require を1行差し込む。
 * ただし @updateURL / @downloadURL は除く。残すと TM の自動更新が
 * スタブをリモートのファイルで上書きし、@require file:// が消えてしまうため。
 * dev のときは、実体ファイルより前に開発フラグ用ファイルを @require する
 * （@require は書かれた順に実行されるので、実体側で __TM_DEV__ を参照できる）。
 */
function buildStub(absPath, metaBlock, dev = false) {
  const requireUrls = [];
  if (dev) requireUrls.push(pathToFileURL(DEV_FLAG_PATH).href);
  requireUrls.push(pathToFileURL(absPath).href);
  const requireLines = requireUrls.map(u => `// @require     ${u}`).join('\n');

  const withoutUpdateUrls = metaBlock.replace(
    /^[ \t]*\/\/\s*@(?:updateURL|downloadURL)\b.*(?:\r?\n)?/gm,
    ''
  );
  const injected = withoutUpdateUrls.replace(
    /\/\/ ==\/UserScript==/,
    () => `${requireLines}\n// ==/UserScript==`
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

// Windows でよく使われる Chromium 系ブラウザの既定インストール先
const WIN_BROWSER_CANDIDATES = [
  [process.env.ProgramFiles,          'Google\\Chrome\\Application\\chrome.exe'],
  [process.env['ProgramFiles(x86)'],  'Google\\Chrome\\Application\\chrome.exe'],
  [process.env.LOCALAPPDATA,          'Google\\Chrome\\Application\\chrome.exe'],
  [process.env.ProgramFiles,          'Microsoft\\Edge\\Application\\msedge.exe'],
  [process.env['ProgramFiles(x86)'],  'Microsoft\\Edge\\Application\\msedge.exe'],
];

function findWindowsBrowser() {
  for (const [base, rel] of WIN_BROWSER_CANDIDATES) {
    if (!base) continue;
    const path = join(base, rel);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * 指定URLをブラウザで開く。
 *
 * Windows では `.user.js` にファイル関連付けがなく、`chrome-extension://` も
 * OSレベルのプロトコルハンドラーとして登録されていないため、`start` に
 * URLを渡すだけでは「開けるアプリがありません」という警告になる。
 * ブラウザの実行ファイルへ直接URLを渡すことでOSの関連付け解決を迂回する。
 */
function openInBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  let child;
  if (process.platform === 'win32') {
    const browser = findWindowsBrowser();
    if (browser) {
      child = spawn(browser, [url], opts);
    } else {
      console.error('⚠️  Chrome / Edge が既定の場所に見つかりませんでした。手動でブラウザを開いて上記URLにアクセスしてください。');
      // `start` はコマンド解釈上、第一引数をウィンドウタイトルとして扱うため空文字を挟む
      child = spawn('cmd', ['/c', 'start', '""', url], opts);
    }
  } else if (process.platform === 'darwin') {
    child = spawn('open', [url], opts);
  } else {
    child = spawn('xdg-open', [url], opts);
  }
  child.unref();
}

// ── インストール ─────────────────────────────────────────────────────────────

/** 各ファイルのスタブを生成してブラウザで開く。失敗した件数を返す。 */
function installFiles(paths, { dev = false } = {}) {
  let failed = 0;
  for (const filePath of paths) {
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
    const stub     = buildStub(absPath, metaBlock, dev);
    const stubPath = writeStub(name, stub);
    const stubUrl  = pathToFileURL(stubPath).href;

    console.log(`📦 ${name}${dev ? ' (dev)' : ''}`);
    console.log(`   ${stubUrl}`);
    openInBrowser(stubUrl);
  }
  return failed;
}

// ── git 連携（tm pull） ───────────────────────────────────────────────────────

// TM に登録済みのスタブへ焼き付き、変更したら再インストールが要るキー
const REINSTALL_KEYS = new Set([
  'name', 'namespace', 'match', 'include', 'exclude', 'grant',
  'run-at', 'noframes', 'connect', 'sandbox', 'require', 'resource',
]);

/** 再インストールが要るキーだけを抜き出し、`key value` の並べ替え済み配列にする */
function reinstallSignature(metaBlock) {
  const lines = [];
  for (const m of metaBlock.matchAll(/^\/\/\s*@([\w-]+)\s*(.*)$/gm)) {
    if (REINSTALL_KEYS.has(m[1])) lines.push(`${m[1]} ${m[2].trim().replace(/\s+/g, ' ')}`);
  }
  return lines.sort();
}

/** 2つのメタデータブロックで、再インストールが要るキーの差分を返す（変更されたキー名の配列） */
function changedReinstallKeys(oldBlock, newBlock) {
  const oldSig = reinstallSignature(oldBlock);
  const newSig = reinstallSignature(newBlock);
  const keys = new Set();
  for (const line of oldSig.filter(l => !newSig.includes(l))) keys.add(line.split(' ')[0]);
  for (const line of newSig.filter(l => !oldSig.includes(l))) keys.add(line.split(' ')[0]);
  return [...keys];
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`git を実行できません: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が失敗しました\n${(r.stderr || '').trim()}`);
  return r.stdout;
}

// ── コマンド実装 ─────────────────────────────────────────────────────────────

const commands = {

  /**
   * tm install <file...>
   * 各ファイルについてインストーラースタブを生成し、ブラウザで開く。
   */
  async install(args) {
    const dev   = args.includes('--dev');
    const files = args.filter(a => a !== '--dev');
    if (!files.length) {
      console.error('使い方: tm install [--dev] <file...>');
      console.error('  例: tm install src/foo.user.js');
      console.error('  例: tm install --dev src/*.user.js');
      process.exit(1);
    }
    if (installFiles(files, { dev })) process.exit(1);
  },

  /**
   * tm pull [--dry-run]
   * 上流の変更を確認し、新規／メタデータ変更のあった .user.js だけを pull 後にインストールする。
   */
  async pull(args) {
    const dryRun = args.includes('--dry-run');
    const dev    = args.includes('--dev');
    const root   = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();

    git(root, ['fetch']);
    try {
      git(root, ['rev-parse', '--abbrev-ref', '@{u}']);
    } catch {
      throw new Error('上流ブランチが設定されていません（git branch --set-upstream-to で設定してください）');
    }

    const base    = git(root, ['merge-base', 'HEAD', '@{u}']).trim();
    const changes = git(root, ['diff', '--name-status', '--no-renames', base, '@{u}', '--', '*.user.js'])
      .split('\n').filter(Boolean).map(l => l.split('\t'));

    if (!changes.length) {
      console.log('上流に .user.js の変更はありません');
      if (!dryRun) git(root, ['pull', '--ff-only']);
      return;
    }

    const toInstall = [];
    const deleted   = [];
    console.log(`上流に変更あり: ${changes.length} ファイル`);
    for (const [status, path] of changes) {
      if (status === 'A') {
        console.log(`  新規      ${path}`);
        toInstall.push(path);
      } else if (status === 'D') {
        console.log(`  削除      ${path}`);
        deleted.push(path);
      } else {
        const oldBlock = extractMetaBlock(git(root, ['show', `${base}:${path}`])) ?? '';
        const newBlock = extractMetaBlock(git(root, ['show', `@{u}:${path}`])) ?? '';
        const keys     = changedReinstallKeys(oldBlock, newBlock);
        if (keys.length) {
          console.log(`  メタ変更  ${path}   (@${keys.join(', @')})`);
          toInstall.push(path);
        } else {
          console.log(`  本体のみ  ${path}   （再インストール不要）`);
        }
      }
    }
    if (deleted.length) {
      console.log('\n削除されたスクリプトは TM の管理画面から手動で削除してください（tm list で開けます）');
    }

    if (dryRun) return;

    console.log('\ngit pull --ff-only');
    git(root, ['pull', '--ff-only']);

    if (toInstall.length && installFiles(toInstall.map(p => resolve(root, p)), { dev })) process.exit(1);
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
  tm install [--dev] <file...>   指定した .user.js をインストール導線に乗せる（ワイルドカード可）
  tm pull [--dry-run] [--dev]     上流を pull し、新規／メタデータ変更のあった .user.js だけインストールする
  tm list                         Tampermonkey の管理画面をブラウザで開く

オプション:
  --dev                   開発用フラグ付きでインストールする（スクリプト側で globalThis.__TM_DEV__ が true になる）
  -h, --help              このヘルプを表示

前提条件:
  Tampermonkey 拡張の設定で「ファイル URL へのアクセスを許可」を有効化してください。

詳細: https://github.com/m-mahiro/tampermonkey-cli
    `);
    process.exit(0);
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`不明なコマンド: ${cmd}`);
    console.error('tm --help で使い方を確認してください');
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

main();
