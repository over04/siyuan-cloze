/**
 * 点击揭晓（持久态）的行为回归。
 *
 * 覆盖四层：
 *   1. 标识的稳定性——它不受同块内增删遮罩影响（序号位移缺陷回归），
 *      同答案文本撞键由末尾序号消歧；
 *   2. 记录与回放——点击切换整簇、DOM 重建后回放、关文档（drop）后恢复默认遮蔽、
 *      失效记录核对；
 *   3. 点击确认——每次点击都切换、连点不吞击、跨重建定位；
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
  markClusterMath,
  parseClusterKey,
  resolveProtyleRoot,
} from '../src/cluster.ts';
import {
  ANIMATE_CLASS,
  HIDING_CLASS,
  UnveilStore,
  dropBlockUnveil,
  dropUnveilForBlockId,
  findClusterByKey,
  forgetBlockOrder,
  isSameCluster,
  rememberBlockOrder,
  replayBlockUnveil,
  replayUnveilInto,
  resetAllUnveil,
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

/**
 * 模拟一次真实点击：整簇切换，并记下这一刻的簇顺序。
 *
 * src/index.ts 的 commitToggle 就是这两步。回放的位置对齐要靠那份顺序才认得出
 * 「位置 i 上的还是同一个遮罩」，所以凡是要验证「编辑后揭晓态保持」的用例都得走这条路径。
 */
const clickUnveil = (store, protyle, block, kbdEl) => {
  const cluster = getClozeCluster(kbdEl);
  const key = getClusterKey(block, cluster);
  toggleUnveilByKey(store.ensure(protyle), key, cluster);
  rememberBlockOrder(store, block);
};

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

test('listBlockClusters：同时给出供对齐使用的 text 与 dup', () => {
  const block = blockWith('blk', kbd('甲') + ' ' + kbd('甲') + ' ' + kbd('乙'));
  const items = listBlockClusters(block);

  assert.deepEqual(items.map((item) => item.text), ['甲', '甲', '乙']);
  assert.deepEqual(items.map((item) => item.dup), [0, 1, 0]);
});

test('parseClusterKey：与 listBlockClusters 的键格式严格对应', () => {
  // 答案文本里带 @ 也不能把序号切错。
  const block = blockWith('blk', maskedMath('a@b') + kbd('乙'));
  const [item] = listBlockClusters(block);

  assert.equal(item.key, 'blk#a@b|乙@0');
  assert.deepEqual(parseClusterKey(item.key), { nodeId: 'blk', text: 'a@b|乙', dup: 0 });
  assert.deepEqual(parseClusterKey('garbage'), { nodeId: '', text: '', dup: 0 }, '不成形的键不得抛错');
});

test('isSameCluster：任意位置的增删改都算同一个簇', () => {
  assert.equal(isSameCluster('1234', '123'), true, '删末尾');
  assert.equal(isSameCluster('123', '1234'), true, '补末尾');
  assert.equal(isSameCluster('(1234)', '(123)'), true, '删末尾，首尾同时变了');
  assert.equal(isSameCluster('abcd', 'abd'), true, '删中间');
  assert.equal(isSameCluster('ab', 'ax'), true, '改掉一个字符');
  assert.equal(isSameCluster('1234', '1243'), true, '调换顺序');

  assert.equal(isSameCluster('', '1234'), true, '重建中间态：文本暂时为空');
  assert.equal(isSameCluster('1234', ''), true);

  assert.equal(isSameCluster('甲', '乙'), false, '毫无关系');
  assert.equal(isSameCluster('1234', '5678'), false);
  assert.equal(isSameCluster('甲', '甲乙丙丁'), false, '只沾一点边，相似度不够');
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

test('replayUnveilInto：把重复答案中的一个改成别的文本，两个都保持揭晓', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('甲'));

  clickUnveil(store, protyle, block, kbdsOf(block)[0]);
  clickUnveil(store, protyle, block, kbdsOf(block)[1]);
  assert.equal(unveiledCount(block), 2);

  // 「甲」→「甲乙」：重复计数下降了，但块内簇数没变，位置也没有前移，两个位置各自
  // 认领自己的记录。位置级必须先于精确级走，否则另一个同文本遮罩的序号前移后会把
  // 第一条记录抢走，改过字的这个反被熄灭。
  block.innerHTML = kbd('甲乙') + ' ' + kbd('甲');
  replayUnveilInto(store, protyle);

  assert.equal(unveiledCount(block), 2, '两个都该保持揭晓');
  assert.equal(store.peek(protyle).has('blk#甲乙@0'), true);
  assert.equal(store.peek(protyle).has('blk#甲@0'), true);
});

