# tests/

## 跑法

```bash
npm test
```

前置条件：装过一次依赖（`pnpm install`），`jsdom` 在 devDependencies 里。

## 退出码

| 情况 | `npm test` 退出码 |
| --- | --- |
| 全部用例通过 | `0` |
| 存在失败用例 | `1`（Node 测试运行器约定，npm 原样透传，可直接当 CI 门禁） |

仓库内不存在「故意失败」的用例。`npm test` 全绿即退出码 `0`；退出码 `1` 只会因为
真的有断言没过。

## 文件

| 文件 | 内容 |
| --- | --- |
| `fixtures.mjs` | 6 个场景的 DOM 夹具（真实内核往返结果）与期望分组 |
| `cluster.test.mjs` | 集群分组、桥接判据、`kbd` 选择器语义 |
| `anchor.test.mjs` | 锚点解析、邻居扫描、节点解析、选区求交，以及 JS↔CSS 契约 |
| `tableCell.test.mjs` | 单元格形态判定与可见文本偏移换算（`src/tableCell.ts` 纯函数层） |
| `unveil.test.mjs` | 标识稳定性、记录与回放、关文档恢复默认、SCSS 契约（`src/unveil.ts` 纯函数层） |
| `helpers.mjs` | 共用件：jsdom 装配与块包装（不以 `.test.mjs` 结尾，不会被当用例执行） |

`cluster.test.mjs` 用 jsdom 建真实 DOM，直接调用 `src/cluster.ts` 里的集群算法。
每个夹具跑两遍：生产口径（`isClozeBridge`）必须得到 `expect`，旧口径（含 `\s` 的
`INVISIBLE_TEXT`，即改前的缺陷版本）必须得到 `wrong`——后者保证这个测试真的能抓到
「两次划选被并成一个遮罩」这个缺陷，而不是永远绿。

尚未覆盖：`src/index.ts` 里的 ⇧⌘C 创建/取消管道、单元格退避流程（`retreatFromCellEditor`）
与显晓类施加——它们依赖 `protyle.toolbar` 与真实单元格编辑器，必须在真实编辑器里才跑得起来；
`index.scss` 的遮蔽视觉也没有断言。
`anchor.test.mjs` 末尾的契约用例只锁住类名与选择器这两个跨文件常量。

`unveil.test.mjs` 覆盖纯函数层：键稳定性与重复答案消歧、点击切换（整簇加类/去类）、
DOM 重建后回放保活、失效记录两轮核对、`store.drop` 后恢复默认遮蔽、取消遮罩时作废并校正视觉。

回放的对齐按顺序走两级，用例按这两级各自的失效方式布防。位置级只在「块内簇数与上一轮
相同」时启用、且先于精确级走，覆盖簇内任意位置的增删改（`abcd` → `abd`、`ab` → `ax`、
`(1234)` → `(123)`）与重建中间态（kbd 还在、文本暂时为空）；精确级（答案文本与重复序号
都对上）兜底，挡住「同块内新建遮罩把状态挪到新遮罩上」。边界各有用例：簇数变了就不做
位置对齐（删掉「甲」之后「甲子」不得接走那条记录）、数量不变但位置错开（删「甲」补「丙」
后状态要跟着「乙」走）、两个遮罩文本变得相同后仍按位置区分、改掉一个重复答案不得熄灭
用户正看着的那个。

另有一组守「输入时不闪」。过渡必须由 `.sy-cloze-animating` 门控——JS 只在点击揭晓与
⌥⇧X 全局切换时挂上（`animateCluster`），回放补类不带它，否则「补类」这一步本身会变成
一段从模糊到清晰的渐变；回放的摘类改成两轮确认，首轮只挂 `.sy-cloze-hiding`，连续两轮
都对不上才真摘，避免思源重建的中间态造成一次「亮 → 暗 → 亮」。

