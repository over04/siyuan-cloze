import {
  collectClusters, isMath, REVEAL_CLASS, UNVEIL_CLASS, ZW_ONLY_TEXT,
} from './cluster';

interface Box { left: number; right: number; top: number; bottom: number }
interface Fragment extends Box { baseline: number; cluster?: HTMLElement[]; draw: boolean }
interface Row { baseline: number; fragments: Fragment[] }
interface Line { left: number; right: number; y: number }
const RADIUS = 1; // 2 CSS px stroke
const NATIVE = 'a, u, s, del, strike, code, [data-type~="u"], [data-type~="a"], [data-type~="tag"], [data-type~="s"], [data-type~="code"], [data-type~="inline-memo"], [data-type~="virtual-block-ref"], [data-type~="block-ref"], [data-type~="file-annotation-ref"]';
const SVG = 'http://www.w3.org/2000/svg';

const viewport = (): Box => ({ left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight });
const intersects = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

// 用 padding box 计算滚动裁切，排除边框及滚动条，并保持 viewport CSS px。
function clipTo(target: Box, el: HTMLElement, x: boolean, y: boolean) {
  const rect = el.getBoundingClientRect();
  const sx = el.offsetWidth ? rect.width / el.offsetWidth : 1;
  const sy = el.offsetHeight ? rect.height / el.offsetHeight : 1;
  if (x) {
    const left = rect.left + el.clientLeft * sx;
    target.left = Math.max(target.left, left);
    target.right = Math.min(target.right, left + el.clientWidth * sx);
  }
  if (y) {
    const top = rect.top + el.clientTop * sy;
    target.top = Math.max(target.top, top);
    target.bottom = Math.min(target.bottom, top + el.clientHeight * sy);
  }
}

function clipFor(container: HTMLElement, fixedOnly = false): Box {
  const clip = fixedOnly ? { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity } : viewport();
  for (let el: HTMLElement | null = container; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    const cell = el.matches('td, th');
    const scroll = el.matches('.protyle-content');
    const clips = (overflow: string) => fixedOnly ? /^(clip|hidden)$/.test(overflow) : overflow !== 'visible';
    if (fixedOnly && scroll && !cell) continue;
    const x = cell || scroll || clips(style.overflowX);
    const y = cell || scroll || clips(style.overflowY);
    if (x || y) clipTo(clip, el, x, y);
  }
  return clip;
}

function fragmentsIn(block: HTMLElement, clusters: HTMLElement[][], masking: boolean) {
  const owners = new Map<HTMLElement, HTMLElement[]>();
  const visible = new Set<HTMLElement[]>();
  for (const cluster of clusters) {
    if (!masking || cluster.some(el => el.classList.contains(REVEAL_CLASS) || el.classList.contains(UNVEIL_CLASS))) visible.add(cluster);
    cluster.forEach(el => owners.set(el, cluster));
  }
  const containers = new Map<HTMLElement, Fragment[]>();
  const styleCache = new Map<HTMLElement, CSSStyleDeclaration>();
  const styleOf = (el: HTMLElement) => {
    let style = styleCache.get(el);
    if (!style) { style = getComputedStyle(el); styleCache.set(el, style); }
    return style;
  };
  const range = document.createRange();
  const add = (container: HTMLElement, box: Box, baseline: number, cluster: HTMLElement[] | undefined, exempt: boolean) => {
    if (box.right - box.left < .05 || box.bottom <= box.top) return;
    const list = containers.get(container) || [];
    if (!containers.has(container)) containers.set(container, list);
    list.push({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, baseline, cluster, draw: Boolean(cluster && visible.has(cluster) && !exempt) });
  };

  function walk(node: Node, container: HTMLElement, cluster?: HTMLElement[], exempt = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (ZW_ONLY_TEXT.test(text)) return;
      const parent = node.parentElement!;
      const style = styleOf(parent);
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        // Range 给出文字盒。基线近似值只用于分行，实际画线用盒底。
        add(container, r, r.bottom - r.height * .21, cluster, exempt || style.visibility !== 'visible');
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el !== block && (el.matches('[data-node-id]:not(span), .protyle-wysiwyg, .protyle-attr, .katex-mathml, script, style'))) return;
    const style = styleOf(el);
    if (style.display === 'none' || style.visibility !== 'visible') return;
    cluster = owners.get(el) ?? cluster;
    exempt ||= el.matches(NATIVE) || /underline|line-through/.test(style.textDecorationLine);
    if (isMath(node)) {
      // KaTeX 的 .base 可能有多段；每段 strut 是该段实际排版的上下沿。
      const bases = el.querySelectorAll<HTMLElement>('.katex-html > :is(.base, .katex-base)');
      if (bases.length) {
        for (const base of bases) {
          const r = base.getBoundingClientRect();
          const strut = base.querySelector<HTMLElement>(':scope > :is(.strut, .katex-strut)');
          if (!strut) {
            add(container, r, r.bottom - r.height * .21, cluster, exempt);
            continue;
          }
          const s = strut.getBoundingClientRect();
          const height = parseFloat(strut.style.height);
          const depth = -parseFloat(strut.style.verticalAlign || '0');
          const baseline = height > 0 ? s.bottom - depth * s.height / height : s.bottom;
          add(container, { left: r.left, right: r.right, top: s.top, bottom: s.bottom }, baseline, cluster, exempt);
        }
      } else {
        for (const r of el.getClientRects()) add(container, r, r.bottom - r.height * .21, cluster, exempt);
      }
      return;
    }
    if (el.matches('td, th') || /^(block|flow-root|list-item|flex|grid|table-cell)$/.test(style.display)) container = el;
    for (const child of el.childNodes) walk(child, container, cluster, exempt);
  }
  walk(block, block);
  return containers;
}