test('replayUnveilInto：改掉一个重复答案不得把用户正看着的那个也熄灭', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙') + ' ' + kbd('乙'));

  // 只揭晓中间那个「乙」。
  clickUnveil(store, protyle, block, kbdsOf(block)[1]);

  // 把末尾的「乙」改成「乙乙」：重复计数从 2 降到 1，但块内簇数没变，位置没有前移，
  // 绝不能按「删掉一个重复答案」处理——那会把用户正看着的那个也一起熄灭。
  block.innerHTML = kbd('甲') + ' ' + kbd('乙') + ' ' + kbd('乙乙');
  replayUnveilInto(store, protyle);

  assert.ok(kbdsOf(block)[1].classList.contains(UNVEIL_CLASS), '正看着的那个必须留着');
  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS));
  assert.ok(!kbdsOf(block)[2].classList.contains(UNVEIL_CLASS));
});

test('replayUnveilInto：删掉一个重复答案时只作废该文本，同块其它簇不受牵连', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('甲') + ' ' + kbd('乙'));

  // 只揭晓「乙」。
  clickUnveil(store, protyle, block, kbdsOf(block)[2]);

  // 删掉一个「甲」：重复文本的计数下降、序号前移，「甲」的记录一律作废；
  // 但「乙」与它无关，必须原样留着。
  block.innerHTML = kbd('甲') + ' ' + kbd('乙');
  replayUnveilInto(store, protyle);

  assert.ok(kbdsOf(block)[1].classList.contains(UNVEIL_CLASS), '「乙」的揭晓态不得被牵连');
  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS));
});

test('forgetBlockOrder：丢掉基线后，同位置的相似新遮罩不得继承旧记录', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));

  clickUnveil(store, protyle, block, kbdsOf(block)[0]);

  // 取消遮罩（等价于原生 ⌥D）之后又在原位置挖空一段相似文本。位置级认不出这两者的
  // 差别，所以 ⌥Q 路径会主动丢掉基线，下一次回放只做精确匹配。
  forgetBlockOrder(store, protyle, 'blk');
  block.innerHTML = kbd('甲子') + ' ' + kbd('乙');
  replayUnveilInto(store, protyle);

  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '新遮罩从未被点开，不得亮起');
  assert.ok(!kbdsOf(block)[1].classList.contains(UNVEIL_CLASS));
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

/* -------------------------------------------- 编辑遮罩内容：两级对齐 */

test('replayUnveilInto：簇内删字后揭晓态必须保持（位置级对齐）', () => {
  const store = new UnveilStore();
  const { protyle, wysiwyg, block } = mountProtyle('blk', kbd('1234'));
  const records = store.ensure(protyle);

  clickUnveil(store, protyle, block, kbdsOf(block)[0]);
  assert.equal(unveiledCount(wysiwyg), 1);
  assert.equal(records.has('blk#1234@0'), true);

  // 点开答案后删掉其中一个字：键从 blk#1234@0 变成 blk#123@0。
  // 只按文本精确匹配的话，回放会判定为「记录里没有」而把揭晓类摘掉，
  // 用户看到的就是「删一个字，答案又藏回去了」。
  block.innerHTML = kbd('123');
  replayUnveilInto(store, protyle);

  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '删字后必须仍是揭晓态');
  assert.equal(records.has('blk#123@0'), true, '记录要迁到新键上，否则下一轮又得重走位置级');
  assert.equal(records.size, 1, '旧键必须一并撤掉，不得留下两条记录');

  replayUnveilInto(store, protyle);
  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '再回放一轮仍然稳定');
  assert.equal(records.size, 1);
});

