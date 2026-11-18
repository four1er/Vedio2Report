# 声稿 · Dialogue Press

把 YouTube 公开视频中的对话整理成分章中文文章。应用优先读取字幕，字幕不可用时可以让 Gemini 直接读取原视频。读者可以限定写作风格、受众、任务和篇幅，在生成过程中阅读正文，再点击章节标题旁的 **5W1H** 展开总结。

[打开声稿写作台](https://vedio2report.tf08202000.workers.dev) · [GitHub 仓库](https://github.com/four1er/Vedio2Report)

点击「填入示例链接」会填入马克·安德森访谈。可在「写作要求」中填写「用两章介绍受访者对 AI 商业化的判断，区分他的观察与预测」，再点「开始生成」。首页另有「阅读示例」，可直接体验预置文章与六项总结。[安德森访谈原视频](https://www.youtube.com/watch?v=xRh2sVcNXQ8) · [项目验收目标](PROJECT.md)

## 本地运行

使用 Node.js 22.12+（项目在 Node.js 24 验证）和 npm。在项目根目录运行：

```sh
npm ci
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填写 GEMINI_API_KEY
npm run dev
```

Wrangler 启动本地 Worker，默认端口为 8787。修改前端时，可在第二个终端运行 `npm run build -- --watch`。密钥仅在 Worker 使用；免费额度及可选模型以自己的 AI Studio 项目为准。[获取 Gemini API 密钥](https://aistudio.google.com/api-keys)

## 从 GitHub 发布到 Cloudflare

1. 在 Cloudflare 的 Workers & Pages 中启用账号的 `workers.dev` 子域，记下 Account ID，并创建限定到目标账号、能够编辑 Workers 的 API Token。
2. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中新增三个 repository secrets：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`GEMINI_API_KEY`。最后一项使用 AI Studio 签发的实际密钥。
3. 在 **Actions → Deploy Worker → Run workflow** 选择 `main`。验收默认使用安德森访谈，也可在 `video_id` 填入其他公开视频的 11 位 ID。工作流先测试和构建，再将静态网页、Worker 和 Gemini secret 一并部署。部署后工作流打开 Wrangler 返回的公网地址，用所选视频生成一篇中文文章，再请求首章 5W1H。成功后对应运行的 Summary 中会显示公开网址、内容来源、首个正文片段耗时和增量事件数。验收会使用部署端的 Gemini 配额。[部署工作流](.github/workflows/deploy.yml)

Wrangler 配置包含 SQLite Durable Object 的首次迁移、静态资源绑定和限流绑定。后续发布使用同一 Worker 名称。可在配置的 `vars` 中设置 `GEMINI_MODEL` 以固定账号支持的模型。[Worker 配置](wrangler.jsonc)

## 实现

| 环节 | 做法 |
| --- | --- |
| 获取字幕 | 从 YouTube 播放页数据读取字幕轨道，优先选人工字幕，同类轨道优先中文、其次英文。请求 JSON3 格式，依序合并文本并清理空白。播放页和字幕请求均限制域名、大小和等待时间。 |
| 写作要求 | 将内容来源与用户要求分别发送给 Gemini。系统提示规定中文标题、章节与事实归属，读者可以指定任务、风格、受众及范围。 |
| 实时阅读 | Worker 调用 Gemini 的 `streamGenerateContent?alt=sse`。字幕模式默认使用 `gemini-flash-lite-latest`，原视频模式使用 `gemini-3.1-flash-lite`。后端增量解码 UTF-8 与 SSE，前端按帧渲染标题和段落。流中断时保留已收到的正文。 |
| 章节总结 | 每篇文章使用独立 Durable Object 保存字幕或原视频 ID、写作要求和全文。点击 5W1H 后，浏览器只用文章和章节 ID 发起空正文 POST。服务端把相同的字幕或完整视频连同文章、目标章节发给 Gemini，校验并缓存六项结果。 |
| 生命周期 | 上下文有效期为 24 小时，通过 Durable Object alarm 清理，读取时也校验过期时间。相同章节的并发请求合并。生成与总结共享按 IP 的 Cloudflare 限流，每分钟 6 次；限额在各 Cloudflare 节点独立计数。 |

### 字幕受限时的行为

- **W3C 官方字幕存档**。W3C 视频的线上字幕读取失败时，使用 *Evaluating Web Accessibility: Resources Overview* 的官方英文逐字稿，保留口述文本并省略视觉描述和时间轴。作者为 W3C Web Accessibility Initiative (WAI), Education and Outreach Working Group。文章由本项目独立生成。[原始字幕和授权说明](https://www.w3.org/WAI/test-evaluate/#transcript) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **安德森访谈及其他公开视频**。字幕接口不可读或完整字幕超过 100 KB 时，Worker 把用户提交的视频 ID 转成标准 YouTube 地址，通过 Gemini 的 `fileData.fileUri` 附上整段视频。为适应长访谈，画面每 10 秒采样一帧，音频覆盖全片。服务端检查 Gemini 返回的影音输入用量，确认读取到媒体后才显示正文。页面将来源标为「YouTube 原视频（Gemini 影音输入）」。
- **耗时与配额**。读取长视频通常比处理字幕更慢，也消耗更多输入 token。原视频模式首次请求每章总结时会再次读取视频，已缓存的章节可直接重开。如果模型返回英文解释，服务端会额外发送一次纯文本翻译请求。视频须可供 Gemini 播放，私有视频或地区限制可能导致读取失败。

## 验证

```sh
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

测试覆盖字幕轨道选择、原视频回退、Gemini 影音用量校验、跨网络块的中文字符、增量输出、生成中断、仅凭 ID 总结和缓存命中。运行时集成测试启动真实 workerd 与 SQLite Durable Object，上游 YouTube 和 Gemini 使用可控响应。

2026-11-19 使用安德森访谈 `xRh2sVcNXQ8` 完成公网验收。此次走原视频模式，从提交到收到首个正文片段用时 13.1 秒，全文用时 18.7 秒，共 16 个增量事件。随后仅用文章和章节 ID 请求首章总结，六项均有内容，What、Why、How 返回中文解释。

在项目根目录使用 Node.js 24 可复验当前部署。脚本会生成一篇新文章并请求首章总结，使用部署端的 Gemini 配额。

```sh
node scripts/verify-deployment.mjs https://vedio2report.tf08202000.workers.dev
```