function rowsOf(fragments: Fragment[]): Row[] {
  const rows: Row[] = [];
  for (const f of fragments.sort((a, b) => a.baseline - b.baseline)) {
    const row = rows.at(-1);
    if (row && f.baseline - row.baseline <= 3) row.fragments.push(f);
    else rows.push({ baseline: f.baseline, fragments: [f] });
  }
  return rows;
}

type Interval = [number, number];
function subtract(intervals: Interval[], left: number, right: number): Interval[] {
  return intervals.flatMap(([a,b]): Interval[] => {
    if (b <= left || a >= right) return [[a,b]];
    return [[a, Math.min(b, left)], [Math.max(a, right), b]].filter(([start,end]) => end > start) as Interval[];
  });
}

function measure(block: HTMLElement, masking: boolean): Line[] {
  const clusters = collectClusters(block, block);
  if (!clusters.some(cluster => !masking || cluster.some(el => el.classList.contains(REVEAL_CLASS) || el.classList.contains(UNVEIL_CLASS)))) return [];
  const result: Line[] = [];
  const groups = fragmentsIn(block, clusters, masking);
  const all = [...groups.values()].flat();
  for (const [container, fragments] of groups) {
    if (!fragments.some(f => f.draw)) continue;
    const clip = clipFor(container);
    const localClip = clipFor(container, true);
    const rows = rowsOf(fragments);
    for (const row of rows) {
      for (const cluster of new Set(row.fragments.filter(f => f.draw).map(f => f.cluster))) {
        const active = row.fragments.filter(f => f.cluster === cluster);
        const drawable = active.filter(f => f.draw).sort((a,b) => a.left - b.left);
        const other = row.fragments.filter(f => !f.draw || f.cluster !== cluster);
        let spans: Interval[] = [];
        for (const f of drawable) {
          const last = spans.at(-1);
          if (last && f.left - last[1] <= .75 && !other.some(o => o.left < f.left && o.right > last[1])) {
            last[1] = Math.max(last[1], f.right);
          } else spans.push([f.left, f.right]);
        }
        for (const o of other) spans = subtract(spans, o.left, o.right);
        // 先缩到笔画恰好在内容下方；还相交时，在该段横向投影内留缺口。
        const bottom = Math.max(...active.map(f => f.bottom));
        const min = bottom + RADIUS;
        const obstacles = all.filter(f => !row.fragments.includes(f) && f.bottom > bottom &&
          spans.some(([l,r]) => f.left < r && f.right > l));
        let y = Math.min(bottom + 2, localClip.bottom - RADIUS);
        if (obstacles.some(f => f.top < y + RADIUS && f.bottom > y - RADIUS)) y = Math.max(min, y - RADIUS);
        if (y < min || y - RADIUS < clip.top || y + RADIUS > clip.bottom) continue;
        for (const f of obstacles) {
          if (f.top < y + RADIUS && f.bottom > y - RADIUS) spans = subtract(spans, f.left, f.right);
        }
        for (const [a,b] of spans) {
          const left = Math.max(a, clip.left), right = Math.min(b, clip.right);
          if (right > left) result.push({ left, right, y });
        }
      }
    }
  }
  return result;
}

