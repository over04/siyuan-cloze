/**
 * 点击揭晓（持久态）的行为回归。
 *
 * 覆盖四层：
 *   1. 标识的稳定性——它不受同块内增删遮罩影响（序号位移缺陷回归），
 *      同答案文本撞键由末尾序号消歧；
 *   2. 记录与回放——点击切换整簇、DOM 重建后回放、关文档（drop）后恢复默认遮蔽、
 *      失效记录核对；
 *   3. 单击确认——双击窗口、连点不吞击、跨重建定位；
 *   4. JS 与 SCSS 的契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WJ, setupDom } from './helpers.mjs';
import {
  KBD_SELECTOR,
  REVEAL_CLASS,
  UNVEIL_CLASS,
  getClozeCluster,
  getClusterKey,
  listBlockClusters,
  resolveProtyleRoot,
} from '../src/cluster.ts';
import {
  UnveilStore,
  dropBlockUnveil,
  dropUnveilForBlockId,
  findClusterByKey,
  replayUnveilInto,
  resetAllUnveil,
  shouldRollback,
  toggleClusterUnveil,
  toggleUnveilByKey,
} from '../src/unveil.ts';

setupDom();

const kbd = (text) => `<span data-type="kbd">${WJ}${text}</span>`;
const maskedMath = (content) =>
  `<span data-type="kbd inline-math" data-subtype="math" data-content="${content}" contenteditable="false" class="render-node">${WJ}</span>`;

const element = (html) => {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return holder.firstChild;
};

/** 造一个带指定块 ID 的块；helpers.parseBlock 固定用 'fixture'，这里要区分块。 */
const blockWith = (nodeId, html) => {
  const block = document.createElement('div');
  block.setAttribute('data-node-id', nodeId);
  block.innerHTML = html;
  return block;
};

const kbdsOf = (block) => Array.from(block.querySelectorAll(KBD_SELECTOR));

/** 装配一个完整的 .protyle > .protyle-wysiwyg > block 结构并挂进 document。 */
const mountProtyle = (nodeId, html) => {
  const protyle = document.createElement('div');
  protyle.className = 'protyle';
  const wysiwyg = document.createElement('div');
  wysiwyg.className = 'protyle-wysiwyg';
  const block = blockWith(nodeId, html);
  wysiwyg.appendChild(block);
  protyle.appendChild(wysiwyg);
  document.body.appendChild(protyle);
  return { protyle, wysiwyg, block };
};

const unveiledCount = (scope) => scope.querySelectorAll(`.${UNVEIL_CLASS}`).length;

/* ---------------------------------------------------------------- 键稳定性 */

test('listBlockClusters：键 = 块ID#答案文本@同答案文本序号', () => {
  const block = blockWith('blk', kbd('甲') + ' ' + kbd('乙'));

  assert.deepEqual(
    listBlockClusters(block).map((item) => item.key),
    ['blk#甲@0', 'blk#乙@0'],
  );
});

test('listBlockClusters：整簇答案文本由全部成员按序拼接，公式取 data-content', () => {
  const block = blockWith('blk', maskedMath('A') + kbd('乙'));
  const items = listBlockClusters(block);

  assert.equal(items.length, 1, '公式与其后的切片属于同一簇');
  assert.deepEqual(items[0].cluster, kbdsOf(block));
  assert.equal(items[0].key, 'blk#A|乙@0');
});

test('listBlockClusters：同块内重复答案靠序号消歧，不得共用一条记录', () => {
  const block = blockWith('blk', kbd('甲') + ' ' + kbd('甲'));
  const items = listBlockClusters(block);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.key), ['blk#甲@0', 'blk#甲@1']);

  // 撞键的后果：点第二个会把第一个的记录删掉，屏幕上却还显示着第一个。
  const records = new Map();
  toggleClusterUnveil(records, block, items[0].cluster);
  toggleClusterUnveil(records, block, items[1].cluster);
  assert.equal(records.size, 2, '两个重复答案必须各自记录');
  assert.equal(unveiledCount(block), 2);
});

