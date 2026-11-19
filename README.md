# 声稿 · Dialogue Press

把一个公开的 YouTube 视频链接粘贴进写作台。服务端取得该视频的完整字幕后，Gemini 会流式写出中文分章文章。访谈保留实际的提问与回答，单人讲座和教程按讲解内容分节。每章写完即显示小结，同时在后台生成 **5W1H**，可点章节标题旁的按钮查看。[在线写作台](https://vedio2report.tf08202000.workers.dev) · [任务要求与验收记录](tasks/youtube-to-article.md)

可以先试 3Blue1Brown 的数学短片，也可以直接提交你要读的视频。写作要求留空时从头到尾整理，有特定用途时可以写「面向初学者，分两章解释视频里提出的问题，保留作者举的例子」。首页另有安德森访谈的预置排版样稿。[数学短片《The cube shadow puzzle》](https://youtu.be/U3O1nzSojnc) · [向量课实际生成的两章问答](tasks/vectors-reader-questions.md) · [访谈排版参考](https://msgeanzs2xvq.sg.larksuite.com/docx/IfDxduc1HoUr3Gx81Bul14CLgog)

## 1. 如何获取和处理 YouTube 字幕

点击「开始生成」后，网页先通过 `POST /api/captions` 提交链接。服务端解析单个视频 ID，支持观看页、短链、Shorts、直播回放和嵌入链接。同一视频的并发请求共用一个下载任务。网页收到 HTTP 202 时显示下载状态，通过 `GET /api/captions/{videoId}` 查询。服务端确认已保存完整、非空字幕后，网页才提交文章请求。[字幕检查](src/worker/captions.ts) · [下载任务与缓存](src/worker/caption-cache.ts)

| 字幕来源 | 何时使用及如何核对 |
| --- | --- |
| YouTube 字幕轨 | 普通视频优先读取公开播放页，核对播放器视频 ID，按人工字幕优先、语言偏好选择轨道。读取 JSON3，合并每条的文字片段、清理空白、保留时间。首选轨为空时继续检查同片其他有效轨道。 |
| 发布者公开字幕 | 碰到流量验证或临时读取故障时，按同一视频 ID 检索发布者目录。目前收录 143 个有英文 SRT 的 3Blue1Brown 视频。目录仅含 ID、标题和路径，下载任务核对发布者的 `video_url.txt` 后读取对应 SRT。页面给出原字幕链接。[发布者字幕库](https://github.com/3b1b/captions/tree/9aef876b0ed62ce4f099c0a2f0e7a52e8d1058c9) · [来源核对](src/worker/published-captions.ts) |
| 可选通用字幕服务 | 配置服务端 Secret `SUPADATA_API_KEY` 后，普通链接在直接读取失败且没有对应发布者记录时，也可通过 Supadata 查询同片现有字幕。请求指定 `mode=native`，异步响应按返回的任务 ID 查询，费用取决于供应商套餐。截至 2026 年 11 月 20 日，本仓库的公开部署尚未配置该密钥。[官方接口](https://docs.supadata.ai/get-transcript) · [实现](src/worker/native-captions.ts) |
| 固定演示存档 | 安德森访谈按精确 ID 使用打包字幕，W3C 无障碍短片在线获取失败时使用该片的官方文字稿。两份存档仅匹配各自的原片。[安德森访谈](https://youtu.be/xRh2sVcNXQ8) · [W3C 官方文字稿](https://www.w3.org/WAI/test-evaluate/#transcript) |

已下载的字幕按视频 ID 缓存 24 小时。播放器明确确认无公开字幕轨时返回 `NO_CAPTIONS`；遇到验证码且各可用来源都无法提供同片字幕时，页面提示暂时无法确认。登录受限和临时网络故障也有相应提示。字幕准备失败时生成流程即结束。[字幕解析与大小限制](src/worker/caption-source.ts)

安德森演示存档记录了原片时长 **1:21:18**、2,801 条英文字幕及末条终点 **1:21:06**。`npm ci` 从固定版本下载并校验文件摘要、视频 ID、条数和首尾时间，再将发布者的 12 个话题与字幕位置对齐。W3C 文字稿来自 W3C Web Accessibility Initiative (WAI), Education and Outreach Working Group，授权为 CC BY 4.0，仅收录口述内容。[存档准备脚本](scripts/prepare-captions.mjs) · [W3C 授权](https://creativecommons.org/licenses/by/4.0/)

## 2. 如何调用 Gemini 并实现流式输出

Worker 调用 Gemini 的 `streamGenerateContent?alt=sse`，默认模型为 `gemini-3.1-flash-lite`，可通过服务端变量 `GEMINI_MODEL` 更换。浏览器用一条 POST 响应流读取正文。服务端逐个解码 UTF-8 和 SSE 帧，以 `delta` 发送新片段，页面在下一次绘制时更新文字。章节正文和章末小结来自同一次调用。服务端保存完整章节，发出 `chapter` 事件并安排后台总结，最后用 `done` 标记全文完成。读者停止生成或连接中断时，已写好的章节仍可阅读。[Gemini 客户端](src/worker/gemini.ts) · [浏览器渲染](src/web/main.ts)

未填写写作要求时，分章取决于字幕材料。带有完整发布者目录的视频按目录顺序逐章生成。普通长片如有至少三个可靠时间锚点、字幕跨度至少 15 分钟，服务端从实际时间锚点选择约 10 分钟或更长的区间，并把不足 3 分钟的尾段合入前章。每章可带前段末尾最多 8 条、480 个字符的字幕，用于理解跨章的追问和代词。其余视频通过一次全文流按话题整理。章节标题只使用来源中可核对的时间；无时间码的文字稿按主题展示。

## 3. 自然语言要求如何影响文章

「写作要求」选填，最多 2,000 个字符。填写后，服务端在一次主文章调用中分别提供完整字幕和读者要求，使模型可以跨全片选择符合范围的内容。例如，「写给新手，只解释作者给出的第一种方法，用两章教程，每章保留一个原文例子」同时限定了受众、任务、篇幅和材料范围。字幕未提供的例子或事实保留空缺。

系统提示要求模型依据发言组织文章。访谈保留可以在原片找到的提问、回答和追问；讲座保留讲者的论证，教程保留操作顺序。无法确认姓名时使用中性称呼。片头如果只有摘录发言，直接整理这段发言。服务端检查主标题、章节、非空正文和章末小结，再开放章节 5W1H。[写作提示](src/worker/gemini.ts) · [文章结构校验](src/worker/protocol.ts)

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
- **控制输入成本。** 主文章和总结均使用字幕文本。长片分段时由单次请求处理当前区间，可带少量前文承接句意。普通小结与该章正文共享一次生成调用。后台总结读取完整字幕与已经保存的文章，以保留跨章节语境。逐章预计算会为没有被打开的章节消耗模型配额，换来读者点开已就绪结果时只需读取缓存。若模型返回英文解释，翻译时仅提交六个结果字段。
- **读者能看到的流式输出。** 公网验收使用真实 Chrome，输入视频并点击生成。脚本在 HTTP 响应结束前测量屏幕上的段落是否在不同绘制帧中多次增长。章节完成后，先保持面板关闭，确认后台已保存首章结果，再点开对照六项内容。[浏览器验收脚本](scripts/verify-deployment.mjs)
- **上下文有期限。** 每篇文章保留 24 小时，Durable Object alarm 到期清理，读取时也检查有效期。按 IP 限制每分钟 6 次文章生成请求，各 Cloudflare 节点独立计数。章节结果查询使用只读接口。
- **长视频保留完整性。** 普通视频的字幕正文以 UTF-8 字节数计量，上限为 512 KB。超过上限会明确报错，避免用残缺字幕生成全文。前端通过 DOM 文本节点渲染模型输出，密钥由 Worker 管理。

## 运行、验证与部署

使用 Node.js 22.12+ 和 npm。首次安装需要能访问 npm 和字幕存档所在的 GitHub Raw 主机。下载后的本地存档可重复使用。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 在 .dev.vars 填写 GEMINI_API_KEY
npm run dev
```

默认本地地址为 `http://localhost:8787`。本地可在同一份 `.dev.vars` 中配置可选的 `SUPADATA_API_KEY`。按以下顺序检查类型、运行测试、构建并模拟部署。[获取 Gemini API 密钥](https://aistudio.google.com/api-keys)

```sh
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

在 Cloudflare 启用账号的 workers.dev 子域，在 GitHub Actions 的仓库 secrets 中填写 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 和 `GEMINI_API_KEY`，如需启用 Supadata，再配置可选 Secret `SUPADATA_API_KEY`。运行 **Deploy Worker**。工作流会先测试和构建，再发布 Worker、绑定加密密钥并执行公网验收。运行摘要记录首屏正文出现时间、可见增长次数和全文耗时。默认验收会生成一篇限定主题的文章，每个已完成章节会自动消耗一次后台总结调用，必要时另有纯文本翻译。[部署工作流](.github/workflows/deploy.yml) · [Worker 配置](wrangler.jsonc)

已有部署可使用 Node.js 24 和本机 Chrome 复验。使用 Chromium 时，令 `CHROME_PATH` 指向可执行文件。通过 `--url` 指定要测的链接，`--default` 让写作要求留空，默认没有该标志时要求两章问答。

```sh
node scripts/verify-deployment.mjs https://vedio2report.tf08202000.workers.dev \
  --url https://youtu.be/U3O1nzSojnc --default
```

脚本核对实际视频 ID、正文在响应结束前的可见增长、章末小结和 5W1H。测试某条特定字幕路径时，可添加 `--expect-source published-captions`、`--expect-source youtube` 或 `--expect-source native-api`。使用 `--full` 可额外核对发布者目录的话题覆盖。若要复验字幕错误分支，传入相应链接并使用 `--default --expect-caption-error`，脚本会检查页面显示原因且文章请求数为零。[公网验收脚本](scripts/verify-deployment.mjs)
