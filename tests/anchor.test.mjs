/**
 * 集群算法其余导出面的回归测试：锚点解析、邻居扫描、节点解析、选区求交，
 * 以及 JS 与 CSS 之间的契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZW, WJ, parseBlock, setupDom } from './helpers.mjs';
import {
  KBD_SELECTOR,
  MATH_SELECTOR,
  REVEAL_CLASS,
  findClustersInRange,
  findKbdInRange,
  isKbd,
  isMath,
  resolveClozeAnchor,
  resolveElement,
  scanAdjacentCloze,
} from '../src/cluster.ts';

setupDom();

const kbd = (text) => `<span data-type="kbd">${WJ}${text}</span>`;
const maskedMath = (content) =>
  `<span data-type="kbd inline-math" data-subtype="math" data-content="${content}" contenteditable="false" class="render-node">${WJ}</span>`;
const bareMath = (content) =>
  `<span data-type="inline-math" data-subtype="math" data-content="${content}" contenteditable="false" class="render-node"></span>`;

test('isKbd / isMath：被挖空的行内公式两边都算', () => {
  const block = parseBlock(maskedMath('A') + bareMath('B') + kbd('文本') + '<span data-type="inline-mathx">c</span>');
  const [masked, bare, text, decoy] = Array.from(block.children);

  assert.equal(isKbd(masked), true);
  assert.equal(isMath(masked), true);
  assert.equal(isKbd(bare), false, '未标记的公式不是 kbd');
  assert.equal(isMath(bare), true);
  assert.equal(isKbd(text), true);
  assert.equal(isMath(text), false);
  assert.equal(isKbd(masked.firstChild), false, '文本节点不算 kbd');
  assert.equal(decoy.matches(MATH_SELECTOR), false, 'MATH_SELECTOR 不能误匹配 inline-mathx');
});

test('scanAdjacentCloze：纯零宽字符与 WBR 可以跨越', () => {
  const next = (after) => scanAdjacentCloze(parseBlock(`<i>a</i>${after}`).firstChild, 'next');
  const prev = (before) => scanAdjacentCloze(parseBlock(`${before}<i>a</i>`).lastChild, 'prev');

  assert.ok(next(ZW + kbd('1'))?.matches(KBD_SELECTOR));
  assert.ok(next('<wbr>' + kbd('1'))?.matches(KBD_SELECTOR));
  assert.ok(next(kbd('1'))?.matches(KBD_SELECTOR), '紧邻的 kbd 直接命中');
  assert.ok(prev(kbd('1') + ZW)?.matches(KBD_SELECTOR));
  assert.ok(prev(kbd('1'))?.matches(KBD_SELECTOR));
});

test('scanAdjacentCloze：真实空白与普通元素立即终止', () => {
  const next = (after) => scanAdjacentCloze(parseBlock(`<i>a</i>${after}`).firstChild, 'next');

  assert.equal(next(' ' + kbd('1')), null, '一个空格就必须断');
  assert.equal(next('      ' + kbd('1')), null);
  assert.equal(next('<b>b</b>' + kbd('1')), null);
  assert.equal(next(''), null, '没有下一个兄弟节点');
});

test('resolveClozeAnchor：命中 kbd 直接返回自身', () => {
  const block = parseBlock(kbd('1') + maskedMath('A'));
  const textSlice = block.children[0];
  const mathSlice = block.children[1];

  assert.equal(resolveClozeAnchor(textSlice), textSlice);
  assert.equal(resolveClozeAnchor(textSlice.firstChild), textSlice, '命中切片内部文本也回到 kbd');
  assert.equal(resolveClozeAnchor(mathSlice), mathSlice, '被挖空的公式自己就是 kbd');
  assert.equal(resolveClozeAnchor(null), null);
});

test('resolveClozeAnchor：被两侧 kbd 夹住的无标记公式归属左侧 kbd', () => {
  const block = parseBlock(kbd('1') + ZW + bareMath('x') + ZW + kbd('2'));
  const math = block.children[1];

  assert.equal(resolveClozeAnchor(math), block.children[0]);
});

test('resolveClozeAnchor：夹心位置出现真实空白就不再归属任何集群（防答案泄漏）', () => {
  const block = parseBlock(kbd('1') + ' ' + bareMath('x') + ' ' + kbd('2'));

  assert.equal(resolveClozeAnchor(block.children[1]), null);
});

test('resolveClozeAnchor：未被夹住的无标记公式不归属任何集群', () => {
  const block = parseBlock(`<i>t</i>${bareMath('x')}<i>t</i>`);

  assert.equal(resolveClozeAnchor(block.children[1]), null);
});

test('resolveElement：元素取自身，文本节点取父元素', () => {
  const block = parseBlock(kbd('1'));
  const span = block.firstChild;

  assert.equal(resolveElement(span), span);
  assert.equal(resolveElement(span.firstChild), span);
  assert.equal(resolveElement(block), block);
  assert.equal(resolveElement(null), null);
});

test('findKbdInRange：起点落在 kbd 内直接命中', () => {
  const block = parseBlock(kbd('1') + ' 2');
  const range = document.createRange();
  const text = block.firstChild.firstChild;
  range.setStart(text, 0);
  range.setEnd(text, 1);

  assert.equal(findKbdInRange(range, block), block.firstChild);
});

test('findKbdInRange：终点落在 kbd 内也命中', () => {
  const block = parseBlock(kbd('1') + ' 2' + kbd('3'));
  const range = document.createRange();
  range.setStart(block.childNodes[1], 0);
  range.setEnd(block.childNodes[2].firstChild, 1);

  assert.equal(findKbdInRange(range, block), block.childNodes[2]);
});

test('findKbdInRange：起止都在遮罩外时靠 intersectsNode 兜底', () => {
  const block = parseBlock(kbd('1') + ' 2');
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(block, block.childNodes.length);

  assert.equal(findKbdInRange(range, block), block.firstChild);
});

test('findKbdInRange：选区完全不碰 kbd 时返回 null', () => {
  const block = parseBlock(kbd('1') + ' 2');
  const range = document.createRange();
  const tail = block.lastChild;
  range.setStart(tail, 1);
  range.setEnd(tail, 2);

  assert.equal(findKbdInRange(range, block), null);
});

test('findClustersInRange：一次返回选区内的全部遮罩簇', () => {
  const block = parseBlock(kbd('1') + ' 2 ' + kbd('3'));
  const range = document.createRange();
  range.setStart(block.firstChild.firstChild, 0);
  range.setEnd(block.lastChild.firstChild, 1);

  const clusters = findClustersInRange(range, block);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0][0], block.children[0]);
  assert.equal(clusters[1][0], block.children[1]);
});

test('findClustersInRange：选区不碰遮罩时返回空数组', () => {
  const block = parseBlock(kbd('1') + ' 2 ' + kbd('3'));
  const range = document.createRange();
  range.setStart(block.childNodes[1], 1);
  range.setEnd(block.childNodes[1], 2);

  assert.deepEqual(findClustersInRange(range, block), []);
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scss = fs.readFileSync(path.join(repoRoot, 'src/index.scss'), 'utf8');

test('JS 与 CSS 的契约：显晓类名与遮蔽选择器必须一致', () => {
  assert.ok(scss.includes(`:not(.${REVEAL_CLASS})`), 'index.scss 必须用 :not(显晓类) 反向失效遮蔽');
  assert.ok(scss.includes(KBD_SELECTOR), 'index.scss 的遮蔽选择器必须与 KBD_SELECTOR 一致');
});