test('getClusterKey：同块内新建遮罩不得改变已有簇的键（序号位移回归）', () => {
  const block = blockWith('blk', kbd('甲') + ' ' + kbd('乙'));
  const [first, second] = kbdsOf(block);

  const beforeFirst = getClusterKey(block, getClozeCluster(first));
  const beforeSecond = getClusterKey(block, getClozeCluster(second));

  // 段首插入一个新遮罩：旧实现的「簇首序号」键会整体后移，
  // 记录跟着落到新遮罩上（新遮罩一出现就揭晓 = 答案直接露出来），原簇反被重新遮蔽。
  block.insertBefore(element(kbd('前言')), block.firstChild);
  block.insertBefore(document.createTextNode(' '), block.childNodes[1]);

  const [, afterFirst, afterSecond] = kbdsOf(block);
  assert.equal(getClusterKey(block, getClozeCluster(afterFirst)), beforeFirst);
  assert.equal(getClusterKey(block, getClozeCluster(afterSecond)), beforeSecond);
});

test('getClusterKey：块 ID 参与隔离，跨块同内容不得撞键', () => {
  const left = blockWith('blk-1', kbd('甲'));
  const right = blockWith('blk-2', kbd('甲'));

  assert.equal(getClusterKey(left, getClozeCluster(left.firstChild)), 'blk-1#甲@0');
  assert.equal(getClusterKey(right, getClozeCluster(right.firstChild)), 'blk-2#甲@0');
});

test('getClusterKey：无块 ID、空簇、簇首不在本块内一律返回 null', () => {
  const noId = document.createElement('div');
  noId.innerHTML = kbd('甲');
  assert.equal(getClusterKey(noId, getClozeCluster(noId.firstChild)), null, '缺 data-node-id 无法记录');

  const block = blockWith('blk', kbd('甲'));
  assert.equal(getClusterKey(block, []), null, '空簇无键可言');
  assert.equal(getClusterKey(null, []), null, '无块上下文');

  const foreign = blockWith('blk-x', kbd('乙'));
  assert.equal(
    getClusterKey(block, getClozeCluster(foreign.firstChild)),
    null,
    '簇首不属于本块时绝不能给出本块的键',
  );
});

test('resolveProtyleRoot：命中 .protyle 根元素，文本节点取父元素', () => {
  const { protyle, block } = mountProtyle('blk', kbd('甲'));
  const target = block.querySelector(KBD_SELECTOR);

  assert.equal(resolveProtyleRoot(target), protyle);
  assert.equal(resolveProtyleRoot(target.firstChild), protyle, '文本节点应回溯到父元素');
  assert.equal(resolveProtyleRoot(null), null);
});

test('resolveProtyleRoot：没有 .protyle 时回落到 .protyle-wysiwyg', () => {
  const orphan = document.createElement('div');
  orphan.className = 'protyle-wysiwyg';
  const block = blockWith('blk-orphan', kbd('甲'));
  orphan.appendChild(block);
  document.body.appendChild(orphan);

  assert.equal(resolveProtyleRoot(block.querySelector(KBD_SELECTOR)), orphan);
});

/* ------------------------------------------------------------ 记录与回放 */

test('UnveilStore：一篇文档一份记录，drop 后即查不到', () => {
  const store = new UnveilStore();
  const { protyle } = mountProtyle('blk', kbd('甲'));

  assert.equal(store.peek(protyle), undefined, '未记录时 peek 不应凭空创建');

  store.ensure(protyle).set('blk#甲@0', true);
  assert.equal(store.peek(protyle)?.size, 1);

  store.drop(protyle);
  assert.equal(store.peek(protyle), undefined);
});

test('UnveilStore.drop：作废记录时一并清掉仍在文档里的揭晓类', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲'));

  toggleClusterUnveil(store.ensure(protyle), block, getClozeCluster(kbdsOf(block)[0]));
  assert.equal(unveiledCount(protyle), 1);

  store.drop(protyle);
  assert.equal(unveiledCount(protyle), 0, '记录清空后不得继续显示');
});

