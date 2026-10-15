import { Plugin, showMessage, Setting, getActiveEditor } from 'siyuan';
import {
  INVISIBLE_TEXT,
  KBD_SELECTOR,
  REVEAL_CLASS,
  UNVEIL_CLASS,
  findKbdInRange,
  getClozeCluster,
  getClusterKey,
  resolveClozeAnchor,
  resolveElement,
  resolveProtyleRoot,
} from './cluster';
import {
  UnveilStore,
  dropUnveilForBlockId,
  findClusterByKey,
  replayUnveilInto,
  resetAllUnveil,
  shouldRollback,
  toggleUnveilByKey,
  type ToggleTarget,
} from './unveil';
import {
  CELL_CONTENT_SELECTOR,
  CELL_SELECTOR,
  closestCellEditor,
  createRangeByVisibleOffset,
  getVisibleOffset,
  isMacPlatform,
  isRichCell,
  matchHotkey,
  parseHotkeyBindings,
} from './tableCell';

export interface PluginSettings {
  defaultHide: boolean;
}

const STORAGE_NAME = 'cloze-settings.json';

const DEFAULT_SETTINGS: PluginSettings = {
  defaultHide: true,
};

/** DOM 重建后回放的节流间隔；回放只是补 class，一帧量级足够。 */
const REPLAY_THROTTLE_MS = 16;

export default class ClozePlugin extends Plugin {
  private settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private isClozeActive: boolean = true;
  private topBarElement?: HTMLElement;

  /** 当前已挂上划选透晓类的元素，用于差分增删，避免每次全量 classList 抖动。 */
  private revealedElements: HTMLElement[] = [];
  private revealRaf = 0;

  /**
   * 点击揭晓态（持久显示）。
   *
   * 记录按 protyle 根元素分开存，并显式监听 destroy-protyle 删除：切页签只是显隐、
   * DOM 不销毁，状态因此保留；关闭文档时事件到达，记录随即作废，回到默认遮蔽。
   * 全程零落盘——揭晓只是本次阅读会话的临时标注，不该污染笔记数据。
   */
  private unveilStore = new UnveilStore();
  /** DOM 重建后待回放揭晓态的 protyle 集合（定时器合并）。 */
  private pendingUnveilRoots = new Set<HTMLElement>();
  private unveilTimer = 0;
  /** 刚被单击切换过的目标，供 dblclick 原样撤回。 */
  private lastToggle?: ToggleTarget;

  private selectionHandler?: () => void;
  private clickToggleHandler?: (e: MouseEvent) => void;
  private doubleClickHandler?: (e: MouseEvent) => void;
  private domObserver?: MutationObserver;
  /** 单元格编辑态下的快捷键兜底监听（捕获阶段）。 */
  private cellShortcutHandler?: (e: KeyboardEvent) => void;

  async onload() {
    console.log('[Cloze] Initializing SiYuan Lossless Inline Cloze Plugin...');
    await this.loadPluginSettings();

    this.isClozeActive = this.settings.defaultHide;

    this.initTopBar();
    this.initCommands();
    this.initSettingsPanel();
    this.initEventBus();
    this.initSelectionReveal();
    this.initClickToggle();
    this.initDomObserver();
    this.initCellShortcutFallback();

    this.updateGlobalStyles();
  }

  onunload() {
    console.log('[Cloze] Unloading SiYuan Lossless Inline Cloze Plugin...');
    this.removeCellShortcutFallback();
    this.removeDomObserver();
    this.removeClickToggle();
    this.removeSelectionReveal();
    this.cleanAllClozeArtifacts();
  }

  private initTopBar() {
    this.topBarElement = this.addTopBar({
      icon: 'iconEye',
      title: String(this.i18n.toggleCloze || '切换完形填空显隐'),
      position: 'right',
      callback: () => {
        this.toggleGlobalCloze();
      },
    });
    this.updateTopBarState();
  }

