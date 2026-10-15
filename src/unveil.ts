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
  /** 块 ID → 每个答案文本出现了几次，用于识别「重复答案被删掉一个」。 */
  private fingerprintByRoot = new WeakMap<HTMLElement, Map<string, Map<string, number>>>();

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
   * 取（必要时创建）某个根元素下「块 ID → 各答案文本出现几次」的表。
   *
   * 回放靠它识别「用户删掉了重复答案中的一个」：思源重建块 DOM 时这些次数不变，
   * 只有真的编辑才会让某个答案文本的簇数变少。
   */
  fingerprints(root: HTMLElement): Map<string, Map<string, number>> {
    let map = this.fingerprintByRoot.get(root);
    if (!map) {
      map = new Map();
      this.fingerprintByRoot.set(root, map);
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
    this.fingerprintByRoot.delete(root);

    if (root.isConnected) {
      root.querySelectorAll(`.${UNVEIL_CLASS}`).forEach((el) => el.classList.remove(UNVEIL_CLASS));
    }
  }
}

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

  cluster.forEach((el) => el.classList.toggle(UNVEIL_CLASS, next));
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

/**
 * 把记录回放到 scope 内的 DOM 上（块 DOM 重建后调用）。
 *
 * 三层收敛，缺一层都会让每次 DOM 抖动变成全文档扫描：
 *   1. scope 内没有 kbd 直接返回；
 *   2. 所属 protyle 没有记录直接返回；
 *   3. 只回放记录里出现过的块，且块索引一次建成。
 *
 * 顺带核对，清掉「块还在、记录里的簇已不存在」的失效记录（原生 ⌥D 取消遮罩、
 * 撤销创建、直接改文本都会留下它），否则同答案文本的遮罩重建时会一出现就是揭晓态。
 * 核对必须两轮确认：思源重建块是「先清空、后填充」的跨帧过程，中间态里块骨架
 * 已存在而 kbd 尚未渲染，此时若直接判定为失效，揭晓态就永久丢了。
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
    const sep = key.indexOf('#');
    if (sep > 0) nodeIds.add(key.slice(0, sep));
  });

  // 一次建索引，避免每个已揭晓块都全文档查一遍。
  const byId = new Map<string, Element>();
  scope.querySelectorAll<Element>('[data-node-id]').forEach((el) => {
    const id = el.getAttribute('data-node-id');
    if (id && !byId.has(id)) byId.set(id, el);
  });

  const suspects = store.suspects(root);
  const snapshots = store.fingerprints(root);

  nodeIds.forEach((nodeId) => {
    const block = byId.get(nodeId);
    // 块整体不在：不清理。块被删除后重建会拿到新 ID，失效记录永远不会误命中；
    // 而文档懒加载期间块可能尚未渲染，此处清理反而会误删。
    if (!block) return;

    const items = listBlockClusters(block);

    // 块内一个 kbd 都没有：无从区分「内容尚未渲染」与「遮罩真的都没了」。
    // 前者是文档加载的常规中间态——static 与 dynamic 在同一加载流程里连续两轮回放，
    // 正好耗尽两轮配额——而靠增加轮数永远分不开这两种观测。
    // 因此一律不清理：跳过这个块的核对，也不把它记进待确认集合。
    // 代价是「整块遮罩被原生 ⌥D 取消」会留下失效记录，但这有 ⌥Q 取消路径与关文档兜底，
    // 且后果只是重建同文本遮罩时多亮一次，远轻于揭晓态被静默抹掉。
    if (items.length === 0) return;

    const existing = new Set<string>();
    const counts = new Map<string, number>();

    items.forEach(({ cluster, key }) => {
      existing.add(key);
      const fingerprint = key.slice(0, key.lastIndexOf('@'));
      counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
      const on = records.has(key);
      cluster.forEach((el) => el.classList.toggle(UNVEIL_CLASS, on));
    });

    // 某个「原本重复」的答案文本，数量变少，才说明用户删掉了重复答案中的一个：
    // 剩下那几个的编号会整体前移，逐条对号会把揭晓状态从被删的那个挪到另一个
    // 文字相同的遮罩上，宁可整块清空，也不能让答案显示到错误的位置。
    //
    // 判定范围必须收窄到「原本出现过不止一次的那些答案文本」：只要块内存在重复答案
    // 就整块清空的话，编辑同段里一个毫不相干的遮罩也会把其它簇的揭晓状态一并清掉。
    const previous = snapshots.get(nodeId);
    const shrunk = previous
      ? Array.from(previous).some(
          ([fingerprint, count]) => count > 1 && (counts.get(fingerprint) || 0) < count,
        )
      : false;

    snapshots.set(nodeId, counts);

    if (shrunk) {
      const prefix = `${nodeId}#`;
      Array.from(records.keys()).forEach((key) => {
        if (key.startsWith(prefix)) records.delete(key);
      });
      items.forEach(({ cluster }) => cluster.forEach((el) => el.classList.remove(UNVEIL_CLASS)));
      return;
    }

    const prefix = `${nodeId}#`;

    // 已恢复正常、能对上号的键，从待确认集合里移出。
    existing.forEach((key) => suspects.delete(key));

    Array.from(records.keys()).forEach((key) => {
      if (!key.startsWith(prefix) || existing.has(key)) return;

      if (suspects.has(key)) {
        suspects.delete(key);
        records.delete(key);
      } else {
        suspects.add(key);
      }
    });
  });
};

/**
 * 作废某个块的全部揭晓记录，并把该块的视觉就地校正。
 *
 * ⌥Q 取消遮罩后，该块的记录失去意义；不清理的话，同块内重新创建的遮罩若答案文本
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

  listBlockClusters(block).forEach(({ cluster, key }) => {
    const on = records.has(key);
    cluster.forEach((el) => el.classList.toggle(UNVEIL_CLASS, on));
  });
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

  const records = store.peek(root);
  if (!records) return;

  const block = root.querySelector<Element>(`[data-node-id="${nodeId}"]`);
  if (!block) return;

  dropBlockUnveil(records, block);
};

/**
 * 清掉所有文档里逐块点开的揭晓状态。
 *
 * 顶栏眼睛与 ⌥X 是全局开关，按下它就该是「所有遮罩统一」：先把逐块点开的痕迹
 * 全部清掉，再翻转开关。不这么做的话，重新开启遮蔽后，之前手动点开的那几块
 * 仍然显示着，屏幕上一半显示一半遮蔽。
 */
