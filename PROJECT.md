# Vedio2Report 项目目标

将有字幕的 YouTube 对话视频转为可阅读的中文分章文章。交付物为 GitHub 仓库、公开访问的 Cloudflare Worker 网址，以及说明实现与取舍的 README。

## 验收场景

1. 输入有字幕的 YouTube 链接并发起生成。应用获取并清洗字幕，向用户标明来源。为字幕获取受限的情况准备一份标明来源的固定示例。
2. 使用 Gemini AI Studio API 生成中文文章，按标题、章节和段落排版。生成过程中逐段或逐字渲染到网页，用户能在请求结束前阅读已输出的内容。
3. 支持可选的自然语言要求，让用户约束任务类型、写作风格、目标受众和内容范围。文章忠于字幕。
4. 每个章节标题旁提供 5W1H 按钮。点击后基于完整视频上下文和该章节生成 Who、What、When、Where、Why、How 六个字段，用统一格式展示。
5. 服务端保存本次生成的上下文。浏览器请求章节总结时只提供文章和章节标识。
6. 用 Node.js / TypeScript 开发和测试，在 Cloudflare Workers 上运行。保持模块边界清晰，凭据由服务端管理。
7. README 说明字幕处理、Gemini 流式输出、自然语言要求、章节总结、部署步骤和主要取舍。

## 演示参考

- [示例视频](https://www.youtube.com/watch?v=xRh2sVcNXQ8)
- [参考文章《对话安德森：AI革命的万亿美金之问》](https://msgeanzs2xvq.sg.larksuite.com/docx/IfDxduc1HoUr3Gx81Bul14CLgog)
