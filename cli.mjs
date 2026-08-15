#!/usr/bin/env node
/**
 * tm — Tampermonkey ユーザースクリプト管理 CLI
 * https://github.com/m-mahiro/tempermonkey-cli
 *
 * コマンド:
 *   tm sync          src/ と Tampermonkey を同期（upsert）
 *   tm watch [dir]   ディレクトリを監視してホットリロード
 *   tm status        src/ と Tampermonkey の状態を比較表示
 *   tm remove <name> Tampermonkey からスクリプトを削除
 *
 * 前提条件:
 *   1. Tampermonkey 拡張をインストール済み
 *   2. Tampermonkey Editors 拡張をインストール済み
 *      https://chromewebstore.google.com/detail/tampermonkey-editors/aijkghbhbchojkjncojpfcdpjkkjkgfh
 *   3. npm install -g tampermonkey-mcp@latest
 */

import { spawn }                            from 'child_process';
import { readFileSync, readdirSync, watch }  from 'fs';
import { resolve, basename, dirname }        from 'path';
import { fileURLToPath }                     from 'url';
import * as readline                         from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 設定 ────────────────────────────────────────────────────────────────────

// 管理対象スクリプトの識別子（@namespace または @updateURL のプレフィックスで判定）
const REPO_NAMESPACE   = 'https://github.com/m-mahiro/userscripts';
const REPO_RAW_PREFIX  = 'https://raw.githubusercontent.com/m-mahiro/userscripts/';

// sync / watch のデフォルト対象ディレクトリ（このファイルから見た ../src）
const DEFAULT_SRC = resolve(__dirname, '../src');

// ── MCP JSON-RPC クライアント ────────────────────────────────────────────────

class TampermonkeyMCP {
  constructor() {
    this._proc    = null;
    this._pending = new Map();
    this._id      = 0;
    this._buffer  = '';
  }

  async start() {
    return new Promise((resolve, reject) => {
      this._proc = spawn('npx', ['tampermonkey-mcp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._proc.stdout.on('data', chunk => {
        this._buffer += chunk.toString();
        this._flush();
      });

      this._proc.stderr.on('data', d => {
        if (process.env.TM_DEBUG) process.stderr.write('[mcp] ' + d);
      });

      this._proc.on('error', reject);

      // MCP initialize ハンドシェイク
      this._write({
        jsonrpc: '2.0', id: ++this._id, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'tempermonkey-cli', version: '1.0.0' },
        },
      });

      setTimeout(() => {
        this._write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        resolve();
      }, 300);
    });
  }

  _flush() {
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          msg.error
            ? reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
            : resolve(msg.result);
        }
      } catch { /* ignore */ }
    }
  }

  _write(obj) {
    this._proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  call(tool, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      this._pending.set(id, { resolve, reject });
      this._write({
        jsonrpc: '2.0', id,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      });
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`Timeout: ${tool}`));
        }
      }, 15000);
    });
  }

  stop() { this._proc?.kill(); }
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

/** MCP レスポンスの content[].text を結合して返す */
function text(result) {
  if (Array.isArray(result?.content)) return result.content.map(c => c.text ?? '').join('');
  return JSON.stringify(result ?? '');
}

