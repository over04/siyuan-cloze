# 测试

## 运行测试

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test
pnpm test:browser
pnpm exec tsc --noEmit
pnpm build
```

单元测试检查挖空范围、文字样式、表格内的选区，以及编辑后能否正确恢复答案的显示状态。浏览器还会检查普通单元格、富文本单元格和单元格内跨段落的挖空。打包测试在临时目录中检查两件事：安装包只包含本次生成的文件，打包失败时保留上一次生成的安装包。打包需要 `zip`，检查安装包需要 `unzip`。

浏览器测试使用 KaTeX 渲染公式，再用截图检查虚线的位置。测试还覆盖鼠标拖选、触摸轻点和编辑器替换内容块后的挖空状态。保存笔记后重新打开、撤销编辑等行为，需要在思源里另行测试。

## 测试数据的来源

[测试数据](fixtures.mjs)中的 `dom` 字段保存了思源 3.8.6 返回的编辑器 HTML。要重新生成这些数据，先启动思源内核，使用独立的测试工作区。以下命令里的资源目录请替换成实际路径。

```bash
SIYUAN_RESOURCES='/Applications/SiYuan.app/Contents/Resources'
WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/siyuan-cloze-test.XXXXXX")"
"$SIYUAN_RESOURCES/kernel/SiYuan-Kernel" serve \
  -w "$WORKSPACE" --port 6806 --wd "$SIYUAN_RESOURCES"
```

在测试工作区中创建一篇文档。用下面的请求向文档插入测试段落，再读取思源生成的 HTML。

```bash
# 将 parentID 替换成测试文档的 ID，将省略号替换成待测试的内容。
curl -s http://127.0.0.1:6806/api/block/insertBlock -X POST \
  -H 'Content-Type: application/json' -d '{
    "dataType": "dom",
    "data": "<div data-node-id=\"20261013230000-cloze01\" data-type=\"NodeParagraph\" class=\"p\"><div contenteditable=\"true\" spellcheck=\"false\">…</div><div class=\"protyle-attr\" contenteditable=\"false\">\u200b</div></div>",
    "parentID": "<测试文档的 ID>"
  }'

# 将 id 替换成上一步返回的内容块 ID。
curl -s http://127.0.0.1:6806/api/block/getBlockDOM -X POST \
  -H 'Content-Type: application/json' -d '{"id":"<内容块的 ID>"}'
```

## 公式旁的空格

Lute 的 `AutoSpace` 选项开启时，可能会在行内公式和后面的文字之间添加普通空格。在思源 3.8.6 的编辑器中，这个选项关闭。用上面的步骤测试 `f(x)` 后紧跟「为多项式」的情况，公式与文字之间只出现了零宽空格 `U+200B`。

插件据此区分两种情况：同一次挖空中的公式和文字之间只有零宽空格时，一起显示；两处挖空之间保留普通空格时，分别显示。

## 应当通过的场景

| 选中的内容 | 预期结果 |
| --- | --- |
| 分别选中两个公式，中间留空格 | 两处公式分别显示 |
| 分别选中文字和公式，中间留空格 | 文字和公式分别显示 |
| 一次选中两个公式及中间的文字 | 整段一起显示 |
| 一次选中相邻的公式和文字 | 公式和文字一起显示 |
| 分别选中两个数字，中间留一个或多个空格 | 两个数字分别显示 |
