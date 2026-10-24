import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

const url = new URL('./index.ts', import.meta.url);
const source = stripTypeScriptTypes(fs.readFileSync(url, 'utf8'))
  .replace(/^import[\s\S]*?from ["'][^"']+["'];?\s*$/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(url.href))
  .replace('export default function', 'function register');

function fixture(t, { platform = 'darwin', env = {}, launchMode = 'tab' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-warp-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const spawns = [];
  const context = vm.createContext({
    fs: {
      ...fs,
      readFileSync(file, ...args) {
        if (file === fileURLToPath(new URL('./config.json', url))) {
          return JSON.stringify({ launchMode, preserveFocus: true });
        }
        return fs.readFileSync(file, ...args);
      },
    },
    os: { ...os, homedir: () => home }, path, fileURLToPath,
    process: { platform, env: { TERM_PROGRAM: 'WarpTerminal', ...env } },
    spawn: (...args) => {
      spawns.push(args);
      return { unref() {}, on() {} };
    },
  });
  vm.runInContext(source, context);
  const pi = {
    getFlag() {},
    async exec(command, args) {
      calls.push([command, Array.from(args)]);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const ctx = { cwd: home, hasUI: true, ui: { notify() {} } };
  return { home, context, pi, ctx, calls, spawns };
}

// The generated subset of TOML uses JSON-compatible basic strings and arrays.
function field(text, name) {
  const match = text.match(new RegExp(`^${name} = (.+)$`, 'm'));
  assert.ok(match, `missing Tab Config field: ${name}`);
  return JSON.parse(match[1]);
}

for (const { platform, env, configRoot, opener } of [
  { platform: 'darwin', env: {}, configRoot: '.warp', opener: 'open' },
  { platform: 'linux', env: {}, configRoot: '.local/share/warp-terminal', opener: 'xdg-open' },
  { platform: 'linux', env: { XDG_DATA_HOME: '/placeholder' }, configRoot: 'xdg/warp-terminal', opener: 'xdg-open' },
]) {
  test(`Warp ${platform}${env.XDG_DATA_HOME ? ' with XDG_DATA_HOME' : ''}: launch a tab whose startup command resumes the exact fork`, async t => {
    const f = fixture(t, { platform });
    if (env.XDG_DATA_HOME) f.context.process.env.XDG_DATA_HOME = path.join(f.home, 'xdg');
    const cwd = path.join(f.home, 'project\'s "quoted" $HOME & café\\folder\x7f');
    fs.mkdirSync(cwd);
    f.ctx.cwd = cwd;
    const forkFile = path.join(f.home, 'fork\'s "quoted"; touch INJECTED #\x7f.jsonl');
    await f.context.openForkInTerminal(f.pi, f.ctx, forkFile);

    assert.equal(f.spawns.length, 0, 'must not fall through to Alacritty');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], opener);
    assert.equal(f.calls[0][1].length, 1);
    const uri = new URL(f.calls[0][1][0]);
    assert.equal(uri.protocol, 'warp:');
    assert.equal(uri.hostname, 'tab_config');
    const configFile = path.join(f.home, configRoot, 'tab_configs', `${decodeURIComponent(uri.pathname.slice(1))}.toml`);
    const text = fs.readFileSync(configFile, 'utf8');
    // TOML rejects raw DEL, which the JSON.parse-based field() would accept.
    assert.doesNotMatch(text, /\x7f/);
    assert.match(text, /\[\[panes\]\]/);
    assert.equal(field(text, 'type'), 'terminal');
    assert.equal(field(text, 'directory'), cwd);
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

    // Execute the actual emitted command with a harmless Pi substitute, not a
    // mock of the command builder: broken quoting or omitted cleanup must fail.
    const bin = path.join(f.home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pi'), `#!${process.execPath}\n` +
      `require('node:fs').writeFileSync(process.env.RESULT_FILE, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd()}));\n`, { mode: 0o700 });
    const resultFile = path.join(f.home, 'result.json');
    execFileSync('sh', ['-c', field(text, 'commands').join(' && ')], {
      cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RESULT_FILE: resultFile },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), { argv: ['--session', forkFile], cwd: fs.realpathSync(cwd) });
    assert.equal(fs.existsSync(configFile), false, 'startup removes the consumed config');
    assert.equal(fs.existsSync(path.join(cwd, 'INJECTED')), false);
  });
}

