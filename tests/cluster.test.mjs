/**
 * 集群判据回归测试。
 *
 * 断言口径：把夹具里所有 kbd 元素按「所属集群」分组，再按成员标签拼成字符串。
 * 于是每个期望值都直接对应需求里写的遮罩范围，例如
 *   [公式] [公式] → (公式) (公式)   期望 ['$A$', '$B$']（两组，各一个成员）
 *   [公式文本 公式] → (公式 文本 公式)  期望 ['$A$文本 $B$']（一组，三个成员）
 *
 * 每个夹具都跑两遍：生产口径（isClozeBridge）必须给出 expect，
 * 旧口径（含 \s，即改前的缺陷版本）必须给出 wrong——保证这个测试真的能抓到该缺陷。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FIXTURES, memberLabel } from './fixtures.mjs';
import { parseBlock, setupDom } from './helpers.mjs';
import { INVISIBLE_TEXT, KBD_SELECTOR, ZW_ONLY_TEXT, getClozeCluster, isClozeBridge } from '../src/cluster.ts';

setupDom();

/** 改前的宽松口径：把真实空白也当成不可见字符。 */
const looseBridge = (node) => {
  if (node.nodeType === Node.TEXT_NODE) {
    return INVISIBLE_TEXT.test(node.textContent || '');
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return node.tagName === 'WBR';
  }
  return false;
};

const parse = parseBlock;

/** 两个成员之间那截没被任何成员覆盖的文本（成员之间只有零宽字符时为空串）。 */
const gapText = (a, b) => {
  let out = '';
  let node = a.nextSibling;
  while (node && node !== b) {
    out += node.textContent || '';
    node = node.nextSibling;
  }
  return out.replace(/[\u200b\u2060\ufeff]/g, '');
};

/** 集群标签：成员标签按 DOM 顺序拼接，中间补上真实的间隙文本。 */
const clusterLabel = (members) =>
  members
    .map((el, i) => (i === 0 ? memberLabel(el) : gapText(members[i - 1], el) + memberLabel(el)))
    .join('');

/** 返回每个集群的标签，按字符串排序，便于与期望值直接比对。 */
const clusters = (html, isBridge) => {
  const block = parse(html);
  const kbds = Array.from(block.querySelectorAll(KBD_SELECTOR));
  const groups = new Map();

  for (const kbd of kbds) {
    const members = getClozeCluster(kbd, isBridge);
    const key = members.map((el) => kbds.indexOf(el)).join(',');
    if (!groups.has(key)) groups.set(key, members);
  }

  return Array.from(groups.values()).map(clusterLabel).sort();
};

for (const fixture of FIXTURES) {
  test(`改后 ${fixture.name}`, () => {
    assert.deepEqual(clusters(fixture.dom, isClozeBridge), fixture.expect);
  });

  test(`改前（宽松口径）复现缺陷 ${fixture.name}`, () => {
    assert.deepEqual(clusters(fixture.dom, looseBridge), fixture.wrong);
  });
}

test('桥接判据：只有纯零宽字符才是桥', () => {
  const mk = (text) => {
    const node = document.createTextNode(text);
    return node;
  };

  assert.equal(isClozeBridge(mk('\u200b')), true);
  assert.equal(isClozeBridge(mk('\u200b\u2060\ufeff')), true);
  assert.equal(isClozeBridge(mk('\u200b \u200b')), false, '切片间隙里出现普通空格必须断簇');
  assert.equal(isClozeBridge(mk('\u200b      \u200b')), false);
  assert.equal(isClozeBridge(mk(' ')), false);

  // 宽松口径与生产口径的唯一差别就是这一处，光标归属判定仍依赖它
  assert.equal(looseBridge(mk('\u200b \u200b')), true);
  assert.equal(ZW_ONLY_TEXT.test('\u200b \u200b'), false);
  assert.equal(ZW_ONLY_TEXT.test('\u200b\u2060\ufeff'), true);
  assert.equal(INVISIBLE_TEXT.test('\u200b \u200b'), true);
});

test('kbd 选择器用 ~= 语义，不会误匹配 kbdish / kbd-span', () => {
  const block = parse('<span data-type="kbdish">a</span><span data-type="kbd-span">b</span><span data-type="kbd">c</span>');
  assert.equal(block.querySelectorAll(KBD_SELECTOR).length, 1);
});
