/**
 * 行内样式兼容回归：插件样式表不得吞掉思源原生行内标记的外观。
 *
 * 思源把多个行内标记合并进同一个 span 的 data-type（strong kbd / mark kbd / code kbd …），
 * 这一层用编译后的插件样式表逐条 selector 求命中，回答两个问题：
 *   1. 对某类共存标记，插件有没有声明它自己使用的属性（声明了就是覆盖）；
 *   2. 写回的取值是否与思源原生一致。
 *
 * 求生效声明用「!important 优先、同重要级取源码靠后」。样式表按这个顺序组织：凡是对同一
 * 元素声明同一属性的规则，都靠 :not() 互斥，不存在需要特异性仲裁的两条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sass from 'sass';

import { setupDom } from './helpers.mjs';

setupDom();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scssPath = path.join(repoRoot, 'src/index.scss');
const css = sass.compile(scssPath, { style: 'expanded' }).css;

// 编译结果里的块注释与 @charset 都要先去掉：前者会混进声明，后者会黏在第一条规则的
// 选择器前面，让 element.matches() 直接抛「非法选择器」。
const stripNoise = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/@charset[^;]*;/g, '');

const splitSelectorList = (text) => {
  const out = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }

  out.push(text.slice(start).trim());
  return out.filter(Boolean);
};

const parseRules = (text) => {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(text);

  while (match !== null) {
    const selectors = splitSelectorList(match[1]).filter((selector) => !selector.startsWith('@'));
    const declarations = match[2]
      .split(';')
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const colon = chunk.indexOf(':');
        const raw = chunk.slice(colon + 1).trim();
        return {
          property: chunk.slice(0, colon).trim(),
          value: raw.replace(/\s*!important$/, '').trim(),
          important: /!important$/.test(raw),
        };
      });

    rules.push({ selectors, declarations, order: rules.length });
    match = pattern.exec(text);
  }

  return rules;
};

const rules = parseRules(stripNoise(css));

/**
 * 只保留能挂在元素本身的 selector。
 *
 * 伪元素（外扩命中区的 ::before）在 element.matches() 里是非法选择器，会直接抛错；
 * 它们的声明描述的也不是元素自身，参与仲裁只会给出错误结论。
 */
const elementSelectors = (rule) => rule.selectors.filter((selector) => !selector.includes('::'));

/** 命中该元素、且声明了指定属性的全部声明，按源码顺序排列。 */
const declarationsFor = (element, property) => {
  const hits = [];

  rules.forEach((rule) => {
    const selector = elementSelectors(rule).find((candidate) => element.matches(candidate));
    if (!selector) return;

    rule.declarations.forEach((decl, index) => {
      if (decl.property !== property) return;
      hits.push({ ...decl, selector, order: rule.order, index });
    });
  });

  return hits;
};

/** 生效的那条声明：!important 优先，同重要级取源码靠后。 */
const effective = (element, property) => {
  const hits = declarationsFor(element, property);
  if (hits.length === 0) return null;

  const important = hits.filter((hit) => hit.important);
  const pool = important.length > 0 ? important : hits;
  return pool[pool.length - 1];
};

const matchesAnyRule = (element) =>
  rules.some((rule) => elementSelectors(rule).some((candidate) => element.matches(candidate)));

const mount = (dataType, options = {}) => {
  document.body.className = options.mask === false ? '' : 'sy-cloze-active';

  const attrs = [
    `data-type="${dataType}"`,
    options.className ? `class="${options.className}"` : '',
    options.style ? `style="${options.style}"` : '',
  ].filter(Boolean).join(' ');

  document.body.innerHTML =
    `<div class="protyle-wysiwyg"><div data-node-id="block"><p><span id="target" ${attrs}>abc</span></p></div></div>`;

  return document.getElementById('target');
};

const expectDeclared = (element, property) => {
  const decl = effective(element, property);
  assert.ok(decl, `插件必须为 [data-type="${element.getAttribute('data-type')}"] 声明 ${property}`);
  return decl.value;
};

const expectUntouched = (element, property, reason) => {
  assert.equal(
    effective(element, property),
    null,
    `插件不得声明 ${property}（[data-type="${element.getAttribute('data-type')}"]）：${reason}`,
  );
};

/* ------------------------------------------------------------ 基础中和 */