test('toggleClusterUnveil：整簇一起揭晓，再点整簇一起遮蔽', () => {
  const records = new Map();
  const block = blockWith('blk', maskedMath('A') + kbd('乙'));
  const [math, tail] = kbdsOf(block);
  const cluster = getClozeCluster(math);

  assert.equal(toggleClusterUnveil(records, block, cluster), true);
  assert.equal(records.get('blk#A|乙@0'), true);
  assert.ok(cluster.every((el) => el.classList.contains(UNVEIL_CLASS)), '整簇必须一起揭晓');

  assert.equal(toggleClusterUnveil(records, block, cluster), false);
  assert.equal(records.has('blk#A|乙@0'), false);
  assert.ok(cluster.every((el) => !el.classList.contains(UNVEIL_CLASS)), '整簇必须一起恢复遮蔽');
});

test('toggleClusterUnveil：无法记录时返回 null 且不碰 DOM', () => {
  const records = new Map();
  const noId = document.createElement('div');
  noId.innerHTML = kbd('甲');

  assert.equal(toggleClusterUnveil(records, noId, getClozeCluster(noId.firstChild)), null);
  assert.equal(records.size, 0);
  assert.equal(unveiledCount(noId), 0);
});

test('findClusterByKey：按块 ID + 答案文本在重建后的 DOM 里重新定位簇', () => {
  const before = blockWith('blk', kbd('甲') + ' ' + kbd('乙'));
  const key = listBlockClusters(before)[1].key;

  // 块被整体重建：旧引用失效，只剩 ID 与答案文本可用。
  const after = blockWith('blk', kbd('甲') + ' ' + kbd('乙'));
  const cluster = findClusterByKey(after, key);

  assert.ok(cluster, '必须能在新 DOM 里找回同一个簇');
  assert.equal(cluster[0], kbdsOf(after)[1]);
  assert.equal(findClusterByKey(after, 'blk#不存在@0'), null);
});

test('replayUnveilInto：DOM 重建后按记录把揭晓态画回去', () => {
  const store = new UnveilStore();
  const { protyle, wysiwyg, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));

  toggleClusterUnveil(store.ensure(protyle), block, getClozeCluster(kbdsOf(block)[0]));
  assert.equal(unveiledCount(wysiwyg), 1);

  const rebuilt = blockWith('blk', kbd('甲') + ' ' + kbd('乙'));
  block.replaceWith(rebuilt);
  assert.equal(unveiledCount(wysiwyg), 0, '重建后 class 确实丢了，这是回放存在的理由');

  replayUnveilInto(store, protyle);
  assert.equal(unveiledCount(wysiwyg), 1, '回放必须把揭晓态补回原簇');
  assert.ok(kbdsOf(rebuilt)[0].classList.contains(UNVEIL_CLASS));
  assert.ok(!kbdsOf(rebuilt)[1].classList.contains(UNVEIL_CLASS), '不得殃及同块的其它簇');
});

test('replayUnveilInto：无 kbd 或无记录时直接返回', () => {
  const store = new UnveilStore();
  const { protyle } = mountProtyle('blk', kbd('甲'));

  replayUnveilInto(store, protyle);
  assert.equal(unveiledCount(protyle), 0);

  const empty = document.createElement('div');
  empty.className = 'protyle';
  replayUnveilInto(store, empty);
});

test('replayUnveilInto：失效记录要连续两轮确认才清理', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲'));

  const records = store.ensure(protyle);
  toggleClusterUnveil(records, block, getClozeCluster(kbdsOf(block)[0]));
  assert.equal(records.size, 1);

  // 原生 ⌥D 取消遮罩 / 撤销创建 / 直接改文本：记录里留下一个当前 DOM 已无对应簇的键。
  const rebuilt = blockWith('blk', kbd('丙'));
  block.replaceWith(rebuilt);

  replayUnveilInto(store, protyle);
  assert.equal(records.size, 1, '首轮只做标记：思源重建块存在跨帧中间态，当场删会误伤');

  replayUnveilInto(store, protyle);
  assert.equal(records.size, 0, '连续两轮都判定为失效才清理');
  assert.equal(unveiledCount(protyle), 0);
});