/** UserScript メタブロックをパースして key→value のオブジェクトを返す */
function parseMeta(src) {
  const meta  = {};
  const block = src.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
  if (!block) return meta;
  for (const line of block[1].split('\n')) {
    const m = line.match(/\/\/\s+@(\w+)\s+(.*)/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return meta;
}

/** src/ 内の *.user.js を { name, path, src, meta } の配列で返す */
function listSrcScripts(dir) {
  return readdirSync(dir)
    .filter(f => f.endsWith('.user.js'))
    .map(f => {
      const path = resolve(dir, f);
      const src  = readFileSync(path, 'utf8');
      const meta = parseMeta(src);
      return { name: meta.name ?? basename(f, '.user.js'), path, src, meta };
    });
}

/**
 * TM の全スクリプトのうち、このリポジトリが管理するものだけを返す。
 * @namespace が REPO_NAMESPACE と一致、または @updateURL が REPO_RAW_PREFIX で始まるものを対象とする。
 */
async function listManagedTM(mcp) {
  const raw = text(await mcp.call('tampermonkey_list'));
  let all;
  try { all = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(all)) all = [all];
  return all.filter(s => {
    const ns  = s.namespace  ?? s.metadata?.namespace  ?? '';
    const upd = s.updateURL  ?? s.metadata?.updateURL  ?? '';
    return ns === REPO_NAMESPACE || upd.startsWith(REPO_RAW_PREFIX);
  });
}

/** TM にスクリプトを upsert（新規インストール or 上書き更新） */
async function upsert(mcp, script, tmScripts) {
  const exists = tmScripts.find(s => (s.name ?? s.metadata?.name) === script.name);
  if (exists) {
    await mcp.call('tampermonkey_patch', { name: script.name, content: script.src });
    return 'updated';
  } else {
    await mcp.call('tampermonkey_put', { name: script.name, content: script.src });
    return 'installed';
  }
}

/** readline で確認プロンプト（y/N） */
function confirm(msg) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${msg} [y/N] `, ans => { rl.close(); res(ans.trim().toLowerCase() === 'y'); });
  });
}

// ── コマンド実装 ─────────────────────────────────────────────────────────────

const commands = {

  /**
   * tm sync [dir]
   * src/ と TM を照合して upsert。TM にあって src/ にないものは警告のみ。
   */
  async sync(mcp, args) {
    const dir = resolve(args[0] ?? DEFAULT_SRC);
    console.log(`📂 src: ${dir}\n`);

    const srcScripts = listSrcScripts(dir);
    const tmScripts  = await listManagedTM(mcp);

    for (const script of srcScripts) {
      const result = await upsert(mcp, script, tmScripts);
      console.log(`  ${result === 'installed' ? '✅ installed' : '🔄 updated'}: ${script.name}`);
    }

    // TM にあって src/ にないものを警告
    const srcNames = new Set(srcScripts.map(s => s.name));
    const orphans  = tmScripts.filter(s => !srcNames.has(s.name ?? s.metadata?.name));
    if (orphans.length) {
      console.log('\n⚠️  TM にあるが src/ にないスクリプト（削除したい場合は tm remove <name>）:');
      for (const s of orphans) console.log(`  - ${s.name ?? s.metadata?.name}`);
    }

    console.log('\n✅ sync 完了');
  },

  /**
   * tm watch [dir]
   * 起動時に sync → ディレクトリを監視してホットリロード。
   * ファイル削除は何もしない（意図しない削除を防ぐ）。
   */
  async watch(mcp, args) {
    const dir = resolve(args[0] ?? DEFAULT_SRC);
    console.log(`👀 監視中: ${dir}`);
    console.log('ファイルの変更・追加を検知して自動で Tampermonkey に反映します。Ctrl+C で終了。\n');

    // 起動時に sync して現状を揃える
    await commands.sync(mcp, [dir]);
    console.log('\n--- watch 開始 ---\n');

    // ディレクトリ監視（変更・追加どちらも検知）
    watch(dir, { persistent: true }, async (event, filename) => {
      if (!filename?.endsWith('.user.js')) return;
      const path = resolve(dir, filename);
      let src;
      try {
        src = readFileSync(path, 'utf8');
      } catch {
        return; // ファイル削除時は何もしない
      }

      const meta   = parseMeta(src);
      const name   = meta.name ?? basename(filename, '.user.js');
      const script = { name, path, src, meta };

      console.log(`🔄 変更検知: ${filename}`);
      try {
        const tmScripts = await listManagedTM(mcp);
        const result    = await upsert(mcp, script, tmScripts);
        console.log(`  ✅ ${result}: ${name}\n`);
      } catch (e) {
        console.error(`  ❌ エラー: ${e.message}\n`);
      }
    });

    // Ctrl+C まで待機
    await new Promise(() => {});
  },

  /**
   * tm status [dir]
   * src/ と TM の状態を比較して一覧表示。
   */
  async status(mcp, args) {
    const dir = resolve(args[0] ?? DEFAULT_SRC);

    const srcScripts = listSrcScripts(dir);
    const tmScripts  = await listManagedTM(mcp);
    const tmNames    = new Set(tmScripts.map(s => s.name ?? s.metadata?.name));
    const srcNames   = new Set(srcScripts.map(s => s.name));

    console.log('状態              スクリプト名');
    console.log('────────────────  ──────────────────────────────');

    for (const s of srcScripts) {
      const state = tmNames.has(s.name) ? '✅ synced        ' : '📥 not installed';
      console.log(`${state}  ${s.name}`);
    }
    for (const s of tmScripts) {
      const name = s.name ?? s.metadata?.name;
      if (!srcNames.has(name)) {
        console.log(`⚠️  TM only        ${name}`);
      }
    }
  },

  /**
   * tm remove <name>
   * 確認プロンプトの後、TM から管理対象スクリプトを削除。
   */
  async remove(mcp, args) {
    const name = args[0];
    if (!name) {
      console.error('使い方: tm remove <スクリプト名>');
      process.exit(1);
    }

    const tmScripts = await listManagedTM(mcp);
    const target    = tmScripts.find(s => (s.name ?? s.metadata?.name) === name);
    if (!target) {
      console.error(`❌ "${name}" は管理対象スクリプトに見つかりません`);
      console.error('  tm status で一覧を確認してください');
      process.exit(1);
    }

    const ok = await confirm(`🗑️  "${name}" を Tampermonkey から削除しますか？`);
    if (!ok) { console.log('キャンセルしました'); return; }

    await mcp.call('tampermonkey_delete', { name });
    console.log(`✅ 削除完了: ${name}`);
  },
};

// ── エントリポイント ──────────────────────────────────────────────────────────

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
tm — Tampermonkey ユーザースクリプト管理 CLI

使い方:
  tm sync [dir]        src/ と Tampermonkey を同期（新規 + 上書き更新）
  tm watch [dir]       ファイルを監視してホットリロード
  tm status [dir]      src/ と Tampermonkey の状態を比較表示
  tm remove <name>     Tampermonkey からスクリプトを削除

オプション:
  -h, --help           このヘルプを表示

環境変数:
  TM_DEBUG=1           MCP のデバッグログを表示

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

  const mcp = new TampermonkeyMCP();
  try {
    await mcp.start();
    await handler(mcp, args);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    if (process.env.TM_DEBUG) console.error(e.stack);
    process.exit(1);
  } finally {
    if (cmd !== 'watch') mcp.stop();
  }
}

main();
