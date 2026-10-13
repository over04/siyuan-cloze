import { Plugin, showMessage, Setting, getActiveEditor } from 'siyuan';

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
  private hoverBoundHandler?: (e: MouseEvent) => void;

  async onload() {
    console.log('[Cloze] Initializing SiYuan Lossless Inline Cloze Plugin...');
    await this.loadPluginSettings();

    this.isClozeActive = this.settings.defaultHide;

    this.initTopBar();
    this.initCommands();
    this.initSettingsPanel();
    this.initEventBus();
    this.initGroupHoverListener();

    this.updateGlobalStyles();
  }

  onunload() {
    console.log('[Cloze] Unloading SiYuan Lossless Inline Cloze Plugin...');
    this.removeGroupHoverListener();
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
   * 100% 对照思源原生高光 (⌥D / setInlineMark('mark')) 对齐与标准化：
   * 1. 跨段落保护：禁止跨 [data-node-id] 块；
   * 2. 多选判定：
   *    - 若选区内全部已是 kbd，执行原生取消，统一清除；
   *    - 若选区内部分未标记或全未标记，执行原生补全，统一打上遮罩；
   * 3. 光标折叠且在 kbd 内部时，执行原生取消；
   * 4. 彻底依托思源内核 AST 与 Undo 事务，零 DOM 撕碎，零格式损坏。
   */
  private handleStandardClozeAction(protyle: any) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
      return;
    }

    const range = selection.getRangeAt(0);

    // 跨段落检查：禁止跨越不同 [data-node-id] 块容器
    const startNode = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
    const endNode = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;

    const startBlock = startNode?.closest('[data-node-id]');
    const endBlock = endNode?.closest('[data-node-id]');

    if (startBlock && endBlock && startBlock !== endBlock) {
      showMessage('行内挖空不能跨段落，请在同一段落内选择', 2000, 'info');
      return;
    }

    // 检查光标折叠时是否不在挖空块内
    if (selection.isCollapsed) {
      const inKbd = startNode?.closest('span[data-type~="kbd"]');
      if (!inKbd) {
        showMessage(String(this.i18n.noSelection || '请先选中文本或将光标置于挖空块内'), 2000, 'info');
        return;
      }
    }

    if (protyle && protyle.toolbar && typeof protyle.toolbar.setInlineMark === 'function') {
      try {
        // 先检测当前选区在思源工具条规范下的已有类型状态
        let currentTypes: string[] = [];
        if (typeof protyle.toolbar.getCurrentType === 'function') {
          try {
            currentTypes = protyle.toolbar.getCurrentType(range) || [];
          } catch {}
        }

        const isFullyMarked = currentTypes.includes('kbd');

        // 生成组 ID
        const groupId = 'cloze-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

        // 核心：直接调用原生官方管道执行标准化处理（完全等价于原生 ⌥D）
        const affectedNodes = protyle.toolbar.setInlineMark(protyle, 'kbd', 'range');

        // 若本次操作属于打上遮罩（补齐或新加），给新生成的节点注入 group 属性以支持长句跨空格悬停一体联动
        if (!isFullyMarked && Array.isArray(affectedNodes)) {
          affectedNodes.forEach((node: Node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as HTMLElement;
              const kbd = el.closest('span[data-type~="kbd"]');
              if (kbd) {
                kbd.setAttribute('data-cloze-group', groupId);
              }
            } else if (node.parentElement) {
              const kbd = node.parentElement.closest('span[data-type~="kbd"]');
              if (kbd) {
                kbd.setAttribute('data-cloze-group', groupId);
              }
            }
          });
        }

        if (!isFullyMarked && !this.isClozeActive) {
          this.isClozeActive = true;
          this.updateTopBarState();
          this.updateGlobalStyles();
        }

        const msg = isFullyMarked
          ? String(this.i18n.clozeRemoved || '已取消行内挖空遮罩')
          : String(this.i18n.clozeCreated || '已创建行内挖空块');
        showMessage(msg, 1500, 'info');
        return;
      } catch (err) {
        console.warn('[Cloze] Standard setInlineMark failed:', err);
      }
    }

    showMessage('未找到活动编辑器，请确保光标在笔记中', 2000, 'info');
  }

  private initGroupHoverListener() {
    this.hoverBoundHandler = (e: MouseEvent) => {
      if (!this.isClozeActive) return;

      const target = e.target as HTMLElement | null;
      const kbd = target?.closest<HTMLElement>('span[data-type~="kbd"]');

      // 清除所有既有联动
      if (e.type === 'mouseleave' || (!kbd && e.type === 'mouseover')) {
        document.querySelectorAll('.sy-cloze-hover-active').forEach((el) => {
          el.classList.remove('sy-cloze-hover-active');
        });
        return;
      }

      if (kbd && e.type === 'mouseover') {
        const groupId = kbd.getAttribute('data-cloze-group');
        if (groupId) {
          const peers = document.querySelectorAll(`span[data-type~="kbd"][data-cloze-group="${groupId}"]`);
          peers.forEach((peer) => {
            peer.classList.add('sy-cloze-hover-active');
          });
        }
      }
    };

    document.addEventListener('mouseover', this.hoverBoundHandler, true);
    document.addEventListener('mouseout', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const kbd = target?.closest<HTMLElement>('span[data-type~="kbd"]');
      if (kbd) {
        const groupId = kbd.getAttribute('data-cloze-group');
        if (groupId) {
          const peers = document.querySelectorAll(`span[data-type~="kbd"][data-cloze-group="${groupId}"]`);
          peers.forEach((peer) => {
            peer.classList.remove('sy-cloze-hover-active');
          });
        }
      }
    }, true);
  }

  private removeGroupHoverListener() {
    if (this.hoverBoundHandler) {
      document.removeEventListener('mouseover', this.hoverBoundHandler, true);
    }
  }

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
  }

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
  }

  private cleanAllClozeArtifacts() {
    document.body.classList.remove('sy-cloze-active');
    const wysiwygs = document.querySelectorAll<HTMLElement>('.protyle-wysiwyg');
    wysiwygs.forEach((wysiwyg) => {
      wysiwyg.classList.remove('sy-cloze-active');
    });
  }

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