test('replayUnveilInto：删中间字符、改字符、连括号一起变，揭晓态都要保持', () => {
  const cases = [
    ['abcd', 'abd', '删中间'],
    ['ab', 'ax', '改一个字符'],
    ['(1234)', '(123)', '删末尾，首尾同时变了'],
    ['1234', '12345', '补末尾'],
  ];

  cases.forEach(([before, after, label]) => {
    const store = new UnveilStore();
    const { protyle, block } = mountProtyle('blk', kbd(before));

    clickUnveil(store, protyle, block, kbdsOf(block)[0]);

    block.innerHTML = kbd(after);
    replayUnveilInto(store, protyle);

    assert.ok(
      kbdsOf(block)[0].classList.contains(UNVEIL_CLASS),
      `${label}：${before} → ${after} 必须仍是揭晓态`,
    );
    assert.equal(store.peek(protyle).has(`blk#${after}@0`), true, `${label}：记录要迁到新键上`);
  });
});

test('replayUnveilInto：重建中间态文本为空时保持揭晓，且不据此改写记录', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('12345'));
  const records = store.ensure(protyle);

  clickUnveil(store, protyle, block, kbdsOf(block)[0]);

  // 思源重建行内元素：kbd 元素已经挂回 DOM，内部文本尚未填回。这一轮是按位置硬配的，
  // 可靠性不足，因此只继承显示、不动记录——否则一次短暂的错配就会变成永久错位。
  block.innerHTML = kbd('');
  replayUnveilInto(store, protyle);

  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '中间态不得把揭晓态摘掉');
  assert.equal(records.has('blk#12345@0'), true, '中间态的匹配不得改写记录');

  block.innerHTML = kbd('12345');
  replayUnveilInto(store, protyle);

  assert.equal(records.size, 1);
  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '文本填回后仍然揭晓');
});

test('replayUnveilInto：位置级只认领同一个位置上的记录，不得抢走别的簇的揭晓态', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));
  const records = store.ensure(protyle);
  const items = listBlockClusters(block);

  // 只点开第二个。
  toggleClusterUnveil(records, block, items[1].cluster);
  replayUnveilInto(store, protyle);
  assert.ok(kbdsOf(block)[1].classList.contains(UNVEIL_CLASS));

  // 把第一个簇改成一个与「乙」毫无关系的字：它不得因此抢到「乙」的记录。
  block.innerHTML = kbd('丙') + ' ' + kbd('乙');
  replayUnveilInto(store, protyle);

  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '不得把答案亮到无关的簇上');
  assert.ok(kbdsOf(block)[1].classList.contains(UNVEIL_CLASS), '原簇的揭晓态必须留住');
});

test('replayUnveilInto：删掉一个遮罩后，同块内文本相似却从未揭晓的遮罩不得被点亮', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('甲子'));

  // 只点开「甲」，「甲子」始终是遮蔽的。
  clickUnveil(store, protyle, block, kbdsOf(block)[0]);
  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS));
  assert.ok(!kbdsOf(block)[1].classList.contains(UNVEIL_CLASS));

  // 用户把「甲」那个遮罩整个删掉（等价于原生 ⌥D 取消遮罩后 kbd 消失）。
  // 块内簇数从 2 变 1，位置已经错开，此时绝不能把那条记录交给「甲子」——
  // 那等于把答案亮在一个用户从没点开过的位置上。
  block.innerHTML = kbd('甲子');
  replayUnveilInto(store, protyle);

  assert.ok(
    !kbdsOf(block)[0].classList.contains(UNVEIL_CLASS),
    '「甲子」不得因为文本包含「甲」就接走那条记录',
  );
});

test('replayUnveilInto：块内簇数不变但位置已错开时，状态要跟着原遮罩走', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));

  // 只揭晓「乙」。
  clickUnveil(store, protyle, block, kbdsOf(block)[1]);

  // 删掉「甲」，又在末尾新建「丙」：数量仍是 2，但位置已经错开。
  block.innerHTML = kbd('乙') + ' ' + kbd('丙');
  replayUnveilInto(store, protyle);

  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '揭晓态要跟着「乙」走');
  assert.ok(!kbdsOf(block)[1].classList.contains(UNVEIL_CLASS), '新建的「丙」不得被点亮');
});

test('replayUnveilInto：两个遮罩的文本变得相同后，揭晓态仍跟着原来那一个', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('12') + ' ' + kbd('1234'));

  // 只揭晓第二个。
  clickUnveil(store, protyle, block, kbdsOf(block)[1]);

  // 把第二个改成与第一个同文本：两个簇的文字完全一样，只能靠位置区分。
  block.innerHTML = kbd('12') + ' ' + kbd('12');
  replayUnveilInto(store, protyle);

  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '第一个从未被点开，不得亮起');
  assert.ok(kbdsOf(block)[1].classList.contains(UNVEIL_CLASS), '第二个的揭晓态要留住');
});

