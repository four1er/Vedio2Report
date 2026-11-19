# 声稿 · Dialogue Press

粘贴一个有可读字幕的 YouTube 视频链接，写作台会把整场内容整理成可边生成边阅读的中文文章。访谈按话题分章，保留提问和第一人称回答。同一回答里，判断、依据和例子可以依次成段。读者在一个议题下读完这轮问答，转入另一项独立讨论时才需要新的小标题。讲座沿用讲者的论证顺序，教程保留操作和条件。每个章节写完后，后台就准备该章的 **5W1H**，点标题旁的按钮即可展开。[在线写作台](https://vedio2report.tf08202000.workers.dev) · [任务要求与验收记录](tasks/youtube-to-article.md)

写作要求留空即可生成整理稿。Gemini 可以删去口头禅、无信息的附和和同一句的反复起头，把同一人讲同一件事的几条字幕连成自然段。同一论点用了几个相似例子时，可以保留最能说明问题的一个。数字与单位、独立理由、反例、否定及「可能」「大概」等影响意思的措辞要保留。想看更贴近原话的版本，可填写「逐字转写」。首页的安德森节选用于对照排版，其他视频使用各自的字幕。[数学短片](https://youtu.be/U3O1nzSojnc) · [访谈参考稿](https://msgeanzs2xvq.sg.larksuite.com/docx/IfDxduc1HoUr3Gx81Bul14CLgog)

## 1. 如何获取和处理 YouTube 字幕

点击「开始生成」后，网页先通过 `POST /api/captions` 提交链接。服务端解析单个视频 ID，支持观看页、短链、Shorts、直播回放和嵌入链接。同一视频的并发请求共用一个下载任务。网页收到 HTTP 202 时显示下载状态，通过 `GET /api/captions/{videoId}` 查询。服务端确认已保存完整、非空字幕后，网页才提交文章请求。[字幕检查](src/worker/captions.ts) · [下载任务与缓存](src/worker/caption-cache.ts)

| 字幕来源 | 何时使用及如何核对 |
| --- | --- |
| YouTube 字幕轨 | 普通视频优先读取公开播放页，核对播放器视频 ID，按人工字幕优先、语言偏好选择轨道。读取 JSON3，合并每条的文字片段、清理空白、保留时间。首选轨为空时继续检查同片其他有效轨道。 |
| 发布者公开字幕 | 碰到流量验证或临时读取故障时，按同一视频 ID 检索发布者目录。目前收录 143 个有英文 SRT 的 3Blue1Brown 视频。目录仅含 ID、标题和路径，下载任务核对发布者的 `video_url.txt` 后读取对应 SRT。页面给出原字幕链接。[发布者字幕库](https://github.com/3b1b/captions/tree/9aef876b0ed62ce4f099c0a2f0e7a52e8d1058c9) · [来源核对](src/worker/published-captions.ts) |
| 可选通用字幕服务 | 配置服务端 Secret `SUPADATA_API_KEY` 后，普通链接在直接读取失败且没有对应发布者记录时，也可通过 Supadata 查询同片现有字幕。请求指定 `mode=native`，异步响应按返回的任务 ID 查询，费用取决于供应商套餐。截至 2026 年 11 月 20 日，本仓库的公开部署尚未配置该密钥。[官方接口](https://docs.supadata.ai/get-transcript) · [实现](src/worker/native-captions.ts) |
| 固定演示存档 | 安德森访谈按精确 ID 使用打包字幕，W3C 无障碍短片在线获取失败时使用该片的官方文字稿。两份存档仅匹配各自的原片。[安德森访谈](https://youtu.be/xRh2sVcNXQ8) · [W3C 官方文字稿](https://www.w3.org/WAI/test-evaluate/#transcript) |

已下载的字幕按视频 ID 缓存 24 小时。播放器明确确认无公开字幕轨时返回 `NO_CAPTIONS`。遇到验证码且各可用来源都无法提供同片字幕时，页面提示暂时无法确认。登录受限和临时网络故障也有相应提示。字幕准备失败时生成流程即结束。[字幕解析与大小限制](src/worker/caption-source.ts)

安德森演示存档记录了原片时长 **1:21:18**、2,801 条英文字幕及末条终点 **1:21:06**。`npm ci` 从固定版本下载并校验文件摘要、视频 ID、条数和首尾时间，再将发布者的 12 个话题与字幕位置对齐。W3C 文字稿来自 W3C Web Accessibility Initiative (WAI), Education and Outreach Working Group，授权为 CC BY 4.0，仅收录口述内容。[存档准备脚本](scripts/prepare-captions.mjs) · [W3C 授权](https://creativecommons.org/licenses/by/4.0/)

## 2. 如何调用 Gemini 并实现流式输出

服务端先为连续的字幕片段分配顺序编号，保留每段原文和起止字幕行。带发布者目录的长片可沿用原章节和跳转时间。时间点落在发言中间时，正文就近从换人处或句子开头分章。普通长片使用可靠的字幕时间锚点，无时间码的长文字稿按连续材料分章。主文章每次向 Gemini 提交一批字幕文本，以及衔接当前发言所需的前文。[字幕分段](src/worker/transcript-plan.ts)

Worker 调用 Gemini 的 `streamGenerateContent?alt=sse`，默认模型为 `gemini-3.1-flash-lite`，可用服务端变量 `GEMINI_MODEL` 更换。在默认整理模式，模型可将几段相邻字幕整理为一条带来源编号范围的记录。收到完整记录后，服务端校验其范围和次序，用 `delta` 事件把成稿段落发给浏览器。纯填充语可以只推进字幕处理进度。读者在后续批次生成期间，就能读到已经写好的问答。[生成与续写](src/worker/gemini.ts) · [整理规则](src/worker/edited-response.ts) · [浏览器渲染](src/web/main.ts)

漏段、乱序或响应提前中断时，服务端从首个未确认的字幕编号有限重试。全部源片段处理完毕并保存章节后才发出 `done`。进度数字用于核对全片材料是否处理到了结尾。检查成稿质量时还要对照原片，看合并后的段落有没有漏掉理由、例子或说话人的保留意见。

## 3. 自然语言要求如何影响文章

「写作要求」选填，最多 2,000 个字符。服务端识别任务类型与范围，再把风格、受众和其他约束连同材料提交给模型。[要求识别](src/worker/transcript-intent.ts) · [写作提示](src/worker/gemini.ts)

| 填写的要求 | 用户读到的文章 |
| --- | --- |
| 留空，或「面向初学者，分两章，保留原例」 | 根据全片字幕生成整理稿。保留有内容的问答或讲解，让同一回答里的几个论点各自成段。 |
| 「逐字转写，保留重复和插话」 | 进入逐字模式，逐段转写字幕，保留说话时的反复起头、强调和插话。 |
| 「只讨论产品定价，为产品经理写一份三百字简报」 | 按用户限定的话题选材，遵循受众、形式和篇幅要求。 |

例如，受访者先答「大概不会去火星」，再解释自己不愿搬离加州、也许愿意通过 VR 体验。整理后的回答应保留他的倾向、理由和例外。单纯附和可以略去，另一人表达相反意愿则应另起一轮。片头只有嘉宾陈述时，可用一个议题小标题帮助读者进入内容。真实问题可以顺句，署名须有字幕依据，未知身份使用中性称呼。[参考片的编辑尺度](tasks/youtube-to-article.md#演示参考)

## 4. 如何实现章节级 5W1H 总结

每篇文章使用独立的 Cloudflare Durable Object 保存本次完整字幕、已完成的正文和章节任务。服务端在一个正文章节完成后，将这一章和待执行的总结任务一起持久化。后台依据整片字幕、已保存的文章和该章节生成六项结果。后续章节继续生成，读者可以随时展开已写完章节的 5W1H。

点击按钮只读取这一章的状态或结果，请求不带字幕、文章或章节文本。

```http
GET /api/articles/{articleId}/chapters/{chapterId}/summary
```

准备就绪时返回 HTTP 200 和 `who`、`what`、`when`、`where`、`why`、`how` 六个字符串。任务排队或运行中时返回 HTTP 202 和 `Retry-After`。若模型答复截断或缺少字段，后台会退避重试，最多执行三轮任务，对象重启后也能继续。字幕未交代的事项标为「本章未提及」。[任务调度与缓存](src/worker/session.ts)

面板展开期间，遇到网络中断或临时网关错误会自动重连，只读取该章的状态。若服务商限额导致较长等待，面板会按读者的本地时间显示下一次查询时间。收起面板即停止轮询，再次打开已读章节直接显示六项。后台已终止的任务返回 `SUMMARY_FAILED`，页面仍保留章节正文。旧文章缺少预生成结果或已过保存期限时，页面说明需要重新生成文章。[读取与重连](src/web/summary.ts) · [总结面板](src/web/reader.ts)

## 5. 主要工程取舍与亮点

- **边读边查。** Otter 会按话题更新 Outline，Google Meet 支持查看“截至目前的摘要”。在这里，读者先看到逐段到达的正文，点开某一章才会在面板看到后台准备的六项总结。复制正文会保留章节、小标题和对话段落。[Otter 官方说明](https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview) · [Google Meet 官方说明](https://support.google.com/meet/answer/14754931?hl=en)
- **模型成本与等待时间。** 主文章按批次发送字幕以控制单次输出长度，逐章 5W1H 则读取完整字幕以理解跨章背景。按议题整理可减少口头重复的输出，同时仍然需要读取全片材料。后台预计算也会为没有被点开的章节消耗配额，结果就绪后，读者展开面板只需读取缓存。
- **核对读者实际看到的内容。** 浏览器验收检查正文在 HTTP 响应结束前的可见增长、已处理的字幕范围和各章的 5W1H。长片还可对照开场、中段、收尾的具体发言，检查论据与最后一轮对话是否保留。[浏览器验收脚本](scripts/verify-deployment.mjs)
- **长文存储。** 服务端接受最多 512 KB 的 UTF-8 字幕，超限会明确提示。长正文按块持久化，每章完成时连同总结队列一起提交。文章与总结保存 24 小时，到期由 Durable Object 清理。按 IP 限制每分钟六次文章生成请求，各 Cloudflare 节点独立计数。[文章会话](src/worker/session.ts)

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

在 Cloudflare 启用账号的 workers.dev 子域，在 GitHub Actions 的仓库 secrets 中填写 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 和 `GEMINI_API_KEY`，如需启用 Supadata，再配置可选 Secret `SUPADATA_API_KEY`。运行 **Deploy Worker**。工作流会先测试和构建，再发布 Worker、绑定加密密钥并执行公网验收。运行摘要记录首屏正文出现时间、可见增长次数和全文耗时。默认验收生成一篇整理稿，后台另为每个有正文的章节调用模型生成 5W1H。[部署工作流](.github/workflows/deploy.yml) · [Worker 配置](wrangler.jsonc)

已有部署可使用 Node.js 24 和本机 Chrome 复验。使用 Chromium 时，令 `CHROME_PATH` 指向可执行文件。通过 `--url` 指定要测的链接，默认留空写作要求。用 `--verbatim` 可验收显式逐字转写，用 `--adapted` 验收指定范围的改写。

```sh
node scripts/verify-deployment.mjs https://vedio2report.tf08202000.workers.dev \
  --url https://youtu.be/U3O1nzSojnc
```

脚本核对实际视频 ID、正文在响应结束前的可见增长、字幕处理进度和章节 5W1H。测试某条特定字幕路径时，可添加 `--expect-source published-captions`、`--expect-source youtube` 或 `--expect-source native-api`。对于有发布者目录的视频，`--full` 还会核对被保留章节的时间链接与原目录的对应关系。若要复验字幕错误分支，传入相应链接并使用 `--expect-caption-error`，脚本会检查页面显示原因且文章请求数为零。[公网验收脚本](scripts/verify-deployment.mjs)
