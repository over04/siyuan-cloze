/**
 * 点击揭晓（持久态）的记录、回放与单击确认。
 *
 * 独立成模块的理由与 cluster.ts 相同：这是插件的行为核心，必须能在 Node 里用
 * 真实 DOM 直接单测；src/index.ts 依赖思源 Plugin 基类，无法被测试加载。
 * 本文件零依赖思源运行时，只用到 DOM 标准对象。
 */
import {
  KBD_SELECTOR,
  PROTYLE_SELECTOR,
  UNVEIL_CLASS,
  getClusterKey,
  listBlockClusters,
  parseClusterKey,
  resolveProtyleRoot,
} from './cluster.ts';

/** 一篇文档的揭晓记录：键 → true。只记「已揭晓」，遮蔽即删除。 */
export type UnveilRecords = Map<string, true>;

/**
 * 记录每篇打开的文档里哪些遮罩块被点开了。
 *
 * 按 protyle 根元素分开存：一篇文档一份。文档关闭时思源会触发 destroy-protyle，
 * 我们据此把那份记录整体删掉（见 index.ts），所以「关闭文档就恢复默认遮蔽」是
 * 一条确定的事件，而不是指望浏览器什么时候回收 DOM。
 */
export class UnveilStore {
  private byRoot = new WeakMap<HTMLElement, UnveilRecords>();
  /** 上一轮被判为「已失效」的键，按根元素分开存；连续两轮都失效才真的删。 */
  private suspectByRoot = new WeakMap<HTMLElement, Set<string>>();
  /**
   * 块 ID → 上一轮回放时块内各簇的答案文本，按 DOM 顺序。
   *
   * 回放靠它做位置对齐：块内簇的数量没变时，位置 i 上的那一条记录就属于位置 i 上的
   * 簇，哪怕用户在簇内改了字。没有这份顺序就只能按文本猜，而「甲」与「甲子」这种
   * 包含关系会让一条记录被认领到另一个从未揭晓过的遮罩上，等于把答案摆出来。
   */
  private orderByRoot = new WeakMap<HTMLElement, Map<string, string[]>>();

  /** 取（必要时创建）某个 protyle 根元素的记录。 */
  ensure(root: HTMLElement): UnveilRecords {
    let records = this.byRoot.get(root);
    if (!records) {
      records = new Map();
      this.byRoot.set(root, records);
    }
    return records;
  }

  /** 只读查看：不存在就返回 undefined，避免无谓创建。 */
  peek(root: HTMLElement | null | undefined): UnveilRecords | undefined {
    return root ? this.byRoot.get(root) : undefined;
  }

  /** 取（必要时创建）某个根元素下「待确认是否失效」的键集合。 */
  suspects(root: HTMLElement): Set<string> {
    let set = this.suspectByRoot.get(root);
    if (!set) {
      set = new Set();
      this.suspectByRoot.set(root, set);
    }
    return set;
  }

  /**
   * 取（必要时创建）某个根元素下「块 ID → 上一轮的簇文本序列」的表。
   *
   * 只记块内各簇的答案文本与顺序，不记位置序号：位置本来就是这个数组的下标。
   */
  orders(root: HTMLElement): Map<string, string[]> {
    let map = this.orderByRoot.get(root);
    if (!map) {
      map = new Map();
      this.orderByRoot.set(root, map);
    }
    return map;
  }

  /**
   * 注销一份记录（文档关闭时调用）。
   *
   * 记录作废的同时必须把 DOM 上残留的揭晓类一并清掉：回放在记录为空时会早退，
   * 留着类就是「记录里没有、屏幕上却还显示着」，而且不会自己恢复。
   */
  drop(root: HTMLElement | null | undefined): void {
    if (!root) return;
    this.byRoot.delete(root);
    this.suspectByRoot.delete(root);
    this.orderByRoot.delete(root);

    if (root.isConnected) {
      root
        .querySelectorAll(`.${UNVEIL_CLASS}, .${HIDING_CLASS}`)
        .forEach((el) => el.classList.remove(UNVEIL_CLASS, HIDING_CLASS));
    }
  }
}