test('Warp split mode fails explicitly without launching a different terminal or leaving configs', async t => {
  const f = fixture(t, { launchMode: 'split' });
  await assert.rejects(f.context.openForkInTerminal(f.pi, f.ctx, '/tmp/fork.jsonl'), /Warp.*launchMode.*tab/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.spawns, []);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('overlapping Warp launches have independent configs that survive URI dispatch', async t => {
  const f = fixture(t);
  await Promise.all([
    f.context.openForkInTerminal(f.pi, f.ctx, '/tmp/first.jsonl'),
    f.context.openForkInTerminal(f.pi, f.ctx, '/tmp/second.jsonl'),
  ]);
  const dir = path.join(f.home, '.warp', 'tab_configs');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  assert.notEqual(f.calls[0][1][0], f.calls[1][1][0]);
  const commands = files.map(file => field(fs.readFileSync(path.join(dir, file), 'utf8'), 'commands').join(' '));
  assert.ok(commands.some(command => command.includes("pi --session '/tmp/first.jsonl'")));
  assert.ok(commands.some(command => command.includes("pi --session '/tmp/second.jsonl'")));
});

for (const throws of [false, true]) {
  test(`Warp opener ${throws ? 'exception' : 'nonzero exit'} is reported and its config removed`, async t => {
    const f = fixture(t);
    f.pi.exec = async () => {
      if (throws) throw new Error('opener unavailable');
      return { code: 1, stdout: '', stderr: 'opener unavailable' };
    };
    await assert.rejects(f.context.openForkInTerminal(f.pi, f.ctx, '/tmp/fork.jsonl'), /opener unavailable/);
    assert.deepEqual(fs.readdirSync(path.join(f.home, '.warp', 'tab_configs')), []);
    assert.deepEqual(f.spawns, []);
  });
}

for (const { backend, env, command } of [
  { backend: 'tmux', env: { TMUX: '/tmp/tmux', TMUX_PANE: '%1' }, command: 'tmux' },
  { backend: 'cmux', env: { CMUX_SOCKET_PATH: '/tmp/cmux' }, command: 'cmux' },
  { backend: 'Orca', env: { ORCA_WORKTREE_ID: 'worktree', ORCA_TERMINAL_HANDLE: 'term_parent' }, command: 'orca' },
]) {
  test(`${backend} nested in Warp retains routing precedence`, async t => {
    const f = fixture(t, { launchMode: 'split', env });
    f.pi.exec = async (executable, args) => {
      f.calls.push([executable, Array.from(args)]);
      return { code: 1, stdout: '', stderr: 'backend reached' };
    };
    await assert.rejects(f.context.openForkInTerminal(f.pi, f.ctx, '/tmp/fork.jsonl'), /backend reached/);
    assert.equal(f.calls[0][0], command);
    assert.deepEqual(fs.readdirSync(f.home), []);
  });
}

test('Ghostty environment retains routing precedence over Warp', async t => {
  const f = fixture(t, { env: { GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources' } });
  await f.context.openForkInTerminal(f.pi, f.ctx, '/tmp/fork.jsonl');
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0][0], 'ghostty');
  assert.deepEqual(Array.from(f.spawns[0][1]), ['-e', 'pi', '--session', '/tmp/fork.jsonl']);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('explicit terminal override still wins over Warp detection', async t => {
  const f = fixture(t);
  f.pi.getFlag = () => 'custom-terminal {session}';
  await f.context.openForkInTerminal(f.pi, f.ctx, '/tmp/fork.jsonl');
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0][0], 'bash');
  assert.deepEqual(Array.from(f.spawns[0][1]), ['-lc', 'custom-terminal /tmp/fork.jsonl']);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readdirSync(f.home), []);
});
