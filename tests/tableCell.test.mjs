/**
 * 表格单元格退避的纯函数层回归测试。
 *
 * 断言口径：偏移一律锚在**可见文本**（剔除 ZWSP / WordJoiner / ZWNBSP）上，
 * 因为退避前后思源会重建 td，零宽字符的数量与位置都会漂移；用 range.toString()
 * 直接比对会被这些不可见字符污染，所以断言前统一过一遍 visibleText()。
 *
 * 覆盖两层：
 *   1. 形态判定——closestCellEditor 只认 .table__cell-editor（编辑态），
 *      内联态单元格必须落空，否则插件会对着正常单元格走退避分支；
 *   2. 偏移往返——getVisibleOffset 与 createRangeByVisibleOffset 必须互逆，
 *      这是退避后能把选区原样找回来的唯一依据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WJ, ZW, setupDom } from './helpers.mjs';
import {
  closestCellEditor,
  createRangeByVisibleOffset,
  getVisibleOffset,
  isRichCell,
  isZeroWidth,
  matchHotkey,
  parseHotkeyBindings,
  visibleText,
} from '../src/tableCell.ts';

setupDom();

const ZWNBSP = '\ufeff';

/** 内联形态单元格：td 里是裸文本（内核实测的真实预览态形态）。 */
const inlineCell = (html) => {
  const td = document.createElement('td');
  td.innerHTML = html;
  return td;
};

/** 编辑态单元格：td 里挂 ProtyleLite 宿主，与 openTableCellRichEditor 的结果同构。 */
const editingCell = (inner) => {
  const td = document.createElement('td');
  const host = document.createElement('div');
  host.className = 'table__cell-editor';
  host.innerHTML = inner;
  td.appendChild(host);
  return td;
};

test('visibleText 剔除三类零宽字符，保留真实空白', () => {
  assert.equal(visibleText(`${ZW}a${WJ} b${ZWNBSP}`), 'a b');
  assert.equal(visibleText('甲 乙'), '甲 乙');
  assert.equal(visibleText(''), '');
});

test('isZeroWidth 只认思源写入的零宽字符', () => {
  assert.equal(isZeroWidth(ZW), true);
  assert.equal(isZeroWidth(WJ), true);
  assert.equal(isZeroWidth(ZWNBSP), true);
  assert.equal(isZeroWidth(' '), false);
  assert.equal(isZeroWidth('甲'), false);
});

test('closestCellEditor 命中编辑态、放过内联态', () => {
  const editing = editingCell('<div contenteditable="true">甲</div>');
  const inner = editing.querySelector('[contenteditable="true"]').firstChild;
  assert.equal(closestCellEditor(inner)?.className, 'table__cell-editor');
  assert.equal(closestCellEditor(editing.querySelector('div')), editing.querySelector('.table__cell-editor'));

  const inline = inlineCell('甲');
  assert.equal(closestCellEditor(inline.firstChild), null);
  assert.equal(closestCellEditor(null), null);
});

test('isRichCell 只看 data-sy-table-cell-rich', () => {
  const cell = inlineCell('甲');
  assert.equal(isRichCell(cell), false);
  cell.setAttribute('data-sy-table-cell-rich', 'stub');
  assert.equal(isRichCell(cell), true);
  assert.equal(isRichCell(null), false);
});

test('getVisibleOffset 把偏移锚在可见文字上', () => {
  const cell = inlineCell(`${ZW}甲${ZW}乙${ZW}`);
  const text = cell.firstChild;
  // 整段是一个文本节点：\u200b甲\u200b乙\u200b
  assert.equal(getVisibleOffset(cell, text, 0), 0);
  // 越过「零宽 + 甲」→ 可见偏移 1
  assert.equal(getVisibleOffset(cell, text, 2), 1);
  // 走到末尾 → 可见偏移 2
  assert.equal(getVisibleOffset(cell, text, text.textContent.length), 2);
});

test('getVisibleOffset 支持元素节点端点', () => {
  const cell = inlineCell('甲<span>乙</span>');
  const span = cell.querySelector('span');
  assert.equal(getVisibleOffset(cell, span, 0), 1);
  assert.equal(getVisibleOffset(cell, span, 1), 2);
});

test('getVisibleOffset 对单元格外的节点返回 -1', () => {
  const cell = inlineCell('甲');
  const outside = document.createElement('div');
  outside.textContent = '乙';
  assert.equal(getVisibleOffset(cell, outside.firstChild, 0), -1);
});

test('createRangeByVisibleOffset 能跨零宽字符重建选区', () => {
  const cell = inlineCell(`${ZW}甲${ZW}乙${ZW}`);
  const range = createRangeByVisibleOffset(cell, 1, 2);
  assert.ok(range);
  assert.equal(visibleText(range.toString()), '乙');
});

