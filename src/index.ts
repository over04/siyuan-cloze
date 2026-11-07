import { Plugin, showMessage, Setting, getActiveEditor } from 'siyuan';
import {
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
  resolveElement,
  resolveProtyleRoot,
} from './cluster';
import {
  HIDING_CLASS,
  UnveilStore,
  dropUnveilForBlockId,
  findClusterByKey,
  forgetBlockOrder,
  rememberBlockOrder,
  replayBlockUnveil,
  replayUnveilInto,
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
  private toggleDownHandler?: (e: MouseEvent) => void;
  private swallowHandler?: (e: MouseEvent) => void;
  /**
   * 命中遮罩的这次交互是否还没结束。
   *
   * 立起来之后，紧随的 mouseup / click / dblclick 一并吞掉，直到这次交互的 click 到达才复位。
   * 不用固定时间窗：用户按住不放超过窗口再松开时，mouseup 会漏给思源，它会收到一次没有对应
   * mousedown 的抬起。
   *
   * 只拦 mousedown 是不够的：思源的编辑器还会在 mouseup / click 上更新选区快照、响应行内
   * 公式，对它来说这次点击仍然「发生过」——点遮罩里的公式照样弹出公式编辑器。
   * 没命中遮罩的 mousedown 会把它复位，因此不会误吞紧接着的下一次点击。
   */
  private swallowing = false;
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
      callback: () => {
        this.toggleGlobalCloze();
      },
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
    const root = resolveProtyleRoot(range.startContainer);
    if (!root) return;

    // 只扫当前编辑器：selectionchange 在拖动选择时每帧都会触发，扫全篇会把
    // 其它页签、表格单元格里的遮罩一起算进来，手机上尤其容易拖慢。
    root.querySelectorAll<HTMLElement>(KBD_SELECTOR).forEach((kbd) => {
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
     ======================================================================== */

  /**
   * 点击揭晓。
   *
   * 挂在捕获阶段的 mousedown 上，不是 click。click 只在 mousedown 与 mouseup 落在同一个
   * 目标上时才派发，而按下抬起之间抖几个像素就足以让目标变成相邻的文本——那次点击既不
   * 切换、又已经开始了拖选，用户看到的就是「点了没反应，还变成了选择」。mousedown 在拖选
   * 开始之前一定触发，这条路径根本不存在。
   *
   * 命中遮罩时把整次交互吞掉，不只是 mousedown：思源还会在 mouseup / click 上更新选区
   * 快照、响应行内公式，只拦 mousedown 的话，点遮罩里的公式照样会弹出公式编辑器。
   * preventDefault 只能拦住浏览器自己的默认行为（选择、聚焦），拦不住思源自己的处理，
   * 所以那几个事件得一并 stopImmediatePropagation。
   *
   * 每次点击都切换，不做双击回滚：mousedown 上的 preventDefault 已经让「双击选词」不可能
   * 发生，那个回滚分支只会让手快的人点两下等于没点。
   */
  private initClickToggle() {
    this.toggleDownHandler = (e: MouseEvent) => {
      if (!this.isClozeActive) return;
      if (e.button !== 0) return;

      const target = this.resolveToggleTarget(e.target as Node | null);
      if (!target) {
        // 没点中遮罩：这次交互不归我们管，紧随的 mouseup / click 也放行。
        this.swallowing = false;
        return;
      }

      this.swallowing = true;

      e.preventDefault();
      e.stopImmediatePropagation();

      // 每次点击都切换，不看 e.detail 的点击计数：连点两下就是切换两次。原本有个
      // 「第二下撤回」的分支，为的是保住双击选词；但 mousedown 上的 preventDefault
      // 早把选词一起拦掉了，那个分支已经没有存在意义，留着只会让手快的人点两下等于没点。
      this.commitToggle(target);
    };

    this.swallowHandler = (e: MouseEvent) => {
      if (!this.swallowing) return;
      // mouseup 只吞不复位：这次交互的 click 紧随其后，标记留到那时再清。
      if (e.type !== 'mouseup') this.swallowing = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    document.addEventListener('mousedown', this.toggleDownHandler, true);
    document.addEventListener('mouseup', this.swallowHandler, true);
    document.addEventListener('click', this.swallowHandler, true);
    document.addEventListener('dblclick', this.swallowHandler, true);
  }

  /** 把命中的簇解析成可跨重建定位的目标：只留根元素、块 ID 与标识。 */
  private resolveToggleTarget(node: Node | null): ToggleTarget | null {
    const anchor = resolveClozeAnchor(node);
    // 编辑器之外（其它插件界面、导出预览）的 kbd 不是遮罩，不参与切换。
    if (!anchor || !anchor.closest('.protyle-wysiwyg')) return null;

    const block = anchor.closest('[data-node-id]');
    const root = resolveProtyleRoot(anchor);
    const nodeId = block?.getAttribute('data-node-id');
    if (!block || !root || !nodeId) return null;

    const key = getClusterKey(block, getClozeCluster(anchor));
    return key ? { root, nodeId, key, anchor } : null;
  }

  /**
   * 真正执行切换。
   *
   * 不按块 ID 在根里 querySelector：同一个块 ID 在 protyle 根里可能同时存在多个元素
   * （实测 3 个），第一个未必是含遮罩的那份，会算出一个空簇，这次点击被静默丢掉——表现
   * 正是「点了没反应」。列表项与普通段落踩不踩得到这个坑，取决于那些副本的先后顺序。
   *
   * 顺序：点击时的那个遮罩元素若还在文档里，用它解析最可信；它被思源重建掉之后，才退回
   * 按块 ID 与答案文本在当前 DOM 里重找，并且逐个同 ID 元素试。
   */
  private commitToggle(target: ToggleTarget) {
    if (!this.isClozeActive) return;
    if (!target.root.isConnected) return;

    // 一级：点击时的锚点还在文档里、且仍属于这个 root，用它解析最可信。
    // 归属校验不能省：块被移到另一个编辑器时锚点依然 isConnected，只用它会让记录写进旧 root，
    // 新 root 的下一次回放读到空记录，把刚点亮的遮罩又清掉——看着就是「亮一下又灭」。
    if (target.anchor.isConnected && target.root.contains(target.anchor)) {
      const block = target.anchor.closest('[data-node-id]');
      const cluster = getClozeCluster(target.anchor);
      const key = block ? getClusterKey(block, cluster) : null;
      if (block && key) {
        this.applyToggle(target.root, block, key, cluster);
        return;
      }
    }

    const candidates = Array.from(
      target.root.querySelectorAll(`[data-node-id="${target.nodeId}"]`),
    );
    for (const block of candidates) {
      const cluster = findClusterByKey(block, target.key);
      if (cluster) {
        this.applyToggle(target.root, block, target.key, cluster);
        return;
      }
    }
  }

  private applyToggle(root: HTMLElement, block: Element, key: string, cluster: HTMLElement[]) {
    toggleUnveilByKey(this.unveilStore.ensure(root), key, cluster);
    // 记下这一刻的簇顺序：用户可能紧接着就在簇内改字，那时还没有任何 DOM 变更触发过
    // 回放，位置对齐要靠这份顺序才认得出「还是同一个遮罩」。
    rememberBlockOrder(this.unveilStore, block);
  }

  private removeClickToggle() {
    // 监听摘掉之后这个标记留着没有意义，顺手复位。
    this.swallowing = false;
    if (this.toggleDownHandler) {
      document.removeEventListener('mousedown', this.toggleDownHandler, true);
      this.toggleDownHandler = undefined;
    }
    if (this.swallowHandler) {
      document.removeEventListener('mouseup', this.swallowHandler, true);
      document.removeEventListener('click', this.swallowHandler, true);
      document.removeEventListener('dblclick', this.swallowHandler, true);
      this.swallowHandler = undefined;
    }
  }

  /* ========================================================================
     三、揭晓态保活

     揭晓写在 DOM 的 class 上，而思源会因编辑事务、页签切换重建块 DOM。
     观察 childList 变化、对受影响的块就地回放，揭晓因此不丢。
     只观察 childList：class 改动属 attributes，不会被自身回放再次触发。

     回放同步执行，不用定时器合并：思源重建块时新的 kbd 元素不带揭晓类，
     而 MutationObserver 的回调跑在微任务里、早于浏览器绘制——同步补类，用户看不到
     中间态。改成 setTimeout 会把落差推到下一帧之后，表现正是「每输入一个字，
     揭晓态闪一下」。

     只处理本次变更涉及的块，不扫全篇：文档里绝大多数块都没有揭晓记录，
     单块回放在记录为空时一次 closest 就早退。
     ======================================================================== */

  private initDomObserver() {
    this.domObserver = new MutationObserver((records) => {
      const blocks = new Set<Element>();

      records.forEach((record) => {
        const target = record.target.nodeType === Node.ELEMENT_NODE
          ? (record.target as HTMLElement)
          : record.target.parentElement;

        // 编辑器之外的变化与本插件无关：其它插件的界面里也会出现带 data-node-id 的元素
        // 与 kbd，打标和回放都不该落进去。新建编辑器由 loaded-protyle-static / dynamic 负责。
        const editor = target?.closest('.protyle-wysiwyg');
        if (!editor) return;

        const host = target?.closest('[data-node-id]');
        if (host) blocks.add(host);

        // 块被整体替换时，新块挂在父容器的 addedNodes 上，record.target 并不是它。
        record.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as Element;
          if (!editor.contains(el)) return;
          if (el.matches('[data-node-id]')) blocks.add(el);
          el.querySelectorAll('[data-node-id]').forEach((child) => blocks.add(child));
        });
      });

      blocks.forEach((block) => {
        // 先打标再回放：簇内公式的成员类要跟着这次变更后的 DOM 走。
        markClusterMath(block);
        replayBlockUnveil(this.unveilStore, block);
      });
    });

    this.domObserver.observe(document.body, { childList: true, subtree: true });
  }

  private removeDomObserver() {
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = undefined;
    }
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
    if (!containerEl.querySelector('.protyle-wysiwyg')) return;

    this.markClusterMathIn(containerEl);
    replayUnveilInto(this.unveilStore, containerEl);
  }

  private handleProtyleDynamic(containerEl: HTMLElement) {
    if (!containerEl.querySelector('.protyle-wysiwyg')) return;

    this.markClusterMathIn(containerEl);
    replayUnveilInto(this.unveilStore, containerEl);
    this.scheduleRevealUpdate();
  }

  /**
   * 给整篇里所有含遮罩的块打公式成员标记。
   *
   * 只从 kbd 反查所属块，不遍历全部块：文档里绝大多数块没有遮罩，逐块 querySelectorAll
   * 是白花的开销。同一个块里的多个 kbd 会被多次查到，用 Set 去重。
   */
  private markClusterMathIn(containerEl: HTMLElement) {
    const blocks = new Set<Element>();
    containerEl.querySelectorAll<HTMLElement>(KBD_SELECTOR).forEach((kbd) => {
      const block = kbd.closest('[data-node-id]');
      if (block) blocks.add(block);
    });
    blocks.forEach((block) => markClusterMath(block));
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

    let startBlock: Element | null = startNode?.closest('[data-node-id]') || null;
    let endBlock: Element | null = endNode?.closest('[data-node-id]') || null;

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
      startBlock = startNode?.closest('[data-node-id]') || null;
      endBlock = endNode?.closest('[data-node-id]') || null;

      if (!startBlock || !endBlock || startBlock !== endBlock) {
        showMessage(String(this.i18n.crossBlock || '行内挖空不能跨段落，请在同一段落内选择'), 2000, 'info');
        return;
      }
    }

    let targetClusters: HTMLElement[][] = [];

    // 检查光标折叠情况（单点光标落入）
    if (range.collapsed) {
      let targetKbd = startNode?.closest<HTMLElement>(KBD_SELECTOR) || null;

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
    // 关遮蔽之后 toggleDownHandler 会早退、不再复位吞事件标记，这里主动清一次：否则
    // 「命中遮罩后 click 丢失（拖选、鼠标移出窗口）→ 关遮蔽」之后，关遮蔽后的第一次
    // 点击的 mouseup / click 会被吞掉，看着像点了没反应。
    this.swallowing = false;
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
    document.querySelectorAll<HTMLElement>(`.${CLUSTER_MATH_CLASS}`).forEach((el) => {
      el.classList.remove(CLUSTER_MATH_CLASS);
    });

    this.clearReveal();
  }

  /* ========================================================================
     七、设置面板
     ======================================================================== */

  private initSettingsPanel() {
    this.setting = new Setting({
      confirmCallback: async () => {
        const next = this.settings.defaultHide;
        const changed = next !== this.isClozeActive;
        await this.savePluginSettings();

        // 「默认隐藏」同时作为当前开关的即时动作：用户改完设置就能看到效果，
        // 不必重载插件。只有真的翻转了状态才清揭晓记录，避免普通保存把阅读进度抹掉。
        if (changed) {
          resetAllUnveil(this.unveilStore, document);
          this.isClozeActive = next;
          this.updateTopBarState();
          this.updateGlobalStyles();
        }
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
