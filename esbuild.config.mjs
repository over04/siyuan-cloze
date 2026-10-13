import esbuild from 'esbuild';
import * as sass from 'sass';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const isDev = process.argv.includes('--watch');

function buildSass() {
  const scssPath = path.resolve('src/index.scss');
  if (fs.existsSync(scssPath)) {
    const result = sass.compile(scssPath, { style: 'compressed' });
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/index.css', result.css);
    console.log('[sass] compiled src/index.scss -> dist/index.css');
  }
}

function copyAssets() {
  fs.mkdirSync('dist', { recursive: true });
  const assets = ['plugin.json', 'icon.png', 'README.md'];
  for (const file of assets) {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join('dist', file));
    }
  }
  if (fs.existsSync('src/i18n')) {
    fs.cpSync('src/i18n', 'dist/i18n', { recursive: true });
  }
}

function makeZip() {
  if (!fs.existsSync('dist/plugin.json')) return;
  try {
    execSync('cd dist && zip -r ../package.zip .', { stdio: 'ignore' });
    console.log('[zip] generated package.zip');
  } catch (err) {
    console.warn('[zip] zip command failed or not available:', err.message);
  }
}

async function build() {
  fs.mkdirSync('dist', { recursive: true });
  buildSass();
  copyAssets();

  const ctx = await esbuild.context({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2020'],
    outfile: 'dist/index.js',
    external: ['siyuan'],
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    logLevel: 'info',
  });

  if (isDev) {
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    makeZip();
    console.log('[esbuild] build complete');
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