test('replayUnveilInto：跨帧重建的中间态不得误删记录', () => {
  const store = new UnveilStore();
  const { protyle, wysiwyg, block } = mountProtyle('blk', kbd('甲'));
  // 同一 protyle 内再放一个带 kbd 的块：否则块清空后回放的第一层早退会挡住，
  // 测不到真正要守的那条核对边界。
  wysiwyg.appendChild(blockWith('blk-2', kbd('乙')));

  const records = store.ensure(protyle);
  toggleClusterUnveil(records, block, getClozeCluster(kbdsOf(block)[0]));

  // 中间态：块骨架还在，kbd 已被清空、内容尚未填回。
  block.innerHTML = '';
  replayUnveilInto(store, protyle);
  assert.equal(records.size, 1, '中间态不得删记录');

  // 下一帧内容填回。
  block.innerHTML = kbd('甲');
  replayUnveilInto(store, protyle);
  assert.equal(records.size, 1, '内容填回后记录仍在');
  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '并且视觉已恢复');
});

test('replayUnveilInto：中间态持续两轮也不得误删记录', () => {
  const store = new UnveilStore();
  const { protyle, wysiwyg, block } = mountProtyle('blk', kbd('甲'));
  wysiwyg.appendChild(blockWith('blk-2', kbd('乙')));

  const records = store.ensure(protyle);
  toggleClusterUnveil(records, block, getClozeCluster(kbdsOf(block)[0]));

  // loaded-protyle-static 与 loaded-protyle-dynamic 在同一加载流程里连续回放，
  // 「两轮确认」的配额正好会被耗尽——所以「块内无 kbd」必须一律不清理。
  block.innerHTML = '';
  replayUnveilInto(store, protyle);
  replayUnveilInto(store, protyle);
  assert.equal(records.size, 1, '无 kbd 的块不得被判为失效，哪怕中间态跨了两轮');

  block.innerHTML = kbd('甲');
  replayUnveilInto(store, protyle);
  assert.equal(records.size, 1, '内容填回后揭晓状态必须自己恢复');
  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS));
});

test('replayUnveilInto：块内存在重复答案文本时，编辑无关簇不得牵连整块', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('甲') + ' ' + kbd('乙'));

  const records = store.ensure(protyle);
  const items = listBlockClusters(block);
  toggleClusterUnveil(records, block, items[0].cluster);
  toggleClusterUnveil(records, block, items[2].cluster);
  replayUnveilInto(store, protyle);

  // 改掉与重复答案文本无关的「乙」：重复答案文本的计数没有下降，不得整块作废。
  block.innerHTML = kbd('甲') + ' ' + kbd('甲') + ' ' + kbd('丙');
  replayUnveilInto(store, protyle);
  replayUnveilInto(store, protyle);

  assert.equal(records.has('blk#甲@0'), true, '重复答案文本未减少时，无关编辑不得牵连其它簇');
  assert.equal(records.has('blk#乙@0'), false, '被改掉的那一簇按失效清理');
});

test('replayUnveilInto：重复答案被删掉一个时整块作废，不把揭晓态串到同文本遮罩', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('甲'));

  const records = store.ensure(protyle);
  const items = listBlockClusters(block);
  toggleClusterUnveil(records, block, items[0].cluster);
  toggleClusterUnveil(records, block, items[1].cluster);
  replayUnveilInto(store, protyle);
  assert.equal(records.size, 2);

  // 用户删掉其中一个重复答案：剩余簇的 @序号 整体前移，
  // 逐键匹配会把揭晓态从被删的那个跳到另一个同文本遮罩上。
  block.innerHTML = kbd('甲');
  replayUnveilInto(store, protyle);

  assert.equal(records.size, 0, '序号已失配，整块作废');
  assert.equal(unveiledCount(protyle), 0, '不得把答案亮到另一个同文本遮罩上');
});

test('replayUnveilInto：无重复答案文本的块里改文本只清该簇，不牵连同块其它簇', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));

  const records = store.ensure(protyle);
  const items = listBlockClusters(block);
  toggleClusterUnveil(records, block, items[0].cluster);
  toggleClusterUnveil(records, block, items[1].cluster);
  replayUnveilInto(store, protyle);
  assert.equal(records.size, 2);

  // 只改掉第一个簇的文本：它变失效（两轮后清），第二个必须原样保留。
  block.innerHTML = kbd('丙') + ' ' + kbd('乙');
  replayUnveilInto(store, protyle);
  replayUnveilInto(store, protyle);

  assert.equal(records.size, 1, '只有被改掉的那一簇作废');
  assert.equal(unveiledCount(protyle), 1);
  assert.ok(kbdsOf(block)[1].classList.contains(UNVEIL_CLASS), '同块其它簇不得被牵连');
});

