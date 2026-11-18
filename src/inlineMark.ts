import { BLOCK_SELECTOR, BODY_SELECTOR, isKbd, isMath, resolveClozeBody } from './cluster';
import { visibleText } from './tableCell';

type Interval = [start: number, end: number];
interface MaskSnapshot {
  content: string;
  marks: Interval[];
  selection?: Interval;
}

// 思源会把段落末尾的换行留在标记之外，不计入可挖空内容。
const logicalText = (text: string) => visibleText(text).replace(/[\r\n]/g, '');

/** 记录 kbd 覆盖的正文位置，忽略重建时可变的包装、语义零宽标记与公式渲染 DOM。 */
export function snapshotInlineMask(block: HTMLElement, range?: Range): MaskSnapshot {
  const marks: Interval[] = [];
  let content = '';
  let from: number | undefined;
  let to: number | undefined;
  const note = (node: Node, offset: number, position = content.length) => {
    if (range?.startContainer === node && range.startOffset === offset) from = position;
    if (range?.endContainer === node && range.endOffset === offset) to = position;
  };
  const append = (text: string, marked: boolean) => {
    const start = content.length;
    content += text;
    if (!marked || !text.length) return;
    const last = marks.at(-1);
    if (last?.[1] === start) last[1] = content.length;
    else marks.push([start, content.length]);
  };
  const walk = (node: Node, marked: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (range?.startContainer === node) note(node, range.startOffset, content.length + logicalText(text.slice(0, range.startOffset)).length);
      if (range?.endContainer === node) note(node, range.endOffset, content.length + logicalText(text.slice(0, range.endOffset)).length);
      append(logicalText(text), marked);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element !== block && element.matches(BLOCK_SELECTOR + ', ' + BODY_SELECTOR + ', .protyle-attr, .cloze-underlines, img, .img')) return;
    marked ||= isKbd(node);
    if (isMath(node)) {
      if (range && node.contains(range.startContainer)) from = content.length;
      append(String.fromCharCode(0xfffc), marked);
      if (range && node.contains(range.endContainer)) to = content.length;
      return;
    }
    let index = 0;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      note(node, index++);
      walk(child, marked);
    }
    note(node, index);
  };
  walk(block, false);
  return { content, marks, selection: from !== undefined && to !== undefined && from < to ? [from, to] : undefined };
}

/** 当前正文中的同一块；同 ID 多副本且无法唯一定位时，不猜哪个副本是操作结果。 */
export function currentInlineBlock(body: HTMLElement, original: HTMLElement, id: string): HTMLElement | null {
  if (!body.isConnected) return null;
  if (original.isConnected && resolveClozeBody(original) === body && original.getAttribute('data-node-id') === id) return original;
  const candidates = [...body.querySelectorAll<HTMLElement>('[data-node-id="' + CSS.escape(id) + '"]:not(span)')]
    .filter(block => resolveClozeBody(block) === body);
  return candidates.length === 1 ? candidates[0] : null;
}

/** 只接受目标位置恰好发生预期变化；不能拿节点数量或旧节点是否还在当事务回执。 */
export function appliedInlineMask(before: MaskSnapshot, after: MaskSnapshot, remove: boolean): boolean {
  if (!before.selection || before.content !== after.content) return false;
  const [start, end] = before.selection;
  const expected: Interval[] = [];
  if (remove) {
    for (const [a, b] of before.marks) {
      if (a < start) expected.push([a, Math.min(b, start)]);
      if (b > end) expected.push([Math.max(a, end), b]);
    }
  } else {
    for (const [a, b] of [...before.marks, before.selection].sort((x, y) => x[0] - y[0])) {
      const last = expected.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else expected.push([a, b]);
    }
  }
  const same = (a: Interval[], b: Interval[]) => a.length === b.length && a.every(([x, y], i) => x === b[i][0] && y === b[i][1]);
  return !same(before.marks, expected) && same(after.marks, expected);
}
