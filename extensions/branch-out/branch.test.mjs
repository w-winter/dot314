import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const url = new URL('./index.ts', import.meta.url);
const source = stripTypeScriptTypes(fs.readFileSync(url, 'utf8'))
  .replace(/^import[\s\S]*?from ["'][^"']+["'];?\s*$/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(url.href))
  .replace('export default function', 'function register');

for (const { args, launchFails } of [
  { args: '', launchFails: false },
  { args: '--model test-model investigate the parser', launchFails: false },
  { args: '', launchFails: true },
]) {
  test(`branch during an active first turn: ${launchFails ? 'terminal failure' : args || 'no arguments'}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-branch-test-'));
    try {
      const parent = SessionManager.create(dir, dir);
      parent.appendMessage({ role: 'user', content: 'Start working', timestamp: Date.now() });
      const parentFile = parent.getSessionFile();
      const parentLeaf = parent.getLeafId();
      const parentBytes = fs.readFileSync(parentFile, 'utf8');
      const model = { provider: 'test', id: 'test-model', name: 'Test' };
      const notices = [];
      let handler;
      let forkFile;
      const context = vm.createContext({
        fs: {
          ...fs,
          readFileSync(file, ...args) {
            if (file === fileURLToPath(new URL('./config.json', url))) {
              return JSON.stringify({ launchMode: 'split', preserveFocus: true });
            }
            return fs.readFileSync(file, ...args);
          },
        },
        os, path, fileURLToPath, SessionManager,
        process: { env: {
          ORCA_WORKTREE_ID: 'test-worktree', ORCA_TERMINAL_HANDLE: 'term_parent',
          PI_CODING_AGENT_DIR: dir,
        } },
      });
      vm.runInContext(source, context);
      context.register({
        registerFlag() {}, on() {}, getFlag() {},
        registerCommand(name, command) {
          assert.equal(name, 'branch');
          handler = command.handler;
        },
        async exec(_command, cliArgs) {
          if (cliArgs[1] === 'list') {
            assert.equal(parent.getSessionFile(), parentFile);
            assert.equal(parent.getLeafId(), parentLeaf);
            assert.equal(fs.readFileSync(parentFile, 'utf8'), parentBytes);
            parent.appendMessage({ role: 'user', content: 'Later parent entry', timestamp: Date.now() });
            return { code: 0, stdout: JSON.stringify({ result: { terminals: [{ handle: 'term_parent' }] } }), stderr: '' };
          }
          if (cliArgs[1] === 'split') {
            const command = cliArgs[cliArgs.indexOf('--command') + 1];
            forkFile = command.match(/pi --session '([^']+)'$/)[1];
            if (launchFails) return { code: 1, stdout: '', stderr: 'terminal split failed' };
          }
          return { code: 0, stdout: '{}', stderr: '' };
        },
      });
      const result = handler(args, {
        cwd: dir, hasUI: true, sessionManager: parent, model,
        modelRegistry: { getAvailable: () => [model] },
        isIdle: () => false,
        waitForIdle: async () => { throw new Error('Must not wait for the active turn'); },
        ui: { notify: (message) => notices.push(message) },
      });
      if (launchFails) await assert.rejects(result, /terminal split failed/);
      else await result;
      assert.ok(forkFile, 'terminal launch requested before parent becomes idle');
      assert.notEqual(forkFile, parentFile);
      const child = SessionManager.open(forkFile);
      assert.equal(child.getHeader().parentSession, parentFile);
      assert.deepEqual(child.buildSessionContext().messages.map(message => message.content), ['Start working']);
      assert.equal(parent.buildSessionContext().messages.length, 2);
      if (args) {
        const launch = child.getBranch().find(entry => entry.type === 'custom' && entry.customType === 'branch-out-launch');
        assert.equal(launch.data.message, 'investigate the parser');
        assert.equal(launch.data.targetModel.id, 'test-model');
      }
      assert.equal(notices.some(message => message.startsWith('Created fork')), !launchFails);
    } finally {
      execFileSync('trash', [dir]);
    }
  });
}
