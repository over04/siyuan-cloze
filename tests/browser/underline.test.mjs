import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, mount, block, editor, kbd, formula, frac, deep, pixels, textRects } from './fixture.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });
const center = (ys) => (ys[0] + ys.at(-1)) / 2;
const inner = ({left, right}) => ({left: left + 2, right: right - 2});

async function withPage(t, html, options) {
  const page = await mount(browser, editor(html), options);
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

function inProgress(page, from, to) {
  return page.waitForFunction(({ from, to }) => {
    const svg = document.querySelector('.cloze-underlines');
    const animation = svg.getAnimations({ subtree: true }).find(item => {
      const points = item.effect.getKeyframes();
      return Number(points[0]?.opacity) === from && Number(points.at(-1)?.opacity) === to;
    });
    if (!animation) return false;
    animation.pause();
    animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
    const opacity = Number(getComputedStyle(animation.effect.target).opacity);
    return opacity > Math.min(from, to) && opacity < Math.max(from, to);
  }, { from, to }, { timeout: 2200 });
}

async function finishFades(page) {
  await page.locator('.cloze-underlines').evaluate(svg => {
    for (const animation of svg.getAnimations({ subtree: true })) animation.finish();
  });
}

test('点击时虚线逐渐出现，再点时逐渐消失', async t => {
  const page = await withPage(t, block('fade', kbd('answer', 'answer')), { hide: true });
  const answer = page.locator('#answer');
  const lines = page.locator('.cloze-underlines line');
  assert.equal(await lines.count(), 0);
  await answer.click();
  await inProgress(page, 0, 1);
  assert.ok(await lines.count());
  await finishFades(page);
  await answer.click();
  await inProgress(page, 1, 0);
  assert.ok(await lines.count(), '淡出结束之前保留虚线');
  await finishFades(page);
  await lines.first().waitFor({ state: 'detached' });
});

test('划选和全局切换也逐渐显示虚线', async t => {
  const page = await withPage(t, block('fade', kbd('answer', 'answer')), { hide: true });
  const answer = page.locator('#answer');
  await answer.evaluate(el => getSelection().selectAllChildren(el));
  await inProgress(page, 0, 1);
  await finishFades(page);
  await page.evaluate(() => getSelection().removeAllRanges());
  await inProgress(page, 1, 0);
  await finishFades(page);
  await page.locator('.cloze-underlines line').first().waitFor({ state: 'detached' });
  await page.evaluate(() => window.plugin.setClozeActive(false));
  await inProgress(page, 0, 1);
  await finishFades(page);
  await page.evaluate(() => window.plugin.setClozeActive(true));
  await inProgress(page, 1, 0);
  await finishFades(page);
  await page.locator('.cloze-underlines line').first().waitFor({ state: 'detached' });
});

test('快速点回去时，虚线从当前透明度淡出', async t => {
  const page = await withPage(t, block('fade', kbd('answer', 'answer')), { hide: true });
  const answer = page.locator('#answer');
  await answer.click();
  await inProgress(page, 0, 1);
  await answer.click();
  await page.waitForFunction(() => {
    return document.querySelector('.cloze-underlines').getAnimations({ subtree: true }).some(item => {
      const points = item.effect.getKeyframes();
      const from = Number(points[0]?.opacity);
      return from > 0 && from < 1 && Number(points.at(-1)?.opacity) === 0;
    });
  }, undefined, { timeout: 2200 });
  await finishFades(page);
  await page.locator('.cloze-underlines line').first().waitFor({ state: 'detached' });
});

test('系统设置减少动态效果时，虚线不播放动画', async t => {
  const page = await withPage(t, block('fade', kbd('answer', 'answer')), { hide: true, context: { reducedMotion: 'reduce' } });
  const answer = page.locator('#answer');
  const svg = page.locator('.cloze-underlines');
  const lines = svg.locator('line');
  await answer.click();
  await lines.first().waitFor({ state: 'attached' });
  assert.equal(await svg.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
  assert.equal(await lines.first().evaluate(el => getComputedStyle(el.parentElement).opacity), '1');
  await answer.click();
  await lines.first().waitFor({ state: 'detached' });
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