test('store.drop 之后回放不再生效——「关文档恢复默认遮蔽」', () => {
  const store = new UnveilStore();
  const { protyle, wysiwyg, block } = mountProtyle('blk', kbd('甲'));

  toggleClusterUnveil(store.ensure(protyle), block, getClozeCluster(kbdsOf(block)[0]));
  assert.equal(unveiledCount(wysiwyg), 1);

  store.drop(protyle);
  const rebuilt = blockWith('blk', kbd('甲'));
  block.replaceWith(rebuilt);

  replayUnveilInto(store, protyle);
  assert.equal(unveiledCount(protyle), 0, '文档关闭后重开的同内容文档必须回到默认遮蔽');
});

test('dropBlockUnveil：作废记录并就地校正同块其它簇的视觉', () => {
  const records = new Map();
  const block = blockWith('blk', kbd('甲') + ' ' + kbd('乙'));
  const [first, second] = kbdsOf(block);

  toggleClusterUnveil(records, block, getClozeCluster(first));
  toggleClusterUnveil(records, block, getClozeCluster(second));
  assert.equal(records.size, 2);
  assert.equal(unveiledCount(block), 2);

  dropBlockUnveil(records, block);

  assert.equal(records.size, 0, '整块记录必须清空');
  assert.equal(unveiledCount(block), 0, 'DOM 上的揭晓类必须一并撤掉，不得留下「记录没有、屏幕还亮」');
});

test('dropUnveilForBlockId：按 ID 重新定位已被重建的块', () => {
  const store = new UnveilStore();
  const { protyle, wysiwyg, block } = mountProtyle('blk', kbd('甲'));

  toggleClusterUnveil(store.ensure(protyle), block, getClozeCluster(kbdsOf(block)[0]));

  const rebuilt = blockWith('blk', kbd('甲'));
  block.replaceWith(rebuilt);

  dropUnveilForBlockId(store, protyle, 'blk');
  assert.equal(store.peek(protyle)?.size, 0);
  assert.equal(unveiledCount(wysiwyg), 0);

  dropUnveilForBlockId(store, null, 'blk');
  dropUnveilForBlockId(store, protyle, null);
  assert.equal(unveiledCount(wysiwyg), 0, '空参数不得抛错也不得改动视觉');
});

test('resetAllUnveil：按一下全局开关就把所有文档的逐块揭晓清空', () => {
  const store = new UnveilStore();
  const first = mountProtyle('blk-a', kbd('甲'));
  const second = mountProtyle('blk-b', kbd('乙'));

  toggleClusterUnveil(store.ensure(first.protyle), first.block, getClozeCluster(kbdsOf(first.block)[0]));
  toggleClusterUnveil(store.ensure(second.protyle), second.block, getClozeCluster(kbdsOf(second.block)[0]));
  assert.equal(unveiledCount(first.protyle), 1, '先造出「逐块点开」的杂状态');
  assert.equal(unveiledCount(second.protyle), 1);

  resetAllUnveil(store, document.body);

  assert.equal(unveiledCount(document.body), 0, '所有遮罩必须统一回到遮蔽');
  assert.equal(store.peek(first.protyle), undefined, '第一篇文档的记录清空');
  assert.equal(store.peek(second.protyle), undefined, '第二篇文档的记录清空');
});

test('resetAllUnveil：容器只到 .protyle-wysiwyg 时也要清掉记录', () => {
  const store = new UnveilStore();
  const cellEditor = document.createElement('div');
  cellEditor.className = 'protyle-wysiwyg';
  const block = blockWith('blk-cell', kbd('甲'));
  cellEditor.appendChild(block);
  document.body.appendChild(cellEditor);

  toggleClusterUnveil(store.ensure(cellEditor), block, getClozeCluster(kbdsOf(block)[0]));
  assert.equal(unveiledCount(cellEditor), 1);

  resetAllUnveil(store, document.body);

  assert.equal(store.peek(cellEditor), undefined, '没有 .protyle 外壳的容器同样要清');
  assert.equal(unveiledCount(cellEditor), 0, '否则下一次自动回放会把它重新点亮');
});

