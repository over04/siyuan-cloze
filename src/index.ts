import { Plugin, showMessage, Setting, getActiveEditor } from 'siyuan';
import {
  INVISIBLE_TEXT,
  KBD_SELECTOR,
  REVEAL_CLASS,
  findKbdInRange,
  getClozeCluster,
  resolveClozeAnchor,
  resolveElement,
} from './cluster';

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

  /** 鼠标当前所在的集群（整簇，含被夹住的行内公式）。 */
  private hoverCluster: HTMLElement[] = [];
  /** 当前已挂上显晓类的元素，用于差分增删，避免每次全量 classList 抖动。 */
  private revealedElements: HTMLElement[] = [];
  private revealRaf = 0;

  private pointerOverHandler?: (e: MouseEvent) => void;
  private pointerOutHandler?: (e: MouseEvent) => void;
  private selectionHandler?: () => void;

  async onload() {
    console.log('[Cloze] Initializing SiYuan Lossless Inline Cloze Plugin...');
    await this.loadPluginSettings();

    this.isClozeActive = this.settings.defaultHide;

    this.initTopBar();
    this.initCommands();
    this.initSettingsPanel();
    this.initEventBus();
    this.initRevealListeners();

    this.updateGlobalStyles();
  }

  onunload() {
    console.log('[Cloze] Unloading SiYuan Lossless Inline Cloze Plugin...');
    this.removeRevealListeners();
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

  /* ========================================================================
     一、显晓联动：悬停 / 划选都以「整簇」为单位

     遮蔽本身是纯 CSS（字形透明 + 模糊光晕），JS 只负责一件事：
     决定哪些元素该加上显晓类。判定口径统一在成员数组上，因此不存在
     「悬停左边整簇亮、悬停右边只亮半边」这类方向性缺口。
     ======================================================================== */

  private initRevealListeners() {
    this.pointerOverHandler = (e: MouseEvent) => {
      if (!this.isClozeActive) return;
      const anchor = resolveClozeAnchor(e.target as Node | null);
      if (!anchor) {
        this.setHoverCluster([]);
        return;
      }
      this.setHoverCluster(getClozeCluster(anchor));
    };

    this.pointerOutHandler = (e: MouseEvent) => {
      if (!this.isClozeActive) return;
      const related = e.relatedTarget as Node | null;
      // 鼠标只是在集群内部或 kbd 的子元素之间移动时不清理，避免闪烁
      if (related && this.hoverCluster.some((el) => el === related || el.contains(related))) {
        return;
      }
      this.setHoverCluster([]);
    };

    this.selectionHandler = () => this.scheduleRevealUpdate();

    document.addEventListener('mouseover', this.pointerOverHandler, true);
    document.addEventListener('mouseout', this.pointerOutHandler, true);
    document.addEventListener('selectionchange', this.selectionHandler);
  }

  private removeRevealListeners() {
    if (this.pointerOverHandler) {
      document.removeEventListener('mouseover', this.pointerOverHandler, true);
    }
    if (this.pointerOutHandler) {
      document.removeEventListener('mouseout', this.pointerOutHandler, true);
    }
    if (this.selectionHandler) {
      document.removeEventListener('selectionchange', this.selectionHandler);
    }
    if (this.revealRaf) {
      window.cancelAnimationFrame(this.revealRaf);
      this.revealRaf = 0;
    }
  }

  private setHoverCluster(cluster: HTMLElement[]) {
    const same = cluster.length === this.hoverCluster.length &&
      cluster.every((el, index) => el === this.hoverCluster[index]);
    if (same) return;

    this.hoverCluster = cluster;
    this.scheduleRevealUpdate();
  }

  private scheduleRevealUpdate() {
    if (this.revealRaf) return;
    this.revealRaf = window.requestAnimationFrame(() => {
      this.revealRaf = 0;
      this.updateReveal();
    });
  }

  /**
   * 重新计算显晓集合：鼠标所在的整簇 ∪ 与划选范围相交的所有整簇。
   * 划选那一路解决的是「遮罩开着时划选看不清自己选了什么」。
   */
  private updateReveal() {
    const next = new Set<HTMLElement>();

    if (this.isClozeActive) {
      this.hoverCluster.forEach((el) => next.add(el));
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
    this.hoverCluster = [];
    for (const el of this.revealedElements) {
      el.classList.remove(REVEAL_CLASS);
    }
    this.revealedElements = [];
  }

  /* ========================================================================
     二、事件总线
     ======================================================================== */

  private initEventBus() {
    this.eventBus.on('loaded-protyle-static', (event) => {
      this.handleProtyleLoaded(event.detail.protyle.element);
    });

    this.eventBus.on('loaded-protyle-dynamic', (event) => {
      this.handleProtyleLoaded(event.detail.protyle.element);
    });
  }

  private handleProtyleLoaded(containerEl: HTMLElement) {
    const wysiwyg = containerEl.querySelector<HTMLElement>('.protyle-wysiwyg');
    if (!wysiwyg) return;

    wysiwyg.classList.toggle('sy-cloze-active', this.isClozeActive);
    this.scheduleRevealUpdate();
  }

  /* ========================================================================
     三、行内挖空命令（⌥Q，逻辑 100% 对齐思源原生 ⌥D）
     ======================================================================== */

  /**
   * 1. 跨段落检查：禁止跨越不同 [data-node-id] 块容器；
   * 2. 光标单点一键取消：光标停在遮罩内任意位置时，自动向上捕获整个连续集群，瞬间全块取消；
   * 3. 划选选区处理：已全部覆盖则一键清除，未全部覆盖则统一打上遮罩；
   * 4. 彻底依托思源官方 AST 与 Undo 事务，零 DOM 撕碎，零格式损坏。
   */
  private handleStandardClozeAction(protyle: any) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
      return;
    }

    let range = selection.getRangeAt(0);

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

        // 关键：思源 setInlineMark 只读 protyle.toolbar.range 这份缓存快照，
        // 并不读取 DOM Selection，且其更新时机仅限 mouseup/keyup/input 等事件。
        // 这里必须显式写回，否则取消操作会退化为「只取消光标所在的那一个切片」。
        if (protyle?.toolbar) {
          protyle.toolbar.range = expandRange;
        }
      }
    }

    if (protyle && protyle.toolbar && typeof protyle.toolbar.setInlineMark === 'function') {
      try {
        let currentTypes: string[] = [];
        if (typeof protyle.toolbar.getCurrentType === 'function') {
          try {
            currentTypes = protyle.toolbar.getCurrentType(range) || [];
          } catch {}
        }

        const isFullyMarked = currentTypes.includes('kbd') || Boolean(targetKbd);

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

        let msg: string;
        let duration = 1500;
        if (!isFullyMarked) {
          msg = String(this.i18n.clozeCreated || '已创建行内挖空块');
        } else if (stillMarked) {
          msg = '取消未生效，请把光标放进挖空块再按一次 ⌥Q';
          duration = 2500;
        } else {
          msg = String(this.i18n.clozeRemoved || '已取消整块行内挖空遮罩');
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
     四、全局显隐
     ======================================================================== */

  private toggleGlobalCloze() {
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

    this.clearReveal();
  }

  /* ========================================================================
     五、设置面板
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