test('replayUnveilInto：同一条记录不得被两个簇同时认领', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));

  // 只揭晓位置 1 的「乙」。
  clickUnveil(store, protyle, block, kbdsOf(block)[1]);

  // 把位置 0 改成「乙」：两个簇的键都长成 blk#乙@N，位置级已经把那条记录判给了位置 1。
  // 精确级不得再认领一次——它只看「记录里有没有这个键」，不看这条记录是不是已经被领走，
  // 于是位置 0 会被点亮，而它从未被点开。
  block.innerHTML = kbd('乙') + ' ' + kbd('乙');
  replayUnveilInto(store, protyle);

  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '位置 0 从未被点开，不得亮起');
  assert.ok(kbdsOf(block)[1].classList.contains(UNVEIL_CLASS), '位置 1 必须留住');
});

test('replayUnveilInto：块内多个 kbd 一起变空的中间态，不得把整块记录清空', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('1234') + ' ' + kbd('5678'));

  clickUnveil(store, protyle, block, kbdsOf(block)[0]);

  // 思源重建块：两个 kbd 元素都还在，文本同时暂时为空。
  // 若把空文本记进顺序表，下一轮就会把它当成「重复答案少了一个」，整块记录被清掉，
  // 而且不会自己恢复。
  block.innerHTML = kbd('') + ' ' + kbd('');
  replayUnveilInto(store, protyle);

  block.innerHTML = kbd('1234') + ' ' + kbd('5678');
  replayUnveilInto(store, protyle);

  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '揭晓态必须自己恢复');
  assert.ok(!kbdsOf(block)[1].classList.contains(UNVEIL_CLASS), '另一个仍应保持遮蔽');
  assert.equal(store.peek(protyle).size, 1, '记录不得被清空');
});

test('replayBlockUnveil：单块入口与整篇回放结果一致', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲'));

  toggleClusterUnveil(store.ensure(protyle), block, getClozeCluster(kbdsOf(block)[0]));

  const rebuilt = blockWith('blk', kbd('甲'));
  block.replaceWith(rebuilt);
  assert.equal(unveiledCount(rebuilt), 0);

  // DOM 抖动时走的就是这条入口：同步补类，不扫全篇。
  replayBlockUnveil(store, rebuilt);
  assert.ok(kbdsOf(rebuilt)[0].classList.contains(UNVEIL_CLASS));

  // 没有记录的块必须原样放过。
  const other = blockWith('blk-other', kbd('乙'));
  replayBlockUnveil(store, other);
  assert.equal(unveiledCount(other), 0);
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

/* ------------------------------------------------------- 过渡与待摘标记 */

test('过渡只在用户主动切换时配，回放补类不配', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲'));

  // 点击切换：要配过渡，否则揭晓/遮蔽的切换会变得生硬。
  clickUnveil(store, protyle, block, kbdsOf(block)[0]);
  assert.ok(kbdsOf(block)[0].classList.contains(ANIMATE_CLASS), '点击切换必须配过渡');

  // 回放补类：不得配过渡，否则「补类」这一步本身会变成一段从模糊到清晰的动画。
  const rebuilt = blockWith('blk', kbd('甲'));
  block.replaceWith(rebuilt);
  replayUnveilInto(store, protyle);

  assert.ok(kbdsOf(rebuilt)[0].classList.contains(UNVEIL_CLASS));
  assert.ok(!kbdsOf(rebuilt)[0].classList.contains(ANIMATE_CLASS), '回放补类不得配过渡');
});

test('replayUnveilInto：一轮对不上只挂待摘标记，连续两轮才真的摘掉', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));

  clickUnveil(store, protyle, block, kbdsOf(block)[0]);
  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS));

  // 只换文本、不换元素——思源重建过程中会出现这种中间态，元素还在、文本已经变了。
  // 当场摘掉、下一轮再加回来，屏幕上就是一次「亮 → 暗 → 亮」的闪动。
  kbdsOf(block)[0].textContent = `${WJ}丙`;
  replayUnveilInto(store, protyle);

  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '首轮不得当场摘掉');
  assert.ok(kbdsOf(block)[0].classList.contains(HIDING_CLASS), '首轮只挂待摘标记');

  replayUnveilInto(store, protyle);

  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '连续两轮都对不上才真摘');
  assert.ok(!kbdsOf(block)[0].classList.contains(HIDING_CLASS), '待摘标记要一并清掉');
});

