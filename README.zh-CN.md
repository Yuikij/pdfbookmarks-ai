# PDFBookmarks AI 本地 PDF 书签与目录

用 Agent 给扫描书、教材和长报告加多级书签或可打印、可点击的目录页。Agent 可以看原始目录页图、识别标题层级和印刷页码。MCP 负责按物理页校准、另存和逐条验证跳转。

[官网](https://pdfbookmarks.com/zh/ai-tools) · [下载安装](https://github.com/Yuikij/pdfbookmarks-ai/releases/latest) · [英文安装说明与配置](README.md)

```sh
npx skills add Yuikij/pdfbookmarks-ai --skill pdf-bookmarks
```

将 [扫描样例](examples/scanned-contents.pdf) 放进 MCP 配置中允许访问的文件夹。可以对 Agent 说：

> 用 PDFBookmarks 给 scanned-contents.pdf 补多级书签和可点击目录页。先看原来的扫描目录，核对第一章和最后一章的落点，保留中文标题，再另存。

[示例成品](examples/with-bookmarks.pdf) 有 6 个书签和 6 个目录链接。印刷第 1 页是原 PDF 物理第 3 页，前面插入 1 页目录后在输出 PDF 的第 4 页。

MCP 在用户设备处理 PDF。连接云端模型的客户端可能会把工具返回的部分正文或页图传给模型。生成的 PDF 需要新文件名。安装和工具参数见 [README](README.md)。
