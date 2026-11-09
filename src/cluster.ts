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
 * 这一处归属判定，让遮罩右侧还带一个空格时 ⇧⌘C 依然点入即撤。
 */
export const INVISIBLE_TEXT = /^[\s\u200b\u2060\ufeff]*$/u;

export const KBD_SELECTOR = 'span[data-type~="kbd"]';
export const MATH_SELECTOR = 'span[data-type~="inline-math"]';

/** 簇成员里的行内公式加这个类，遮蔽规则据此把它与 kbd 一起模糊。 */
export const CLUSTER_MATH_CLASS = 'sy-cloze-math';

/** 簇里只剩零宽字符的 kbd 切片加这个类，样式表据此不给它画提示线。 */
export const BLANK_CLASS = 'sy-cloze-blank';

/** 簇内含深公式时写入的下划线垂直下移量（CSS 自定义属性名）。 */
export const LINE_DROP_VAR = '--sy-cloze-line-drop';

/** 划选时加在整簇每个成员上的透晓类，由 index.scss 的 :not() 反向生效。 */
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
 *   - 行内公式先挂起：其后（同方向）又遇到 kbd 时立刻入列，走到头仍未遇到时
 *     也入列——划选范围以公式结尾（或开头）时，公式另一侧本来就没有切片。
 *
 * 公式必须入列：否则整簇透晓类加不到公式上，会出现
 * 「选中左侧公式整簇透晓、选中右侧 kbd 只有 kbd 透晓」的单向缺陷。
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

    // 走到头还没遇到下一个切片：夹在末尾（或开头）的公式仍属于这一簇。
    // 划选范围正好结束在公式上时就是这种形态——Lute 只能把公式写成切片的兄弟，
    // 公式另一侧不会再有切片，丢掉它会让这段答案在背诵态原样露出。
    found.push(...pendingMath);

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
 * 未被夹住的独立公式不归属任何集群——否则点击普通公式时会连带揭晓
 * 其相邻挖空的答案，在背诵模式下造成信息泄漏。
 */
const scanClusterKbd = (from: Node, direction: 'prev' | 'next'): HTMLElement | null => {
  let curr: Node | null = from;
  while (curr) {
    curr = direction === 'prev' ? curr.previousSibling : curr.nextSibling;
    if (!curr) return null;
    if (isClozeBridge(curr) || isMath(curr)) continue;
    if (isKbd(curr)) return curr;
    return null;
  }
  return null;
};

