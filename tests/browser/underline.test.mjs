import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, mount, block, editor, kbd, formula, frac, deep, pixels, textRects } from './fixture.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });
const center = (ys) => (ys[0] + ys.at(-1)) / 2;
const inner = ({left, right}) => ({left: left + 2, right: right - 2});

async function withPage(t, html) {
  const page = await mount(browser, editor(html));
  t.after(() => page.close());
  return page;
}

test('同行文字与 KaTeX 的虚线中心误差不超过 1 CSS px', async t => {
  const page = await withPage(t, block('mixed', kbd('left', 'answer') + '​' + formula('formula', frac, 'kbd inline-math') + '​' + kbd('right', 'value')));
  const r = (await textRects(page, '#left'))[0];
  const m = await page.locator('#formula .katex-base').evaluate(el => { const r = el.getBoundingClientRect(), s = el.querySelector('.katex-strut').getBoundingClientRect(); return {left:r.left, right:r.right, bottom:s.bottom}; });
  const color = await pixels(page);
  const text = color(inner(r), r.bottom, r.bottom + 40);
  const math = color(m, m.bottom - 3, m.bottom + 40);
  assert.ok(text.length && math.length, JSON.stringify({text, math, m}));
  assert.ok(Math.abs(center(text) - center(math)) <= 1, JSON.stringify({text, math}));
  assert.ok(center(math) >= m.bottom, JSON.stringify({math, m}));
});

test('深公式不拖低纯文字续行，续行虚线留在裁切区内', async t => {
  const page = await withPage(t, block('deep', kbd('first', 'A') + formula('formula', deep, 'kbd inline-math') + kbd('next', 'no formula on the continuation'), 'width: 306px; overflow: hidden'));
  const rows = await textRects(page, '#next');
  assert.ok(rows.length >= 2);
  const r = rows.at(-1);
  const clip = await page.locator('#deep').evaluate(el => el.getBoundingClientRect().bottom);
  const ys = (await pixels(page))(inner(r), r.bottom - 1, clip);
  assert.ok(ys.length > 0, JSON.stringify({rows, clip, ys}));
});

test('嵌套 KaTeX 前后文本各自有可见虚线', async t => {
  const page = await withPage(t, block('nested', kbd('wrap', 'before ' + formula('formula', frac) + ' after')));
  const rows = await textRects(page, '#wrap');
  const color = await pixels(page);
  for (const r of rows) {
    const ys = color(inner(r), r.bottom - 1, r.bottom + 30);
    assert.ok(ys.length > 0, JSON.stringify({r, ys}));
  }
});

test('两行纯文字对照：每行各有一条线', async t => {
  const page = await withPage(t, block('control', kbd('text', 'first second third fourth'), 'width: 155px; overflow: hidden'));
  const rs = await textRects(page, '#text');
  assert.equal(rs.length, 2);
  const color = await pixels(page);
  for (const r of rs) {
    assert.ok(color(inner(r), r.bottom - 3, r.bottom + 6).length > 0, JSON.stringify(r));
  }
});
