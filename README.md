# 声稿 · Dialogue Press

把有字幕的 YouTube 对话整理成分章中文文章。读者可以限定写作风格、受众、任务和篇幅，在 Gemini 写作时阅读正文，再点击章节标题旁的 **5W1H** 展开总结。

**试用素材**　点击「填入示例链接」选择 W3C 的无障碍评估短片，再点「开始生成」。例如，写作要求可填「写给第一次参与无障碍测试的产品经理，按评估时机和工具选择分为两章」。首页的「阅读示例」可直接体验预置文章与六项总结，无需 API 密钥。[W3C 示例视频](https://www.youtube.com/watch?v=C4GIqWeywiI) · [项目验收目标](PROJECT.md)

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
3. 在 **Actions → Deploy Worker → Run workflow** 选择 `main`。工作流先测试和构建，再将静态网页、Worker 和 Gemini secret 一并部署。部署步骤的 Wrangler 输出会给出该账号下的公开网址。[部署工作流](.github/workflows/deploy.yml)

Wrangler 配置包含 SQLite Durable Object 的首次迁移、静态资源绑定和限流绑定。后续发布使用同一 Worker 名称。可在配置的 `vars` 中设置 `GEMINI_MODEL` 以固定账号支持的模型。[Worker 配置](wrangler.jsonc)

## 实现

| 环节 | 做法 |
| --- | --- |
| 获取字幕 | 从 YouTube 播放页数据读取字幕轨道，优先选人工字幕，同类轨道优先中文、其次英文。请求 JSON3 格式，依序合并文本并清理空白。播放页和字幕请求均限制域名、大小和等待时间。 |
| 写作要求 | 将字幕、标题、来源与用户要求分别作为结构化输入发送。系统提示规定中文标题、章节与事实归属，读者可以在这些边界内指定任务、风格、受众及范围。 |
| 实时阅读 | Worker 直接调用 Gemini REST 的 `streamGenerateContent?alt=sse`，默认使用 `gemini-flash-lite-latest`。后端增量解码 UTF-8 与 SSE，随收到的内容向浏览器发出 `delta`。前端按帧渲染标题、段落和强调文字，使用 DOM 文本节点处理模型输出。流中断时保留已收到的正文。 |
| 章节总结 | 每篇文章分配独立 Durable Object。文章顺利完成后保存字幕、写作要求和全文，再返回章节 ID。点击按钮只发出含文章与章节 ID 的空正文 POST。服务端定位章节，连同全文和字幕请求 Gemini，校验六个 JSON 字段并缓存结果。 |
| 生命周期 | 上下文有效期为 24 小时，通过 Durable Object alarm 清理，读取时也校验过期时间。相同章节的并发请求合并。生成与总结共享按 IP 的 Cloudflare 限流，每分钟 6 次；限额在各 Cloudflare 节点独立计数。 |

### 字幕受限时的行为

- **W3C 官方字幕存档**。W3C 视频的线上字幕读取失败时，使用 *Evaluating Web Accessibility: Resources Overview* 的官方英文逐字稿，保留口述文本并省略视觉描述和时间轴。作者为 W3C Web Accessibility Initiative (WAI), Education and Outreach Working Group。文章由本项目独立生成。[原始字幕和授权说明](https://www.w3.org/WAI/test-evaluate/#transcript) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **安德森访谈示例**。题目中的视频优先尝试真实字幕。失败时使用根据题面编写的原创演示对话，页面显示「内置示例素材」，并将来源说明传给模型。首页的预置试读也单独标识。[参考视频](https://www.youtube.com/watch?v=xRh2sVcNXQ8)
- **其他视频**。遇到验证码、私有视频、无字幕或字幕不可读时，界面提示更换视频。当前实现直接使用 Worker 的 HTTPS fetch，省去额外代理服务。字幕文本上限为 100 KB，避免长视频被静默截断后生成一篇看似完整的文章。

## 验证

```sh
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

测试覆盖字幕轨道选择与回退、跨网络块的中文字符、文章未结束时的增量输出、生成中断、仅凭 ID 总结和缓存命中。运行时集成测试启动真实 workerd 与 SQLite Durable Object，上游 YouTube 和 Gemini 使用可控响应。真实 API 联调需要可用的 Gemini 密钥及网络。
