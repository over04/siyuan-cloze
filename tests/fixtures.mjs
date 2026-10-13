/**
 * 集群判据回归夹具。
 *
 * 记号：[] = 一次划选，() = 由这次划选产生的遮罩范围。
 *
 * 每个 dom 都是从**真实内核**（SiYuan 3.8.6 自带 Lute）往返一次后读回的
 * 「段落 contenteditable 内层 HTML」，不是手搓的：
 *
 *   POST /api/block/insertBlock  { dataType: "dom", data: <编辑器形态> }
 *   POST /api/block/getBlockDOM  { id }
 *
 * 复现方式见 tests/README.md。之所以必须来自内核：kbd 切片之间到底有没有
 * 普通空格，取决于 Lute 的 AutoSpace 选项，而这只有真实渲染才说得准。
 * 实测结论——Protyle 渲染路径上 AutoSpace 关闭（lute protyle.go:285/1037
 * 强制 options.AutoSpace = false），于是：
 *   · 同一次挖空被行内公式切成的切片之间：只有 U+200B
 *   · 两次独立划选之间（源里有空格）：U+200B + 空格 + U+200B
 * 这就是「真实空白即断簇」这条判据成立的根据。
 */

const ZW = '\u200b';
const WJ = '\u2060';

const math = (content) =>
  `<span data-type="kbd inline-math" data-subtype="math" data-content="${content}" contenteditable="false" class="render-node">${WJ}</span>`;

const kbd = (text) => `<span data-type="kbd">${WJ}${text}</span>`;

/** 公式切片是空元素（公式体在 data-content），文本切片用 textContent。 */
export const memberLabel = (el) =>
  el.hasAttribute('data-content') ? `$${el.getAttribute('data-content')}$` : el.textContent.replace(/[\u200b\u2060\ufeff]/g, '');

export const FIXTURES = [
  {
    name: '[公式] [公式] → (公式) (公式)',
    dom: ZW + math('A') + ZW + ' ' + ZW + math('B') + ZW,
    expect: ['$A$', '$B$'],
    wrong: ['$A$ $B$'],
  },
  {
    name: '[文本] [公式] → (文本) (公式)',
    dom: ZW + kbd('文本') + ZW + ' ' + ZW + math('A') + ZW,
    expect: ['$A$', '文本'],
    wrong: ['文本 $A$'],
  },
  {
    name: '[公式 文本 公式] → (公式 文本 公式)',
    dom: ZW + math('A') + ZW + kbd(' 文本 ') + ZW + math('B') + ZW,
    expect: ['$A$ 文本 $B$'],
    wrong: ['$A$ 文本 $B$'],
  },
  {
    name: '[公式文本 公式] → (公式 文本 公式)',
    dom: ZW + math('A') + ZW + kbd('文本 ') + ZW + math('B') + ZW,
    expect: ['$A$文本 $B$'],
    wrong: ['$A$文本 $B$'],
  },
  {
    name: '[1] [2] → (1) (2)',
    dom: ZW + kbd('1') + ZW + ' ' + ZW + kbd('2') + ZW,
    expect: ['1', '2'],
    wrong: ['1 2'],
  },
  {
    name: '[1]      [2] → (1)      (2)',
    dom: ZW + kbd('1') + ZW + '      ' + ZW + kbd('2') + ZW,
    expect: ['1', '2'],
    wrong: ['1      2'],
  },
];