  private initCommands() {
    // 快捷键 ⌥Q：多选与单选逻辑 100% 对照思源原生高光 (⌥D) 标准化对齐
    this.addCommand({
      langKey: 'createCloze',
      langText: String(this.i18n.createCloze || '创建/取消行内挖空 (对齐⌥D)'),
      hotkey: '⌥Q',
      editorCallback: (protyle: any) => {
        this.handleStandardClozeAction(protyle);
      },
      callback: () => {
        const editor = getActiveEditor();
        this.handleStandardClozeAction(editor ? (editor as any).protyle : null);
      },
    });

    // 快捷键 ⌥X：专职切换全局背诵显隐
    this.addCommand({
      langKey: 'toggleCloze',
      langText: String(this.i18n.toggleCloze || '切换完形填空显隐'),
      hotkey: '⌥X',
      callback: () => {
        this.toggleGlobalCloze();
      },
    });
  }

  /**
   * 单元格编辑态下的快捷键兜底。
   *
   * 思源的编辑器快捷键分发（commonHotkey → dispatchPluginShortcut）绑在**外层**
   * .protyle-wysiwyg 上；单元格编辑器只把键盘事件转发到 owner.element（protyle 根元素，
   * 是 .protyle-wysiwyg 的祖先），转发事件不经过那个监听点，插件命令因此永远不会被
   * 分发——用户按了快捷键毫无反应，连提示都没有。ProtyleLite 自身
   * pluginExtensions: false，也不会代分发。所以这里在捕获阶段自己接管。
   *
   * 只在选区落在单元格编辑器内时接管；其余场景仍旧交给思源自身的命令分发，
   * 避免同一次按键被执行两次。
   */
  private initCellShortcutFallback() {
    this.cellShortcutHandler = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || event.repeat) return;

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      if (!closestCellEditor(selection.getRangeAt(0).startContainer)) return;

      if (!this.matchesClozeHotkey(event)) return;

      // 拦在这里：外层本来就收不到这个事件，不会重复执行。
      event.preventDefault();
      event.stopPropagation();