test('多节点内联单元格也能按可见偏移重建', () => {
  const cell = inlineCell(`甲<span data-type="kbd">${WJ}乙</span>`);
  const range = createRangeByVisibleOffset(cell, 0, 2);
  assert.ok(range);
  assert.equal(visibleText(range.toString()), '甲乙');
});

test('偏移往返一致', () => {
  const cell = inlineCell(`${ZW}甲${ZW}乙${ZW}`);
  const range = createRangeByVisibleOffset(cell, 0, 2);
  assert.ok(range);
  assert.equal(getVisibleOffset(cell, range.startContainer, range.startOffset), 0);
  assert.equal(getVisibleOffset(cell, range.endContainer, range.endOffset), 2);
});

test('偏移越界或区间非法时返回 null，不做兜底猜测', () => {
  const cell = inlineCell('甲');
  assert.equal(createRangeByVisibleOffset(cell, 0, 9), null);
  assert.equal(createRangeByVisibleOffset(cell, 2, 1), null);
  assert.equal(createRangeByVisibleOffset(cell, -1, 1), null);
});

test('空单元格无法落位时返回 null', () => {
  const cell = inlineCell('');
  assert.equal(createRangeByVisibleOffset(cell, 0, 0), null);
});

/* 单元格编辑态下思源不会分发插件快捷键，只能由插件在捕获阶段自己匹配，
   所以这套匹配逻辑必须单独锁死。 */

test('parseHotkeyBindings 兼容新旧两种绑定格式', () => {
  assert.deepEqual(parseHotkeyBindings({ custom: '⌥Q' }), ['⌥Q']);
  assert.deepEqual(
    parseHotkeyBindings({ bindings: { version: 1, keys: ['⌥Q', '⌃⇧K', '⌥Q'] } }),
    ['⌥Q', '⌃⇧K'],
  );
  assert.deepEqual(parseHotkeyBindings({ bindings: { version: 2, keys: ['⌥Q'] } }), []);
  assert.deepEqual(parseHotkeyBindings({ custom: '' }), []);
  assert.deepEqual(parseHotkeyBindings(null), []);
});

const keyEvent = (over) => ({
  key: 'q',
  code: 'KeyQ',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
});

test('matchHotkey 按思源口径匹配修饰键', () => {
  assert.equal(matchHotkey('⌥Q', keyEvent({ altKey: true }), false), true);
  assert.equal(matchHotkey('⌥Q', keyEvent({ altKey: true }), true), true);
  assert.equal(matchHotkey('⌥Q', keyEvent({}), false), false);
  assert.equal(matchHotkey('⌥Q', keyEvent({ altKey: true, shiftKey: true }), false), false);
  // ⌥ 组合在部分平台会改写 event.key，靠 event.code 兜底
  assert.equal(matchHotkey('⌥Q', keyEvent({ altKey: true, key: 'º' }), true), true);
});

test('matchHotkey 处理 ⌘ 与 ⌃ 的平台差异', () => {
  const kEvent = (over) => keyEvent({ key: 'k', code: 'KeyK', ...over });
  // mac：⌘ → metaKey
  assert.equal(matchHotkey('⌘K', kEvent({ metaKey: true }), true), true);
  assert.equal(matchHotkey('⌘K', kEvent({ ctrlKey: true }), true), false);
  // 非 mac：⌘ → ctrlKey
  assert.equal(matchHotkey('⌘K', kEvent({ ctrlKey: true }), false), true);
  assert.equal(matchHotkey('⌘K', kEvent({ metaKey: true }), false), false);
  // 非 mac：⌃ 归一成 ⌘ 语义，落到 ctrlKey
  assert.equal(matchHotkey('⌃K', kEvent({ ctrlKey: true }), false), true);
  // mac：⌃ 保持 ctrlKey
  assert.equal(matchHotkey('⌃K', kEvent({ ctrlKey: true }), true), true);
  // 思源对 ⌃D 的特例：非 mac 下不参与匹配
  assert.equal(matchHotkey('⌃D', kEvent({ key: 'd', code: 'KeyD', ctrlKey: true }), false), false);
});

test('matchHotkey 支持功能键与方向键，空主键不匹配', () => {
  const base = { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  assert.equal(matchHotkey('⌥F10', { ...base, key: 'F10', code: 'F10', altKey: true }, false), true);
  assert.equal(matchHotkey('⌥↑', { ...base, key: 'ArrowUp', code: 'ArrowUp', altKey: true }, false), true);
  assert.equal(matchHotkey('', base, false), false);
  assert.equal(matchHotkey('⌥', { ...base, altKey: true }, false), false);
});
