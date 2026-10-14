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
| `helpers.mjs` | 共用件：jsdom 装配与块包装（不以 `.test.mjs` 结尾，不会被当用例执行） |

`cluster.test.mjs` 用 jsdom 建真实 DOM，直接调用 `src/cluster.ts` 里的集群算法。
每个夹具跑两遍：生产口径（`isClozeBridge`）必须得到 `expect`，旧口径（含 `\s` 的
`INVISIBLE_TEXT`，即改前的缺陷版本）必须得到 `wrong`——后者保证这个测试真的能抓到
「两次划选被并成一个遮罩」这个缺陷，而不是永远绿。

尚未覆盖：`src/index.ts` 里的 ⌥Q 创建/取消管道、单元格退避流程（`retreatFromCellEditor`）
与显晓类施加——它们依赖 `protyle.toolbar` 与真实单元格编辑器，必须在真实编辑器里才跑得起来；
`index.scss` 的遮蔽视觉也没有断言。
`anchor.test.mjs` 末尾的契约用例只锁住类名与选择器这两个跨文件常量。
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