test('裸 kbd 被中和成普通文字，只留提示线', () => {
  const el = mount('kbd');

  assert.equal(expectDeclared(el, 'font'), 'inherit');
  assert.equal(expectDeclared(el, 'background-color'), 'transparent');
  assert.equal(expectDeclared(el, 'background-image'), 'none');
  assert.equal(expectDeclared(el, 'border-bottom-style'), 'none');
  assert.equal(expectDeclared(el, 'border-top-style'), 'none');
  assert.equal(expectDeclared(el, 'box-shadow'), 'none');
  assert.equal(expectDeclared(el, 'vertical-align'), 'baseline');
  assert.equal(expectDeclared(el, 'color'), 'inherit');
  assert.match(expectDeclared(el, 'text-decoration'), /^underline dashed var\(--b3-theme-primary/);

  // font 是简写：思源那条 kbd 规则会把 strong 的字重、code 的等宽一起重置，
  // 只压 font-size / font-family 压不住。
  assert.equal(declarationsFor(el, 'font').length, 1, '只能用 font 简写整体中和');
});

test('正文容器之外的 kbd 不命中任何插件规则', () => {
  document.body.className = 'sy-cloze-active';
  document.body.innerHTML = '<div class="protyle-wysiwyg"></div><div class="other-plugin"><span id="outside" data-type="kbd">abc</span></div>';

  const outside = document.getElementById('outside');
  assert.equal(matchesAnyRule(outside), false, '样式必须限定在 .protyle-wysiwyg 内，否则其它插件的界面会被一起改写');
});

test('导出预览的正文容器同样中和', () => {
  document.body.className = '';
  document.body.innerHTML = '<div class="b3-typography"><span id="exported" data-type="kbd">abc</span></div>';

  const el = document.getElementById('exported');
  assert.equal(expectDeclared(el, 'font'), 'inherit');
  assert.equal(expectDeclared(el, 'background-color'), 'transparent');
  assert.equal(expectDeclared(el, 'background-image'), 'none');
  assert.match(expectDeclared(el, 'text-decoration'), /^underline dashed var\(--b3-theme-primary/);
});

test('遮蔽态只在 body 开关打开时生效', () => {
  const masked = mount('kbd');
  assert.match(expectDeclared(masked, 'filter'), /blur\(6px\)/);

  const plain = mount('kbd', { mask: false });
  expectUntouched(plain, 'filter', '遮蔽由 body 上的开关向下生效');
});

/* -------------------------------------------------------- 自带底色的标记 */

test('高光与检索命中的底色、文字颜色按主题变量写回', () => {
  ['mark kbd', 'search-mark kbd'].forEach((type) => {
    const el = mount(type);
    assert.equal(expectDeclared(el, 'background-color'), 'var(--b3-protyle-inline-mark-background)');
    assert.equal(expectDeclared(el, 'color'), 'var(--b3-protyle-inline-mark-color)');
  });

  const memo = mount('inline-memo kbd');
  assert.equal(expectDeclared(memo, 'background-color'), 'var(--b3-card-info-background)');

  // 当前命中的浅色底与 mark--hl 的描边归思源自己管
  const current = mount('search-mark kbd', { className: 'search-mark--hl' });
  expectUntouched(current, 'background-color', '当前命中的底色属于检索');
  const hl = mount('mark kbd', { className: 'mark--hl' });
  expectUntouched(hl, 'background-color', 'mark--hl 的底色属于思源');
});

test('mark--hl 的外描边要留着', () => {
  const el = mount('mark kbd', { className: 'mark--hl' });
  expectUntouched(el, 'box-shadow', 'mark--hl 用 box-shadow 画外描边');
});

test('行内代码写回等宽字体、85% 字号、代码底色与内边距', () => {
  const el = mount('code kbd');

  assert.equal(expectDeclared(el, 'font-family'), 'var(--b3-font-family-code)');
  assert.equal(expectDeclared(el, 'font-size'), '85%');
  assert.equal(expectDeclared(el, 'background-color'), 'var(--b3-protyle-code-background)');
  assert.equal(expectDeclared(el, 'padding'), '0.2em 0.4em');
  assert.equal(expectDeclared(el, 'border-radius'), 'var(--b3-border-radius)');
});

/* ------------------------------------------------------- 自带边框线的标记 */

test('下划线、链接、标签、备注、虚拟引用靠下边框画线，插件不得清除', () => {
  ['u kbd', 'a kbd', 'tag kbd', 'inline-memo kbd', 'virtual-block-ref kbd'].forEach((type) => {
    const el = mount(type);
    expectUntouched(el, 'border-bottom-style', '这类标记的线画在 border-bottom 上');
  });
});

test('标签的横向内边距要留着', () => {
  const el = mount('tag kbd');
  expectUntouched(el, 'padding-left', '标签的 1px 内边距是它的外观');
});

/* --------------------------------------------------------- 自带装饰的标记 */

test('删除线、公式、代码不叠提示线', () => {
  ['s kbd', 'inline-math kbd', 'code kbd'].forEach((type) => {
    const el = mount(type);
    expectUntouched(el, 'text-decoration', '这类标记自己就带线或自带底色');
  });
});

test('提示线在遮蔽态置透明，删除线例外', () => {
  const masked = mount('kbd');
  assert.equal(expectDeclared(masked, 'text-decoration-color'), 'transparent');

  const strike = mount('s kbd');
  expectUntouched(strike, 'text-decoration-color', '删除线用的也是 text-decoration，一起置透明会把它藏掉');
});

/* ------------------------------------------------------------- 字体形状 */

test('加粗与斜体写回思源原生取值', () => {
  const strong = mount('strong kbd');
  assert.equal(expectDeclared(strong, 'font-weight'), 'bold');
  assert.equal(expectDeclared(strong, 'color'), 'var(--b3-protyle-inline-strong-color)');

  const em = mount('em kbd');
  assert.equal(expectDeclared(em, 'font-style'), 'italic');
  assert.equal(expectDeclared(em, 'color'), 'var(--b3-protyle-inline-em-color)');
});

test('删除线的颜色写回主题变量', () => {
  const el = mount('s kbd');
  assert.equal(expectDeclared(el, 'color'), 'var(--b3-protyle-inline-s-color)');
});

test('上标与下标写回 75% 字号与零行高', () => {
  ['sup kbd', 'sub kbd'].forEach((type) => {
    const el = mount(type);
    assert.equal(expectDeclared(el, 'font-size'), '75%');
    assert.equal(expectDeclared(el, 'line-height'), '0');
  });
});

/* ------------------------------------------------------- 自定义文字样式 */

test('自定义文字样式的字体、颜色、底色交给行内 style', () => {
  const el = mount('text kbd', { style: 'color: rgb(0, 128, 0); font-size: 20px' });

  ['font', 'color', 'background-color'].forEach((property) => {
    const decl = effective(el, property);
    assert.ok(decl, `必须为 text kbd 声明 ${property}`);
    assert.equal(decl.important, false, `${property} 不能带 !important，否则行内 style 会被压掉`);
  });
});

test('文字样式叠在高光上时，底色仍归高光', () => {
  const el = mount('text mark kbd', { style: 'color: rgb(0, 128, 0)' });

  assert.equal(expectDeclared(el, 'background-color'), 'var(--b3-protyle-inline-mark-background)');
  assert.equal(expectDeclared(el, 'color'), 'var(--b3-protyle-inline-mark-color)');
});

/* --------------------------------------------------------------- 遮蔽态 */

test('簇内公式与 kbd 一起进入遮蔽规则', () => {
  document.body.className = 'sy-cloze-active';
  document.body.innerHTML =
    '<div class="protyle-wysiwyg"><div data-node-id="block"><p><span id="math" class="sy-cloze-math">x</span></p></div></div>';

  const math = document.getElementById('math');
  assert.match(expectDeclared(math, 'filter'), /blur\(6px\)/);
  assert.equal(expectDeclared(math, 'opacity'), '0.65');
});

test('揭晓态与划选透晓态都要退出遮蔽', () => {
  const revealed = mount('kbd', { className: 'sy-cloze-reveal' });
  expectUntouched(revealed, 'filter', '划选时整簇要露出来');

  const unveiled = mount('kbd', { className: 'sy-cloze-unveiled' });
  expectUntouched(unveiled, 'filter', '点击揭晓后要保持可见');
});

/* ------------------------------------------------------------ 排版安全 */

test('插件不改任何元素的 display', () => {
  const offenders = rules.filter((rule) =>
    rule.declarations.some((decl) => decl.property === 'display' || decl.property === 'font-display'),
  );

  assert.equal(offenders.length, 0, '行内公式的 display 一旦被改成 inline-block，基线与行高都会跟着变');
});
