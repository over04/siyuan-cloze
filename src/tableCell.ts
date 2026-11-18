import { resolveClozeBlock, resolveClozeBody, resolveElement } from './cluster.ts';

export const CELL_EDITOR_SELECTOR = '.table__cell-editor';
export const CELL_SELECTOR = 'td, th';
export const RICH_CELL_ATTRIBUTE = 'data-sy-table-cell-rich';

export const closestTableCell = (node: Node | null): HTMLTableCellElement | null =>
  resolveElement(node)?.closest<HTMLTableCellElement>(CELL_SELECTOR) ?? null;

/** 一段选区可覆盖单元格里的多个段落或列表项。每个原生格式操作只接收一个正文块。 */
export function cellEditableRanges(body: HTMLElement, range: Range): { block: HTMLElement; range: Range }[] {
  const ranges: { block: HTMLElement; range: Range }[] = [];
  for (const content of body.querySelectorAll<HTMLElement>('[contenteditable="true"]')) {
    if (resolveClozeBody(content) !== body || !range.intersectsNode(content)) continue;
    const block = resolveClozeBlock(content);
    if (!block || !body.contains(block) || block.dataset.type === 'NodeCodeBlock') continue;
    const segment = content.ownerDocument.createRange();
    segment.selectNodeContents(content);
    if (range.comparePoint(segment.startContainer, segment.startOffset) < 0) segment.setStart(range.startContainer, range.startOffset);
    if (range.comparePoint(segment.endContainer, segment.endOffset) > 0) segment.setEnd(range.endContainer, range.endOffset);
    if (!segment.collapsed || content.contains(range.startContainer)) ranges.push({ block, range: segment });
  }
  return ranges;
}

/** 思源在行内元素边界写入的零宽字符（ZWSP / WordJoiner / ZWNBSP）。 */
const ZERO_WIDTH_CHARS = '\u200b\u2060\ufeff';

export const isZeroWidth = (ch: string): boolean => ZERO_WIDTH_CHARS.indexOf(ch) !== -1;

/** 去掉思源为行内标记插入的零宽字符。 */
export const visibleText = (value: string): string => {
  let out = '';
  for (const ch of value) {
    if (!isZeroWidth(ch)) out += ch;
  }
  return out;
};

/** 节点是否落在单元格编辑器（ProtyleLite）内。 */
export const closestCellEditor = (node: Node | null): HTMLElement | null => {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  return el ? el.closest<HTMLElement>(CELL_EDITOR_SELECTOR) : null;
};

/** 单元格是否已是 rich 形态：复杂内容已持久化，外层事务不适用。 */
export const isRichCell = (cell: Element | null): boolean =>
  Boolean(cell && cell.hasAttribute(RICH_CELL_ATTRIBUTE));

/* ==========================================================================
   快捷键：单元格编辑态下的兜底分发

   思源的编辑器快捷键处理器（commonHotkey → dispatchPluginShortcut）绑在**外层**
   .protyle-wysiwyg 上，而单元格编辑器只把键盘事件转发到 owner.element（protyle
   根元素，.protyle-wysiwyg 的祖先）——转发事件根本不经过那个监听点，插件命令
   因此永远不被分发，表现为「按了快捷键毫无反应、连提示都没有」。
   同时 ProtyleLite 自身 pluginExtensions: false，也不会代分发插件快捷键。

   所以单元格场景必须由插件自己在捕获阶段接管。这里只做「匹配 + 判定」，
   不碰 DOM，便于单测。
   ========================================================================== */

/** matchHotkey 需要的最小事件形状，便于在 jsdom 里构造。 */
export interface HotkeyEvent {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export const isMacPlatform = (): boolean =>
  /Mac|iPod|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '');

/**
 * 取出一条快捷键绑定对应的字符串列表。
 *
 * 与思源 util/keymapBindings.ts 的口径一致：新版是 bindings.keys 数组，
 * 旧版是单个 custom 字符串；两者都没有就返回空数组，由调用方回落到默认键。
 */
