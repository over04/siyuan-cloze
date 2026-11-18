import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const script = resolve('esbuild.config.mjs');
const archiveToolsAvailable = ['zip', 'unzip'].every(tool => spawnSync(tool, ['-v'], { stdio: 'ignore' }).status === 0);

function outputDirectory(t) {
  const base = realpathSync(tmpdir());
  const cwd = mkdtempSync(join(base, 'cloze-build-test-'));
  t.after(() => {
    assert.equal(dirname(realpathSync(cwd)), base);
    assert.ok(cwd.startsWith(join(base, 'cloze-build-test-')));
    rmSync(cwd, { recursive: true });
  });
  for (const asset of ['src', 'README.md', 'plugin.json', 'icon.png']) cpSync(asset, join(cwd, asset), { recursive: true });
  return cwd;
}

test('发布包只包含当前插件产物，不打包旧 dist 文件', { skip: !archiveToolsAvailable }, t => {
  const cwd = outputDirectory(t);
  mkdirSync(join(cwd, 'dist'));
  writeFileSync(join(cwd, 'dist', 'old.txt'), 'obsolete');
  const built = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const entries = spawnSync('unzip', ['-Z1', join(cwd, 'package.zip')], { encoding: 'utf8' });
  assert.equal(entries.status, 0, entries.stderr);
  assert.deepEqual(entries.stdout.trim().split('\n').filter(name => !name.endsWith('/')).sort(),
    ['README.md', 'i18n/en_US.json', 'i18n/zh_CN.json', 'icon.png', 'index.css', 'index.js', 'plugin.json'].sort());
});

test('打包工具缺失时返回失败，不删除上一版安装包', t => {
  const cwd = outputDirectory(t);
  const archive = join(cwd, 'package.zip');
  writeFileSync(archive, 'previous archive');
  const built = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.notEqual(built.status, 0, built.stdout);
  assert.ok(existsSync(archive));
  assert.equal(readFileSync(archive, 'utf8'), 'previous archive');
});