/* ==========================================================================
   过渡与待摘标记
   ========================================================================== */

/** 用户主动切换时临时挂上的类：只有带它的元素才走过渡（见 index.scss）。 */
export const ANIMATE_CLASS = 'sy-cloze-animating';

/**
 * 待摘标记：一轮对不上只登记，连续两轮都对不上才真的摘掉揭晓类。
 *
 * 思源重建块 DOM 的中间态里，某一轮可能算出「这个簇不该揭晓」。当场摘掉、下一轮
 * 文本恢复又加回来，屏幕上就是一次「亮 → 暗 → 亮」的闪动。
 */
export const HIDING_CLASS = 'sy-cloze-hiding';

/** 过渡时长，与 index.scss 里的 transition 保持一致。 */
const ANIMATE_MS = 260;

/** 每个元素身上的收尾定时器；重复切换时清掉旧的，免得前一次提前把动画收走。 */
const animateTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * 给这些元素配一次过渡。
 *
 * 过渡只在用户主动切换（点击、⌥⇧X）时才有。回放补类是思源重建 DOM 的副产物，
 * 给它配过渡就等于把「补类」变成一次从模糊到清晰的渐变，输入时看着就是闪一下。
 */
export const animateCluster = (cluster: HTMLElement[]): void => {
  cluster.forEach((el) => {
    el.classList.add(ANIMATE_CLASS);

    const previous = animateTimers.get(el);
    if (previous) clearTimeout(previous);

    animateTimers.set(
      el,
      setTimeout(() => {
        animateTimers.delete(el);
        el.classList.remove(ANIMATE_CLASS);
      }, ANIMATE_MS),
    );
  });
};

/** 按已知的键切换整簇的揭晓态，返回切换后的状态。 */
export const toggleUnveilByKey = (
  records: UnveilRecords,
  key: string,
  cluster: HTMLElement[],
): boolean => {
  const next = !records.has(key);
  if (next) {
    records.set(key, true);
  } else {
    records.delete(key);
  }

  animateCluster(cluster);
  cluster.forEach((el) => {
    el.classList.remove(HIDING_CLASS);
    el.classList.toggle(UNVEIL_CLASS, next);
  });
  return next;
};

/**
 * 切换一个遮罩块的揭晓态（整簇一起）。
 *
 * @returns 切换后的状态；块无 ID 或簇为空导致无法记录时返回 null。
 */
export const toggleClusterUnveil = (
  records: UnveilRecords,
  block: Element,
  cluster: HTMLElement[],
): boolean | null => {
  const key = getClusterKey(block, cluster);
  return key ? toggleUnveilByKey(records, key, cluster) : null;
};

/**
 * 在块内按键重新定位簇。
 *
 * 点击到执行之间块 DOM 可能被思源重建，闭包里的元素引用会失连；按块 ID + 答案文本
 * 在当前 DOM 里重找，这一次点击才不会静默丢掉。
 */
export const findClusterByKey = (block: Element, key: string): HTMLElement[] | null => {
  const found = listBlockClusters(block).find((item) => item.key === key);
  return found ? found.cluster : null;
};

/** 判定「同一个簇被编辑过」所需的最低相似度：公共子序列占较长文本的比例。 */
const SIMILAR_RATIO = 0.5;

const countTexts = (texts: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) || 0) + 1);
  return counts;
};

/** 最长公共子序列的长度；只留两行，避免为一次判据分配整张二维表。 */
const commonLength = (a: string, b: string): number => {
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[b.length];
};

/**
 * 判断两段答案文本是不是同一个簇被编辑前后的样子。
 *
 * 只看「互相包含」不够：删掉中间的字符（`abcd` → `abd`）或改掉一个字符（`ab` → `ax`）
 * 会让首尾同时变化，包含关系不成立，可用户就是在编辑那一个遮罩——揭晓态会因此丢掉。
 * 改用最长公共子序列的占比，任意位置的增删改都容得下，同时挡住「甲」与「甲乙丙丁」
 * 这种只沾一点边的组合。
 *
 * 空文本一律算同一个簇：它只出现在思源重建块 DOM 的中间态（kbd 还在、文本尚未填回），
 * 而调用方已把认领范围收窄到「同一个位置上的那一条记录」，不会认到别处去。
 */