两轮确认有两处不能省：`blocked` 命中的簇要当场摘干净（记录随后就被删掉，下一轮回放会
在「记录为空」处早退，留着标记就是永久残留、遮罩一直亮着答案）；`records.size === 0` 的
早退口也要就地清一遍标记，兜住同类路径。

两处早退口的清理都必须过滤归属，否则会摘掉别人的揭晓类。块级（`mine.length === 0`）用
`el.parentElement?.closest('[data-node-id]') !== block`：思源的列表项、引述块、超级块都是
嵌套的 `[data-node-id]`，子块有自己的记录；从父元素起算是因为行内引用、行内公式的渲染容器
自身就带 `data-node-id`，用 `el.closest` 会把它们误判成别的块而漏清。root 级
（`records.size === 0`）用 `resolveProtyleRoot(el) !== root`：表格单元格是嵌在主文档块里的
独立 `.protyle`，它有自己的记录。两种误伤的后果都是「记录还在、标记没了」，而父块排在同一批
MutationRecord 后半段时不会自愈。

这些用例不是永远绿，逐条拆掉对应判据即可复现失败：
把 `previous.length === items.length` 这个前提去掉 → 「删掉一个遮罩后…不得被点亮」失败；
把 `isSameCluster` 换回「互相包含」→「删中间字符、改字符、连括号一起变」失败；
把 `orders` 与 `shrunk` 两处空文本防护同时去掉 → 「多个 kbd 一起变空的中间态…不得清空」失败；
把 `previous.length > items.length` 去掉 → 「改掉一个重复答案…」两条失败；
把两级顺序倒过来（精确级先走）→「把重复答案中的一个改成别的文本…」失败；
把 `forgetBlockOrder` 改成空函数 → 「丢掉基线后…」失败；
把 `transition` 放回基础规则 → 「过渡必须由动画类门控」失败；
把摘类改回一轮 → 「一轮对不上只挂待摘标记」失败；
把 `blocked` 分支的当场摘掉改回两轮确认 → 「blocked 清空记录后…」失败；
把 `store.drop` 的清理退回只摘揭晓类 → 「关文档时连待摘标记一起清」失败；
把块级早退口的 `closest` 守卫去掉 → 「清理残留标记时不得碰嵌套子块」失败；
把 root 级早退口的 root 归属守卫去掉 → 「root 级早退不得清掉嵌套内层 protyle 的标记」失败；
把块级守卫改回 `el.closest(...)` → 「元素自身带 data-node-id 时也要清掉残留标记」失败；
把 `mousedown` 改回 `click` → 「切换挂在 mousedown 上」失败；
把遮蔽段的 `position: relative` 或外扩伪元素去掉 → 「遮蔽态的命中区要跟着模糊范围一起外扩」失败；
把 `mouseup` / `click` 的吞事件监听去掉 → 「切换挂在 mousedown 上，命中时把整次交互吞掉」失败；
把提示线改回 `text-decoration`，或把 kbd 与公式拆成两套画线机制 → 「提示线由 ::before 统一画」失败；
把遮蔽态的隐藏从 `::before` 挪回元素本身 → 同一条用例失败；
去掉 `markClusterMath` 的打标、或去掉它的摘类分支 → 「簇内相邻的多个公式都打标」/「遮罩取消后公式的类要摘掉」失败；
在 `commitToggle` 里加回 `root.querySelector(\`[data-node-id=…]\`)` → 「提交切换时不得按块 ID 直接取第一个元素」失败；
去掉一级的 `target.root.contains(target.anchor)` 校验 → 同一条用例失败；
把 `this.isClozeActive = true` 加回去 → 「创建或取消遮罩不得顺手切换填空模式」失败。

另有一组守「点得中、点得动、不穿公式」。切换挂在捕获阶段的 `mousedown` 上而不是 `click`：
`click` 只在 `mousedown` 与 `mouseup` 落在同一目标上时才派发，按下抬起之间抖几个像素就丢了，
那次点击既不切换又已经开始了拖选；`mousedown` 在拖选之前一定触发，命中遮罩时把整次交互
（`mousedown` / `mouseup` / `click` / `dblclick`）一并吞掉——只拦 `mousedown` 的话，思源照样会
在 `mouseup` / `click` 上更新选区快照、弹出公式编辑器。每次点击都切换，不做双击回滚：
`preventDefault` 已经让双击选词不可能发生，回滚只会让手快的人点两下等于没点。