test('replayUnveilInto：blocked 清空记录后不得把揭晓类留在元素上', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('乙') + ' ' + kbd('乙'));

  // 揭晓位置 0，再把位置 1 整个删掉：重复答案少了一个，该文本的记录整批作废。
  // 必须只删元素、留着位置 0 那个（它还带着揭晓类），否则重建出来的新元素本来就没类，
  // 测不出「残留」。
  clickUnveil(store, protyle, block, kbdsOf(block)[0]);
  assert.ok(kbdsOf(block)[0].classList.contains(UNVEIL_CLASS));

  kbdsOf(block)[1].remove();
  replayUnveilInto(store, protyle);

  // 记录已经清空，下一轮回放会在「记录为空」处早退。若这一轮只挂待摘标记而没摘掉，
  // 揭晓类就再也没人收拾——遮蔽规则被 :not(.sy-cloze-unveiled) 反向失效，
  // 那个遮罩会永远亮着答案。
  assert.equal(store.peek(protyle).size, 0, '记录已整批作废');
  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '揭晓类必须当场摘掉');
  assert.ok(!kbdsOf(block)[0].classList.contains(HIDING_CLASS), '待摘标记也不得留下');

  replayUnveilInto(store, protyle);
  replayUnveilInto(store, protyle);

  assert.equal(unveiledCount(protyle), 0, '再跑两轮也不得复活');
});

test('resetAllUnveil：⌥X 重置要连待摘标记一起清', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));

  clickUnveil(store, protyle, block, kbdsOf(block)[0]);

  // 先造一个待摘标记：把文本改成对不上的内容，跑一轮回放（首轮只挂标记、不摘）。
  kbdsOf(block)[0].textContent = `${WJ}丙`;
  replayUnveilInto(store, protyle);
  assert.ok(kbdsOf(block)[0].classList.contains(HIDING_CLASS), '先造出待摘标记');

  resetAllUnveil(store, document.body);

  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS));
  assert.ok(!kbdsOf(block)[0].classList.contains(HIDING_CLASS), '重置不得留下待摘标记');
});

test('UnveilStore.drop：关文档时连待摘标记一起清', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲'));

  clickUnveil(store, protyle, block, kbdsOf(block)[0]);

  kbdsOf(block)[0].textContent = `${WJ}丙`;
  replayUnveilInto(store, protyle);
  assert.ok(kbdsOf(block)[0].classList.contains(HIDING_CLASS));

  store.drop(protyle);

  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS));
  assert.ok(!kbdsOf(block)[0].classList.contains(HIDING_CLASS), '关文档不得留下待摘标记');
});

test('replayBlockUnveil：块内没有记录时，残留的标记也要就地清掉', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲') + ' ' + kbd('乙'));

  // 造一个「这个块没有记录、元素却带着标记」的状态：记录挂在别的块上，
  // 因此走的是块级早退口，而不是「整篇记录为空」那条兜底。
  store.ensure(protyle).set('other#甲@0', true);
  kbdsOf(block)[0].classList.add(UNVEIL_CLASS);
  kbdsOf(block)[1].classList.add(HIDING_CLASS);

  replayBlockUnveil(store, block);

  assert.ok(!kbdsOf(block)[0].classList.contains(UNVEIL_CLASS), '残留的揭晓类要清掉');
  assert.ok(!kbdsOf(block)[1].classList.contains(HIDING_CLASS), '残留的待摘标记也要清掉');
});