export const isSameCluster = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a === '' || b === '') return true;

  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;

  // 公共子序列不可能超过较短的那一段，长度比就先不达标时不必再算。
  if (shorter.length / longer.length < SIMILAR_RATIO) return false;

  return commonLength(a, b) / longer.length >= SIMILAR_RATIO;
};

/**
 * 位置 i 上的簇在记录里对应的键。
 *
 * 记录只存答案文本与同文本出现的次序，位置靠「上一轮的文本序列」反推：该位置的
 * 文本在块内是第几次出现，它的序号就是几。
 */
const recordKeyAt = (nodeId: string, order: string[], i: number): string => {
  let dup = 0;
  for (let j = 0; j < i; j++) {
    if (order[j] === order[i]) dup++;
  }
  return `${nodeId}#${order[i]}@${dup}`;
};

/**
 * 回放一个块的揭晓态（块 DOM 重建后调用）。
 *
 * 对齐按顺序走两级，缺任何一级都会踩到一类真实故障：
 *
 *   1. 位置级——只在「块内簇的数量与上一轮相同」时启用，并且**先于精确级**。此时位置 i
 *      上的簇就是上一轮位置 i 上的那一个，哪怕用户在它内部增删改字（`abcd` → `abd`、
 *      `1234` → `123`），它对应的那条记录（键由上一轮的文本序列反推）照旧归它。
 *      先走是必须的：用户把重复答案中的一个改成别的文本后，另一个同文本遮罩的序号会
 *      前移，精确级会把那条记录先抢走，改过字的那个反被熄灭。
 *   2. 精确级——兜底：答案文本与重复序号都对上就继承。这一级保住了「同块内新建遮罩
 *      不得把揭晓态挪到新遮罩上」：段首插一个新遮罩会让所有旧簇的位置整体后移，
 *      只按位置对齐就会把答案亮到新遮罩上，而它本不该是揭晓态。
 *
 * 数量变了就一律不做位置对齐。用户取消或删掉一个遮罩后，后面的簇会整体前移，此时
 * 按位置认领会把记录交到另一个遮罩手上——「甲」被删掉后，紧邻的「甲子」会因为文本
 * 相似把那条记录接走，答案就亮在一个从未揭晓过的位置上。
 *
 * 中间态（kbd 还在、文本暂时为空）只继承显示，不改写记录、也不更新顺序表：那种匹配
 * 是按位置硬配的，可靠性不足，一旦据此迁移或记账，一次短暂的错配就变成永久错位。
 *
 * 位置级认的是「同一个位置上还是同一个遮罩」，它认不出「删掉一个遮罩、又在同一个位置
 * 挖空一段相似文本」——两者在 DOM 上完全同形。这条路径由调用方兜底：⇧⌘C 取消或新建
 * 遮罩之后会调 forgetBlockOrder 丢掉基线（见 index.ts）。
 *
 * 顺带核对，清掉「块还在、记录里的簇已不存在」的失效记录（原生行内标记取消遮罩、
 * 撤销创建、直接改文本都会留下它），否则同答案文本的遮罩重建时会一出现就是揭晓态。
 * 核对必须两轮确认：思源重建块是「先清空、后填充」的跨帧过程，中间态里块骨架
 * 已存在而 kbd 尚未渲染，此时若直接判定为失效，揭晓态就永久丢了。
 */
