# 声稿 · Dialogue Press

输入有字幕的 YouTube 视频链接，按需填写写作要求，就能在浏览器里边生成、边读分章中文文章。每章末尾自动出现简短小结。章节写完后，即可点击标题旁的 **5W1H**，同时继续阅读后续章节。[在线写作台](https://vedio2report.tf08202000.workers.dev) · [作业要求与验收记录](tasks/youtube-to-article.md)

**试用安德森访谈**　点击「填入示例链接」，将写作要求留空，再点「开始生成」，可按原片顺序读完整场访谈。也可填写「写给刚入行的产品经理，只讨论 AI 产品定价，分两章写成问答」，把阅读范围收窄到一个议题。首页的「阅读样稿」可直接查看一篇预置的排版样稿。也可以直接阅读公网验收时实际生成的完整纪要。[访谈原视频](https://www.youtube.com/watch?v=xRh2sVcNXQ8) · [12 章实际成稿](tasks/andreessen-full-interview.md)

## 1. 如何获取和处理 YouTube 字幕

Worker 将 watch、短链、shorts、embed 或 live 链接解析成视频 ID，并检验域名及 ID。普通视频从播放页提取与 ID 匹配的字幕轨道，优先人工字幕，再按中文、英文、其他语言排序。随后读取 YouTube 的 JSON3 字幕，依次拼接片段、清理空白并保留文本顺序。实时提取限制请求耗时、响应大小和清洗后的文本大小。无法取得字幕且没有匹配存档时，页面提示更换视频，并结束该请求。[字幕处理代码](src/worker/captions.ts)

**指定示例有随 Worker 发布的字幕。** 安德森访谈 `xRh2sVcNXQ8` 的原片时长为 **1 小时 21 分 18 秒**。2,801 条英文字幕从 00:00:00 开始，末条止于 01:21:06。页面分别标注原片时长与字幕覆盖终点。展开「原片时间线」可查看发布者给出的 12 个话题，点时间即可回到原片对应位置。首次 `npm ci` 从固定版本下载并校验 SHA-256、视频 ID、条数和首尾时间，保存完整文本，以及发布者话题对应的字幕位置。构建将文本嵌入 Worker。此后输入同一视频 ID 会直接读取这份存档，文章和章节总结均只向 Gemini 提交文本。页面显示「YouTube 英文字幕存档」。[下载用的固定版本](https://github.com/ledeeden/yt-subtitle-fetcher/blob/af5881fc6d633c7a08ab760af0fd2cafbe1e8b9a/data/a16z/Marc%20Andreessen%27s%202026%20Outlook_%20AI%20Timelines%2C%20US%20vs.%20China%2C%20and%20The%20Price%20of%20AI%20%28xRh2sVcNXQ8%29.md) · [准备脚本](scripts/prepare-captions.mjs)

W3C 短片 `C4GIqWeywiI` 优先取在线字幕，失败时使用该片的官方英文逐字稿，保留口述内容，省略视觉描述和时间轴。作者为 W3C Web Accessibility Initiative (WAI), Education and Outreach Working Group，授权为 CC BY 4.0。两份存档各自匹配自己的视频 ID。[W3C 原稿](https://www.w3.org/WAI/test-evaluate/#transcript) · [授权](https://creativecommons.org/licenses/by/4.0/)

## 2. 如何调用 Gemini 并实现流式输出

Worker 在服务端调用 Gemini REST 的 `streamGenerateContent?alt=sse`，默认固定为 `gemini-3.1-flash-lite`，可通过服务端变量 `GEMINI_MODEL` 更换。它增量解码 UTF-8 字节和 SSE 帧，把每个正文片段立即作为 `delta` 发送给浏览器。页面用 `fetch` 读取 POST 响应流，把片段接到已有 Markdown 上，在下一次浏览器绘制时更新标题、段落和强调文字。阅读区在提交时预留一屏空间并滚动到屏幕顶部，第一段到达后就能看见。网页只建立一条主文章响应流。对于写作要求留空的示例访谈，服务端依次读取发布者的 12 个话题区间，每次只将当前区间的字幕交给 Gemini。每章的正文和小结来自同一次调用，正文到达就显示。服务端确认一章已经结束、保存好上下文后发送 `chapter` 事件，开启这章的 5W1H。最后用 `done` 通知全文完成。Gemini 在本章首次显示文字前限流或暂时失联时，服务端会有限重试。停止生成或流中断时，页面保留已经收到的正文和原片时间线，已写完的章节仍可展开 5W1H。[Gemini 客户端](src/worker/gemini.ts) · [浏览器渲染流程](src/web/main.ts)

## 3. 自然语言要求如何影响文章

「写作要求」选填，支持 2,000 个字符。读者填写要求时，服务端在一次文章生成调用中分别提交完整字幕和读者原话，让模型能在全片范围内选择相关发言。系统提示把事实来源限定在字幕内，并要求模型按读者指定的任务、风格、受众和范围写作。未填写时按原片时间顺序整理。示例访谈逐个处理带时间码的话题，确保覆盖开场、中段和收尾。没有发布者话题目录的视频由模型结合完整字幕分章。有可信时间锚点的章节可以点回原片核对。字幕没有交代的事实保留不确定性。

例如，上面的试用要求指定了读者是产品经理，形式是两章问答，范围是 AI 产品定价。发布验收使用这类要求，检查文章实际包含两个章节、问和答，以及定价话题。服务端检查主标题、章节标题、非空正文与章末小结，写完的章节才会开放 5W1H。其他开放式写作要求由模型执行。[写作提示](src/worker/gemini.ts) · [文章结构校验](src/worker/protocol.ts)

## 4. 如何实现章节级 5W1H 总结

每次生成分配一个 Cloudflare Durable Object。逐话题写作时，服务端在本章模型调用正常结束后确认该章。使用一次调用写多章时，下一章标题标志着上一章结束，最后一章以模型正常结束为准。已完成章节按序分配 ID，服务端保存本次完整字幕、写作要求与已写完的文章内容。前端立即开放对应标题旁的 5W1H 按钮。点击后发送以下请求，请求体为空。

```http
POST /api/articles/{articleId}/chapters/{chapterId}/summary
```

服务端用两个 ID 找回该次生成的上下文，定位目标章节，将完整视频字幕、此时已保存的文章内容和该章一并发给 Gemini。全文生成完成后，新请求可使用最终文章。返回值为包含 `who`、`what`、`when`、`where`、`why`、`how` 六个字符串的 JSON。页面按固定顺序展示。字幕未交代的事项标为「本章未提及」。只在用户点开时生成，同章并发请求合并，结果在服务端缓存。[上下文与缓存](src/worker/session.ts) · [按钮和字段渲染](src/web/reader.ts)

## 5. 主要工程取舍与亮点

- **会议笔记的交互。** Otter 在录制过程中按主题更新 Outline，Google Meet 提供“截至目前的摘要”。本项目把这种交互用于已有字幕的录像，按原片时间组织发言与话题，边写正文边给阶段小结。资料已经齐全，生成按模型实际响应速度进行。每个 5W1H 由读者决定是否展开。[Otter 官方说明](https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview) · [Google Meet 官方说明](https://support.google.com/meet/answer/14754931?hl=en)
- **控制输入成本。** 主文章和总结均使用字幕文本。全场模式用多次短请求换取可核对的话题覆盖，每段字幕只出现在所属章节的主文输入里。普通小结与该章正文共享一次生成调用。首次点击某章 5W1H 时发送完整字幕和已保存的文章，以保留跨章节语境。再次打开同一章使用缓存。若模型返回英文解释，翻译时仅提交六个结果字段。
- **读者能看到的流式输出。** 公网验收使用真实 Chrome，输入视频、点击生成，并在后续章节还在写作时点开首章总结。它测量 HTTP 响应结束前，屏幕可见段落是否在不同绘制帧中多次增长，同时验证总结请求体为空、返回数据与页面六项一致。[浏览器验收脚本](scripts/verify-deployment.mjs)
- **上下文有期限。** 每篇文章保留 24 小时，Durable Object alarm 到期清理，读取时也检查有效期。按 IP 限制每分钟 6 次生成或总结请求，各 Cloudflare 节点独立计数。
- **长视频保留完整性。** 普通视频清洗后的字幕超过 100 KB 时会提示更换，指定示例使用已校验的完整存档。前端通过 DOM 文本节点渲染模型输出，密钥由 Worker 管理。

## 运行、验证与部署

使用 Node.js 22.12+ 和 npm。首次安装需要能访问 npm 和字幕存档所在的 GitHub Raw 主机。下载后的本地存档可重复使用。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 在 .dev.vars 填写 GEMINI_API_KEY
npm run dev
```

默认本地地址为 `http://localhost:8787`。本地按以下顺序检查类型、运行测试、构建并模拟部署。[获取 Gemini API 密钥](https://aistudio.google.com/api-keys)

```sh
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

在 Cloudflare 启用账号的 workers.dev 子域，在 GitHub Actions 的仓库 secrets 中填写 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 和 `GEMINI_API_KEY`，运行 **Deploy Worker**。工作流会先测试和构建，再发布 Worker、绑定加密密钥并执行公网验收。运行摘要记录首屏正文出现时间、可见增长次数和全文耗时。默认验收会生成一次限定主题的文章并请求一次首章总结，必要时另有一次纯文本翻译。[部署工作流](.github/workflows/deploy.yml) · [Worker 配置](wrangler.jsonc)

已有部署可使用 Node.js 24 和本机 Chrome 复验。若安装的是 Chromium，可用 `CHROME_PATH` 指向可执行文件。

```sh
node scripts/verify-deployment.mjs https://vedio2report.tf08202000.workers.dev
```

默认验收还会检验读者指定的两章问答。添加 `--full` 可复验不限定主题的完整访谈，逐一检查 12 章是否与发布者时间表对应、每章是否有小结。完整验收会对每个话题生成一次主文，并主动展开一次首章 5W1H。