遮蔽态的 kbd 另加一层透明伪元素，左右各外扩 6px、纵向撑满行高：`blur(6px)` 让模糊块看起来比
实际宽出一圈，而 kbd 的 padding 只有 1px，命中区不跟着扩就会「照着模糊边缘点、实际落到相邻
文本上」。伪元素绝对定位、不参与排版，点击落在它身上时事件目标仍是宿主 kbd，判定照旧。

常态提示线由 `::before` 统一画在元素盒底，`kbd` 与公式共用同一套机制；`markClusterMath` 量出每个成员到簇内容最低点的差值写进 `--sy-cloze-line-drop`，把较矮的成员下移，整簇落在同一条水平线上。不要改回 `text-decoration` 或 `border-bottom`：前者会沿基线横穿较高的公式，后者落在行盒底、跨行还会分段。公式必须是 `inline-block`，否则线仍会落在行盒底。遮蔽态的隐藏也要打在 `::before` 上——线在伪元素上，打在元素本身不起作用。

公式是 kbd 的**兄弟**而不是后代：思源把一次挖空拆成多个 kbd 切片，行内公式是原子节点、kbd 无法跨越它，所以簇是「kbd 公式 kbd」这样的平级结构（见 cluster.ts 的兄弟遍历）。**不要用 CSS 选择器去找簇成员公式**：相邻兄弟 `+` 只能覆盖「kbd 紧跟一个公式」，覆盖不到「kbd 公式 公式 kbd」里排在后面的那些——而簇里连续多个公式是常态（一个矩阵公式后面紧跟一个 `~` 符号的公式），它还会误伤紧挨遮罩但不属于这个遮罩的公式；后代选择器则一个元素都命不中。簇成员由 `markClusterMath` 按同一套簇计算打上 `.sy-cloze-math`。

提交切换时不得按块 ID 在根里 `querySelector`：同一个块 ID 在 protyle 根里可能同时存在多个
元素（实测 3 个），拿到的第一个未必是含遮罩的那份，`listBlockClusters` 会算出空簇，
`findClusterByKey` 随即找不到，这次点击被静默丢掉——表现是「点了完全没反应」，而且只在部分
块上复现（列表项能切、普通段落不能，取决于那些副本的先后顺序）。正确顺序是：点击时的那个
遮罩元素还在文档里就用它解析，它被思源重建掉之后才退回按块 ID 与答案文本重找，并且逐个同 ID
元素试到能算出键的那一个。一级还必须校验锚点仍属于这个 root（`target.root.contains(anchor)`）：
块被移到另一个编辑器时锚点依然 `isConnected`，只查它就等于把记录写进旧 root，新 root 的下一次
回放读到空记录，会把刚点亮的遮罩又清掉——看着就是「亮一下又灭」。

**边界**：位置级认的是「同一个位置上还是同一个遮罩」，它认不出「删掉一个遮罩、又在同一
位置挖空一段相似文本」——两者在 DOM 上完全同形。⇧⌘C 路径靠 `forgetBlockOrder` 丢掉基线兜住；
不经 ⇧⌘C 而在同一帧内完成「删除 + 新建」的操作（例如整块粘贴覆盖）仍可能让新遮罩被点亮。
同文本的两个遮罩之间也无法区分左右，属键机制的固有代价。

**仍未覆盖**：`src/index.ts` 的 `initClickToggle` 捕获阶段接管与 `commitToggle` 的 DOM 重定位接线、
`MutationObserver` 的同步回放调度、`destroy-protyle` 事件接线，以及表格单元格编辑态下的块重建行为
——这些都需要真实思源运行时，只能手工验收。
`tableCell.test.mjs` 覆盖 `src/tableCell.ts` 的纯函数层（形态判定、可见文本偏移往返），
但退避流程本身（派发 pointerdown → 触发 finish → 重建选区 → 重执行）仍需真实内核验证。