export const replayBlockUnveil = (store: UnveilStore, block: Element): void => {
  const nodeId = block.getAttribute('data-node-id');
  if (!nodeId) return;

  const root = resolveProtyleRoot(block);
  if (!root) return;

  const records = store.peek(root);
  if (!records) return;

  if (records.size === 0) {
    // 记录刚被清空（blocked 判定、两轮确认清理都会走到这里）。DOM 上可能还留着上一轮
    // 的标记，而遮蔽规则被 :not(.sy-cloze-unveiled) 反向失效——留着就是答案一直亮着，
    // 用户点一下也看不出变化。就地摘干净，别指望下一轮，下一轮同样会在这里早退。
    block.querySelectorAll<HTMLElement>(`.${UNVEIL_CLASS}, .${HIDING_CLASS}`).forEach((el) => {
      // 表格单元格是嵌在主文档块里的独立 .protyle，它有自己的记录。按 root 归属过滤，
      // 别把内层的揭晓态一起摘掉。
      if (resolveProtyleRoot(el) !== root) return;
      el.classList.remove(UNVEIL_CLASS, HIDING_CLASS);
    });
    return;
  }

  const prefix = `${nodeId}#`;
  const mine: string[] = [];
  records.forEach((_value, key) => {
    if (key.startsWith(prefix)) mine.push(key);
  });
  // 这个块没有记录：绝大多数 DOM 抖动都落在这里。早退之前先把 DOM 上的残留标记清掉
  // ——标记与记录同源，留着就是遮蔽规则被 :not(.sy-cloze-unveiled) 反向失效、答案一直
  // 亮着。块内元素很少，这一次查询的代价可以忽略。
  if (mine.length === 0) {
    block.querySelectorAll<HTMLElement>(`.${UNVEIL_CLASS}, .${HIDING_CLASS}`).forEach((el) => {
      // 只清属于这个块的：思源的列表项、引述块、超级块都是嵌套的 [data-node-id]，
      // 子块有它自己的记录，连它的标记一起清掉就会出现「记录还在、标记没了」。
      // 从父元素起算：行内引用、行内公式的渲染容器自身就带 data-node-id，
      // 用 el.closest 会把它们误判成别的块而漏清。
      if (el.parentElement?.closest('[data-node-id]') !== block) return;
      el.classList.remove(UNVEIL_CLASS, HIDING_CLASS);
    });
    return;
  }

  const items = listBlockClusters(block);

  // 块内一个 kbd 都没有：无从区分「内容尚未渲染」与「遮罩真的都没了」。
  // 前者是文档加载与块重建的常规中间态——static 与 dynamic 在同一加载流程里连续
  // 两轮回放，正好耗尽两轮配额——而靠增加轮数永远分不开这两种观测。
  // 因此一律不清理：跳过这个块的核对，也不把它记进待确认集合。
  // 代价是「整块遮罩被原生行内标记取消」会留下失效记录，但这有 ⇧⌘C 取消路径与关文档兜底，
  // 且后果只是重建同文本遮罩时多亮一次，远轻于揭晓态被静默抹掉。
  if (items.length === 0) return;

  const orders = store.orders(root);
  const previous = orders.get(nodeId);
  const texts = items.map((item) => item.text);

  const blocked = new Set<string>();
  // 结构增删会改变重复答案的序号，不能用旧序号猜身份。数量未变则仍按编辑回放处理。
  // 空文本可能只是渲染中间态，不据此作废记录。
  if (previous && previous.length !== items.length && !texts.includes('')) {
    const previousCounts = countTexts(previous);
    const currentCounts = countTexts(texts);
    for (const [text, count] of previousCounts) {
      const current = currentCounts.get(text) || 0;
      if (text !== '' && count !== current && Math.max(count, current) > 1) blocked.add(text);
    }
  }

  const claimed = new Map<string, string>();
  const used = new Set<string>();
  const blankMatch = new Set<string>();

  // 位置级先走，精确级兜底。顺序不能反：用户把重复答案中的一个改成别的文本之后，
  // 另一个同文本遮罩的序号会前移，精确级会把那条记录先抢走，改过字的那个反被熄灭。
  if (previous && previous.length === items.length) {
    items.forEach(({ key, text }, i) => {
      if (blocked.has(text)) return;
      if (!isSameCluster(previous[i], text)) return;

      const hit = recordKeyAt(nodeId, previous, i);
      if (!records.has(hit) || used.has(hit)) return;

      claimed.set(key, hit);
      used.add(hit);
      if (text === '') blankMatch.add(key);
    });
  }

  // 精确级兜底。必须一并排除已被位置级认领的记录：两个簇文本变得相同时，位置级已经
  // 把那条记录判给了正确的位置，精确级再认领一次就会把另一个位置也点亮。
  items.forEach(({ key, text }) => {
    if (blocked.has(text) || claimed.has(key) || used.has(key)) return;
    if (!records.has(key)) return;
    claimed.set(key, key);
    used.add(key);
  });

  items.forEach(({ cluster, key, text }) => {
    if (blocked.has(text)) {
      // blocked 的判定是确定的（簇数真的变少、重复答案的计数下降），不必再走两轮确认。
      // 而且这里必须当场摘干净：记录马上会被删掉，下一轮回放会在「记录为空」处早退，
      // 留在元素上的揭晓类再也没人收拾——遮蔽规则被 :not(.sy-cloze-unveiled) 反向失效，
      // 那个遮罩就永远亮着答案。
      cluster.forEach((el) => el.classList.remove(UNVEIL_CLASS, HIDING_CLASS));
      return;
    }

    const on = claimed.has(key);

    cluster.forEach((el) => {
      if (on) {
        el.classList.remove(HIDING_CLASS);
        el.classList.add(UNVEIL_CLASS);
        return;
      }

      // 对不上可能只是思源重建过程中的中间态。当场摘掉、下一轮再加回来，屏幕上就是
      // 一次「亮 → 暗 → 亮」的闪动；改成连续两轮都对不上才真摘。
      if (!el.classList.contains(UNVEIL_CLASS)) return;

      if (el.classList.contains(HIDING_CLASS)) {
        el.classList.remove(UNVEIL_CLASS, HIDING_CLASS);
      } else {
        el.classList.add(HIDING_CLASS);
      }
    });
  });

  const suspects = store.suspects(root);

  // 中间态不更新顺序表：把空文本记进去，下一轮就会把「重复答案少了一个」误判到头上，
  // 记录被清掉，而且不会自己恢复。
  if (!texts.some((text) => text === '')) orders.set(nodeId, texts);

  // 被强制遮蔽的那些文本，其记录一并作废。
  if (blocked.size > 0) {
    mine.forEach((key) => {
      if (!blocked.has(parseClusterKey(key).text)) return;
      records.delete(key);
      suspects.delete(key);
    });
  }

  // 先删除所有待迁移的源键，再写目标键。若两个键互换，不能边删边写。
  const moves = [...claimed].filter(([newKey, oldKey]) => oldKey !== newKey && !blankMatch.has(newKey));
  for (const [, oldKey] of moves) records.delete(oldKey);
  for (const [newKey] of moves) records.set(newKey, true);

  // 已恢复正常、能对上号的键，从待确认集合里移出。
  claimed.forEach((oldKey, newKey) => {
    suspects.delete(oldKey);
    suspects.delete(newKey);
  });

  // 连续两轮都认领不到的记录才真的删。
  mine.forEach((key) => {
    if (!records.has(key)) {
      suspects.delete(key);
      return;
    }
    if (used.has(key)) return;

    if (suspects.has(key)) {
      suspects.delete(key);
      records.delete(key);
    } else {
      suspects.add(key);
    }
  });
};