export class UnderlineLayer {
  readonly svg = document.createElementNS(SVG, 'svg');
  private readonly blocks = new Map<HTMLElement, { visible: boolean; dirty: boolean; lines: SVGLineElement[] }>();
  private readonly resize: ResizeObserver;
  private readonly intersection: IntersectionObserver;
  private readonly events = new AbortController();
  private frame = 0;

  constructor(readonly body: HTMLElement, private readonly masking: () => boolean) {
    this.svg.setAttribute('class', 'cloze-underlines');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('focusable', 'false');
    const content = body.closest('.protyle-content');
    const mount = content && content.closest('.protyle') === body.closest('.protyle') ? content : body;
    mount.after(this.svg);
    body.classList.add('sy-cloze-editor');
    this.resize = new ResizeObserver(entries => {
      if (entries.some(e => e.target === body || e.target === content)) this.invalidate();
      else for (const e of entries) this.dirty(e.target as HTMLElement);
    });
    this.resize.observe(body);
    if (content && content !== body) this.resize.observe(content);
    this.intersection = new IntersectionObserver(entries => {
      for (const e of entries) {
        const state = this.blocks.get(e.target as HTMLElement);
        if (!state) continue;
        state.visible = e.isIntersecting;
        state.dirty = true;
      }
      this.schedule();
    });
    const signal = this.events.signal;
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true, signal });
    window.addEventListener('resize', this.invalidate, { signal });
    window.visualViewport?.addEventListener('resize', this.invalidate, { signal });
    window.visualViewport?.addEventListener('scroll', this.invalidate, { signal });
    document.fonts.addEventListener('loadingdone', this.invalidate, { signal });
  }

  private onScroll = (e: Event) => {
    const target = e.target;
    if (target === document || target instanceof Element && (target.contains(this.body) || this.body.contains(target))) this.invalidate();
  };

  private dirty(block: HTMLElement) {
    const state = this.blocks.get(block);
    if (state) { state.dirty = true; this.schedule(); }
  }

  track(block: HTMLElement, hasCloze: boolean) {
    if (!hasCloze) { this.remove(block); return; }
    if (!this.blocks.has(block)) {
      this.blocks.set(block, { visible: intersects(block.getBoundingClientRect(), viewport()), dirty: true, lines: [] });
      this.resize.observe(block);
      this.intersection.observe(block);
    }
    this.dirty(block);
  }

  invalidate = () => {
    for (const state of this.blocks.values()) state.dirty = true;
    this.schedule();
  };

  private schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(this.render);
  }

  private remove(block: HTMLElement) {
    const state = this.blocks.get(block);
    if (!state) return;
    state.lines.forEach(line => line.remove());
    this.resize.unobserve(block);
    this.intersection.unobserve(block);
    this.blocks.delete(block);
  }

  prune() {
    for (const block of this.blocks.keys()) if (block.closest('.protyle-wysiwyg') !== this.body) this.remove(block);
  }

  private render = () => {
    this.frame = 0;
    this.prune();
    const ctm = this.svg.getScreenCTM()?.inverse();
    if (!ctm || !Number.isFinite(ctm.a)) return;
    const changed: { state: { lines: SVGLineElement[] }; lines: Line[] }[] = [];
    for (const [block, state] of this.blocks) {
      if (!state.dirty) continue;
      state.dirty = false;
      changed.push({ state, lines: state.visible && block.getClientRects().length ? measure(block, this.masking()) : [] });
    }
    // 完成所有布局读取后再写 SVG。
    for (const { state, lines } of changed) {
      while (state.lines.length > lines.length) state.lines.pop()!.remove();
      lines.forEach(({left, right, y}, i) => {
        let line = state.lines[i];
        if (!line) { line = document.createElementNS(SVG, 'line'); state.lines.push(line); this.svg.append(line); }
        const a = new DOMPoint(left, y).matrixTransform(ctm);
        const b = new DOMPoint(right, y).matrixTransform(ctm);
        line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y));
        line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
      });
    }
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.intersection.disconnect();
    this.events.abort();
    this.blocks.clear();
    this.svg.remove();
    this.body.classList.remove('sy-cloze-editor');
  }
}
