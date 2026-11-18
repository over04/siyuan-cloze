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
 *   - 行内公式先挂起：只有同方向又遇到 kbd 切片时才入列，也就是被这一簇的切片
 *     夹住的公式（`kbd 公式 kbd`）。走到头仍未遇到切片的公式属于簇外内容，一律丢弃。
 *
 * 公式必须入列：否则整簇透晓类加不到公式上，会出现
 * 「选中左侧公式整簇透晓、选中右侧 kbd 只有 kbd 透晓」的单向缺陷。
 * 但入列只限被切片夹住的那些：相邻的两个公式之间只隔着零宽字符，外侧没有任何标记
 * 能说明它被同一次划选覆盖过。把外侧公式也算进来，就是「只选了右边公式，左边公式
 * 跟着一起被遮住」——整簇外边缘的公式必须原样保留。
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
  startKbd = outerKbd(startKbd) || startKbd;
  if (!resolveClozeBlock(startKbd)) return [startKbd];

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

    // 走到头仍未遇到下一个切片：挂起的公式在簇外，丢弃。
    // 记在遮罩里的公式本身带 kbd 类型（`data-type="inline-math kbd"`），
    // 它由上面的 isKbd 分支直接入列，不依赖这条兜底。
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
    if (isKbd(curr)) return curr;
    if (isClozeBridge(curr) || isMath(curr)) continue;
    return null;
  }
  return null;
};

/** 引用与公式可能自带 data-node-id；该属性在行内指向目标，不是宿主块。 */
export const BLOCK_SELECTOR = '[data-node-id]:not(span)';
export const BODY_SELECTOR = '.protyle-wysiwyg';
export const resolveClozeBlock = (node: Node | null): HTMLElement | null =>
  resolveElement(node)?.closest<HTMLElement>(BLOCK_SELECTOR) || null;
export const resolveClozeBody = (node: Node | null): HTMLElement | null => {
  const body = resolveElement(node)?.closest<HTMLElement>(BODY_SELECTOR);
  return body && !body.closest('.protyle-wysiwyg--mindmap, .protyle--mindmap, [data-type="mindmap"]') ? body : null;
};

const outerKbd = (el: HTMLElement): HTMLElement | null => {
  const block = resolveClozeBlock(el);
  let outer: HTMLElement | null = null;
  for (let p: HTMLElement | null = el; p && p !== block; p = p.parentElement) {
    if (p.matches(KBD_SELECTOR)) outer = p;
    if (p.matches(BODY_SELECTOR)) break;
  }
  return outer;
};

export const resolveClozeAnchor = (node: Node | null): HTMLElement | null => {
  const el = resolveElement(node);
  if (!el) return null;
  const direct = outerKbd(el);
  if (direct) return direct;
  const math = el.closest<HTMLElement>(MATH_SELECTOR);
  if (!math) return null;
  const prev = scanClusterKbd(math, 'prev');
  return prev && scanClusterKbd(math, 'next') ? prev : null;
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
  return resolveClozeAnchor(range.startContainer) || resolveClozeAnchor(range.endContainer) ||
    findClustersInRange(range, block)[0]?.find(isKbd) || null;
};

/** 选中夹在切片间的公式时也命中整簇。 */
export const findClustersInRange = (range: Range, scope: ParentNode | null): HTMLElement[][] => {
  const body = resolveClozeBody(range.startContainer);
  return collectClusters(scope || document).filter(cluster => cluster.some(el =>
    (!body || resolveClozeBody(el) === body) && range.intersectsNode(el)));
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
  const contents = (node: Node): string => {
    if (isMath(node)) return node.getAttribute('data-content') ?? '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    return Array.from(node.childNodes, contents).join('');
  };
  const raw = contents(el);
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

  const duplicates = new Map<string, number>();
  const out: BlockCluster[] = [];
  for (const cluster of collectClusters(block, block)) {
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

/** 只从外层切片起簇；子块与嵌套编辑器各自独立。 */
export const collectClusters = (scope: ParentNode, block?: Element): HTMLElement[][] => {
  const root = block ? resolveClozeBody(block) : null;
  const seen = new Set<HTMLElement>();
  const clusters: HTMLElement[][] = [];
  for (const kbd of scope.querySelectorAll<HTMLElement>(KBD_SELECTOR)) {
    if (seen.has(kbd) || outerKbd(kbd) !== kbd) continue;
    if (block && (resolveClozeBlock(kbd) !== block || resolveClozeBody(kbd) !== root)) continue;
    const cluster = getClozeCluster(kbd);
    cluster.forEach(el => seen.add(el));
    clusters.push(cluster);
  }
  return clusters;
};

/** 只给平级公式打标；嵌在切片里的公式随切片一起模糊。 */
export const markClusterMath = (block: Element): void => {
  const math = new Set(collectClusters(block, block).flat().filter(isMath));
  block.querySelectorAll<HTMLElement>(MATH_SELECTOR).forEach(el => {
    if (resolveClozeBlock(el) === block) el.classList.toggle(CLUSTER_MATH_CLASS, math.has(el));
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