/**
 * 把记录回放到 scope 内的 DOM 上（页签切回、文档重载时调用）。
 *
 * 三层收敛，缺一层都会让每次 DOM 抖动变成全文档扫描：
 *   1. scope 内没有 kbd 直接返回；
 *   2. 所属 protyle 没有记录直接返回；
 *   3. 只回放记录里出现过的块，且块索引一次建成。
 *
 * 逐块的对齐与核对都在 replayBlockUnveil 里，两条入口共用同一套判据。
 */
export const replayUnveilInto = (store: UnveilStore, scope: ParentNode): void => {
  const first = scope.querySelector<HTMLElement>(KBD_SELECTOR);
  if (!first) return;

  // 用首个切片反查 protyle 根：调用方给的是 .protyle 还是它的容器都能对上，
  // 记录路径与点击时完全一致。
  const root = resolveProtyleRoot(first);
  const records = store.peek(root);
  if (!root || !records || records.size === 0) return;

  const nodeIds = new Set<string>();
  records.forEach((_value, key) => {
    const { nodeId } = parseClusterKey(key);
    if (nodeId) nodeIds.add(nodeId);
  });
  if (nodeIds.size === 0) return;

  // 一次建索引，避免每个已揭晓块都全文档查一遍。
  const byId = new Map<string, Element>();
  scope.querySelectorAll<Element>('[data-node-id]').forEach((el) => {
    const id = el.getAttribute('data-node-id');
    if (id && !byId.has(id)) byId.set(id, el);
  });

  nodeIds.forEach((nodeId) => {
    const block = byId.get(nodeId);
    // 块整体不在：不清理。块被删除后重建会拿到新 ID，失效记录永远不会误命中；
    // 而文档懒加载期间块可能尚未渲染，此处清理反而会误删。
    if (block) replayBlockUnveil(store, block);
  });
};