      const editor = getActiveEditor();
      this.handleStandardClozeAction(editor ? (editor as any).protyle : null);
    };

    document.addEventListener('keydown', this.cellShortcutHandler, true);
  }

  private removeCellShortcutFallback() {
    if (this.cellShortcutHandler) {
      document.removeEventListener('keydown', this.cellShortcutHandler, true);
      this.cellShortcutHandler = undefined;
    }
  }

  /** 取用户实际绑定的快捷键（在思源设置里改过就用改过的），没有绑定则回落默认 ⌥Q。 */
  private matchesClozeHotkey(event: KeyboardEvent): boolean {
    const keymap = (window as any)?.siyuan?.config?.keymap?.plugin?.[this.name]?.['createCloze'];
    const bindings = parseHotkeyBindings(keymap);
    const list = bindings.length > 0 ? bindings : ['⌥Q'];
    return list.some((hotkey) => matchHotkey(hotkey, event, isMacPlatform()));
  }

  /* ========================================================================
     一、透晓联动：划选临时透晓 + 点击持久揭晓

     遮蔽本身是纯 CSS（字形透明 + 毛玻璃模糊），JS 只负责决定哪些元素
     该带上透晓类：

       - sy-cloze-reveal   ：划选临时态，选区离开即撤（悬停透晓已按需求移除）
       - sy-cloze-unveiled ：点击切换的持久态，活到本次文档打开结束

     两者判定口径统一在「整簇」上，因此不存在「悬停左边整簇亮、悬停右边
     只亮半边」这类方向性缺口。
     ======================================================================== */

  private initSelectionReveal() {
    this.selectionHandler = () => this.scheduleRevealUpdate();
    document.addEventListener('selectionchange', this.selectionHandler);
  }

  private removeSelectionReveal() {
    if (this.selectionHandler) {
      document.removeEventListener('selectionchange', this.selectionHandler);
      this.selectionHandler = undefined;
    }
    if (this.revealRaf) {
      window.cancelAnimationFrame(this.revealRaf);
      this.revealRaf = 0;
    }
  }

  private scheduleRevealUpdate() {
    if (this.revealRaf) return;
    this.revealRaf = window.requestAnimationFrame(() => {
      this.revealRaf = 0;
      this.updateReveal();
    });
  }

  /**
   * 重新计算划选透晓集合：与选区相交的所有整簇。
   * 这一路解决的是「遮罩开着时划选看不清自己选了什么」。
   */
  private updateReveal() {
    const next = new Set<HTMLElement>();

    if (this.isClozeActive) {
      this.collectSelectedClusters(next);
    }

    for (const el of this.revealedElements) {
      if (!next.has(el)) el.classList.remove(REVEAL_CLASS);
    }
    for (const el of next) {
      if (this.revealedElements.indexOf(el) === -1) el.classList.add(REVEAL_CLASS);
    }

    this.revealedElements = Array.from(next);
  }

  private collectSelectedClusters(target: Set<HTMLElement>) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);

    document.querySelectorAll<HTMLElement>(KBD_SELECTOR).forEach((kbd) => {
      let hit = false;
      try {
        hit = range.intersectsNode(kbd);
      } catch {
        hit = false;
      }
      if (!hit) return;

      getClozeCluster(kbd).forEach((el) => target.add(el));
    });
  }

  private clearReveal() {
    for (const el of this.revealedElements) {
      el.classList.remove(REVEAL_CLASS);
    }
    this.revealedElements = [];
  }

  /* ========================================================================
     二、点击揭晓（持久态）

     捕获阶段监听：表格单元格编辑器对 mousedown/mouseup/click 一律
     stopPropagation，冒泡阶段收不到；捕获阶段先于目标处理，能拿到。
     不调 preventDefault——光标定位、原生双击选词全部原样保留。
     ======================================================================== */

  /**
   * 点击揭晓。
   *
   * 捕获阶段监听：表格单元格编辑器对 mousedown/mouseup/click 一律 stopPropagation，
   * 冒泡阶段收不到；捕获阶段先于目标处理，能拿到。
   *
   * 遮蔽模式下，命中遮罩块的这次点击会被拦下，不再传给思源：点行内公式因此不会
   * 弹出公式编辑器。拦的只是 click / dblclick，光标定位由 mousedown 决定，不受
   * 影响——点完之后光标仍会落在遮罩里，想编辑就先按 ⌥X 关掉遮蔽。
   *
   * 单击立即生效，不做任何等待。双击时第一下已经切换过，由 dblclick 原样撤回：
   * 「双击选词复制答案」的净效果为零，而单击零延迟。
   */
  private initClickToggle() {
    this.clickToggleHandler = (e: MouseEvent) => {
      if (!this.isClozeActive) return;
      if (e.button !== 0) return;

      const target = this.resolveToggleTarget(e.target as Node | null);
      if (!target) {
        // 没点中遮罩：顺手作废待撤回项，免得它跨到下一次双击里去。
        this.lastToggle = undefined;
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();

      // 双击的第二下不再切换，净效果交给 dblclick 回滚。
      if (e.detail > 1) return;

      this.commitToggle(target);
      this.lastToggle = target;
    };

    this.doubleClickHandler = (e: MouseEvent) => {
      if (!this.isClozeActive) return;
      if (e.button !== 0) return;

      const pending = this.lastToggle;
      this.lastToggle = undefined;
      if (!pending) return;

      // 只有这次双击确实落在刚才那个遮罩块上才撤回；落在别处一律放行给思源。
      const target = this.resolveToggleTarget(e.target as Node | null);
      if (!shouldRollback(pending, target)) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      this.commitToggle(pending);
    };

    document.addEventListener('click', this.clickToggleHandler, true);
    document.addEventListener('dblclick', this.doubleClickHandler, true);
  }

  /** 把命中的簇解析成可跨重建定位的目标：只留根元素、块 ID 与标识。 */
  private resolveToggleTarget(node: Node | null): ToggleTarget | null {
    const anchor = resolveClozeAnchor(node);
    if (!anchor) return null;

    const block = anchor.closest('[data-node-id]');
    const root = resolveProtyleRoot(anchor);
    const nodeId = block?.getAttribute('data-node-id');
    if (!block || !root || !nodeId) return null;

    const key = getClusterKey(block, getClozeCluster(anchor));
    return key ? { root, nodeId, key } : null;
  }

  /**
   * 真正执行切换。
   *
   * 刻意不依赖点击那一刻的元素引用：按块 ID 与答案文本在当前 DOM 里重找簇。
   * 思源在放置光标时可能重建该块 DOM，若沿用旧引用，这次点击会被静默丢弃，
   * 用户只看到「点了没反应」。
   */
  private commitToggle(target: ToggleTarget) {
    if (!this.isClozeActive) return;
    if (!target.root.isConnected) return;

    const block = target.root.querySelector(`[data-node-id="${target.nodeId}"]`);
    if (!block) return;

    const cluster = findClusterByKey(block, target.key);
    if (!cluster) return;

    toggleUnveilByKey(this.unveilStore.ensure(target.root), target.key, cluster);
  }

  private removeClickToggle() {
    this.lastToggle = undefined;
    if (this.clickToggleHandler) {
      document.removeEventListener('click', this.clickToggleHandler, true);
      this.clickToggleHandler = undefined;
    }
    if (this.doubleClickHandler) {
      document.removeEventListener('dblclick', this.doubleClickHandler, true);
      this.doubleClickHandler = undefined;
    }
  }

  /* ========================================================================
     三、揭晓态保活

     揭晓写在 DOM 的 class 上，而思源会因编辑事务、页签切换重建块 DOM。
     观察 childList 变化、按 protyle 收敛后合并回放，揭晓因此不丢。
     只观察 childList：class 改动属 attributes，不会被自身回放再次触发。

     调度用 setTimeout 而非 rAF：标签页不可见时浏览器会暂停 rAF，而期间
     （例如后台关文档）累积的变更会让调度一直短路，回放停摆到页面重新可见。
     ======================================================================== */

  private initDomObserver() {
    this.domObserver = new MutationObserver((records) => {
      records.forEach((record) => {
        const target = record.target.nodeType === Node.ELEMENT_NODE
          ? (record.target as HTMLElement)
          : record.target.parentElement;
        const root = resolveProtyleRoot(target);
        if (root) this.pendingUnveilRoots.add(root);
      });
      this.scheduleUnveilReplay();
    });

    this.domObserver.observe(document.body, { childList: true, subtree: true });
  }

  private removeDomObserver() {
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = undefined;
    }
    if (this.unveilTimer) {
      window.clearTimeout(this.unveilTimer);
      this.unveilTimer = 0;
    }
    this.pendingUnveilRoots.clear();
  }

  private scheduleUnveilReplay() {
    if (this.unveilTimer) return;
    this.unveilTimer = window.setTimeout(() => {
      this.unveilTimer = 0;
      const roots = Array.from(this.pendingUnveilRoots);
      this.pendingUnveilRoots.clear();
      roots.forEach((root) => replayUnveilInto(this.unveilStore, root));
    }, REPLAY_THROTTLE_MS);
  }

  /* ========================================================================
     四、事件总线
     ======================================================================== */

  private initEventBus() {
    // 静态阶段先挂上遮蔽开关，并补一次回放：只读/预览等路径只走静态渲染，
    // 不会有 dynamic 事件。常规路径此时通常还没渲染出 kbd，回放会立刻早退。
    this.eventBus.on('loaded-protyle-static', (event) => {
      this.handleProtyleStatic(event.detail.protyle.element);
    });

    // 动态就绪阶段再回放一次：页签切回、文档重载都走这里。
    this.eventBus.on('loaded-protyle-dynamic', (event) => {
      this.handleProtyleDynamic(event.detail.protyle.element);
    });

    // 文档关闭：显式注销该 protyle 的记录。
    // 「关闭文档恢复默认遮蔽」由此成为一条确定的事件，而不是「元素会被 GC」的运气。
    // detail 结构按类型包声明读取，但这里做防御：该包是社区维护的，若与内核实际
    // 结构不符，抛错会让清理静默失效——正是这条监听要消灭的那种失效。
    this.eventBus.on('destroy-protyle', (event) => {
      const element = (event as any)?.detail?.protyle?.element;
      if (element) this.unveilStore.drop(element);
    });
  }

  private handleProtyleStatic(containerEl: HTMLElement) {
    const wysiwyg = containerEl.querySelector<HTMLElement>('.protyle-wysiwyg');
    if (!wysiwyg) return;

    wysiwyg.classList.toggle('sy-cloze-active', this.isClozeActive);
    replayUnveilInto(this.unveilStore, containerEl);
  }

  private handleProtyleDynamic(containerEl: HTMLElement) {
    const wysiwyg = containerEl.querySelector<HTMLElement>('.protyle-wysiwyg');
    if (!wysiwyg) return;

    wysiwyg.classList.toggle('sy-cloze-active', this.isClozeActive);
    replayUnveilInto(this.unveilStore, containerEl);
    this.scheduleRevealUpdate();
  }

  /* ========================================================================
     五、行内挖空命令（⌥Q，逻辑 100% 对齐思源原生 ⌥D）
     ======================================================================== */

  /**
   * 从单元格编辑态退避：先把 ProtyleLite 提交掉，再按可见文本偏移重建选区重执行。
   *
   * 思源在 document 捕获阶段监听 pointerdown，目标不属于编辑器时会执行其 finish()，
   * 把 td 还原成可事务化的形态——这就是退避的着力点，不需要任何私有 API。
   * finish 之后 td 会被重建，原 Range 必然失效，因此只能靠可见文本偏移找回选区。
   */
  private retreatFromCellEditor(
    protyle: any,
    selection: Selection,
    range: Range,
    cellEditor: HTMLElement,
  ) {
    const cell = cellEditor.closest(CELL_SELECTOR);
    if (!cell) {
      showMessage('未能在单元格内定位选区，请重新选择', 2000, 'info');
      return;
    }

    // 偏移必须锚在「单元格内容区」上：编辑态的内容挂在 ProtyleLite 的 .protyle-wysiwyg 里，
    // 退避后则由 td 直接承载。拿整个 td 去算偏移会被编辑器外壳（表格控件按钮等）的文本
    // 带偏，恢复时必然越界——实测表现就是「选区恢复失败」。
    const contentRoot = cellEditor.querySelector(CELL_CONTENT_SELECTOR) || cellEditor;
    const start = getVisibleOffset(contentRoot, range.startContainer, range.startOffset);
    const end = getVisibleOffset(contentRoot, range.endContainer, range.endOffset);
    if (start < 0 || end < 0) {
      showMessage('未能在单元格内定位选区，请重新选择', 2000, 'info');
      return;
    }

    // 派发到 body：既不属于单元格编辑器，也不在外层 wysiwyg 内，
    // 正好命中思源「目标不属于编辑器就 finish」这一条分支。
    const PointerCtor: typeof PointerEvent =
      typeof PointerEvent === 'function' ? PointerEvent : (MouseEvent as unknown as typeof PointerEvent);
    document.body.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true, cancelable: true }));

    window.requestAnimationFrame(() => {
      if (!cell.isConnected) {
        showMessage('单元格已失效，请重新选择', 2000, 'info');
        return;
      }

      // rich 形态：单元格内容已按持久化的复杂块存着，外层 setInlineMark 依然不适用。
      // 如实告知，而不是硬闯出一次事务错误。
      if (isRichCell(cell)) {
        showMessage('该单元格内容较复杂，请退出单元格编辑后再按 ⌥Q', 2500, 'info');
        return;
      }

      const restored = createRangeByVisibleOffset(cell, start, end);
      if (!restored) {
        showMessage('选区恢复失败，请重新选择', 2000, 'info');
        return;
      }

      selection.removeAllRanges();
      selection.addRange(restored);
      this.handleStandardClozeAction(protyle, true);
    });
  }

  /**
   * 1. 跨段落检查：禁止跨越不同 [data-node-id] 块容器；
   * 2. 光标单点一键取消：光标停在遮罩内任意位置时，自动向上捕获整个连续集群，瞬间全块取消；
   * 3. 划选选区处理：已全部覆盖则一键清除，未全部覆盖则统一打上遮罩；
   * 4. 彻底依托思源官方 AST 与 Undo 事务，零 DOM 撕碎，零格式损坏。
   */
  private handleStandardClozeAction(protyle: any, isRetry = false) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
      return;
    }

    let range = selection.getRangeAt(0);

    // 表格单元格编辑态：td 已被 openTableCellRichEditor 整体换成独立 ProtyleLite，
    // 单元格内的块是**没有持久 ID 的临时块**。此时若继续走外层 protyle 的事务，
    // 内核会以 block not found 拒绝并回滚——前端 DOM 看着像加上了 kbd，数据却不落库。
    // 先退避：提交掉单元格编辑器，等 td 回到可事务化形态，再按偏移重建选区重执行。
    const cellEditor = closestCellEditor(range.startContainer);
    if (cellEditor) {
      if (isRetry) {
        showMessage('单元格仍处于编辑状态，请点击单元格外部后再按 ⌥Q', 2500, 'info');
        return;
      }
      this.retreatFromCellEditor(protyle, selection, range, cellEditor);
      return;
    }

    let startNode = resolveElement(range.startContainer);
    let endNode = resolveElement(range.endContainer);

    let startBlock: Element | null = startNode?.closest('[data-node-id]') || null;
    let endBlock: Element | null = endNode?.closest('[data-node-id]') || null;

    if (!startBlock || !endBlock) {
      showMessage('请将光标置于正文段落内', 2000, 'info');
      return;
    }

    // 选区落到了列表项、超级块这类容器上时（典型场景：从列表圆点处一路划到内容开头），
    // 起止会分属容器与内容块两个 [data-node-id]，思源随即改走跨块管道
    // setBlockRangesInlineMark，行为与块内不一致，操作就失败了。
    // 这里把起止收拢进真正的内容块，再判定是否真的跨块。
    if (startBlock !== endBlock) {
      if (startBlock.contains(endBlock)) {
        range.setStart(endBlock, 0);
      } else if (endBlock.contains(startBlock)) {
        range.setEnd(startBlock, startBlock.childNodes.length);
      } else {
        showMessage('行内挖空不能跨段落，请在同一段落内选择', 2000, 'info');
        return;
      }

      startNode = resolveElement(range.startContainer);
      endNode = resolveElement(range.endContainer);
      startBlock = startNode?.closest('[data-node-id]') || null;
      endBlock = endNode?.closest('[data-node-id]') || null;

      if (!startBlock || !endBlock || startBlock !== endBlock) {
        showMessage('行内挖空不能跨段落，请在同一段落内选择', 2000, 'info');
        return;
      }
    }

    let targetKbd: HTMLElement | null = null;

    // 检查光标折叠情况（单点光标落入）
    if (selection.isCollapsed) {
      targetKbd = startNode?.closest<HTMLElement>(KBD_SELECTOR) || null;

      if (!targetKbd) {
        // 光标可能落在被挖空夹住的行内公式内部
        targetKbd = resolveClozeAnchor(range.startContainer);
      }

      if (!targetKbd) {
        // 光标可能停在 kbd 前后的零宽边界文本节点上，按紧邻的挖空块归属
        const caretNode = range.startContainer;
        if (caretNode.nodeType === Node.TEXT_NODE && INVISIBLE_TEXT.test(caretNode.textContent || '')) {
          const prev = caretNode.previousSibling;
          const next = caretNode.nextSibling;
          if (prev && prev.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).matches(KBD_SELECTOR)) {
            targetKbd = prev as HTMLElement;
          } else if (next && next.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).matches(KBD_SELECTOR)) {
            targetKbd = next as HTMLElement;
          }
        }
      }

      if (!targetKbd) {
        showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
        return;
      }
    } else {
      // 划选：只要选区与挖空块相交，就按「取消整个遮罩」处理。
      // 用户语义——选中遮罩的一部分（哪怕只选到一小段、甚至起点落在遮罩外面）
      // 再按 ⌥Q，取消的是整个遮罩，而不是只取消被选中的那一片。
      targetKbd = findKbdInRange(range, startBlock);
    }

    // 取消场景：把选区扩展到整个连续集群，免除逐片取消的痛苦
    let cluster: HTMLElement[] = [];
    if (targetKbd) {
      cluster = getClozeCluster(targetKbd);
      if (cluster.length > 0) {
        const expandRange = document.createRange();
        expandRange.setStartBefore(cluster[0]);
        expandRange.setEndAfter(cluster[cluster.length - 1]);

        selection.removeAllRanges();
        selection.addRange(expandRange);
        range = expandRange;
      }
    }

    if (protyle && protyle.toolbar && typeof protyle.toolbar.setInlineMark === 'function') {
      try {
        // 关键：思源 setInlineMark 只读 protyle.toolbar.range 这份缓存快照，并不读 DOM Selection；
        // 它的更新时机仅限 mouseup/keyup/input 等事件。而表格单元格编辑器对
        // mousedown/mouseup/click 一律 stopPropagation，外层根本收不到，于是这份快照会停在
        // 「点开单元格那一刻的折叠光标」上。创建与取消都必须显式写回当前选区，
        // 否则创建会静默无事发生、取消会退化为只撤掉光标所在的那一个切片。
        protyle.toolbar.range = range.cloneRange();

        let currentTypes: string[] = [];
        if (typeof protyle.toolbar.getCurrentType === 'function') {
          try {
            currentTypes = protyle.toolbar.getCurrentType(range) || [];
          } catch {}
        }

        const isFullyMarked = currentTypes.includes('kbd') || Boolean(targetKbd);
        const kbdBefore = startBlock.querySelectorAll(KBD_SELECTOR).length;

        // 取消之前先把记录坐标取好：setInlineMark 之后块 DOM 可能被整体重建，
        // 届时 startBlock 已脱离文档，再也问不出它属于哪个 protyle。
        const unveilRoot = resolveProtyleRoot(startBlock);
        const blockNodeId = startBlock.getAttribute('data-node-id');

        // 调用思源官方原生管道执行标准化处理（等价于原生 ⌥D）。
        // 不注入任何自定义属性：Markdown 序列化只保留 kbd 的文本内容，
        // 附加属性在保存/重载后必然丢失，故集群完全由渲染层可见内容连续性重建。
        protyle.toolbar.setInlineMark(protyle, 'kbd', 'range');

        // 校验实际结果，不再只凭意图报喜。
        // 集群成员若仍是 kbd，说明这一次没有取消成功；此时自动重试一次
        // （第二次 protyle.toolbar.range 已是整簇，rangeTypes 必然收得到 kbd），
        // 仍失败就如实提示，绝不谎报「已取消」。
        let stillMarked = isFullyMarked &&
          cluster.some((el) => el.isConnected && el.matches(KBD_SELECTOR));
        if (stillMarked) {
          protyle.toolbar.setInlineMark(protyle, 'kbd', 'range');
          stillMarked = cluster.some((el) => el.isConnected && el.matches(KBD_SELECTOR));
        }

        if (!isFullyMarked && !this.isClozeActive) {
          this.isClozeActive = true;
          this.updateTopBarState();
          this.updateGlobalStyles();
        }

        this.scheduleRevealUpdate();

        // 创建同样要验收：事务被内核拒绝时前端 DOM 可能毫无变化，
        // 不校验就会谎报「已创建」。
        const createdOk = !isFullyMarked &&
          startBlock.querySelectorAll(KBD_SELECTOR).length > kbdBefore;

        let msg: string;
        let duration = 1500;
        if (!isFullyMarked) {
          if (createdOk) {
            msg = String(this.i18n.clozeCreated || '已创建行内挖空块');
          } else {
            msg = '创建未生效，请重试或把光标置于段落内再按 ⌥Q';
            duration = 2500;
          }
        } else if (stillMarked) {
          msg = '取消未生效，请把光标放进挖空块再按一次 ⌥Q';
          duration = 2500;
        } else {
          msg = String(this.i18n.clozeRemoved || '已取消整块行内挖空遮罩');
          // 遮罩已拆，该块的揭晓记录随之作废：不清理的话，同块内重新创建的遮罩
          // 若答案文本恰好与旧记录相同，会一出现就是揭晓态。
          dropUnveilForBlockId(this.unveilStore, unveilRoot, blockNodeId);
        }
        showMessage(msg, duration, 'info');
        return;
      } catch (err) {
        console.warn('[Cloze] Standard setInlineMark failed:', err);
      }
    }

    showMessage('未找到活动编辑器，请确保光标在笔记中', 2000, 'info');
  }

  /* ========================================================================
     六、全局显隐

     ⌥X / 顶栏眼睛是全局开关，按下它就是「所有遮罩统一」：先把逐块点开的揭晓
     痕迹全部作废，再翻转开关。于是关闭时全部可见、重新开启时全部遮蔽，
     不会出现「一半显示一半遮蔽」。
     ======================================================================== */

  private toggleGlobalCloze() {
    // 全局重置时把待撤回项一并作废：否则用户接着在正文里双击，会把刚清掉的块又翻回来。
    this.lastToggle = undefined;
    resetAllUnveil(this.unveilStore, document);

    this.isClozeActive = !this.isClozeActive;
    this.updateTopBarState();
    this.updateGlobalStyles();

    const msg = this.isClozeActive
      ? String(this.i18n.clozeActive || '完形填空模式已开启')
      : String(this.i18n.clozeInactive || '完形填空模式已关闭');
    showMessage(msg, 2000, 'info');
  }

  private updateTopBarState() {
    if (!this.topBarElement) return;
    if (this.isClozeActive) {
      this.topBarElement.classList.add('protyle-icon--active');
    } else {
      this.topBarElement.classList.remove('protyle-icon--active');
    }
  }

  private updateGlobalStyles() {
    document.body.classList.toggle('sy-cloze-active', this.isClozeActive);

    const wysiwygs = document.querySelectorAll<HTMLElement>('.protyle-wysiwyg');
    wysiwygs.forEach((wysiwyg) => {
      wysiwyg.classList.toggle('sy-cloze-active', this.isClozeActive);
    });

    if (!this.isClozeActive) {
      this.clearReveal();
    } else {
      this.scheduleRevealUpdate();
    }
  }

  private cleanAllClozeArtifacts() {
    document.body.classList.remove('sy-cloze-active');

    const wysiwygs = document.querySelectorAll<HTMLElement>('.protyle-wysiwyg');
    wysiwygs.forEach((wysiwyg) => {
      wysiwyg.classList.remove('sy-cloze-active');
    });

    // 插件卸载后揭晓类失去 CSS 依托，留在 DOM 上只是垃圾，一并清掉。
    document.querySelectorAll<HTMLElement>(`.${UNVEIL_CLASS}`).forEach((el) => {
      el.classList.remove(UNVEIL_CLASS);
    });

    this.clearReveal();
  }

  /* ========================================================================
     七、设置面板
     ======================================================================== */

  private initSettingsPanel() {
    this.setting = new Setting({
      confirmCallback: async () => {
        await this.savePluginSettings();
        this.updateGlobalStyles();
      },
    });

    const defaultHideCheckbox = document.createElement('input');
    defaultHideCheckbox.type = 'checkbox';
    defaultHideCheckbox.className = 'b3-switch fn__flex-center';
    defaultHideCheckbox.checked = this.settings.defaultHide;
    defaultHideCheckbox.addEventListener('change', () => {
      this.settings.defaultHide = defaultHideCheckbox.checked;
    });
    this.setting.addItem({
      title: String(this.i18n.defaultHide || '默认隐藏填空'),
      description: String(this.i18n.defaultHideDesc || '打开文档时默认遮挡所有行内挖空块'),
      actionElement: defaultHideCheckbox,
    });
  }

  private async loadPluginSettings() {
    try {
      const data = await this.loadData(STORAGE_NAME);
      if (data && typeof data === 'object') {
        this.settings = { ...DEFAULT_SETTINGS, ...data };
      }
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  private async savePluginSettings() {
    await this.saveData(STORAGE_NAME, this.settings);
  }
}
