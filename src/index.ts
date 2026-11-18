import { Plugin, showMessage, Setting, getActiveEditor } from 'siyuan';
import {
  BODY_SELECTOR,
  CLUSTER_MATH_CLASS,
  INVISIBLE_TEXT,
  KBD_SELECTOR,
  REVEAL_CLASS,
  UNVEIL_CLASS,
  findClustersInRange,
  getClozeCluster,
  getClusterKey,
  listBlockClusters,
  markClusterMath,
  resolveClozeAnchor,
  resolveClozeBlock,
  resolveClozeBody,
  resolveElement,
  resolveProtyleRoot,
} from './cluster';
import {
  HIDING_CLASS,
  UnveilStore,
  dropBlockUnveil,
  forgetBlockOrder,
  forgetBlockOrderAfterCreate,
  rememberBlockOrder,
  replayBlockUnveil,
  resetAllUnveil,
  toggleUnveilByKey,
  type ToggleTarget,
} from './unveil';
import {
  CELL_SELECTOR,
  cellEditableRanges,
  closestCellEditor,
  closestTableCell,
  isMacPlatform,
  isRichCell,
  matchHotkey,
  resolveHotkeyBindings,
} from './tableCell';
import { UnderlineLayer } from './underline';
import { appliedInlineMask, currentInlineBlock, snapshotInlineMask } from './inlineMark';

/** 创建/取消挖空的工具栏图标。 */
const CLOZE_ICON = `<symbol id="iconCloze" viewBox="0 0 32 32">
  <rect x="5" y="7" width="22" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M9 21L23 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <circle cx="11" cy="12" r="1.5" fill="currentColor"/>
</symbol>`;

export interface PluginSettings {
  defaultHide: boolean;
}

const STORAGE_NAME = 'cloze-settings.json';