export const parseHotkeyBindings = (keymap: unknown): string[] => {
  if (!keymap || typeof keymap !== 'object') return [];
  const item = keymap as {
    custom?: unknown;
    bindings?: { version?: unknown; keys?: unknown };
  };

  if (item.bindings && typeof item.bindings === 'object') {
    if (item.bindings.version !== 1 || !Array.isArray(item.bindings.keys)) return [];
    return [
      ...new Set(item.bindings.keys.filter((k): k is string => typeof k === 'string' && k.length > 0)),
    ];
  }
  return typeof item.custom === 'string' && item.custom ? [item.custom] : [];
};

/**
 * 取实际生效的快捷键。
 *
 * 只有 keymap 项不存在时才回落默认键；显式清空绑定（custom: '' 或空 keys）
 * 表示用户禁用了这个动作，不能把默认键重新塞回去。
 */
export const resolveHotkeyBindings = (keymap: unknown, fallback: string): string[] =>
  keymap === undefined || keymap === null ? [fallback] : parseHotkeyBindings(keymap);

/** 主键比对：先比 event.key，再退到 event.code（⌥ 组合在部分平台会改写 key）。 */
const matchesMainKey = (main: string, event: HotkeyEvent): boolean => {
  const upper = main.toUpperCase();
  const evKey = (event.key || '').toUpperCase();
  const evCode = (event.code || '').toUpperCase();

  if (evKey === upper) return true;
  if (/^[A-Z]$/.test(upper) && evCode === `KEY${upper}`) return true;
  if (/^[0-9]$/.test(upper) && evCode === `DIGIT${upper}`) return true;
  if (/^F([1-9]|1[0-2])$/.test(upper) && evCode === upper) return true;

  const named: Record<string, string> = {
    '↑': 'ARROWUP',
    '↓': 'ARROWDOWN',
    '←': 'ARROWLEFT',
    '→': 'ARROWRIGHT',
    '空格': 'SPACE',
    SPACE: 'SPACE',
    '回车': 'ENTER',
    ENTER: 'ENTER',
    '退格': 'BACKSPACE',
    '删除': 'DELETE',
    ESC: 'ESCAPE',
    TAB: 'TAB',
    HOME: 'HOME',
    END: 'END',
    PAGEUP: 'PAGEUP',
    PAGEDOWN: 'PAGEDOWN',
  };
  return Boolean(named[upper]) && evCode === named[upper];
};

/**
 * 匹配思源格式的快捷键字符串（如 ⇧⌘C、⌘⇧F、⌃D）。
 *
 * 口径对齐思源 util/keymapBindings.normalizeShortcutKey：非 mac 平台把 ⌃ 前缀
 * 归一成 ⌘ 语义；而 ⌘ 在非 mac 上落到 ctrlKey、在 mac 上落到 metaKey。
 */
export const matchHotkey = (hotkey: string, event: HotkeyEvent, isMac: boolean): boolean => {
  if (!hotkey) return false;

  let key = hotkey;
  if (!isMac && key.startsWith('⌃')) {
    if (key === '⌃D') return false;
    key = key
      .replace('⌘', '')
      .replace('⌃', '⌘')
      .replace('⌘⇧', '⇧⌘')
      .replace('⌘⌥⇧', '⌥⇧⌘')
      .replace('⌘⌥', '⌥⌘');
  }

  let needCtrl = false;
  let needAlt = false;
  let needShift = false;
  let needMeta = false;
  let i = 0;
  while (i < key.length && '⌃⌥⇧⌘'.indexOf(key[i]) !== -1) {
    const ch = key[i];
    if (ch === '⌃') needCtrl = true;
    else if (ch === '⌥') needAlt = true;
    else if (ch === '⇧') needShift = true;
    else if (ch === '⌘') needMeta = true;
    i += 1;
  }

  const main = key.slice(i);
  if (!main) return false;

  const expectCtrl = needCtrl || (!isMac && needMeta);
  const expectMeta = isMac && needMeta;

  if (Boolean(event.ctrlKey) !== expectCtrl) return false;
  if (Boolean(event.altKey) !== needAlt) return false;
  if (Boolean(event.shiftKey) !== needShift) return false;
  if (Boolean(event.metaKey) !== expectMeta) return false;

  return matchesMainKey(main, event);
};