## 夹具从哪来

`tests/fixtures.mjs` 里每个 `dom` 都是**真实内核往返后的渲染结果**，不是手搓的。
复现方式（内核 SiYuan 3.8.6，探针工作区 `/tmp/cloze-probe-ws`，端口 6806）：

```bash
# 1) 起内核
cd <siyuan>/resources && ELECTRON_DISABLE_SANDBOX=1 ./kernel/SiYuan-Kernel serve \
  -w /tmp/cloze-probe-ws --port 6806 --wd <siyuan>/resources

# 2) 以「编辑器 DOM」形态插入一个段落
curl -s http://127.0.0.1:6806/api/block/insertBlock -X POST \
  -H 'Content-Type: application/json' -d '{
    "dataType": "dom",
    "data": "<div data-node-id=\"20261013230000-fixture\" data-type=\"NodeParagraph\" class=\"p\"><div contenteditable=\"true\" spellcheck=\"false\">…</div><div class=\"protyle-attr\" contenteditable=\"false\">\u200b</div></div>",
    "parentID": "<某个文档的 id>"
  }'

# 3) 读回渲染 DOM（这就是夹具）
curl -s http://127.0.0.1:6806/api/block/getBlockDOM -X POST \
  -H 'Content-Type: application/json' -d '{"id":"<上一步返回的 id>"}'
```

必须走内核而不能手写的原因：**kbd 切片之间到底有没有普通空格，取决于 Lute 的
AutoSpace 选项**。`render/protyle_renderer.go` 的 `renderTextMark` 在离场分支里会写

```go
if parse.ContainTextMark(node, "code", "inline-math", "kbd") {
    if r.Options.AutoSpace {
        if firstc, _ := utf8.DecodeRuneInString(node.NextNodeText()); unicode.IsLetter(firstc) || unicode.IsDigit(firstc) {
            r.WriteByte(lex.ItemSpace)
        }
    }
}
```

也就是说，若 AutoSpace 打开，紧跟行内公式之后、以字母/汉字开头的那个切片前面会被塞进
一个**真实空格**，此时「切片间隙」与「两次独立划选之间的间隙」在 DOM 上完全同形，
纯 DOM 判据就失效了。

实测结论：**Protyle 渲染路径上 AutoSpace 是关闭的**——`protyle.go:285` 与 `protyle.go:1037`
都显式 `options.AutoSpace = false`。内核往返实测（第三个切片以汉字「为」开头，必然命中
上面那个分支）得到的间隙仍只有 `U+200B`，可佐证：

```
<kbd>(</kbd><kbd>$f(x)$</kbd>\u200b<kbd>为多项式)</kbd>
  → \u200b<span data-type="kbd">\u2060(</span>\u200b<span data-type="kbd inline-math" …>…</span>\u200b<span data-type="kbd">\u2060为多项式)</span>\u200b
```

于是判据成立：

| 情形 | 切片之间的节点 | 判定 |
| --- | --- | --- |
| 同一次挖空被行内公式切成多片 | 只有 `U+200B` | 同一集群，桥接 |
| 两次独立划选（源里有空格） | `U+200B` + 空格 + `U+200B` | 两个集群，断簇 |

## 回归清单

| 场景 | 期望 | 改前（错误） |
| --- | --- | --- |
| `[公式] [公式]` | `(公式) (公式)` | `(公式 公式)` |
| `[文本] [公式]` | `(文本) (公式)` | `(文本 公式)` |
| `[公式 文本 公式]` | `(公式 文本 公式)` | 同左（不受影响） |
| `[公式文本 公式]` | `(公式 文本 公式)` | 同左（不受影响） |
| `[1] [2]` | `(1) (2)` | `(1 2)` |
| `[1]      [2]` | `(1)      (2)` | `(1       2)` |
