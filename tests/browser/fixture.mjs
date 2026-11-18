import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import katex from 'katex';
import { chromium } from 'playwright';
import * as sass from 'sass';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const katexDir = dirname(require.resolve('katex/dist/katex.css'));
const css = sass.compile('src/index.scss').css;
const { outputFiles: [bundle] } = await build({
  stdin: { contents: 'export { default } from "./src/index.ts"', resolveDir: process.cwd() },
  bundle: true, write: false, globalName: 'Cloze', format: 'iife', external: ['siyuan'],
  banner: { js:     "function require() { return { Plugin: class { i18n = {}; eventBus = { on() {}, off() {} }; addIcons() {} addTopBar() {} addCommand(cmd) { (this.commands ??= []).push(cmd); } loadData() { return window.saved; } async saveData(key, data) { if (window.rejectSave) throw Error('save failed'); window.writes.push([key, data]); } }, Setting: class { constructor(opts) { this.options = opts; } addItem(item) { this.item = item; } }, showMessage() {}, getActiveEditor() {} }; }" },
});

export const deep = String.raw`\begin{matrix}a&b\\c&d\\e&f\\g&h\end{matrix}`;
export const frac = String.raw`\frac{1}{2}`;
export function formula(id, tex, types = 'inline-math') {
  return '<span id="' + id + '" data-type="' + types + '" data-content="' + tex + '">' +
    katex.renderToString(tex) + '</span>';
}
export const block = (id, body, style = '') =>
  '<div class="block" id="' + id + '" data-node-id="' + id + '" style="' + style + '"><div contenteditable="true">' + body + '</div></div>';
export const kbd = (id, text, types = 'kbd') => '<span id="' + id + '" data-type="' + types + '">' + text + '</span>';
export const editor = (html, id = 'editor') => '<div class="protyle" id="' + id + '"><div class="protyle-content"><div class="protyle-wysiwyg b3-typography">' + html + '</div></div></div>';

export async function launch() {
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
}

export async function mount(browser, html, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 650 }, deviceScaleFactor: 1, ...opts.context });
  await page.route('https://cloze.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    if (pathname.startsWith('/fonts/')) return route.fulfill({ path: join(katexDir, pathname), contentType: 'font/woff2' });
    return route.abort();
  });
  await page.goto('https://cloze.test/');
  await page.addStyleTag({ content: readFileSync(join(katexDir, 'katex.css'), 'utf8') });
  await page.addStyleTag({ content:     "body { margin: 20px; font: 20px/1.55 Arial, sans-serif; color: #111; --b3-theme-primary: #ff00ff; } .protyle { position: relative; width: 390px; } .protyle-content { position: relative; overflow: auto; max-height: 590px; } .block { margin-bottom: 20px; } td { vertical-align: top; } [data-type~='u'] { border-bottom: 1px solid; } [data-type~='inline-math'] { white-space: nowrap; }" });
  await page.evaluate(({html, hide}) => {
    document.body.innerHTML = html;
    window.saved = { defaultHide: hide };
    window.writes = [];
  }, {html, hide: opts.hide ?? false});
  await page.evaluate(() => document.fonts.ready.then(() => true));
  if (opts.before) await opts.before(page);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.text });
  await page.evaluate(async () => {
    window.plugin = new Cloze.default();
    await window.plugin.onload();
  });
  await settle(page);
  return page;
}

export function settle(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
  });
}

export async function textRects(page, id) {
  return page.locator(id).evaluate(el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).flatMap(n => {
    const range = new Range();
    range.selectNodeContents(n);
    return [...range.getClientRects()].map(r => r.toJSON());
  }));
}

export async function pixels(page) {
  const png = PNG.sync.read(await page.screenshot());
  return ({left, right}, top, bottom) => {
    const ys = [];
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(png.height, bottom); y++) {
      let count = 0;
      for (let x = Math.max(0, Math.ceil(left)); x < Math.min(png.width, right); x++) {
        const [r,g,b] = png.data.subarray(4 * (y * png.width + x), 4 * (y * png.width + x) + 3);
        if (r - g > 65 && b - g > 65) count++;
      }
      if (count > 2) ys.push(y + .5);
    }
    return ys;
  };
}
