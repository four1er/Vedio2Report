# 声稿 · Dialogue Press

输入有字幕的 YouTube 访谈链接，留空写作要求，就能边生成边读中文对谈。大章下按具体议题分小节，提问与回答各自署名，长回答保留自然段。每章末尾自动出现小结，服务端同时在后台准备本章的 **5W1H**。读者可用标题旁的按钮查看。[在线写作台](https://vedio2report.tf08202000.workers.dev) · [作业要求与验收记录](tasks/youtube-to-article.md)

**试用安德森访谈**　点击「填入示例链接」，将写作要求留空，再点「开始生成」，可按原片顺序读 Jen、John 与 Mark 的访谈。字幕或参考稿未能区分两位提问者时，使用「主持人」。也可填写「写给刚入行的产品经理，只讨论 AI 产品定价，分两章写成问答」，把阅读范围收窄到一个议题。首页的「阅读样稿」可直接查看一篇预置的排版样稿。也可以直接阅读公网验收时实际生成的完整访谈。[访谈原视频](https://www.youtube.com/watch?v=xRh2sVcNXQ8) · [12 章实际成稿](tasks/andreessen-full-interview.md)

## 1. 如何获取和处理 YouTube 字幕

用户点「开始生成」后，网页先通过 `POST /api/captions` 提交视频链接。字幕准备好，网页才发起文章生成。

1. **检查视频和已有字幕。** 解析 watch、短链、shorts、embed 或 live 链接，只接受合法的 YouTube 域名与视频 ID。按视频 ID 读取已下载的字幕或与该视频精确匹配的固定存档。
2. **确认字幕轨。** 首次访问普通视频时读取公开播放页。只跟随指向同一视频的 YouTube HTTPS 播放页跳转，最多三次。只有播放器可用、视频 ID 匹配、且确实没有字幕轨时才报告“没有字幕”。登录要求、同意设置、流量验证和暂时性网络故障分别报告。
3. **先下载，再写作。** 找到有效轨道后，按视频 ID 保存下载任务。页面收到 HTTP 202 时显示下载进度状态，通过 `GET /api/captions/{videoId}` 查询。后台按人工字幕、语言优先级读取 JSON3，首选轨为空或失败时尝试同视频的其他有效轨道。拼接字幕、清理空白、检查时间与大小后才保存非空正文。
4. **复用一次下载。** 同一视频的并发请求共用任务，完整在线字幕缓存 24 小时。下次命中可直接使用。字幕不可用时，页面显示具体原因，Gemini 不会收到文章或总结请求。[字幕检查与清洗](src/worker/captions.ts) · [字幕下载任务](src/worker/caption-cache.ts)

**指定示例有随 Worker 发布的字幕。** 安德森访谈 `xRh2sVcNXQ8` 的原片时长为 **1 小时 21 分 18 秒**。2,801 条英文字幕从 00:00:00 开始，末条止于 01:21:06。页面分别标注原片时长与字幕覆盖终点。展开「原片时间线」可查看发布者给出的 12 个话题，点时间即可回到原片对应位置。首次 `npm ci` 从固定版本下载并校验 SHA-256、视频 ID、条数和首尾时间，保存完整文本，以及发布者话题对应的字幕位置。构建将文本嵌入 Worker。此后输入同一视频 ID 会直接读取这份存档，文章和章节总结均只向 Gemini 提交文本。页面显示「YouTube 英文字幕存档」。[下载用的固定版本](https://github.com/ledeeden/yt-subtitle-fetcher/blob/af5881fc6d633c7a08ab760af0fd2cafbe1e8b9a/data/a16z/Marc%20Andreessen%27s%202026%20Outlook_%20AI%20Timelines%2C%20US%20vs.%20China%2C%20and%20The%20Price%20of%20AI%20%28xRh2sVcNXQ8%29.md) · [准备脚本](scripts/prepare-captions.mjs)

W3C 短片 `C4GIqWeywiI` 优先取在线字幕，失败时使用该片的官方英文逐字稿，保留口述内容，省略视觉描述和时间轴。作者为 W3C Web Accessibility Initiative (WAI), Education and Outreach Working Group，授权为 CC BY 4.0。两份存档各自匹配自己的视频 ID。[W3C 原稿](https://www.w3.org/WAI/test-evaluate/#transcript) · [授权](https://creativecommons.org/licenses/by/4.0/)

## 2. 如何调用 Gemini 并实现流式输出

Worker 在服务端调用 Gemini REST 的 `streamGenerateContent?alt=sse`，默认固定为 `gemini-3.1-flash-lite`，可通过服务端变量 `GEMINI_MODEL` 更换。它增量解码 UTF-8 字节和 SSE 帧，把每个正文片段立即作为 `delta` 发送给浏览器。页面用 `fetch` 读取 POST 响应流，把片段接到已有 Markdown 上，在下一次浏览器绘制时更新标题、段落和强调文字。阅读区在提交时预留一屏空间并滚动到屏幕顶部，第一段到达后就能看见。网页只建立一条主文章响应流。对于写作要求留空的示例访谈，服务端依次读取发布者的 12 个话题区间，每次只将当前区间的字幕交给 Gemini。每章的正文和小结来自同一次调用，正文到达就显示。服务端确认一章已经结束、保存好上下文后发送 `chapter` 事件，让页面显示本章的 5W1H 按钮，并将本章加入后台总结队列。最后用 `done` 通知全文完成。Gemini 在本章首次显示文字前限流或暂时失联时，服务端会有限重试。停止生成或流中断时，页面保留已经收到的正文和原片时间线，已写完的章节仍可展开 5W1H。[Gemini 客户端](src/worker/gemini.ts) · [浏览器渲染流程](src/web/main.ts)

普通访谈根据字幕中的换人和问答线索分段。示例片头剪入了后文的发言，片头的部分提问由编辑根据回答整理。文章会说明这一点。单人讲解保留讲解段落，无法辨认姓名的说话人使用中性标签。[作业参考排版](https://msgeanzs2xvq.sg.larksuite.com/docx/IfDxduc1HoUr3Gx81Bul14CLgog)

## 3. 自然语言要求如何影响文章

「写作要求」选填，支持 2,000 个字符。读者填写要求时，服务端在一次文章生成调用中分别提交完整字幕和读者原话，让模型能在全片范围内选择相关发言。系统提示把事实来源限定在字幕内，并要求模型按读者指定的任务、风格、受众和范围写作。未填写时按原片时间顺序整理。示例访谈逐个处理带时间码的话题，各章内保留具体问题、独立署名的答复和后续追问。没有发布者话题目录的视频由模型结合完整字幕分章。有可信时间锚点的章节可以点回原片核对。无时间码的逐字稿按话题分章，服务端会过滤模型在章节标题里补写的无依据时间。字幕没有交代的事实保留不确定性。

例如，上面的试用要求指定了读者是产品经理，形式是两章问答，范围是 AI 产品定价。发布验收使用这类要求，检查文章实际包含两个章节、问和答，以及定价话题。服务端检查主标题、章节标题、非空正文与章末小结，写完的章节才会开放 5W1H。其他开放式写作要求由模型执行。[写作提示](src/worker/gemini.ts) · [文章结构校验](src/worker/protocol.ts)

## 4. 如何实现章节级 5W1H 总结

每篇文章使用一个 Cloudflare Durable Object 保存完整字幕、已完成的文章和章节总结任务。章末小结到达后，服务端确认章节完整，把正文和该章的 5W1H 任务一起保存。后台根据完整视频和当前章节生成总结并缓存，即使页面上没人点击按钮也会执行，正文可继续输出。

点击按钮只读取这一章的状态或结果，请求不带字幕、文章或章节文本。

```http
GET /api/articles/{articleId}/chapters/{chapterId}/summary
```

准备就绪时返回 HTTP 200 和 `who`、`what`、`when`、`where`、`why`、`how` 六个字符串。任务排队或运行中时返回 HTTP 202 和 `Retry-After`。若模型答复截断或缺少字段，后台会退避重试，最多执行三轮任务，对象重启后也能继续。字幕未交代的事项标为「本章未提及」。[任务调度与缓存](src/worker/session.ts)

面板展开期间，遇到网络中断或临时网关错误会自动重连，只读取该章的状态。用户可以继续读正文，收起面板即停止轮询，再次打开已读章节直接显示六项。后台已终止的任务返回 `SUMMARY_FAILED`，页面提示读者查看章末小结。旧文章缺少预生成结果或已过保存期限时，页面说明需要重新生成文章。[读取与重连](src/web/summary.ts) · [总结面板](src/web/reader.ts)

## 5. 主要工程取舍与亮点

- **会议笔记的交互。** Otter 在录制过程中按主题更新 Outline，Google Meet 提供“截至目前的摘要”。本项目把这种交互用于已有字幕的录像，按原片时间组织发言与话题，边写正文边给阶段小结。资料已经齐全，生成按模型实际响应速度进行。每个 5W1H 在后台独立准备，读者决定是否展开。[Otter 官方说明](https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview) · [Google Meet 官方说明](https://support.google.com/meet/answer/14754931?hl=en)
- **控制输入成本。** 主文章和总结均使用字幕文本。全场模式用多次短请求换取可核对的话题覆盖，每段字幕只出现在所属章节的主文输入里。普通小结与该章正文共享一次生成调用。后台总结读取完整字幕与已经保存的文章，以保留跨章节语境。逐章预计算会为没有被打开的章节消耗模型配额，换来读者点开已就绪结果时只需读取缓存。若模型返回英文解释，翻译时仅提交六个结果字段。
- **读者能看到的流式输出。** 公网验收使用真实 Chrome，输入视频并点击生成。脚本在 HTTP 响应结束前测量屏幕上的段落是否在不同绘制帧中多次增长。章节完成后，先保持面板关闭，确认后台已保存首章结果，再点开对照六项内容。[浏览器验收脚本](scripts/verify-deployment.mjs)
- **上下文有期限。** 每篇文章保留 24 小时，Durable Object alarm 到期清理，读取时也检查有效期。按 IP 限制每分钟 6 次文章生成请求，各 Cloudflare 节点独立计数。章节结果查询使用只读接口。
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

在 Cloudflare 启用账号的 workers.dev 子域，在 GitHub Actions 的仓库 secrets 中填写 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 和 `GEMINI_API_KEY`，运行 **Deploy Worker**。工作流会先测试和构建，再发布 Worker、绑定加密密钥并执行公网验收。运行摘要记录首屏正文出现时间、可见增长次数和全文耗时。默认验收会生成一篇限定主题的文章，每个已完成章节会自动消耗一次后台总结调用，必要时另有纯文本翻译。[部署工作流](.github/workflows/deploy.yml) · [Worker 配置](wrangler.jsonc)

已有部署可使用 Node.js 24 和本机 Chrome 复验。若安装的是 Chromium，可用 `CHROME_PATH` 指向可执行文件。

```sh
node scripts/verify-deployment.mjs https://vedio2report.tf08202000.workers.dev
```

默认验收还会检验读者指定的两章问答。添加 `--full` 可复验不限定主题的完整访谈，逐一检查 12 章是否与发布者时间表对应、每章是否有小结。完整验收会逐话题生成主文，并验证默认的子标题、实际问答、收尾交流和后台 5W1H。对其他视频使用 `ACCEPTANCE_VIDEO_ID=<视频ID>` 和 `--default`，即可在该视频上以空写作要求复验。若要复验字幕错误分支，同时添加 `--expect-caption-error`，脚本会检查页面显示的错误，并确认文章请求数为零。