test('replayBlockUnveil：清理残留标记时不得碰嵌套子块', () => {
  const store = new UnveilStore();

  const protyle = document.createElement('div');
  protyle.className = 'protyle';
  const wysiwyg = document.createElement('div');
  wysiwyg.className = 'protyle-wysiwyg';

  const parent = document.createElement('div');
  parent.setAttribute('data-node-id', 'parent');
  const child = document.createElement('div');
  child.setAttribute('data-node-id', 'child');
  child.innerHTML = kbd('甲');
  parent.appendChild(child);
  wysiwyg.appendChild(parent);
  protyle.appendChild(wysiwyg);
  document.body.appendChild(protyle);

  // 子块有记录、元素带揭晓类；父块自己没有记录，走的是块级早退口。
  // 思源的列表项、引述块、超级块都是嵌套的 [data-node-id]，父块的回放不能递归进去把
  // 子块的标记清掉——那样会出现「记录还在、标记没了」，父块排在后时还不自愈。
  store.ensure(protyle).set('child#甲@0', true);
  kbdsOf(child)[0].classList.add(UNVEIL_CLASS);

  replayBlockUnveil(store, parent);

  assert.ok(
    kbdsOf(child)[0].classList.contains(UNVEIL_CLASS),
    '子块的揭晓类不得被父块的清理顺手摘掉',
  );
});

test('replayBlockUnveil：元素自身带 data-node-id 时也要清掉残留标记', () => {
  const store = new UnveilStore();
  const { protyle, block } = mountProtyle('blk', kbd('甲'));

  store.ensure(protyle).set('other#甲@0', true);
  const el = kbdsOf(block)[0];
  // 行内引用、行内公式的渲染容器常自带 data-node-id，守卫不能因此把它当成别的块。
  el.setAttribute('data-node-id', 'inline-ref');
  el.classList.add(UNVEIL_CLASS);

  replayBlockUnveil(store, block);

  assert.ok(!el.classList.contains(UNVEIL_CLASS), '自身带 node-id 也要按所属块清掉');
});

test('replayBlockUnveil：root 级早退不得清掉嵌套内层 protyle 的标记', () => {
  const store = new UnveilStore();

  // 外层文档：一个表格块，里面嵌着单元格自己的 .protyle。
  const outer = document.createElement('div');
  outer.className = 'protyle';
  const outerWysiwyg = document.createElement('div');
  outerWysiwyg.className = 'protyle-wysiwyg';
  const tableBlock = document.createElement('div');
  tableBlock.setAttribute('data-node-id', 'table-block');

  const inner = document.createElement('div');
  inner.className = 'protyle';
  const innerWysiwyg = document.createElement('div');
  innerWysiwyg.className = 'protyle-wysiwyg';
  const cellBlock = document.createElement('div');
  cellBlock.setAttribute('data-node-id', 'cell-block');
  cellBlock.innerHTML = kbd('甲');
  innerWysiwyg.appendChild(cellBlock);
  inner.appendChild(innerWysiwyg);
  tableBlock.appendChild(inner);
  outerWysiwyg.appendChild(tableBlock);
  outer.appendChild(outerWysiwyg);
  document.body.appendChild(outer);

  // 外层 root 没有任何记录（走 root 级早退），内层单元格有自己的记录与标记。
  store.ensure(outer);
  store.ensure(inner).set('cell-block#甲@0', true);
  kbdsOf(cellBlock)[0].classList.add(UNVEIL_CLASS);

  replayBlockUnveil(store, tableBlock);

  assert.ok(
    kbdsOf(cellBlock)[0].classList.contains(UNVEIL_CLASS),
    '单元格的揭晓态不得被外层块的清理顺手摘掉',
  );
});

