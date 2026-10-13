/**
 * 行内挖空的集群算法。
 *
 * 独立成模块的原因：这套判据是插件的行为核心，必须能被 tests/ 用真实 DOM 直接单测，
 * 而 src/index.ts 依赖思源运行时（Plugin 基类），无法在 Node 里加载。
 * 本文件零依赖，只用到 DOM 标准对象（Node / document）。
 */

/**
 * 零宽字符正则：思源在行内元素边界写入的 ZWSP(\u200b)、WordJoiner(\u2060)、
 * ZWNBSP(\ufeff)。它们的 Unicode 类别为 Cf，String.prototype.trim() 不会移除，
 * 必须显式匹配，否则集群扫描会在遇到第一个零宽字符时立即中断。
 *
 * 这里刻意**不含 \s**：真实空白是可见内容，正是「两次划选＝两个遮罩」的唯一判据。
 * 一次挖空被行内公式切成多个 kbd 切片时，切片之间只会有零宽字符——Lute 的
 * renderKbdOpenMarker 只写 \u2060、renderKbdCloseMarker 只写 \u200b，且 kbd 内部
 * 关闭 AutoSpace，空白一律留在切片内部（见 lute test/spin_block_test.go:186/232）。
 * 因此「切片之间出现真实空白」必然意味着那是两个互不相干的挖空标记。
 */
export const ZW_ONLY_TEXT = /^[\u200b\u2060\ufeff]*$/u;

/**
 * 宽松口径：连真实空白也算不可见。只用于「光标停在 kbd 紧邻的边界文本节点上」
 * 这一处归属判定，让遮罩右侧还带一个空格时 ⌥Q 依然点入即撤。
 */
export const INVISIBLE_TEXT = /^[\s\u200b\u2060\ufeff]*$/u;

export const KBD_SELECTOR = 'span[data-type~="kbd"]';
export const MATH_SELECTOR = 'span[data-type~="inline-math"]';

/** 悬停/划选时加在整簇每个成员上的显晓类，由 index.scss 的 :not() 反向生效。 */
export const REVEAL_CLASS = 'sy-cloze-reveal';

export const isKbd = (node: Node): node is HTMLElement =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).matches(KBD_SELECTOR);

export const isMath = (node: Node): node is HTMLElement =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).matches(MATH_SELECTOR);

/**
 * 桥接判据（不中断扫描）：
 *   - 纯零宽字符文本节点（ZWSP / WordJoiner / ZWNBSP）
 *   - WBR 换行提示元素
 * 除此之外的一切内容——包括一个普通空格——都视为可见内容并立即断簇。
 */
export const isClozeBridge = (node: Node): boolean => {
  if (node.nodeType === Node.TEXT_NODE) {
    return ZW_ONLY_TEXT.test(node.textContent || '');
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return (node as HTMLElement).tagName === 'WBR';
  }
  return false;
};

/**
 * 计算与指定挖空块相连的完整集群（防拆分核心）。
 *
 * 思源会把一次挖空拆成多个 kbd 切片（行内公式是原子节点，kbd 无法跨越它；
 * Markdown 序列化又会丢弃一切自定义属性），因此集群只能依据
 * 「DOM 可见内容的连续性」在渲染层重建，绝不依赖任何持久化属性。
 *
 * 成员规则：
 *   - kbd 元素直接入列并继续向两侧延伸；
 *   - 行内公式先挂起，只有在其之后（同方向）又遇到 kbd 时才入列，
 *     即「被两侧 kbd 夹住」的公式才算集群成员。
 *
 * 公式必须入列：否则悬停联动类永远加不到公式上，会出现
 * 「悬停左侧公式整簇显晓、悬停右侧 kbd 只有 kbd 显晓」的单向缺陷。
 *
 * 断簇条件：遇到任何既非 kbd、也非桥接的内容立即终止。真实空白同样算可见
 * 内容——这正是「分两次创建就是两个遮罩」的判据：两次划选之间没被选中的
 * 内容（哪怕只是一个空格）会把这个位置切开，于是得到两个互不牵连的集群。
 *
 * @param isBridge 桥接判据。默认即生产口径（isClozeBridge）；tests/ 会显式传入
 *                 含 \s 的旧口径，用于锁死「宽松口径会把两个遮罩并成一簇」这一缺陷。
 */