/* ------------------------------------------------------------- 点击语义 */

test('toggleUnveilByKey：单击立即生效，撤回即回到原状', () => {
  const records = new Map();
  const block = blockWith('blk', kbd('甲'));
  const cluster = getClozeCluster(kbdsOf(block)[0]);
  const key = listBlockClusters(block)[0].key;

  // 单击：立即切换，不做任何等待。
  toggleUnveilByKey(records, key, cluster);
  assert.equal(unveiledCount(block), 1, '单击必须立即揭晓');

  // 撤回：把第一下原样切回去，净效果为零。
  toggleUnveilByKey(records, key, cluster);
  assert.equal(unveiledCount(block), 0, '撤回后回到遮蔽');
  assert.equal(records.size, 0, '撤回不得留下记录');
});

test('shouldRollback：只有双击落在同一个遮罩块上才撤回', () => {
  const target = (key, root = null) => ({ root: root || document.body, nodeId: 'blk', key });

  assert.equal(shouldRollback(target('blk#甲@0'), target('blk#甲@0')), true, '同一遮罩块：撤回');

  assert.equal(
    shouldRollback(target('blk#甲@0'), target('blk#乙@0')),
    false,
    '落在别的遮罩块上不得撤回，那次双击也不该被拦下',
  );

  assert.equal(
    shouldRollback(target('blk#甲@0'), null),
    false,
    '落在正文上不得撤回——否则「点开遮罩后去正文双击选词」会把遮罩无故翻回去',
  );

  assert.equal(
    shouldRollback(undefined, target('blk#甲@0')),
    false,
    '没有待撤回项时不得凭空切换',
  );

  assert.equal(
    shouldRollback(target('blk#甲@0'), target('blk#甲@0', document.createElement('div'))),
    false,
    '跨文档不得撤回',
  );
});

/* --------------------------------------------------------------- 契约层 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scss = fs.readFileSync(path.join(repoRoot, 'src/index.scss'), 'utf8');

test('JS 与 CSS 的契约：揭晓类必须落在遮蔽规则的选择器里', () => {
  // 先剥注释再按规则切段：否则把 :not(...) 挪进注释也能骗过 includes。
  const stripped = scss.replace(/\/\*[\s\S]*?\*\//g, '');
  const maskRule = stripped.split('}').find((rule) => rule.includes(`:not(.${REVEAL_CLASS})`));

  assert.ok(maskRule, 'index.scss 必须存在以 :not(显晓类) 反向失效的遮蔽规则');
  assert.ok(maskRule.includes(`:not(.${UNVEIL_CLASS})`), '揭晓类必须与显晓类写在同一段遮蔽选择器里');
  assert.ok(maskRule.includes(KBD_SELECTOR), '遮蔽规则必须锚在 KBD_SELECTOR 上');
});

test('JS 与 CSS 的契约：手型光标只挂在遮蔽开启时，且不落在遮蔽段内', () => {
  const stripped = scss.replace(/\/\*[\s\S]*?\*\//g, '');
  const cursorRule = stripped
    .split('}')
    .find((rule) => rule.includes(KBD_SELECTOR) && rule.includes('cursor: pointer'));

  assert.ok(cursorRule, '遮蔽开启时必须有手型光标提示可点击');
  assert.ok(
    cursorRule.includes('body.sy-cloze-active'),
    '光标规则必须限定在遮蔽开启时，否则编辑态会出现「手型但点了没反应」',
  );
  assert.ok(
    !cursorRule.includes(`:not(.${REVEAL_CLASS})`),
    '光标规则不得落在遮蔽段里，否则揭晓态会丢掉手型提示',
  );
});

test('两种透晓态必须是彼此独立的类名', () => {
  assert.notEqual(UNVEIL_CLASS, REVEAL_CLASS, '划选临时态与点击持久态混用会让「离开选区即撤」失效');
});