export const resetAllUnveil = (store: UnveilStore, scope: ParentNode): void => {
  // 两个选择器都遍历：文档的根元素通常是 .protyle，但表格单元格里的独立编辑器
  // 可能只到 .protyle-wysiwyg，漏掉它的话，那些块的记录会在下一次自动回放时复活。
  scope
    .querySelectorAll<HTMLElement>(`${PROTYLE_SELECTOR}, .protyle-wysiwyg`)
    .forEach((root) => store.drop(root));

  // 兜底：不在上面的容器里的残留标记一并清掉。
  scope.querySelectorAll<HTMLElement>(`.${UNVEIL_CLASS}`).forEach((el) => {
    el.classList.remove(UNVEIL_CLASS);
  });
};

/* ==========================================================================
   点击目标
   ========================================================================== */

/**
 * 一次点击的目标：只记定位信息，不持有元素引用。
 *
 * 块 DOM 可能被思源重建，持有引用会让这次点击静默失效；按「块 ID + 标识」
 * 在当前 DOM 里重新定位，才是可靠的。
 */
export interface ToggleTarget {
  root: HTMLElement;
  nodeId: string;
  key: string;
}

/**
 * 判断这次双击是否该把上一次单击撤回。
 *
 * 只有「双击落点解析出来的目标」与「上一次单击的目标」是同一个遮罩块时才成立。
 * 否则就会出现这种情况：用户点开一个遮罩看答案，随后在正文里双击选词，
 * 那个遮罩被无故翻回去，而这次双击也被从思源手里拦走。
 */
export const shouldRollback = (
  pending: ToggleTarget | undefined,
  current: ToggleTarget | null,
): boolean =>
  Boolean(
    pending &&
      current &&
      pending.root === current.root &&
      pending.nodeId === current.nodeId &&
      pending.key === current.key,
  );
