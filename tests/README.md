# 测试

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
npm test
pnpm test:browser
pnpm build
```

锁定依赖安装后，原版单测 140 项通过。保留簇边界、原生富文本、单元格偏移和揭晓回放用例；旧画法和按下拦截的断言已移除。

Chromium 使用真实 KaTeX 和截图像素验证：原版在该夹具上同行线差 2 CSS px、纯文字续行被裁掉、嵌套公式两边文字无线；两行纯文字对照正常。修复后四项均通过。

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