/**
 * 记下这个块当前的簇顺序，供下次回放做位置对齐。
 *
 * 点击揭晓之后必须立刻记一次：用户可能紧接着就在簇内改字，而那时还没有任何 DOM 变更
 * 触发过回放，位置对齐会因为「没有上一轮的顺序」而失效，这一次揭晓就白丢了。
 */
export const rememberBlockOrder = (store: UnveilStore, block: Element): void => {
  const nodeId = block.getAttribute('data-node-id');
  if (!nodeId) return;

  const root = resolveProtyleRoot(block);
  if (!root) return;

  const texts = listBlockClusters(block).map((item) => item.text);
  // 空文本只出现在重建中间态，记进去只会污染下一轮的比对。
  if (texts.length === 0 || texts.some((text) => text === '')) return;

  store.orders(root).set(nodeId, texts);
};

/**
 * 作废某个块的全部揭晓记录，并把该块的视觉就地校正。
 *
 * ⇧⌘C 取消遮罩后，该块的记录失去意义；不清理的话，同块内重新创建的遮罩若答案文本
 * 恰好与旧记录相同，会一出现就是揭晓态。
 *
 * 只删记录是不够的——同块内其它簇的标记还留在 DOM 上，会出现「记录里没有、
 * 屏幕上却还显示着」的不一致。这里按记录重算一遍该块的所有簇，让显示与记录一致。
 */
export const dropBlockUnveil = (records: UnveilRecords, block: Element): void => {
  const nodeId = block.getAttribute('data-node-id');
  if (!nodeId) return;

  const prefix = `${nodeId}#`;
  Array.from(records.keys()).forEach((key) => {
    if (key.startsWith(prefix)) records.delete(key);
  });

  const items = listBlockClusters(block);

  // 取消遮罩是用户主动操作，配一次过渡；回放路径不走这里。
  const touched: HTMLElement[] = [];
  items.forEach(({ cluster }) => touched.push(...cluster));
  if (touched.length > 0) animateCluster(touched);

  items.forEach(({ cluster, key }) => {
    const on = records.has(key);
    cluster.forEach((el) => {
      el.classList.remove(HIDING_CLASS);
      el.classList.toggle(UNVEIL_CLASS, on);
    });
  });
};

/**
 * 忘掉这个块的对齐基线。
 *
 * 块内新增或取消一个遮罩之后必须调用：块结构变了，上一轮的簇顺序不再代表「同一个位置
 * 上还是同一个遮罩」。忘掉它，下次回放就只做精确匹配，那一次回放结束时基线会自然重建。
 * 不这么做的话，「取消一个遮罩、又在原位置挖空一段相似文本」会被位置对齐当成同一次编辑，
 * 新遮罩一出现就是揭晓态——答案亮在用户从没点开过的位置。
 */
export const forgetBlockOrder = (
  store: UnveilStore,
  root: HTMLElement | null,
  nodeId: string | null,
): void => {
  if (!root || !nodeId) return;
  store.orders(root).delete(nodeId);
};

