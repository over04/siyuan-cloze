/**
 * 表格单元格退避的纯函数层。
 *
 * 背景：思源把单元格点开编辑时，openTableCellRichEditor 会用
 * cell.replaceChildren(host) 把 td 整体换成独立的 ProtyleLite，单元格内随即
 * 出现带 data-node-id 的段落块——但那是**临时块，没有持久 ID**（思源在
 * protyle/util/selection.ts 的撤销恢复里明确写着「单元格内部块没有持久 ID」）。
 *
 * 此时若沿用外层文档 protyle 的 setInlineMark，事务会落到那个临时块上，
 * 内核直接 `Transaction failed: block not found` 并回滚：前端 DOM 看着像
 * 加上了 kbd，数据却没落库。实测（SiYuan 3.8.6）复现路径与结论一致。
 *
 * 退避思路：先把单元格编辑器提交掉（finish），等 td 回到可事务化形态，
 * 再按「可见文本偏移」重建选区重执行。本文件只放这一步所需的纯计算，
 * 零依赖（仅用 DOM 标准对象），便于 tests/ 用 jsdom 直接单测。
 */

export const CELL_EDITOR_SELECTOR = '.table__cell-editor';
export const CELL_SELECTOR = 'td, th';
export const RICH_CELL_ATTRIBUTE = 'data-sy-table-cell-rich';

/**
 * 单元格编辑态下承载正文的容器。
 *
 * 退避前内容挂在这里，退避后则由 td 直接承载，两者的可见文本才是同一个东西；
 * 拿整个 td 去算偏移会被编辑器外壳（表格控件按钮等）的文本带偏。
 */
export const CELL_CONTENT_SELECTOR = '.protyle-wysiwyg';

/** 思源在行内元素边界写入的零宽字符（ZWSP / WordJoiner / ZWNBSP）。 */
const ZERO_WIDTH_CHARS = '\u200b\u2060\ufeff';

export const isZeroWidth = (ch: string): boolean => ZERO_WIDTH_CHARS.indexOf(ch) !== -1;

/**
 * 可见文本：剔除零宽字符。
 *
 * 偏移必须锚在用户看得见的文字上——退避前后思源会重建 td，零宽字符的数量
 * 与位置都会漂移，把它们计入偏移会让恢复出来的选区整体跑偏。
 */
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

/** 深度优先收集元素内的文本节点。不用 TreeWalker，免得依赖 NodeFilter 全局。 */
const collectTextNodes = (el: Element, out: Text[] = []): Text[] => {
  el.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(child as Text);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      collectTextNodes(child as Element, out);
    }
  });
  return out;
};

/**
 * 把 (node, offset) 折算成相对 el 起点的「可见文本偏移」。
 * 节点不在 el 内、或 el 为空导致 Range 无法建立时返回 -1。
 */
export const getVisibleOffset = (el: Element, node: Node, offset: number): number => {
  if (el !== node && !el.contains(node)) return -1;

  const probe = document.createRange();
  try {
    probe.setStart(el, 0);
    probe.setEnd(node, offset);
  } catch {
    return -1;
  }
  return visibleText(probe.toString()).length;
};

/**
 * 按可见文本偏移在 el 内重建 Range。
 * 偏移越界、或端点无法落位时返回 null——调用方据此如实提示，不做兜底猜测。
 */
export const createRangeByVisibleOffset = (
  el: Element,
  start: number,
  end: number,
): Range | null => {
  if (start < 0 || end < start) return null;

  const texts = collectTextNodes(el);
  const locate = (target: number): { node: Text; offset: number } | null => {
    let consumed = 0;
    for (const text of texts) {
      const raw = text.textContent || '';
      let visible = 0;
      for (let i = 0; i < raw.length; i++) {
        if (consumed + visible === target) return { node: text, offset: i };
        if (!isZeroWidth(raw[i])) visible += 1;
      }
      if (consumed + visible === target) return { node: text, offset: raw.length };
      consumed += visible;
    }
    return null;
  };

  const from = locate(start);
  const to = locate(end);
  if (!from || !to) return null;

  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
};

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
