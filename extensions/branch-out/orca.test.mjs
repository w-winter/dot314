import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const url = new URL('./index.ts', import.meta.url);
const source = stripTypeScriptTypes(fs.readFileSync(url, 'utf8'))
  .replace(/^import[\s\S]*?from ["'][^"']+["'];?\s*$/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(url.href))
  .replace('export default function', 'function register');
const env = { ORCA_WORKTREE_ID: 'repo::/work', ORCA_TERMINAL_HANDLE: 'term_current' };
const context = vm.createContext({ fs, os, path, fileURLToPath, process: { env }, console });
vm.runInContext(source, context);
const terminals = JSON.stringify({ result: { terminals: [
  { handle: 'term_other', tabId: 'tab', leafId: 'other' },
  { handle: 'term_current', tabId: 'tab', leafId: 'current' },
] } });
assert.equal(context.detectTerminalBackend(), 'orca');
assert.equal(context.parseOrcaTerminalHandle(terminals, undefined, 'term_current'), 'term_current');
assert.equal(context.parseOrcaTerminalHandle(terminals, 'tab:current'), 'term_current');
assert.equal(context.parseOrcaTerminalHandle(terminals, 'tab:current', 'stale'), undefined);
assert.equal(context.parseOrcaTerminalHandle('invalid', undefined, 'term_current'), undefined);
const calls = [];
const pi = { exec: async (_cmd, args) => {
  calls.push(args);
  return { code: 0, stdout: args[1] === 'list' ? terminals : '{}', stderr: '' };
} };
const config = { launchMode: 'split', splitDirectionPreferences: ['right'], preserveFocus: true };
assert.equal((await context.openInOrca(pi, '/tmp/fork.jsonl', config, "/tmp/user's project")).opened, true);
assert.deepEqual(calls.map(args => args[1]), ['list', 'split', 'switch']);
assert.equal(calls[1][3], 'term_current');
assert.equal(calls[1][7], "cd '/tmp/user'\\''s project' && pi --session '/tmp/fork.jsonl'");
calls.length = 0;
env.ORCA_TERMINAL_HANDLE = 'stale';
assert.equal((await context.openInOrca(pi, '/tmp/fork.jsonl', config, '/tmp')).opened, false);
assert.deepEqual(calls.map(args => args[1]), ['list']);
delete env.ORCA_TERMINAL_HANDLE;
env.ORCA_PANE_KEY = 'tab:current';
assert.equal(context.detectTerminalBackend(), 'orca');
console.log('PASS: handle/legacy routing, stale rejection, exact split target, cwd quoting, focus restore');