const DEFAULT_SETTINGS: PluginSettings = {
  defaultHide: true,
};

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

  private selectionHandler?: () => void;
  private gestureEvents?: AbortController;
  private cancelGesture?: () => void;
  private readonly layers = new Map<HTMLElement, UnderlineLayer>();
  private readonly destroyedRoots = new WeakSet<HTMLElement>();
  private domObserver?: MutationObserver;
  /** 单元格编辑态下的快捷键兜底监听（捕获阶段）。 */
  private cellShortcutHandler?: (e: KeyboardEvent) => void;
  private readonly pendingCellOpens = new WeakSet<HTMLTableCellElement>();
  /** 移动端键盘工具栏的插件项点击监听。 */
  private pluginToolbarClickHandler?: (e: Event) => void;
  private pluginToolbarTouchStart?: { x: number; y: number; moved: boolean };
  private pluginToolbarTouchAt = 0;

  async onload() {
    console.log('[Cloze] Initializing SiYuan Lossless Inline Cloze Plugin...');
    await this.loadPluginSettings();

    this.isClozeActive = this.settings.defaultHide;

    this.addIcons(CLOZE_ICON);
    this.initTopBar();
    this.initCommands();
    this.initToolbarItem();
    this.initSettingsPanel();
    this.initEventBus();
    this.initSelectionReveal();
    this.initClickToggle();
    this.initDomObserver();
    this.initCellShortcutFallback();

    this.attachEditors(document.body);
    this.updateGlobalStyles();
  }

  onunload() {
    console.log('[Cloze] Unloading SiYuan Lossless Inline Cloze Plugin...');
    if (typeof (this as any).removeToolbarItem === 'function') {
      (this as any).removeToolbarItem('cloze');
    }
    this.removeMobileToolbarItem();
    this.removeCellShortcutFallback();
    this.removeDomObserver();
    this.eventBus.off('loaded-protyle-static', this.protyleLoaded);
    this.eventBus.off('loaded-protyle-dynamic', this.protyleLoaded);
    this.eventBus.off('destroy-protyle', this.protyleDestroyed);
    for (const layer of this.layers.values()) layer.dispose();
    this.layers.clear();
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
    // 快捷键 ⌥⇧X：专职切换全局背诵显隐
    this.addCommand({
      langKey: 'toggleCloze',
      langText: String(this.i18n.toggleCloze || '切换完形填空显隐'),
      hotkey: '⌥⇧X',
      callback: () => this.toggleGlobalCloze(),
    });
    this.addCommand({
      langKey: 'toggleClozeAtCaret',
      langText: String(this.i18n.toggleClozeAtCaret || '切换光标处挖空揭晓'),
      hotkey: '',
      callback: () => this.toggleAtCaret(),
    });
  }

  /**
   * 编辑器工具栏入口。
   *
   * 桌面端显示在选区工具栏，移动端由思源插到键盘工具栏；同一个注册项，
   * 不额外注册顶栏或菜单入口。
   */
  private initToolbarItem() {
    const addToolbarItem = (this as any).addToolbarItem;
    if (typeof addToolbarItem !== 'function') return;

    addToolbarItem.call(this, {
      name: 'cloze',
      icon: 'iconCloze',
      hotkey: '⇧⌘C',
      tip: String(this.i18n.createClozeTip || '创建/取消行内挖空'),
      click: (protyle: any) => {
        this.handleStandardClozeAction(protyle, undefined, true);
      },
    });

    this.bindMobileToolbarItem();
  }

  /**
   * 移动端键盘工具栏只把插件项渲染成按钮，没有把自定义项的 click 分发出去。
   * 这里补一个捕获阶段监听，直接接管 data-plugin-toolbar="true" 的挖空按钮。
   */
  private bindMobileToolbarItem() {
    if (this.pluginToolbarClickHandler) return;

    this.pluginToolbarClickHandler = (event: Event) => {
      if (event.type === 'touchmove') {
        const start = this.pluginToolbarTouchStart;
        const touch = (event as TouchEvent).touches[0];
        if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) {
          start.moved = true;
        }
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLElement>('[data-plugin-toolbar="true"][data-type="cloze"]');
      if (!button || !button.closest('#keyboardToolbar')) {
        if (event.type === 'touchend') this.pluginToolbarTouchStart = undefined;
        return;
      }

      if (event.type === 'touchstart') {
        const touch = (event as TouchEvent).touches[0];
        this.pluginToolbarTouchStart = touch
          ? { x: touch.clientX, y: touch.clientY, moved: false }
          : undefined;
        return;
      }

      if (event.type === 'touchend') {
        const start = this.pluginToolbarTouchStart;
        this.pluginToolbarTouchStart = undefined;
        // 横向滑动工具栏时不要误触发创建/取消。
        if (!start || start.moved) return;
        this.pluginToolbarTouchAt = Date.now();
      } else if (event.type === 'click') {
        // touchend 已经处理过时，忽略随后补发的 click。
        if (Date.now() - this.pluginToolbarTouchAt < 500) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const editor = getActiveEditor();
      const protyle = editor ? (editor as any).protyle : (window as any)?.siyuan?.mobile?.editor?.protyle ?? null;
      this.handleStandardClozeAction(protyle, undefined, true);
    };

    document.addEventListener('touchstart', this.pluginToolbarClickHandler, true);
    document.addEventListener('touchmove', this.pluginToolbarClickHandler, true);
    document.addEventListener('touchend', this.pluginToolbarClickHandler, true);
    document.addEventListener('click', this.pluginToolbarClickHandler, true);
  }

  private removeMobileToolbarItem() {
    if (!this.pluginToolbarClickHandler) return;
    document.removeEventListener('touchstart', this.pluginToolbarClickHandler, true);
    document.removeEventListener('touchmove', this.pluginToolbarClickHandler, true);
    document.removeEventListener('touchend', this.pluginToolbarClickHandler, true);
    document.removeEventListener('click', this.pluginToolbarClickHandler, true);
    this.pluginToolbarClickHandler = undefined;
    this.pluginToolbarTouchStart = undefined;
    this.pluginToolbarTouchAt = 0;
  }

  /**
   * 单元格编辑态下的快捷键兜底。
   *
   * 思源的编辑器快捷键分发（commonHotkey → dispatchPluginShortcut）绑在**外层**
   * .protyle-wysiwyg 上；单元格编辑器只把键盘事件转发到 owner.element（protyle 根元素，
   * 是 .protyle-wysiwyg 的祖先），转发事件不经过那个监听点，插件快捷键因此永远不会被
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
      const range = selection.getRangeAt(0);
      const cell = closestTableCell(range.startContainer);
      if (!cell || cell !== closestTableCell(range.endContainer) ||
          (!closestCellEditor(range.startContainer) && !isRichCell(cell))) return;

      if (!this.matchesClozeHotkey(event)) return;

      // 拦在这里：外层本来就收不到这个事件，不会重复执行。
      event.preventDefault();
      event.stopPropagation();

      const editor = getActiveEditor();
      const protyle = (editor as any)?.protyle ?? (window as any)?.siyuan?.mobile?.editor?.protyle;
      this.handleStandardClozeAction(protyle, range);
    };

    document.addEventListener('keydown', this.cellShortcutHandler, true);
  }

  private removeCellShortcutFallback() {
    if (this.cellShortcutHandler) {
      document.removeEventListener('keydown', this.cellShortcutHandler, true);
      this.cellShortcutHandler = undefined;
    }
  }

  /** 取工具栏项实际绑定的快捷键（在思源设置里改过就用改过的），没有绑定则回落默认 ⇧⌘C。 */
  private matchesClozeHotkey(event: KeyboardEvent): boolean {
    const keymap = (window as any)?.siyuan?.config?.keymap?.plugin?.[this.name]?.['cloze'];
    const list = resolveHotkeyBindings(keymap, '⇧⌘C');
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

    const dirty = new Set<HTMLElement>();
    const change = (el: HTMLElement, reveal: boolean) => {
      el.classList.toggle(REVEAL_CLASS, reveal);
      const block = resolveClozeBlock(el);
      if (block) dirty.add(block);
    };
    for (const el of this.revealedElements) if (!next.has(el)) change(el, false);
    for (const el of next) if (!this.revealedElements.includes(el)) change(el, true);
    this.revealedElements = [...next];
    dirty.forEach(block => this.invalidateBlock(block));
  }

  private collectSelectedClusters(target: Set<HTMLElement>) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const body = resolveClozeBody(range.startContainer);
    if (!body || body !== resolveClozeBody(range.endContainer)) return;
    for (const cluster of findClustersInRange(range, body)) cluster.forEach(el => target.add(el));
  }

  private clearReveal() {
    for (const el of this.revealedElements) el.classList.remove(REVEAL_CLASS);
    this.revealedElements = [];
  }

  private resolveToggleTarget(node: Node | null): ToggleTarget | null {
    const anchor = resolveClozeAnchor(node);
    if (!anchor || !resolveClozeBody(anchor)) return null;
    const block = resolveClozeBlock(anchor);
    const root = resolveProtyleRoot(anchor);
    const nodeId = block?.getAttribute('data-node-id');
    if (!block || !root || !nodeId) return null;
    const key = getClusterKey(block, getClozeCluster(anchor));
    return key ? { root, nodeId, key, anchor } : null;
  }

  private toggleTarget(target: ToggleTarget) {
    const block = resolveClozeBlock(target.anchor);
    if (!this.isClozeActive || !block || !target.anchor.isConnected || resolveProtyleRoot(target.anchor) !== target.root) return false;
    const cluster = getClozeCluster(target.anchor);
    const key = getClusterKey(block, cluster);
    if (!key) return false;
    toggleUnveilByKey(this.unveilStore.ensure(target.root), key, cluster);
    rememberBlockOrder(this.unveilStore, block);
    this.refreshBlockCopies(block, target.root);
    return true;
  }

  private toggleAtCaret() {
    const editor = getActiveEditor();
    const protyle = (editor as any)?.protyle ?? (window as any)?.siyuan?.mobile?.editor?.protyle;
    const range = this.resolveActionRange(protyle);
    if (!range?.collapsed) return;
    const target = this.resolveToggleTarget(this.caretAnchor(range));
    if (target) this.toggleTarget(target);
  }

  private initClickToggle() {
    this.gestureEvents = new AbortController();
    const signal = this.gestureEvents.signal;
    const capture = { capture: true, signal };
    type Point = { node: Node; offset: number };
    type Tap = { target: ToggleTarget; id: number; x: number; y: number; at: number; touch: boolean };
    let press: (Tap & { body: HTMLElement; origin: Point | null; moved: boolean }) | undefined;
    let released: (Tap & { handled: boolean }) | undefined;
    const reset = () => { press = undefined; released = undefined; };
    this.cancelGesture = reset;
    const anchorAt = (node: EventTarget | null) => this.isClozeActive && node instanceof Node && resolveClozeBody(node)
      ? resolveClozeAnchor(node) : null;
    const consume = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const distance = (a: { x: number; y: number }, b: { clientX: number; clientY: number }) => Math.hypot(a.x - b.clientX, a.y - b.clientY);
    const matchesRelease = (end: NonNullable<typeof released>, event: MouseEvent) =>
      event.button === 0 && event.detail > 0 && event.timeStamp - end.at < 650 && distance(end, event) <= 8 &&
      (!('pointerId' in event) || event.pointerId === end.id || event.pointerId === 0);
    const confirm = (end: NonNullable<typeof released>, x: number, y: number) => {
      // 一处挖空可能有多个元素，用实际落点确认是不是同一处。
      const target = this.resolveToggleTarget(document.elementFromPoint(x, y));
      if (!target || target.root !== end.target.root || target.key !== end.target.key || !this.toggleTarget(target)) return;

      clearEditorSelection(resolveClozeBody(target.anchor));
    };
    const clearEditorSelection = (body: HTMLElement | null) => {
      const selection = window.getSelection();
      if (body && selection?.rangeCount && resolveClozeBody(selection.anchorNode) === body &&
          resolveClozeBody(selection.focusNode) === body) {
        selection.removeAllRanges();
        this.updateReveal();
      }
    };
    const textPoint = (x: number, y: number, body: HTMLElement): Point | null => {
      const caret = document.caretPositionFromPoint?.(x, y);
      const fallback = caret ? null : document.caretRangeFromPoint?.(x, y);
      const node = caret?.offsetNode ?? fallback?.startContainer;
      return node && resolveClozeBody(node) === body ? { node, offset: caret?.offset ?? fallback!.startOffset } : null;
    };
    const updateDrag = (start: NonNullable<typeof press>, event: PointerEvent) => {
      if (!start.moved && distance(start, event) <= 7) return;
      start.moved = true;
      if (!start.origin?.node.isConnected) return;
      const end = textPoint(event.clientX, event.clientY, start.body);
      if (end) window.getSelection()?.setBaseAndExtent(start.origin.node, start.origin.offset, end.node, end.offset);
    };

    window.addEventListener('pointerdown', e => {
      reset();
      if (!e.isPrimary || e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = this.resolveToggleTarget(anchorAt(e.target));
      const body = target && resolveClozeBody(target.anchor);
      if (!target || !body) return;
      const touch = e.pointerType === 'touch';
      press = { target, body, id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp,
        touch, moved: false, origin: touch ? null : textPoint(e.clientX, e.clientY, body) };
      if (!touch) {
        // 隔开思源的按下处理，但保留浏览器产生 mouseup 的能力，让拖选结束后工具栏照常更新。
        e.stopImmediatePropagation();
        clearEditorSelection(body);
      }
    }, capture);
    window.addEventListener('mousedown', e => {
      // 浏览器在 mousedown 的默认处理中放置光标。必须在按下时阻止，不能等 click 再清理。
      if (press && !press.touch && e.button === 0 && distance(press, e) <= 8) consume(e);
    }, capture);
    window.addEventListener('pointermove', e => {
      if (press?.id === e.pointerId) updateDrag(press, e);
    }, capture);
    window.addEventListener('pointerup', e => {
      const start = press?.id === e.pointerId ? press : undefined;
      if (!start) return;
      press = undefined;
      updateDrag(start, e);
      if (start.moved || e.button !== 0 || (start.touch && e.timeStamp - start.at > 430)) return;
      // 触摸可能捕获指针，用实际落点而不是事件目标。
      const end = this.resolveToggleTarget(document.elementFromPoint(e.clientX, e.clientY));
      if (end && end.root === start.target.root && end.key === start.target.key) {
        released = { target: end, id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, touch: start.touch, handled: false };
        if (!start.touch) e.stopImmediatePropagation();
      }
    }, capture);
    window.addEventListener('touchend', e => {
      const end = released;
      if (!end?.touch || end.handled || Math.abs(e.timeStamp - end.at) > 50) return;
      if (![...e.changedTouches].some(touch => distance(end, touch) <= 8)) return;
      // 只接管已经确认的轻触，防止浏览器补发鼠标双击后选中文字。滑动和长按不走这里。
      consume(e);
      end.handled = true;
      confirm(end, end.x, end.y);
    }, { ...capture, passive: false });
    // 只有已经判定为点击时，才阻止编辑器把这次松手当成选中文字。
    window.addEventListener('mouseup', e => {
      if (released && matchesRelease(released, e)) e.stopImmediatePropagation();
    }, capture);
    window.addEventListener('click', e => {
      const end = released;
      released = undefined;
      if (end && matchesRelease(end, e)) {
        consume(e);
        if (!end.handled) confirm(end, e.clientX, e.clientY);
      } else if (anchorAt(e.target)) consume(e);
    }, capture);
    for (const type of ['pointercancel', 'dragstart', 'contextmenu'] as const) {
      window.addEventListener(type, reset, capture);
    }
    for (const type of ['dblclick', 'auxclick'] as const) {
      window.addEventListener(type, e => { if (anchorAt(e.target)) consume(e); }, capture);
    }
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'] as const) {
      window.addEventListener(type, e => {
        if (e.buttons === 0 && anchorAt(e.target)) e.stopImmediatePropagation();
      }, capture);
    }
    window.addEventListener('scroll', reset, { capture: true, passive: true, signal });
    window.addEventListener('blur', reset, { signal });
  }

  private removeClickToggle() {
    this.cancelGesture?.();
    this.cancelGesture = undefined;
    this.gestureEvents?.abort();
    this.gestureEvents = undefined;
  }

  private attachEditors(scope: Element) {
    const bodies = Array.from(scope.querySelectorAll<HTMLElement>(BODY_SELECTOR));
    if (scope.matches(BODY_SELECTOR)) bodies.unshift(scope as HTMLElement);
    for (const body of bodies) {
      const root = resolveProtyleRoot(body);
      if (!root || this.destroyedRoots.has(root) || !body.isConnected || resolveClozeBody(body) !== body || this.layers.has(body)) continue;
      this.layers.set(body, new UnderlineLayer(body, () => this.isClozeActive));
      const blocks = new Set<HTMLElement>();
      body.querySelectorAll<HTMLElement>(KBD_SELECTOR).forEach(kbd => {
        const block = resolveClozeBlock(kbd);
        if (block && resolveClozeBody(kbd) === body) blocks.add(block);
      });
      blocks.forEach(block => this.refreshBlock(block));
    }
  }

  private invalidateBlock(block: HTMLElement) {
    const body = resolveClozeBody(block);
    if (!body) return;
    const hasCloze = [...block.querySelectorAll(KBD_SELECTOR)].some(kbd => resolveClozeBlock(kbd) === block && resolveClozeBody(kbd) === body);
    this.layers.get(body)?.track(block, hasCloze);
  }

  private refreshBlock(block: HTMLElement) {
    const body = resolveClozeBody(block);
    if (!body || !this.layers.has(body)) return;
    markClusterMath(block);
    replayBlockUnveil(this.unveilStore, block);
    this.invalidateBlock(block);
  }

  private refreshBlockCopies(block: HTMLElement, root: HTMLElement) {
    this.invalidateBlock(block);
    const id = block.getAttribute('data-node-id');
    if (!id) return;
    for (const copy of root.querySelectorAll<HTMLElement>(      "[data-node-id=\"" + CSS.escape(id) + "\"]:not(span)")) {
      if (copy !== block && resolveProtyleRoot(copy) === root) this.refreshBlock(copy);
    }
  }

  private initDomObserver() {
    const withoutPlugin = (value: string | null) => (value || '').split(/\s+/).filter(c => c && !c.startsWith('sy-cloze-')).join(' ');
    this.domObserver = new MutationObserver(records => {
      const blocks = new Set<HTMLElement>();
      let prune = false;
      for (const record of records) {
        const target = resolveElement(record.target);
        if (!target || target.closest('.cloze-underlines')) continue;
        if (record.type === 'attributes' && record.attributeName === 'class' &&
            withoutPlugin(record.oldValue) === withoutPlugin(target.getAttribute('class'))) continue;
        const body = resolveClozeBody(target);
        const block = resolveClozeBlock(target);
        if (body && block && body.contains(block)) blocks.add(block);
        if (record.type === 'attributes' && (record.attributeName === 'style' || record.attributeName === 'class' || record.attributeName === 'data-type')) {
          if (body && !block) this.layers.get(body)?.invalidate();
          if (!block) for (const layer of this.layers.values()) if (target.contains(layer.body)) layer.invalidate();
          if (record.attributeName !== 'style' && !block && !body) prune = true;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          this.attachEditors(node);
          if (node.matches('[data-node-id]:not(span)') && resolveClozeBody(node)) blocks.add(node);
          if (!node.closest('span')) node.querySelectorAll<HTMLElement>(KBD_SELECTOR).forEach(kbd => {
            const owner = resolveClozeBlock(kbd);
            if (owner && resolveClozeBody(kbd)) blocks.add(owner);
          });
        }
        if (record.removedNodes.length) prune = true;
        if (body && !block && record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element) || !node.matches('.cloze-underlines'))) this.layers.get(body)?.invalidate();
      }
      if (prune) for (const [body, layer] of this.layers) {
        if (!body.isConnected || resolveClozeBody(body) !== body) {
          const root = resolveProtyleRoot(body);
          if (root && !root.isConnected) this.unveilStore.drop(root);
          layer.dispose();
          this.layers.delete(body);
        } else layer.prune();
      }
      blocks.forEach(block => { if (block.isConnected) this.refreshBlock(block); });
      if (blocks.size) this.scheduleRevealUpdate();
    });
    this.domObserver.observe(document.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'data-render', 'data-content', 'data-type'] });
  }

  private removeDomObserver() {
    this.domObserver?.disconnect();
    this.domObserver = undefined;
  }

  private initEventBus() {
    this.eventBus.on('loaded-protyle-static', this.protyleLoaded);
    this.eventBus.on('loaded-protyle-dynamic', this.protyleLoaded);
    this.eventBus.on('destroy-protyle', this.protyleDestroyed);
  }

  private protyleLoaded = (event: CustomEvent) => {
    const root: HTMLElement | undefined = event.detail?.protyle?.element;
    if (!root) return;
    this.destroyedRoots.delete(root);
    this.attachEditors(root);
    for (const [body, layer] of this.layers) if (root.contains(body)) layer.invalidate();
    this.scheduleRevealUpdate();
  };

  private protyleDestroyed = (event: CustomEvent) => {
    const root: HTMLElement | undefined = event.detail?.protyle?.element;
    if (!root) return;
    this.destroyedRoots.add(root);
    this.unveilStore.drop(root);
    for (const [body, layer] of this.layers) if (root === body || root.contains(body)) {
      const owner = resolveProtyleRoot(body);
      if (owner) { this.destroyedRoots.add(owner); this.unveilStore.drop(owner); }
      layer.dispose();
      this.layers.delete(body);
    }
    this.scheduleRevealUpdate();
  };

  private caretAnchor(range: Range): HTMLElement | null {
    const node = range.startContainer;
    const direct = resolveClozeAnchor(node);
    if (direct) return direct;
    if (node.nodeType === Node.TEXT_NODE && INVISIBLE_TEXT.test(node.textContent || '')) {
      for (const sibling of [node.previousSibling, node.nextSibling]) {
        if (sibling instanceof HTMLElement && sibling.matches(KBD_SELECTOR)) return resolveClozeAnchor(sibling);
      }
    }
    return null;
  }

  /* ========================================================================
     五、行内挖空动作（⇧⌘C，选区语义对齐思源 setInlineMark）
     ======================================================================== */

  private openCellAndApplyCloze(protyle: any, cell: HTMLTableCellElement, range: Range, selection: Selection) {
    const body = resolveClozeBody(cell);
    const table = cell.closest<HTMLElement>('[data-type="NodeTable"]');
    const tableId = table?.dataset.nodeId;
    const row = cell.closest('tr')?.rowIndex;
    const col = cell.cellIndex;
    const removing = Boolean(this.caretAnchor(range));
    const lifetime = this.gestureEvents?.signal;
    if (!body || !table || !tableId || row === undefined || !lifetime || protyle?.disabled || protyle?.wysiwyg?.element !== body) {
      this.showClozeFailure(removing);
      return;
    }
    if (this.pendingCellOpens.has(cell)) return;
    this.pendingCellOpens.add(cell);

    selection.removeAllRanges();
    selection.addRange(range);
    const collapsed = range.collapsed;
    const applyWhenReady = () => {
      if (!body.isConnected) { finish(); return; }
      const current = window.getSelection();
      if (!current?.rangeCount) return;
      const restored = current.getRangeAt(0);
      const host = closestCellEditor(restored.startContainer);
      if (!host || host !== closestCellEditor(restored.endContainer) || restored.collapsed !== collapsed) return;
      const currentCell = host.closest<HTMLTableCellElement>(CELL_SELECTOR);
      const liveTable = currentInlineBlock(body, table, tableId);
      if (!currentCell || currentCell.cellIndex !== col || currentCell.closest('tr')?.rowIndex !== row ||
          currentCell.closest('[data-type="NodeTable"]') !== liveTable) return;
      finish();
      this.applyClozeInCellEditor(protyle, host, restored.cloneRange(), current);
    };
    const observer = new MutationObserver(applyWhenReady);
    const pending = new AbortController();
    const finish = () => {
      observer.disconnect();
      pending.abort();
      lifetime.removeEventListener('abort', finish);
      window.clearTimeout(timer);
      this.pendingCellOpens.delete(cell);
    };
    const timer = window.setTimeout(() => {
      finish();
      if (body.isConnected) this.showClozeFailure(removing);
    }, 1800);
    lifetime.addEventListener('abort', finish, { once: true });
    document.addEventListener('selectionchange', applyWhenReady, { signal: pending.signal });
    // 用户开始别的操作时，不再修改原来的选区。
    document.addEventListener('pointerdown', finish, { capture: true, signal: pending.signal });
    document.addEventListener('keydown', finish, { capture: true, signal: pending.signal });
    observer.observe(body, { childList: true, subtree: true });
    // 思源用方向键松开事件从预览进入单元格，并自行恢复其中的选区。
    // 只发送 keyup，避免浏览器移动光标或插入内容。
    body.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight' }));
  }

  private applyClozeInCellEditor(protyle: any, host: HTMLElement, range: Range, selection: Selection) {
    const body = host.querySelector<HTMLElement>(BODY_SELECTOR);
    const ownerToolbar = protyle?.toolbar;
    if (!body || !body.contains(range.startContainer) || !body.contains(range.endContainer) ||
        protyle?.disabled || typeof ownerToolbar?.setInlineMarkInBlock !== 'function') {
      this.showClozeFailure(Boolean(this.caretAnchor(range)));
      return;
    }

    const caret = range.collapsed ? this.caretAnchor(range) : null;
    if (range.collapsed && !caret) {
      showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
      return;
    }
    const targets = cellEditableRanges(body, range).map(({ block, range: segment }) => {
      const clusters = caret && block.contains(caret) ? [getClozeCluster(caret)] : findClustersInRange(segment, block);
      return { block, range: segment, cluster: clusters.flat() };
    });
    const removing = targets.some(item => item.cluster.length > 0);
    const edits = targets.flatMap(item => {
      if (removing && !item.cluster.length) return [];
      if (removing) {
        item.range.setStartBefore(item.cluster[0]);
        item.range.setEndAfter(item.cluster[item.cluster.length - 1]);
      }
      const before = snapshotInlineMask(item.block, item.range);
      return before.selection ? [{ ...item, before, previous: listBlockClusters(item.block).map(entry => entry.text) }] : [];
    });
    if (!edits.length) { this.showClozeFailure(removing); return; }

    // 复用思源的行内格式处理。明确传入添加/删除，进入其不发送事务的分支；
    // 单元格编辑器观察内容变化，由思源以所属表格的 ID 保存并记录撤销。
    const toolbar = Object.create(ownerToolbar);
    const local = { ...protyle, wysiwyg: { element: body }, toolbar };
    let applied = 0;
    let firstResult: Range | undefined;
    let lastResult: Range | undefined;
    try {
      for (const { block, range: segment, before, previous } of edits) {
        toolbar.range = segment;
        toolbar.setInlineMarkInBlock(local, 'kbd', 'range', undefined, removing, false);
        if (!appliedInlineMask(before, snapshotInlineMask(block), removing)) continue;
        applied++;
        firstResult ??= toolbar.range.cloneRange();
        lastResult = toolbar.range.cloneRange();
        this.finishClozeBlock(block, removing, previous);
      }
    } catch (error) {
      console.warn('[Cloze] Table cell inline mark failed:', error);
    }
    if (firstResult && lastResult && body.contains(firstResult.startContainer) && body.contains(lastResult.endContainer)) {
      firstResult.setEnd(lastResult.endContainer, lastResult.endOffset);
      selection.removeAllRanges();
      selection.addRange(firstResult);
    }
    if (applied !== edits.length) this.showClozeFailure(removing);
    else this.showClozeSuccess(removing);
  }

  private showClozeFailure(removing: boolean) {
    const message = removing
      ? String(this.i18n.removeFailed || '未能确认挖空已取消，请检查选区后再试')
      : String(this.i18n.createFailed || '未能确认挖空已创建，请检查选区后再试');
    showMessage(message, 2500, 'info');
  }

  private showClozeSuccess(removing: boolean) {
    const message = removing
      ? String(this.i18n.clozeRemoved || '已取消整块行内挖空遮罩')
      : String(this.i18n.clozeCreated || '已创建行内挖空块');
    showMessage(message, 1500, 'info');
  }

  private finishClozeBlock(block: HTMLElement, removing: boolean, previous: string[]) {
    const root = resolveProtyleRoot(block);
    if (removing) {
      forgetBlockOrder(this.unveilStore, root, block.getAttribute('data-node-id'));
      const records = this.unveilStore.peek(root);
      if (records) dropBlockUnveil(records, block);
    } else {
      forgetBlockOrderAfterCreate(this.unveilStore, block, previous);
    }
    this.refreshBlock(block);
    if (root) this.refreshBlockCopies(block, root);
    this.scheduleRevealUpdate();
  }

  /**
   * 取本次操作真正要用的 Range。
   *
   * 移动端键盘工具栏、命令面板弹出时，编辑区可能已经失焦，window.getSelection()
   * 会折叠甚至清空；思源自己的格式按钮用的是 protyle.toolbar.range 这份快照。
   * 这里按可信度取：调用方显式传入的 Range → 当前选区 → 工具栏快照。
   * 工具栏按钮场景显式要求先用快照，避免当前折叠光标把用户原来的划选覆盖掉。
   */
  private resolveActionRange(protyle: any, preferredRange?: Range, preferSaved = false): Range | null {
    const root = protyle?.wysiwyg?.element as HTMLElement | undefined;
    const valid = (range?: Range | null): range is Range => {
      if (!range || !range.startContainer?.isConnected || !range.endContainer?.isConnected) return false;
      return !root || (root.contains(range.startContainer) && root.contains(range.endContainer));
    };

    if (valid(preferredRange)) return preferredRange.cloneRange();

    const selection = window.getSelection();
    const current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const saved = protyle?.toolbar?.range as Range | undefined;

    // 单元格有自己的编辑器，外层工具栏可能还记着另一段正文。
    if (preferSaved && valid(current)) {
      const host = closestCellEditor(current.startContainer);
      if (host && host === closestCellEditor(current.endContainer) && (!current.collapsed || this.caretAnchor(current))) {
        return current.cloneRange();
      }
    }
    if (preferSaved && valid(saved)) return saved.cloneRange();
    if (valid(current)) return current.cloneRange();
    if (valid(saved)) return saved.cloneRange();
    return null;
  }

  /** 正文和表格共用入口，分别通过各自的编辑器保存。 */
  private handleStandardClozeAction(
    protyle: any,
    preferredRange?: Range,
    preferSaved = false,
  ) {
    // 桌面工具栏的 click 与 hotkey 传的是 Protyle 实例，命令回调传的是 IProtyle；
    // 这里统一成带 toolbar / wysiwyg 的 IProtyle，否则会被误判成“没有活动编辑器”。
    protyle = protyle?.protyle ?? protyle;

    const selection = window.getSelection();
    if (!selection) {
      showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
      return;
    }

    let range = this.resolveActionRange(protyle, preferredRange, preferSaved);
    if (!range) {
      showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
      return;
    }

    if (!resolveClozeBody(range.startContainer) || resolveClozeBody(range.startContainer) !== resolveClozeBody(range.endContainer)) return;

    const startCell = closestTableCell(range.startContainer);
    const endCell = closestTableCell(range.endContainer);
    if (startCell !== endCell) {
      showMessage(String(this.i18n.crossCell || '请在同一个单元格内选中文字或公式'), 2000, 'info');
      return;
    }
    const cellEditor = closestCellEditor(range.startContainer);
    if (cellEditor) {
      this.applyClozeInCellEditor(protyle, cellEditor, range, selection);
      return;
    }
    if (startCell && isRichCell(startCell)) {
      this.openCellAndApplyCloze(protyle, startCell, range, selection);
      return;
    }

    let startNode = resolveElement(range.startContainer);
    let endNode = resolveElement(range.endContainer);

    let startBlock: HTMLElement | null = resolveClozeBlock(startNode);
    let endBlock: HTMLElement | null = resolveClozeBlock(endNode);

    if (!startBlock || !endBlock) {
      showMessage(String(this.i18n.notInParagraph || '请将光标置于正文段落内'), 2000, 'info');
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
        showMessage(String(this.i18n.crossBlock || '行内挖空不能跨段落，请在同一段落内选择'), 2000, 'info');
        return;
      }

      startNode = resolveElement(range.startContainer);
      endNode = resolveElement(range.endContainer);
      startBlock = resolveClozeBlock(startNode);
      endBlock = resolveClozeBlock(endNode);

      if (!startBlock || !endBlock || startBlock !== endBlock) {
        showMessage(String(this.i18n.crossBlock || '行内挖空不能跨段落，请在同一段落内选择'), 2000, 'info');
        return;
      }
    }

    let targetClusters: HTMLElement[][] = [];

    // 检查光标折叠情况（单点光标落入）
    if (range.collapsed) {
      const targetKbd = this.caretAnchor(range);
      if (!targetKbd) {
        showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
        return;
      }
      targetClusters = [getClozeCluster(targetKbd)];
    } else {
      // 划选：收集全部相交簇。用户选中多个遮罩再按快捷键时，取消的应当是
      // 整段选区里的所有遮罩，而不是只取消 DOM 顺序上的第一个。
      targetClusters = findClustersInRange(range, startBlock);
    }

    // 取消场景：把选区扩展到首尾簇，免除逐片取消的痛苦。
    // 多个簇之间的普通内容不会被打上 kbd，setInlineMark 只清选区内的 kbd。
    const cluster = targetClusters.flat();
    if (cluster.length > 0) {
      const expandRange = document.createRange();
      expandRange.setStartBefore(cluster[0]);
      expandRange.setEndAfter(cluster[cluster.length - 1]);

      selection.removeAllRanges();
      selection.addRange(expandRange);
      range = expandRange;
    }

    if (protyle && protyle.toolbar && typeof protyle.toolbar.setInlineMark === 'function') {
      try {
        const body = resolveClozeBody(startBlock);
        const blockNodeId = startBlock.getAttribute('data-node-id');
        if (!body || !blockNodeId) return;

        const removing = targetClusters.length > 0;
        const before = snapshotInlineMask(startBlock, range);
        const previous = removing ? [] : listBlockClusters(startBlock).map(item => item.text);
        if (!before.selection) {
          this.showClozeFailure(removing);
          return;
        }

        // 思源读取的是工具栏保存的 Range。原生切换只能调用一次，重复会把结果再切回去。
        protyle.toolbar.range = range.cloneRange();
        protyle.toolbar.setInlineMark(protyle, 'kbd', 'range');

        const currentBlock = currentInlineBlock(body, startBlock, blockNodeId);
        if (!currentBlock || !appliedInlineMask(before, snapshotInlineMask(currentBlock), removing)) {
          this.showClozeFailure(removing);
          return;
        }
        this.finishClozeBlock(currentBlock, removing, previous);
        this.showClozeSuccess(removing);
        return;
      } catch (err) {
        console.warn('[Cloze] Standard setInlineMark failed:', err);
      }
    }

    showMessage(String(this.i18n.notInEditor || '未找到活动编辑器，请确保光标在笔记中'), 2000, 'info');
  }

  /* ========================================================================
     六、全局显隐

     ⌥⇧X / 顶栏眼睛是全局开关，按下它就是「所有遮罩统一」：先把逐块点开的揭晓
     痕迹全部作废，再翻转开关。于是关闭时全部可见、重新开启时全部遮蔽，
     不会出现「一半显示一半遮蔽」。
     ======================================================================== */

  private toggleGlobalCloze() {
    this.setClozeActive(!this.isClozeActive);

    const msg = this.isClozeActive
      ? String(this.i18n.clozeActive || '完形填空模式已开启')
      : String(this.i18n.clozeInactive || '完形填空模式已关闭');
    showMessage(msg, 2000, 'info');
  }

  private setClozeActive(active: boolean) {
    if (this.isClozeActive === active) return;
    this.cancelGesture?.();
    resetAllUnveil(this.unveilStore, document);
    this.isClozeActive = active;
    this.updateTopBarState();
    this.updateGlobalStyles();
  }

  private updateTopBarState() {
    if (!this.topBarElement) return;

    const title = String(this.i18n.toggleCloze || '切换完形填空显隐');
    this.topBarElement.classList.toggle('protyle-icon--active', this.isClozeActive);
    this.topBarElement.setAttribute('aria-pressed', String(this.isClozeActive));
    this.topBarElement.setAttribute('aria-label', title);
    this.topBarElement.setAttribute('title', title);

    // 顶栏图标与移动端插件菜单项都靠 <use> 取图标；换图标比只加一个没有
    // 样式的 class 更能让用户看出当前是开还是关。
    const use = this.topBarElement.querySelector('use');
    if (use) {
      use.setAttribute('xlink:href', this.isClozeActive ? '#iconEyeoff' : '#iconEye');
    }
  }

  private updateGlobalStyles() {
    // 遮蔽只由 body 上的开关向下生效，作用域在样式表里收进 .protyle-wysiwyg：
    // 分栏、单元格编辑器这类后建的编辑器无需补类。
    document.body.classList.toggle('sy-cloze-active', this.isClozeActive);
    for (const layer of this.layers.values()) layer.invalidate();

    if (!this.isClozeActive) {
      this.clearReveal();
    } else {
      this.scheduleRevealUpdate();
    }
  }

  private cleanAllClozeArtifacts() {
    document.body.classList.remove('sy-cloze-active');

    // 插件卸载后这些类失去 CSS 依托，留在 DOM 上只是垃圾，一并清掉。
    document.querySelectorAll<HTMLElement>(`.${UNVEIL_CLASS}, .${HIDING_CLASS}`).forEach((el) => {
      el.classList.remove(UNVEIL_CLASS, HIDING_CLASS);
    });
    document.querySelectorAll('.' + CLUSTER_MATH_CLASS).forEach(el => el.classList.remove(CLUSTER_MATH_CLASS));

    this.clearReveal();
  }

  /* ========================================================================
     七、设置面板
     ======================================================================== */

  private initSettingsPanel() {
    let draft: HTMLInputElement | undefined;
    let pending: Promise<void> = Promise.resolve();
    this.setting = new Setting({
      confirmCallback: () => {
        const next = draft?.checked;
        if (next === undefined) return;
        pending = pending.then(async () => {
          if (next === this.settings.defaultHide) return;
          const settings = { ...this.settings, defaultHide: next };
          try {
            const result = await this.saveData(STORAGE_NAME, settings) as { code?: number } | undefined;
            if (result?.code) throw new Error(`saveData: ${result.code}`);
            this.settings = settings;
            this.setClozeActive(next);
          } catch {
            showMessage(String(this.i18n.settingsSaveFailed || '未能保存挖空设置'), 3000, 'error');
          }
        });
        return pending;
      },
    });
    this.setting.addItem({
      title: String(this.i18n.defaultHide || '启动时遮蔽挖空'),
      description: String(this.i18n.defaultHideDesc || '插件启动时采用此模式。更改并保存后，也会应用到当前会话。'),
      createActionElement: () => {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'b3-switch fn__flex-center';
        input.checked = this.settings.defaultHide;
        draft = input;
        return input;
      },
    });
  }

  private async loadPluginSettings() {
    try {
      const data = await this.loadData(STORAGE_NAME);
      if (data && typeof data === 'object') {
        this.settings = { ...data, defaultHide: typeof data.defaultHide === 'boolean' ? data.defaultHide : DEFAULT_SETTINGS.defaultHide };
      }
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }
}