export const resolveClozeAnchor = (node: Node | null): HTMLElement | null => {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (!el) return null;

  const direct = el.closest<HTMLElement>(KBD_SELECTOR);
  if (direct) return direct;

  const math = el.closest<HTMLElement>(MATH_SELECTOR);
  if (!math) return null;

  const prevKbd = scanClusterKbd(math, 'prev');
  const nextKbd = scanClusterKbd(math, 'next');
  if (math.classList.contains(CLUSTER_MATH_CLASS)) {
    return prevKbd || nextKbd;
  }
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

/**
 * 找出与划选范围相交的全部挖空簇，按 DOM 顺序返回。
 *
 * 取消遮罩时一次处理整段选区：用户选中多个遮罩再按快捷键，应当把选中的
 * 都取消，而不是只取消第一个。簇之间可能夹着普通内容，调用方按首尾成员
 * 扩展 Range 后交给 setInlineMark 统一清除。
 */
export const findClustersInRange = (range: Range, block: Element | null): HTMLElement[][] => {
  const scope: ParentNode = block || document;
  const kbds = scope.querySelectorAll<HTMLElement>(KBD_SELECTOR);
  const handled = new Set<HTMLElement>();
  const clusters: HTMLElement[][] = [];

  for (let i = 0; i < kbds.length; i++) {
    const kbd = kbds[i];
    if (handled.has(kbd)) continue;

    let hit = false;
    try {
      hit = range.intersectsNode(kbd);
    } catch {
      hit = false;
    }
    if (!hit) continue;

    const cluster = getClozeCluster(kbd);
    cluster.forEach((el) => handled.add(el));
    clusters.push(cluster);
  }

  return clusters;
};

/* ==========================================================================
   点击揭晓（持久态）
   ========================================================================== */

/**
 * 点击揭晓类的类名。与划选临时透晓 REVEAL_CLASS 相互独立：
 * 划选结束即撤，点击则活到本次文档打开结束。
 */
export const UNVEIL_CLASS = 'sy-cloze-unveiled';

/** 承载揭晓态生命周期的容器：思源每篇打开的文档对应一个 .protyle 根元素。 */
export const PROTYLE_SELECTOR = '.protyle';

/**
 * 从任意节点向上找 protyle 根元素。
 *
 * 揭晓态按这个元素记录：切换页签只是显隐、DOM 不销毁，状态因此得以保留；
 * 文档关闭后元素被移除，记录随之被 GC 回收——「关文档恢复默认遮蔽」
 * 由此零成本成立，不需要任何销毁事件判定。
 */
export const resolveProtyleRoot = (node: Node | null): HTMLElement | null => {
  const el = resolveElement(node);
  if (!el) return null;
  return el.closest<HTMLElement>(PROTYLE_SELECTOR) || el.closest<HTMLElement>('.protyle-wysiwyg');
};

/**
 * 成员文本：公式优先取思源持久化的 data-content，其余取可见文本，剔除零宽字符。
 *
 * data-content 由思源按 Markdown 源码写出，DOM 重建后必然一致；kbd 文本切片没有
 * 这个属性，回落到 textContent。
 */
const memberText = (el: HTMLElement): string => {
  const raw = el.getAttribute('data-content') || el.textContent || '';
  return raw.replace(/[\u200b\u2060\ufeff]/g, '').trim();
};

/** 块内一个簇及其揭晓键。 */
export interface BlockCluster {
  cluster: HTMLElement[];
  key: string;
  /** 簇内全部成员的文本按序拼接。簇内文本被编辑后，靠它认出「还是那一个」。 */
  text: string;
  /** 同一段答案文本在块内出现的次序，用于区分文字完全相同的多个遮罩。 */
  dup: number;
}

/**
 * 一次性算出块内所有簇及其揭晓键，按 DOM 顺序返回。
 *
 * 键 = 块 ID + 该簇全部成员的文本按顺序拼起来 + 同文本出现的次序。
 *
 * 为什么不用「簇首切片在块内的序号」：块内每增删一个遮罩，所有旧序号都会整体
 * 往后挪，记录也就跟着对错了地方。实际遇到的序列——段落 `前言 甲 乙`，点击
 * 「甲」揭晓（记录 `blk#0`），再选中「前言」按 ⇧⌘C 新建遮罩，`blk#0` 就落到了
 * 新遮罩头上：新遮罩一出现就是揭晓状态（背诵时等于直接把答案摆出来），而「甲」
 * 的编号变成 `blk#1`、记录里没有，被回放重新遮蔽。改用答案文本则不受同块内
 * 增删影响，这类错位从根上消失。
 *
 * 末尾的序号用来区分「答案文本完全相同」的多个遮罩：同段落出现重复答案
 * （`填空 填空`）时，两簇的答案文本一模一样，不加序号就会共用同一条记录——
 * 点第二个会把第一个的记录删掉，屏幕上却还显示着第一个，出现「记录为空、
 * 显示还在」的不一致。序号只在同块内出现重复答案文本时才递增，因此不影响
 * 上面那条「新建遮罩不改变已有簇的记录」的性质（新遮罩的答案文本不同，
 * 不会插进同一组里）。
 *
 * 键只由页面上看得见的内容推导，不往笔记里写任何属性，与「不落盘、不改动
 * 笔记数据」的要求一致。簇内文本被编辑后键会跟着变，回放靠答案文本与块内位置
 * 重新对上号（见 unveil.ts 的两级对齐），所以编辑遮罩内容不会把揭晓态丢掉。
 */
export const listBlockClusters = (block: Element): BlockCluster[] => {
  const nodeId = block.getAttribute('data-node-id');
  if (!nodeId) return [];

  const kbds = block.querySelectorAll<HTMLElement>(KBD_SELECTOR);
  const handled = new Set<Element>();
  const duplicates = new Map<string, number>();
  const out: BlockCluster[] = [];

  for (let i = 0; i < kbds.length; i++) {
    const kbd = kbds[i];
    if (handled.has(kbd)) continue;

    const cluster = getClozeCluster(kbd);
    cluster.forEach((el) => handled.add(el));

    const text = cluster.map(memberText).join('|');
    const dup = duplicates.get(text) || 0;
    duplicates.set(text, dup + 1);

    out.push({ cluster, key: `${nodeId}#${text}@${dup}`, text, dup });
  }

  return out;
};

/**
 * 单个簇的揭晓键。簇首不属于本块时返回 null。
 *
 * 批量场景请直接用 listBlockClusters：它一次遍历给出全部键，
 * 逐个调用本函数会在块内形成平方级重复计算。
 */
export const getClusterKey = (block: Element | null, cluster: HTMLElement[]): string | null => {
  if (!block || cluster.length === 0) return null;

  const found = listBlockClusters(block).find((item) => item.cluster[0] === cluster[0]);
  return found ? found.key : null;
};

/**
 * 读取单个行内公式在基线以下的最大深度（单位为 KaTeX 的 em）。
 *
 * KaTeX 在每个 .base 首部写入 `<span class="strut" style="height:...em;vertical-align:-...em;">`，
 * 其 vertical-align 负值即 TeX 排版引擎算出的基线以下深度。直接读取该内联样式字符串，
 * 不触发任何布局重排。若 KaTeX 尚未完成渲染，则依据 data-content 中的数学结构给出下界。
 */
export const measureMathDepthEm = (mathEl: HTMLElement): number => {
  let maxDepth = 0;

  const struts = mathEl.querySelectorAll<HTMLElement>('.strut, [style*="vertical-align"]');
  for (let i = 0; i < struts.length; i++) {
    const style = struts[i].getAttribute('style') || '';
    const match = /vertical-align\s*:\s*(-?\d+(?:\.\d+)?)em/i.exec(style);
    if (!match) continue;
    const val = Number(match[1]);
    if (val < 0 && -val > maxDepth) {
      maxDepth = -val;
    }
  }

  const depthRows = mathEl.querySelectorAll<HTMLElement>('.vlist-t2 > .vlist-r:nth-child(2) > .vlist');
  for (let i = 0; i < depthRows.length; i++) {
    const style = depthRows[i].getAttribute('style') || '';
    const match = /height\s*:\s*(\d+(?:\.\d+)?)em/i.exec(style);
    if (!match) continue;
    const val = Number(match[1]);
    if (val > maxDepth) {
      maxDepth = val;
    }
  }

  const raw = mathEl.getAttribute('data-content') || '';
  if (!raw) return maxDepth;

  let depth = maxDepth;
  if (/\\begin\{(?:[bpvBV]?matrix|cases|dcases|rcases|aligned|align|array|smallmatrix|split|gather|gathered|subarray)\}|\\substack\b/.test(raw)) {
    const rows = raw.split(/\\\\/).length;
    depth = Math.max(depth, Math.max(0.55, (rows - 1) * 0.6 + 0.35));
  }
  if (
    /\\(?:dfrac|cfrac)\b/.test(raw) ||
    /\\limits\s*_/.test(raw) ||
    /\\(?:sum|prod|coprod|bigcup|bigcap|bigoplus|bigotimes|lim|limsup|liminf|sup|inf|max|min)\s*(?:\\limits\s*)?_/.test(raw) ||
    (/\\displaystyle\b/.test(raw) && /\\(?:frac|i+nt|oint|sum|prod|coprod|bigcup|bigcap|lim)\b/.test(raw))
  ) {
    depth = Math.max(depth, 1.15);
  }
  if (/\\(?:underbrace|underset)\b/.test(raw)) {
    depth = Math.max(depth, 1.05);
  }
  if (/\\(?:d?frac|tfrac)\s*\{[^{}]*\}\s*\{[^}]*\\(?:d?frac|tfrac)/.test(raw)) {
    depth = Math.max(depth, 0.75);
  }
  if (/\\(?:frac|tfrac|binom|dbinom|tbinom)\b/.test(raw)) {
    depth = Math.max(depth, 0.42);
  }
  if (/\\(?:i+nt|oint|sum|prod|coprod|bigcup|bigcap|bigoplus|bigotimes|lim|limsup|liminf|sup|inf|max|min)\b/.test(raw)) {
    depth = Math.max(depth, 0.36);
  }
  if (/\\(?:left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr|vert|Vert)\b|[|()[\]{}]/.test(raw)) {
    depth = Math.max(depth, 0.25);
  }
  if (/[_]|\\sqrt\b|[gjpqy]|\\(?:mu|rho|phi|varphi|chi|psi|eta|gamma|beta|zeta|xi)\b/.test(raw)) {
    depth = Math.max(depth, 0.2);
  }
  return depth;
};

/**
 * 给块内属于某个簇的行内公式打上簇成员类，并按簇内最大公式深度同步下划线偏移量。
 *
 * 公式是 kbd 的兄弟节点，CSS 的相邻兄弟选择器覆盖不到「kbd 公式 公式 kbd」里排在后面的
 * 公式。按同一套簇计算打标，同时把紧挨遮罩但不属于该遮罩的独立公式排除在外。
 *
 * Markdown 往返会把簇内公式上的 kbd 去掉（`<kbd>a</kbd>$x$` 读回时公式只有 inline-math），
 * 遮蔽规则与提示线规则都靠 CLUSTER_MATH_CLASS 命中它。只剩零宽字符的切片打上 BLANK_CLASS，
 * 样式表把它们略过，由公式自身的提示线接上。
 *
 * 行内公式保持 display: inline，其元素盒底停在正文字体基线下方约 0.2em 处，而分式、积分、
 * 矩阵等公式的可见内容会延伸到基线下方更深的位置。把整簇的最大下探深度折算为正文字号下的
 * em 值写入 `--sy-cloze-line-drop`，让公式伪元素与同行文本切片的提示线一起避开公式底部。
 */
export const markClusterMath = (block: Element): void => {
  const seen = new Set<HTMLElement>();

  block.querySelectorAll<HTMLElement>(KBD_SELECTOR).forEach((kbd) => {
    if (seen.has(kbd)) return;

    const cluster = getClozeCluster(kbd);
    const mathMembers: HTMLElement[] = [];

    cluster.forEach((el) => {
      seen.add(el);
      if (el.matches(MATH_SELECTOR)) {
        mathMembers.push(el);
      }
      // 切片里嵌套的公式同样是簇的一部分（表格单元格里就是这种形态）
      el.querySelectorAll<HTMLElement>(MATH_SELECTOR).forEach((nested) => {
        seen.add(nested);
        mathMembers.push(nested);
      });
    });

    let maxDepth = 0;
    for (let i = 0; i < mathMembers.length; i++) {
      const d = measureMathDepthEm(mathMembers[i]);
      if (d > maxDepth) maxDepth = d;
    }

    const dropEm = maxDepth > 0 ? Math.round((maxDepth * 1.25 + 0.16) * 1000) / 1000 : 0;
    const applyDrop = (node: HTMLElement) => {
      if (dropEm > 0) {
        node.style.setProperty(LINE_DROP_VAR, `${dropEm}em`);
      } else {
        node.style.removeProperty(LINE_DROP_VAR);
      }
    };

    cluster.forEach((el) => {
      applyDrop(el);
      if (el.matches(MATH_SELECTOR)) {
        el.classList.add(CLUSTER_MATH_CLASS);
        return;
      }
      el.classList.toggle(BLANK_CLASS, ZW_ONLY_TEXT.test(el.textContent || ''));
      el.querySelectorAll<HTMLElement>(MATH_SELECTOR).forEach((nested) => {
        nested.classList.add(CLUSTER_MATH_CLASS);
        applyDrop(nested);
      });
    });
  });

  // 本块内不再属于任何簇的成员要把类与偏移变量一并摘掉（遮罩被取消后它们恢复为普通元素）。
  block.querySelectorAll<HTMLElement>(MATH_SELECTOR).forEach((el) => {
    if (seen.has(el)) return;
    el.classList.remove(CLUSTER_MATH_CLASS);
    el.style.removeProperty(LINE_DROP_VAR);
  });

  block.querySelectorAll<HTMLElement>(`.${BLANK_CLASS}`).forEach((el) => {
    if (seen.has(el)) return;
    el.classList.remove(BLANK_CLASS);
    el.style.removeProperty(LINE_DROP_VAR);
  });
};

/** 揭晓键的组成部分，格式与 listBlockClusters 的产出严格对应。 */
export interface ClusterKeyParts {  nodeId: string;
  text: string;
  dup: number;
}

/**
 * 拆解揭晓键，取出块 ID、答案文本与重复序号。
 *
 * 回放需要从记录里反查答案文本——记录只有键，簇本身早已被思源重建掉了。
 * 答案文本里可能含 `#` 或 `@`，所以块 ID 取第一个 `#` 之前、序号取最后一个 `@` 之后。
 */
export const parseClusterKey = (key: string): ClusterKeyParts => {
  const hash = key.indexOf('#');
  const at = key.lastIndexOf('@');

  if (hash <= 0 || at <= hash) return { nodeId: '', text: '', dup: 0 };

  return {
    nodeId: key.slice(0, hash),
    text: key.slice(hash + 1, at),
    dup: Number(key.slice(at + 1)) || 0,
  };
};
