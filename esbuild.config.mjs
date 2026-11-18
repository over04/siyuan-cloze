import esbuild from 'esbuild';
import * as sass from 'sass';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const isDev = process.argv.includes('--watch');
const dist = path.resolve('dist');
const assetFiles = ['plugin.json', 'icon.png', 'README.md'];
const languages = ['zh_CN.json', 'en_US.json'];

function copyAssets(output) {
  fs.mkdirSync(output, { recursive: true });
  const result = sass.compile(path.resolve('src/index.scss'), { style: 'compressed' });
  fs.writeFileSync(path.join(output, 'index.css'), result.css);
  for (const file of assetFiles) fs.copyFileSync(file, path.join(output, file));
  fs.mkdirSync(path.join(output, 'i18n'), { recursive: true });
  for (const lang of languages) fs.copyFileSync(path.join('src', 'i18n', lang), path.join(output, 'i18n', lang));
}

function bundleOptions(output) {
  return {
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2020'],
    outfile: path.join(output, 'index.js'),
    external: ['siyuan'],
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    logLevel: 'info',
  };
}

async function build() {
  if (isDev) {
    copyAssets(dist);
    const ctx = await esbuild.context(bundleOptions(dist));
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
    return;
  }

  const prefix = path.resolve('.cloze-build-');
  const work = fs.mkdtempSync(prefix);
  try {
    const staging = path.join(work, 'dist');
    const archive = path.join(work, 'package.zip');
    copyAssets(staging);
    await esbuild.build(bundleOptions(staging));
    // 只打包本次生成、明确列出的文件；旧 dist 与发布包完全隔离。
    execFileSync('zip', ['-X', archive, 'index.js', 'index.css', ...assetFiles, ...languages.map(lang => 'i18n/' + lang)], {
      cwd: staging, stdio: 'inherit',
    });
    fs.cpSync(staging, dist, { recursive: true });
    fs.renameSync(archive, path.resolve('package.zip'));
    console.log('[esbuild] build complete: package.zip');
  } finally {
    if (work.startsWith(prefix) && path.dirname(work) === path.dirname(prefix)) fs.rmSync(work, { recursive: true });
  }
}

build().catch(error => {
  console.error('[build] failed:', error);
  process.exitCode = 1;
});