/** 创建成功后，新出现或增多的答案不继承旧记录，其他文本仍可精确回放。 */
export const forgetBlockOrderAfterCreate = (store: UnveilStore, block: HTMLElement, previous: string[]): void => {
  const root = resolveProtyleRoot(block);
  const nodeId = block.getAttribute('data-node-id');
  forgetBlockOrder(store, root, nodeId);
  const records = store.peek(root);
  if (!root || !nodeId || !records?.size) return;

  const items = listBlockClusters(block);
  const before = countTexts(previous);
  const after = countTexts(items.map(item => item.text));
  const newTexts = new Set([...after].filter(([text, count]) => count > (before.get(text) || 0)).map(([text]) => text));
  const suspects = store.suspects(root);
  for (const key of records.keys()) {
    const parts = parseClusterKey(key);
    if (parts.nodeId !== nodeId || !newTexts.has(parts.text)) continue;
    records.delete(key);
    suspects.delete(key);
  }
  for (const { cluster, text } of items) {
    if (newTexts.has(text)) cluster.forEach(el => el.classList.remove(UNVEIL_CLASS, HIDING_CLASS));
  }
};

/**
 * 按块 ID 作废记录。
 *
 * 取消遮罩时块 DOM 可能已被思源整体重建，调用方手里那份引用早已脱离文档，
 * 因此这里按 ID 在 root 内重新定位，再交给 dropBlockUnveil。
 */
export const dropUnveilForBlockId = (
  store: UnveilStore,
  root: HTMLElement | null,
  nodeId: string | null,
): void => {
  if (!root || !nodeId) return;

  // 遮罩没了，对齐基线随之作废：留着它，同块内下一个相似文本的新遮罩会认领旧记录。
  forgetBlockOrder(store, root, nodeId);

  const records = store.peek(root);
  if (!records) return;

  const block = root.querySelector<Element>(`[data-node-id="${nodeId}"]`);
  if (!block) return;

  dropBlockUnveil(records, block);
};

/**
 * 清掉所有文档里逐块点开的揭晓状态。
 *
 * 顶栏眼睛与 ⌥⇧X 是全局开关，按下它就该是「所有遮罩统一」：先把逐块点开的痕迹
 * 全部清掉，再翻转开关。不这么做的话，重新开启遮蔽后，之前手动点开的那几块
 * 仍然显示着，屏幕上一半显示一半遮蔽。
 */
export const resetAllUnveil = (store: UnveilStore, scope: ParentNode): void => {
  // ⌥⇧X 会同时翻转全局遮蔽开关，整篇 kbd 的样式都要变，因此整篇都配一次过渡。
  // 必须赶在 store.drop 摘掉揭晓类之前收集，否则那些元素就找不回来了。
  const kbds = Array.from(scope.querySelectorAll<HTMLElement>(KBD_SELECTOR));
  if (kbds.length > 0) animateCluster(kbds);

  // 两个选择器都遍历：文档的根元素通常是 .protyle，但表格单元格里的独立编辑器
  // 可能只到 .protyle-wysiwyg，漏掉它的话，那些块的记录会在下一次自动回放时复活。
  scope
    .querySelectorAll<HTMLElement>(`${PROTYLE_SELECTOR}, .protyle-wysiwyg`)
    .forEach((root) => store.drop(root));

  // 兜底：不在上面的容器里的残留标记一并清掉。
  scope.querySelectorAll<HTMLElement>(`.${UNVEIL_CLASS}, .${HIDING_CLASS}`).forEach((el) => {
    el.classList.remove(UNVEIL_CLASS, HIDING_CLASS);
  });
};

/* ==========================================================================
   点击目标
   ========================================================================== */

/**
 * 一次点击的目标：定位信息，外加点击那一刻的那个遮罩元素。
 *
 * 块 DOM 可能被思源重建，所以定位以「块 ID + 标识」为准；但只按块 ID 在根里查是不够的——
 * 同一个块 ID 在 protyle 根里可能同时存在多个元素（实测 3 个：编辑区、面包屑、另一处渲染
 * 各一份），querySelector 拿到的第一个未必是含遮罩的那份，会算出一个空簇，这次点击就被
 * 静默丢掉。anchor 还在文档里时用它解析最可信，它被重建掉之后才退回按 ID 找。
 */
export interface ToggleTarget {
  root: HTMLElement;
  nodeId: string;
  key: string;
  /** 点击命中的那个 kbd 元素；可能在提交前被思源重建掉，用前要查 isConnected。 */
  anchor: HTMLElement;
}

