import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = path.resolve(packageDirectory, '../..');

test('npm pack refreshes stale branch-out code with user-level ignore-scripts enabled', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-branch-package-'));
  t.after(() => execFileSync('trash', [temporaryDirectory]));
  const fixturePackage = path.join(temporaryDirectory, 'packages/pi-branch-out');
  const packageInputs = new Set(['package.json', '.npmrc', '.npmignore', 'README.md', 'THIRD-PARTY-NOTICES.md']);
  fs.cpSync(packageDirectory, fixturePackage, {
    recursive: true,
    filter: (file) => file === packageDirectory || packageInputs.has(path.relative(packageDirectory, file)),
  });
  for (const file of [
    'scripts/pi-package-prepack.mjs',
    'extensions/branch-out/index.ts',
    'extensions/branch-out/config.json.example',
    'LICENSE',
  ]) {
    const destination = path.join(temporaryDirectory, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryDirectory, file), destination);
  }
  const entrypoint = 'extensions/branch-out/index.ts';
  fs.mkdirSync(path.dirname(path.join(fixturePackage, entrypoint)), { recursive: true });
  fs.writeFileSync(path.join(fixturePackage, entrypoint), 'export default function stale() {}\n');
  const userConfig = path.join(temporaryDirectory, 'user.npmrc');
  fs.writeFileSync(userConfig, 'ignore-scripts=true\n');
  const env = { ...process.env, npm_config_userconfig: userConfig };
  delete env.npm_config_ignore_scripts;
  delete env.NPM_CONFIG_IGNORE_SCRIPTS;
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temporaryDirectory], {
    cwd: fixturePackage,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const tarball = path.join(temporaryDirectory, packed.filename);
  execFileSync('tar', ['-xzf', tarball, '-C', temporaryDirectory]);
  const extractedPackage = path.join(temporaryDirectory, 'package');
  const manifest = JSON.parse(fs.readFileSync(path.join(extractedPackage, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.pi.extensions, [entrypoint]);
  assert.ok(
    fs.readFileSync(path.join(extractedPackage, entrypoint)).equals(
      fs.readFileSync(path.join(repositoryDirectory, 'extensions/branch-out/index.ts')),
    ),
    'The tarball must contain the current branch-out implementation, not stale generated code',
  );
  const orcaTest = path.join(extractedPackage, 'extensions/branch-out/orca.test.mjs');
  fs.copyFileSync(path.join(repositoryDirectory, 'extensions/branch-out/orca.test.mjs'), orcaTest);
  execFileSync(process.execPath, ['--test', orcaTest], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.diagnostic(JSON.stringify({
    tarball: packed.filename,
    sha256: createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),
    sourceParity: true,
    orcaTestsPassed: true,
  }));
});
