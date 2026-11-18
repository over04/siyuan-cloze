/** 表格选区与挖空快捷键测试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WJ, ZW, setupDom } from './helpers.mjs';
import {
  cellEditableRanges,
  closestCellEditor,
  closestTableCell,
  isRichCell,
  isZeroWidth,
  matchHotkey,
  parseHotkeyBindings,
  resolveHotkeyBindings,
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

test('closestTableCell：支持表头与表体，使用最近的单元格', () => {
  const head = document.createElement('th');
  head.textContent = '标题';
  const cell = editingCell('<span>答案</span>');
  assert.equal(closestTableCell(head.firstChild), head);
  assert.equal(closestTableCell(cell.querySelector('span').firstChild), cell);
  assert.equal(closestTableCell(null), null);
});

function cellBody() {
  const cell = editingCell('<div class="protyle-wysiwyg">' +
    '<div data-node-id="one"><div contenteditable="true">首段答案</div></div>' +
    '<div data-node-id="two"><div contenteditable="true">中间内容</div></div>' +
    '<div data-node-id="code" data-type="NodeCodeBlock"><div contenteditable="true">代码</div></div>' +
    '<div data-node-id="three"><div contenteditable="true">最后一段</div></div></div>');
  return cell.querySelector('.protyle-wysiwyg');
}

test('cellEditableRanges：按正文块分开选区，保留首尾边界', () => {
  const body = cellBody();
  const range = document.createRange();
  range.setStart(body.firstElementChild.firstElementChild.firstChild, 2);
  range.setEnd(body.lastElementChild.firstElementChild.firstChild, 2);
  assert.deepEqual(cellEditableRanges(body, range).map(item => [item.block.dataset.nodeId, item.range.toString()]),
    [['one', '答案'], ['two', '中间内容'], ['three', '最后']]);
});

test('cellEditableRanges：光标落在段内时只返回当前段', () => {
  const body = cellBody();
  const range = document.createRange();
  const text = body.children[1].firstElementChild.firstChild;
  range.setStart(text, 1);
  range.collapse(true);
  const items = cellEditableRanges(body, range);
  assert.equal(items.length, 1);
  assert.equal(items[0].block.dataset.nodeId, 'two');
  assert.equal(items[0].range.startContainer, text);
  assert.equal(items[0].range.startOffset, 1);
});

// 单元格子编辑器不分发插件快捷键，插件自行匹配按键。

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

test('默认快捷键：⇧⌘C 创建、⌥⇧X 显隐', () => {
  const cKey = (over) => keyEvent({ key: 'C', code: 'KeyC', shiftKey: true, ...over });
  assert.equal(matchHotkey('⇧⌘C', cKey({ metaKey: true }), true), true);
  assert.equal(matchHotkey('⇧⌘C', cKey({ ctrlKey: true }), false), true);
  assert.equal(matchHotkey('⇧⌘C', cKey({ metaKey: true, altKey: true }), true), false);

  const xKey = keyEvent({ key: 'X', code: 'KeyX', altKey: true, shiftKey: true });
  assert.equal(matchHotkey('⌥⇧X', xKey, true), true);
  assert.equal(matchHotkey('⌥⇧X', xKey, false), true);
  assert.equal(matchHotkey('⌥⇧X', keyEvent({ key: 'X', code: 'KeyX', altKey: true }), false), false);
});

test('resolveHotkeyBindings 区分未配置与显式清空', () => {
  assert.deepEqual(resolveHotkeyBindings(undefined, '⇧⌘C'), ['⇧⌘C']);
  assert.deepEqual(resolveHotkeyBindings(null, '⇧⌘C'), ['⇧⌘C']);
  assert.deepEqual(resolveHotkeyBindings({ custom: '' }, '⇧⌘C'), []);
  assert.deepEqual(resolveHotkeyBindings({ bindings: { version: 1, keys: [] } }, '⇧⌘C'), []);
  assert.deepEqual(resolveHotkeyBindings({ custom: '⌥K' }, '⇧⌘C'), ['⌥K']);
});

test('工具栏项默认键位与唯一创建入口写死在插件源码里', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');

  assert.match(source, /hotkey: '⇧⌘C'/, '创建/取消默认键必须是 ⇧⌘C');
  assert.match(source, /hotkey: '⌥⇧X'/, '全局显隐默认键必须是 ⌥⇧X');
  assert.match(source, /name: 'cloze'/, '必须注册工具栏入口');
  assert.doesNotMatch(source, /langKey: 'createCloze'/, '创建动作不得再注册成第二条命令');
  assert.doesNotMatch(source, /ensureTopBarCreate/, '不得再注册顶栏或菜单兜底入口');
  assert.match(source, /protyle = protyle\?\.protyle \?\? protyle;/, '桌面 Protyle 实例必须归一成 IProtyle');
  assert.match(source, /data-plugin-toolbar="true"\]\[data-type="cloze"\]/, '移动端必须接管插件工具栏按钮');
  assert.match(source, /#keyboardToolbar/, '移动端按钮必须限定在键盘工具栏');
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