test('JS 与 CSS 的契约：过渡必须由动画类门控', () => {
  const stripped = scss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = stripped.split('}').filter((rule) => rule.includes('transition'));

  assert.equal(rules.length, 1, 'transition 只该出现在一条规则里');
  assert.ok(rules[0].includes(ANIMATE_CLASS), `过渡必须由 .${ANIMATE_CLASS} 门控`);
  assert.ok(
    !rules[0].includes('body.sy-cloze-active'),
    '过渡不得挂在基础规则或遮蔽段上——那样回放补类会变成一段可见的渐变',
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

test('JS 与 CSS 的契约：遮蔽态的命中区要跟着模糊范围一起外扩', () => {
  const stripped = scss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = stripped.split('}');

  // blur(6px) 让模糊块看起来比实际宽出一圈，而 kbd 的 padding 只有 1px。命中区不跟着扩，
  // 用户照着模糊的边缘点下去就落到相邻文本上，这次点击等于没发生。
  const maskRule = rules.find((rule) => rule.includes('blur(6px)'));
  assert.ok(maskRule, '找不到遮蔽段规则');
  assert.ok(maskRule.includes('position: relative'), '遮蔽段要给外扩的伪元素留定位参照');

  const hitRule = rules.find((rule) => rule.includes('::after') && rule.includes('pointer-events'));
  assert.ok(hitRule, '遮蔽态缺少外扩命中区');
  assert.ok(/left:\s*-\d/.test(hitRule) && /right:\s*-\d/.test(hitRule), '命中区要左右外扩');
  assert.ok(hitRule.includes(KBD_SELECTOR), '命中区必须挂在 kbd 上，否则事件目标不再是遮罩');
});

test('JS 与 CSS 的契约：切换挂在 mousedown 上，命中时把整次交互吞掉', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');

  // click 只在 mousedown 与 mouseup 落在同一目标上时才派发，按下抬起之间抖几个像素就丢
  // 了——那次点击既不切换又已经开始了拖选。mousedown 在拖选开始之前一定触发。
  assert.ok(
    /addEventListener\('mousedown',\s*this\.\w+,\s*true\)/.test(source),
    '切换必须挂在捕获阶段的 mousedown 上',
  );
  assert.ok(
    /addEventListener\('mouseup',\s*this\.\w+,\s*true\)/.test(source) &&
      /addEventListener\('click',\s*this\.\w+,\s*true\)/.test(source),
    '命中遮罩时 mouseup 与 click 也要拦：只拦 mousedown 的话，思源照样会更新选区快照、弹出公式编辑器',
  );
  assert.ok(
    !/e\.detail\s*[<>=]/.test(source),
    '不做双击回滚：preventDefault 已经让双击选词不可能发生，回滚只会让手快的人点两下等于没点',
  );
  assert.ok(
    !/swallowUntil/.test(source),
    '吞事件要用「本次交互是否结束」的标记，不用固定时间窗：长按超过窗口再松开时 mouseup 会漏给思源',
  );
});

test('JS 与 CSS 的契约：创建或取消遮罩不得顺手切换填空模式', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');

  // 模式只由顶栏眼睛与 ⌥X 控制。之前「新建一处遮罩就把整篇切进填空模式」会让只想取消
  // 遮罩、却因选区没被识别成 kbd 而走了创建路径的用户，莫名其妙换了一整篇的模式。
  assert.ok(
    !/this\.isClozeActive\s*=\s*true/.test(source),
    '除 toggleGlobalCloze 外，别处不得把填空模式设成开启',
  );
});

test('JS 与 CSS 的契约：提示线由 ::before 统一画，kbd 与公式共用一套机制', () => {
  const stripped = scss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = stripped.split('}');

  // 两套机制（text-decoration 沿基线走 / border 落在盒底）高度天然不同，公式盒高又随内容变，
  // 视觉上会断成几条。统一由 ::before 画在元素盒底，再用 JS 量出的下移量对齐到簇内容最低点。
  const lineRule = rules.find(
    (rule) => rule.includes('::before') && rule.includes('--sy-cloze-line-drop'),
  );
  assert.ok(lineRule, '提示线必须由 ::before 画，并用 JS 量出的下移量对齐');
  assert.ok(
    lineRule.includes(KBD_SELECTOR) && lineRule.includes('.sy-cloze-math'),
    'kbd 与公式必须共用同一条画线规则，两套机制的高度对不齐',
  );
  assert.ok(
    /border-bottom:\s*2px\s+dashed\s+var\(--b3-theme-primary/.test(lineRule),
    '提示线要用主题色、2px 虚线',
  );

  assert.ok(
    !/text-decoration(-line)?:\s*underline/.test(stripped),
    'text-decoration 沿基线走，与公式盒底的高度对不齐，已被 ::before 取代',
  );

  // 线在伪元素上，遮蔽态的隐藏也必须打在伪元素上——打在元素本身不起作用。
  const hideRule = rules.find(
    (rule) => rule.includes('body.sy-cloze-active') && rule.includes('::before'),
  );
  assert.ok(hideRule, '遮蔽态必须在 ::before 上把线置透明，打在元素本身不起作用');
  assert.ok(
    hideRule.includes(KBD_SELECTOR) && hideRule.includes('.sy-cloze-math'),
    'kbd 与公式的线都要被遮蔽态藏掉',
  );
  assert.ok(
    hideRule.includes(`:not(.${REVEAL_CLASS})`) && hideRule.includes(`:not(.${UNVEIL_CLASS})`),
    '揭晓态与划选透晓态必须排除在外，线在那两种状态下要保持可见',
  );

  // 公式侧：类名由 JS 按簇计算打上，CSS 不再依赖相邻兄弟——相邻兄弟覆盖不到「kbd 公式 公式
  // kbd」里排在后面的公式，还会误伤紧挨遮罩但不属于它的公式。
  const mathRule = rules.find(
    (rule) => rule.includes('.sy-cloze-math') && rule.includes('display: inline-block'),
  );
  assert.ok(mathRule, '公式要 inline-block，线才会落在公式盒底而不是行盒底');
});

test('JS 契约：簇成员公式的类与下移量由 markClusterMath 打上', () => {  const cluster = fs.readFileSync(path.join(repoRoot, 'src/cluster.ts'), 'utf8');
  const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');

  assert.ok(/export const markClusterMath/.test(cluster), 'cluster.ts 必须导出 markClusterMath');
  assert.ok(
    /getBoundingClientRect\(\)\.bottom/.test(cluster),
    '下移量要按元素实际盒底量，不能靠 CSS 猜',
  );
  assert.ok(
    /markClusterMath\(block\)/.test(source) && /markClusterMathIn/.test(source),
    'index.ts 必须在 DOM 变更与加载两个时机都打标，否则公式线会漏',
  );
});

test('JS 契约：提交切换时不得按块 ID 直接取第一个元素', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');

  // 同一个块 ID 在 protyle 根里可能同时存在多个元素（实测 3 个），querySelector 拿到的
  // 第一个未必是含遮罩的那份，会算出一个空簇，这次点击被静默丢掉——表现就是「点了没反应」，
  // 而且只在部分块上复现（列表项能切、普通段落不能）。必须用点击时的锚点解析，或逐个同 ID
  // 元素试到能算出键的那个。
  assert.ok(
    !/querySelector\(`\[data-node-id/.test(source),
    '按块 ID 取第一个元素会踩到同 ID 副本，改用锚点解析或逐个同 ID 元素试',
  );
  assert.ok(
    /target\.anchor\.isConnected\s*&&\s*target\.root\.contains\(target\.anchor\)/.test(source),
    '一级解析要校验锚点仍属于这个 root：块被移到别的编辑器时锚点依然 isConnected，只用它会把记录写进旧 root',
  );
});

test('markClusterMath：簇内相邻的多个公式都打标，簇外公式不打标', () => {
  // 公式是 kbd 的兄弟而不是后代，CSS 的相邻兄弟只能覆盖紧跟在 kbd 后面那一个。簇里连续
  // 多个公式是常态（一个矩阵公式后面紧跟一个 ~ 符号的公式），所以打标必须按簇计算来。
  const math = (content) =>
    `<span data-type="inline-math" data-subtype="math" data-content="${content}" contenteditable="false" class="render-node">${WJ}</span>`;

  const block = element(
    `<div data-node-id="mk-1">${kbd('若')}${math('A')}${math('\\sim')}${kbd('B')}${math('孤')}</div>`,
  );

  markClusterMath(block);

  const marked = Array.from(block.querySelectorAll('.sy-cloze-math')).map((el) =>
    el.getAttribute('data-content'),
  );
  assert.deepEqual(marked, ['A', '\\sim'], '簇内两个相邻公式都要打标，簇外那个不打标');
});

test('markClusterMath：遮罩取消后公式的类要摘掉', () => {
  const math = (content) =>
    `<span data-type="inline-math" data-subtype="math" data-content="${content}" contenteditable="false" class="render-node">${WJ}</span>`;

  const block = element(`<div data-node-id="mk-2">${kbd('若')}${math('A')}${kbd('则')}</div>`);
  markClusterMath(block);
  assert.equal(block.querySelectorAll('.sy-cloze-math').length, 1);

  // 取消遮罩：kbd 被还原成普通文字，公式不再是簇成员。
  block.querySelectorAll(KBD_SELECTOR).forEach((el) => el.replaceWith(...el.childNodes));
  markClusterMath(block);

  assert.equal(
    block.querySelectorAll('.sy-cloze-math').length,
    0,
    '取消遮罩后公式就是普通公式了，标记必须摘掉，否则它会一直带着一条提示线',
  );
});