export const getClozeCluster = (
  startKbd: HTMLElement,
  isBridge: (node: Node) => boolean = isClozeBridge,
): HTMLElement[] => {
  if (!startKbd.closest('[data-node-id]')) return [startKbd];

  const collect = (direction: 'prev' | 'next'): HTMLElement[] => {
    const found: HTMLElement[] = [];
    const pendingMath: HTMLElement[] = [];
    let curr: Node | null = startKbd;

    while (curr) {
      curr = direction === 'prev' ? curr.previousSibling : curr.nextSibling;
      if (!curr) break;
      if (isBridge(curr)) continue;

      if (isKbd(curr)) {
        found.push(...pendingMath);
        pendingMath.length = 0;
        found.push(curr);
        continue;
      }

      if (isMath(curr)) {
        pendingMath.push(curr);
        continue;
      }

      break;
    }

    return found;
  };

  const left = collect('prev').reverse();
  const right = collect('next');
  return [...left, startKbd, ...right];
};

/**
 * 沿兄弟节点方向扫描，跳过纯零宽字符文本与 WBR，返回遇到的第一个 kbd；
 * 遇到任何其他内容（含真实空白）立即终止。与 getClozeCluster 的桥接口径一致。
 */
export const scanAdjacentCloze = (from: Node, direction: 'prev' | 'next'): HTMLElement | null => {
  let curr: Node | null = from;
  while (curr) {
    curr = direction === 'prev' ? curr.previousSibling : curr.nextSibling;
    if (!curr) return null;
    if (curr.nodeType === Node.TEXT_NODE) {
      if (ZW_ONLY_TEXT.test(curr.textContent || '')) continue;
      return null;
    }
    if (curr.nodeType === Node.ELEMENT_NODE) {
      const el = curr as HTMLElement;
      if (el.tagName === 'WBR') continue;
      return el.matches(KBD_SELECTOR) ? el : null;
    }
    return null;
  }
  return null;
};

/**
 * 从鼠标命中的任意节点解析出所属集群的锚点 kbd。
 *
 * 覆盖两种情况：
 *   1. 直接命中 kbd 切片（含被标记为 inline-math kbd 的行内公式）；
 *   2. 命中「被两侧 kbd 夹住」的行内公式。
 *
 * 未被夹住的独立公式不归属任何集群——否则鼠标划过普通公式时会连带显晓
 * 其相邻挖空的答案，在背诵模式下造成信息泄漏。
 */
export const resolveClozeAnchor = (node: Node | null): HTMLElement | null => {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (!el) return null;

  const direct = el.closest<HTMLElement>(KBD_SELECTOR);
  if (direct) return direct;

  const math = el.closest<HTMLElement>(MATH_SELECTOR);
  if (!math) return null;

  const prevKbd = scanAdjacentCloze(math, 'prev');
  const nextKbd = scanAdjacentCloze(math, 'next');
  return prevKbd && nextKbd ? prevKbd : null;
};

/** 把任意节点解析成元素（文本节点取其父元素）。 */
export const resolveElement = (node: Node | null): HTMLElement | null => {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
  return node.parentElement;
};

/**
 * 找出与划选范围相交的第一个挖空块。
 *
 * 先看起止是否直接落在 kbd 内（最快路径），再退回到块内逐个求交，
 * 覆盖「选区横跨遮罩、起止都落在遮罩外面」这种情形。
 */
export const findKbdInRange = (range: Range, block: Element | null): HTMLElement | null => {
  const startKbd = resolveElement(range.startContainer)?.closest<HTMLElement>(KBD_SELECTOR);
  if (startKbd) return startKbd;

  const endKbd = resolveElement(range.endContainer)?.closest<HTMLElement>(KBD_SELECTOR);
  if (endKbd) return endKbd;

  const scope: ParentNode = block || document;
  const kbds = scope.querySelectorAll<HTMLElement>(KBD_SELECTOR);
  for (let i = 0; i < kbds.length; i++) {
    try {
      if (range.intersectsNode(kbds[i])) return kbds[i];
    } catch {
      continue;
    }
  }
  return null;
};
