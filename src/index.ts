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
  dropUnveilForBlockId,
  forgetBlockOrder,
  rememberBlockOrder,
  replayBlockUnveil,
  resetAllUnveil,
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
  resolveHotkeyBindings,
} from './tableCell';
import { UnderlineLayer } from './underline';

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
        this.handleStandardClozeAction(protyle, false, undefined, true);
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
      this.handleStandardClozeAction(protyle, false, undefined, true);
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
    const capture = { capture: true, passive: false, signal };
    const owned = new Set<number>();
    let tap: { target: ToggleTarget; id: number; x: number; y: number; at: number } | undefined;
    let released: { id: number; x: number; y: number; at: number } | undefined;
    const reset = () => { owned.clear(); tap = undefined; released = undefined; };
    this.cancelGesture = reset;

    const anchorAt = (node: EventTarget | null) => this.isClozeActive && node instanceof Node && resolveClozeBody(node)
      ? resolveClozeAnchor(node) : null;
    const stop = (event: Event) => event.stopImmediatePropagation();
    const consume = (event: Event) => { event.preventDefault(); stop(event); };
    const distance = (a: { x: number; y: number }, b: MouseEvent) => Math.hypot(a.x - b.clientX, a.y - b.clientY);

    // 在 window 捕获阶段接管命中挖空的按下；切换仍等到同簇轻点抬起。
    window.addEventListener('pointerdown', e => {
      released = undefined;
      if (!e.isPrimary) tap = undefined;
      const anchor = anchorAt(e.target);
      if (!anchor) return;
      owned.add(e.pointerId);
      consume(e);
      if (e.isPrimary && e.button === 0 && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const target = this.resolveToggleTarget(anchor);
        if (target) tap = { target, id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp };
      }
    }, capture);
    window.addEventListener('pointermove', e => {
      if (!owned.has(e.pointerId)) {
        if (e.buttons === 0 && anchorAt(e.target)) stop(e);
        return;
      }
      if (tap?.id === e.pointerId && distance(tap, e) > 7) tap = undefined;
      stop(e);
    }, capture);
    window.addEventListener('pointerup', e => {
      if (!owned.delete(e.pointerId)) {
        if (anchorAt(e.target)) consume(e);
        return;
      }
      consume(e);
      released = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp };
      const start = tap?.id === e.pointerId ? tap : undefined;
      if (!start) return;
      tap = undefined;
      if (e.button !== 0 || e.timeStamp - start.at > 430 || distance(start, e) > 7) return;
      // 触摸会隐式捕获指针，抬起时用实际落点，而不是被捕获的事件目标。
      const end = this.resolveToggleTarget(document.elementFromPoint(e.clientX, e.clientY));
      if (end && end.root === start.target.root && end.key === start.target.key) this.toggleTarget(end);
    }, capture);
    window.addEventListener('pointercancel', e => {
      if (tap?.id === e.pointerId) tap = undefined;
      if (owned.delete(e.pointerId)) stop(e);
    }, capture);

    // click 不受 pointerdown.preventDefault() 保证；原生点击处理不能依赖揭晓是否成功。
    const swallowMouse = (e: MouseEvent) => {
      if (anchorAt(e.target)) { consume(e); return; }
      if (released && e.detail > 0 && e.timeStamp - released.at < 650 && distance(released, e) <= 8 &&
          (!('pointerId' in e) || e.pointerId === released.id || e.pointerId === 0)) consume(e);
    };
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'] as const) {
      window.addEventListener(type, swallowMouse, capture);
    }
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'] as const) {
      window.addEventListener(type, e => {
        if (e.buttons === 0 && anchorAt(e.target)) stop(e);
      }, capture);
    }
    const cancelAction = (e: Event) => {
      if (!owned.size && !anchorAt(e.target)) return;
      tap = undefined;
      consume(e);
    };
    window.addEventListener('contextmenu', cancelAction, capture);
    window.addEventListener('dragstart', cancelAction, capture);
    window.addEventListener('selectstart', cancelAction, capture);

    // 拦截旧触摸监听及补发点击，保留浏览器原生的滑动滚动和缩放。
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      window.addEventListener(type, e => {
        if (!Array.from(e.changedTouches).some(touch => anchorAt(touch.target))) return;
        if (type === 'touchend') consume(e);
        else stop(e);
      }, capture);
    }
    window.addEventListener('scroll', () => { tap = undefined; }, { capture: true, passive: true, signal });
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
      showMessage(String(this.i18n.cellSelectionNotFound || '未能在单元格内定位选区，请重新选择'), 2000, 'info');
      return;
    }

    // 偏移必须锚在「单元格内容区」上：编辑态的内容挂在 ProtyleLite 的 .protyle-wysiwyg 里，
    // 退避后则由 td 直接承载。拿整个 td 去算偏移会被编辑器外壳（表格控件按钮等）的文本
    // 带偏，恢复时必然越界——实测表现就是「选区恢复失败」。
    const contentRoot = cellEditor.querySelector(CELL_CONTENT_SELECTOR) || cellEditor;
    const start = getVisibleOffset(contentRoot, range.startContainer, range.startOffset);
    const end = getVisibleOffset(contentRoot, range.endContainer, range.endOffset);
    if (start < 0 || end < 0) {
      showMessage(String(this.i18n.cellSelectionNotFound || '未能在单元格内定位选区，请重新选择'), 2000, 'info');
      return;
    }

    // 派发到 body：既不属于单元格编辑器，也不在外层 wysiwyg 内，
    // 正好命中思源「目标不属于编辑器就 finish」这一条分支。
    const PointerCtor: typeof PointerEvent =
      typeof PointerEvent === 'function' ? PointerEvent : (MouseEvent as unknown as typeof PointerEvent);
    document.body.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true, cancelable: true }));

    window.requestAnimationFrame(() => {
      if (!cell.isConnected) {
        showMessage(String(this.i18n.cellInvalid || '单元格已失效，请重新选择'), 2000, 'info');
        return;
      }

      // rich 形态：单元格内容已按持久化的复杂块存着，外层 setInlineMark 依然不适用。
      // 如实告知，而不是硬闯出一次事务错误。
      if (isRichCell(cell)) {
        showMessage(String(this.i18n.cellRich || '该单元格内容较复杂，请退出单元格编辑后再试'), 2500, 'info');
        return;
      }

      const restored = createRangeByVisibleOffset(cell, start, end);
      if (!restored) {
        showMessage(String(this.i18n.cellRestoreFailed || '选区恢复失败，请重新选择'), 2000, 'info');
        return;
      }

      selection.removeAllRanges();
      selection.addRange(restored);
      this.handleStandardClozeAction(protyle, true);
    });
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

    if (preferSaved && valid(saved)) return saved.cloneRange();
    if (valid(current)) return current.cloneRange();
    if (valid(saved)) return saved.cloneRange();
    return null;
  }

  /**
   * 1. 跨段落检查：禁止跨越不同 [data-node-id] 块容器；
   * 2. 光标单点一键取消：光标停在遮罩内任意位置时，自动向上捕获整个连续集群，瞬间全块取消；
   * 3. 划选选区处理：已全部覆盖则一键清除，未全部覆盖则统一打上遮罩；
   * 4. 彻底依托思源官方 AST 与 Undo 事务，零 DOM 撕碎，零格式损坏。
   */
  private handleStandardClozeAction(
    protyle: any,
    isRetry = false,
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

    // 表格单元格编辑态：td 已被 openTableCellRichEditor 整体换成独立 ProtyleLite，
    // 单元格内的块是**没有持久 ID 的临时块**。此时若继续走外层 protyle 的事务，
    // 内核会以 block not found 拒绝并回滚——前端 DOM 看着像加上了 kbd，数据却不落库。
    // 先退避：提交掉单元格编辑器，等 td 回到可事务化形态，再按偏移重建选区重执行。
    const cellEditor = closestCellEditor(range.startContainer);
    if (cellEditor) {
      if (isRetry) {
        showMessage(String(this.i18n.cellStillEditing || '单元格仍处于编辑状态，请点击单元格外部后再试'), 2500, 'info');
        return;
      }
      this.retreatFromCellEditor(protyle, selection, range, cellEditor);
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

        const isFullyMarked = currentTypes.includes('kbd') || targetClusters.length > 0;
        const kbdBefore = startBlock.querySelectorAll(KBD_SELECTOR).length;

        // 取消之前先把记录坐标取好：setInlineMark 之后块 DOM 可能被整体重建，
        // 届时 startBlock 已脱离文档，再也问不出它属于哪个 protyle。
        const unveilRoot = resolveProtyleRoot(startBlock);
        const blockNodeId = startBlock.getAttribute('data-node-id');

        // 调用思源官方原生管道执行标准化处理（等价于思源原生行内标记）。
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

        if (startBlock.isConnected) {
          this.invalidateBlock(startBlock);
        }
        this.scheduleRevealUpdate();

        // 创建同样要验收：事务被内核拒绝时前端 DOM 可能毫无变化，
        // 不校验就会谎报「已创建」。
        const createdOk = !isFullyMarked &&
          startBlock.querySelectorAll(KBD_SELECTOR).length > kbdBefore;

        if (createdOk) {
          // 块里多了一个遮罩，上一轮的簇顺序不再对应「同一个位置还是同一个遮罩」，
          // 基线就此作废；下一次回放结束时会自然重建。
          forgetBlockOrder(this.unveilStore, unveilRoot, blockNodeId);
        }

        let msg: string;
        let duration = 1500;
        if (!isFullyMarked) {
          if (createdOk) {
            msg = String(this.i18n.clozeCreated || '已创建行内挖空块');
          } else {
            msg = String(this.i18n.createFailed || '创建未生效，请重试或把光标置于段落内');
            duration = 2500;
          }
        } else if (stillMarked) {
          msg = String(this.i18n.removeFailed || '取消未生效，请把光标放进挖空块再试一次');
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
