# 声稿 · Dialogue Press

输入任意公开且带字幕的 YouTube 视频链接，实时流式生成排版清晰的中文深度对话文章，支持自然语言写作要求约束与章节级 **5W1H** 结构化总结。

- **在线演示**：[https://vedio2report.tf08202000.workers.dev](https://vedio2report.tf08202000.workers.dev)
- **技术栈**：TypeScript · Vite（前端零框架原生 DOM）· Cloudflare Workers · Durable Objects（SQLite）· Gemini AI Studio API

---

## 模块结构

```text
src/
├── shared/types.ts          # 前后端共享协议类型（5W1H、四维度约束、SSE 元信息）
├── worker/
│   ├── index.ts             # HTTP 路由、同源校验、限流与 Durable Object 调度
│   ├── protocol.ts          # 错误封装、JSON/空请求体校验、章节边界解析
│   ├── tls13.ts             # 基于原生 WebCrypto 的纯 TS TLS 1.3 客户端（RFC 8446）
│   ├── proxy-http.ts        # Cloudflare TCP Socket + HTTP CONNECT 代理客户端与代理池解析
│   ├── captions.ts          # YouTube 字幕解析（Android Innertube + Watch Page + 硬编码兜底）
│   ├── caption-cache.ts     # CaptionCache Durable Object（24h 字幕缓存 + 并发去重）
│   ├── gemini.ts            # Gemini 调用：4D 意图解析 / 全局流式正文 / 章节 5W1H JSON
│   ├── session.ts           # ArticleSession Durable Object（上下文持久化 + 按需 5W1H 缓存）
│   └── archives/            # 构建期校验并准备的示例视频兜底字幕（xRh2sVcNXQ8）
└── web/
    ├── main.ts              # 表单交互、快捷要求预设、SSE 流式消费与约束标签渲染
    ├── reader.ts            # 纯 DOM 增量 Markdown 渲染器、动态章节目录与 5W1H 面板
    ├── stream.ts            # 浏览器端 SSE 解析器
    ├── sample.ts            # 参考排版样稿与 5W1H 示例
    └── style.css            # 编辑部暖纸排版样式
```

---

## 1. 如何获取和处理 YouTube 字幕

核心实现见 [`src/worker/captions.ts`](src/worker/captions.ts)、[`src/worker/proxy-http.ts`](src/worker/proxy-http.ts)、[`src/worker/tls13.ts`](src/worker/tls13.ts) 与 [`src/worker/caption-cache.ts`](src/worker/caption-cache.ts)。

1. **解决 Cloudflare Worker 访问 YouTube 验证码问题（TCP Socket + 代理池 + WebCrypto TLS 1.3）**：
   - Cloudflare Worker 的标准 `fetch()` 无法配置 HTTP 代理，直连 YouTube 常在数据中心 IP 上触发 `/sorry` 验证码或 `LOGIN_REQUIRED`。
   - 本项目通过环境变量 `PROXY_LIST` 接入 **webshare.io** 免费代理列表（兼容 `IP:PORT:USER:PASS` 与 `http://user:pass@host:port` 格式），每次请求随机轮换最多 3 个代理节点，通过 Cloudflare Workers 原生 **TCP Socket（`cloudflare:sockets` `connect()`）** 建立 `HTTP CONNECT` 隧道并附带 `Proxy-Authorization` 鉴权。
   - **生产级细节处理**：Cloudflare 边缘节点当前存在已知缺陷（`cloudflare/workerd#6903`），对 IP 连接调用 `socket.startTls({ expectedServerHostname })` 时会遗漏 TLS SNI，导致 HTTPS 代理隧道在本地 `wrangler dev` 正常但线上握手失败。为此，[`tls13.ts`](src/worker/tls13.ts) 基于 Workers 原生硬件加速的 `crypto.subtle`（ECDH P-256 + HKDF + AES-GCM）实现了零依赖的 **RFC 8446 TLS 1.3 客户端**，完整发送 `server_name`（SNI）扩展、校验服务端证书 SAN 主机名与 `CertificateVerify` 签名及 `Finished` MAC，在生产边缘稳定运行且 CPU 开销低于 1 ms。
2. **双路径提取与格式兼容**：
   - **主路径（轻量快速）**：优先依次调用 YouTube Android / iOS Innertube 接口（`POST /youtubei/v1/player`），体积极小且避免 Web 端 `timedtext` 需要 PO Token 返回空正文的问题；同时从 `shortDescription` 提取发布者时间轴章节提示。
   - **降级路径**：若无 Key 的 Innertube 被拦截或未返回轨道，自动回退拉取 Watch 页面提取 `INNERTUBE_API_KEY` 与 `ytInitialPlayerResponse`。
   - **字幕解析**：按「人工字幕优先、中文 > 英文 > 其他」择优选择轨道，优先解析 `json3`，空返回时自动降级解析 XML（`<text>` / `<p>`）并解码 HTML 实体，每 30 秒插入时间戳锚点并限制 512 KB 上限。
3. **缓存与兜底策略**：
   - 使用 [`CaptionCache`](src/worker/caption-cache.ts) Durable Object 按 `videoId` 缓存字幕 24 小时并对并发请求去重。
   - 若所有代理与直连均失败，针对示例视频 `xRh2sVcNXQ8` 自动降级使用内置校验字幕存档，保证演示零失败；若播放器确认视频本身无字幕轨，则直接返回 HTTP `422 NO_CAPTIONS`，不浪费 Gemini 额度。

---

## 2. 如何调用 Gemini 并实现流式输出

核心实现见 [`src/worker/gemini.ts`](src/worker/gemini.ts)、[`src/worker/session.ts`](src/worker/session.ts) 与 [`src/web/reader.ts`](src/web/reader.ts)。

- **单次全局上下文流式生成**：1 小时 20 分钟访谈的完整字幕仅约 2~3 万输入 token，远低于 Gemini 1M 上下文窗口；参考成稿约 8,400 字，亦远低于模型单次输出上限。因此直接将全片字幕与时间锚点一次传入 Gemini `streamGenerateContent?alt=sse`（默认模型 `gemini-3.1-flash-lite`，可通过 `GEMINI_MODEL` 覆盖），既保证了全片宏观分章质量，又将首字延迟压缩到 1~2 秒。
- **端到端 SSE 实时推送与可视化指标**：Worker 解析上游 SSE 帧后立即以 `event: delta` 转发至浏览器；前端通过 `requestAnimationFrame` 合并渲染，使用纯 DOM 节点增量对比更新（杜绝 `innerHTML` XSS 风险，同时保持已生成段落可选中、不闪烁），并实时显示首字耗时、已生成字数与章节目录；成稿后支持一键**复制 Markdown** 或**导出排版完整的独立 HTML**（含已展开的 5W1H 总结）。
- **流式章节 Checkpoint**：服务端实时扫描已抵达的完整行，每当新的 `## ` 章节标题出现，立即将上一已完成章节持久化到 Durable Object 并推送 `event: chapter`，读者在后续章节仍在流式生成时即可提前点击已完成章节的 `[5W1H]` 按钮。

---

## 3. 自然语言生成要求如何影响输出结果

核心实现见 [`src/worker/gemini.ts`](src/worker/gemini.ts) 中的 `parseUserRequirements` 与 `streamArticle`。

采用 **「结构化四维度意图解析 + 约束注入」** 两阶段策略：

1. **留空零开销**：用户未填写要求时直接跳过解析，零额外延迟与 token 消耗，输出还原参考稿水准的中文深度对话文章。
2. **四维度结构化提取**：用户填写自然语言要求后，先通过一次轻量的 Gemini Structured Output（`temperature: 0`，强制 JSON Schema）将自然语言归类到题目限定的 4 个维度：
   - `taskType`（任务类型）
   - `outputStyle`（输出风格）
   - `targetAudience`（目标受众）
   - `constraints`（约束条件数组）
   系统指令严格限定不脑补未提及的维度、忽略超出范围的注入指令；若解析调用偶发失败则优雅降级为直传原始要求。
3. **透明展示与强约束注入**：解析结果通过 `event: constraints` 实时推送并在文章顶部展示为「生效约束标签」，同时连同原始表述结构化注入主文章 Prompt，指导模型在保持 `# 标题` / `## 章节` 结构与字幕事实的前提下精准落地用户偏好。

---

## 4. 如何实现章节级 5W1H 总结

核心实现见 [`src/worker/session.ts`](src/worker/session.ts) 与 [`src/web/reader.ts`](src/web/reader.ts)。

- **服务端上下文持久化**：每次文章生成会创建独立的 SQLite Durable Object（`ArticleSession`），持久化保存完整视频字幕、已生成正文及分章列表（24 小时后由 `alarm()` 自动清理）。
- **严格零正文重传**：点击章节标题旁 `[5W1H]` 按钮时，前端仅发送空请求体调用：
  ```http
  POST /api/articles/{articleId}/chapters/{chapterId}/summary
  ```
  服务端通过 `requireEmptyBody()` 强制校验请求体为空，绝不由前端重新提交文章或字幕内容。
- **按需生成 + 并发去重 + 持久化缓存**：
  - 服务端优先读取 Durable Object 中的 `summary/{chapterId}` 缓存（命中返回 `X-Summary-Cache: HIT`）。
  - 未命中时，结合服务端保存的**完整视频字幕 + 完整文章 + 当前目标章节**调用 Gemini Structured Output（强制返回 `who` / `what` / `when` / `where` / `why` / `how` 六个非空字符串字段；未提及项标为「本章未提及」），写入持久化缓存后返回。
  - 内存 `inflightSummaries` Map 对同一章节的并发点击去重，避免重复扣减 API 配额。
- **固定格式渲染**：前端将返回 JSON 固定渲染为六行结构化卡片（Who / What / When / Where / Why / How），收起后再次展开直接复用已加载内容。

---

## 5. 主要工程取舍与亮点

| 维度 | 工程取舍与亮点 |
| --- | --- |
| **边缘代理可靠性** | 面对 Cloudflare Workers `fetch()` 不支持代理以及 `startTls()` 生产边缘缺失 SNI 的限制，自研 ~300 行纯 WebCrypto TLS 1.3 + HTTP CONNECT 传输层，零第三方加密大依赖、CPU 耗时 <1 ms，且通过真实 OpenSSL TLS 1.3 与 `workerd` 集成测试验证。 |
| **简洁架构 vs 过度设计** | 摒弃复杂的多轮分批 JSON 编号校验与脆弱正则分类，利用 Gemini 长上下文与原生流式 Markdown 直出，大幅精简代码并显著缩短长视频生成耗时，模块边界清晰易维护。 |
| **按需 5W1H vs 后台全量预计算** | 改为用户点击时按需生成 + Durable Object 持久缓存 + 并发去重：既不浪费 Gemini AI Studio 免费日配额，又能让用户任意优先点击靠后的章节立即出结果。 |
| **可解释的四维度要求解析** | 用结构化 Schema 将自由自然语言收敛到任务类型、输出风格、目标受众、约束条件四个可控维度，并在页面可视化展示生效约束，兼具工程可控性与产品体验。 |

---

## 本地开发、测试与部署

需要 Node.js 22.12+（推荐 24 LTS）。

```bash
npm ci
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填写 GEMINI_API_KEY，并可选填写 Webshare 代理列表 PROXY_LIST
npm run dev
```

运行类型检查、单元测试（含真实 TLS 1.3 代理与 `workerd` Durable Object 集成测试）与构建：

```bash
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

### Cloudflare Worker 部署

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中配置：
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `GEMINI_API_KEY`
- `PROXY_LIST`（推荐：直接粘贴 Webshare 导出的 10 行 `IP:PORT:USER:PASS` 代理列表）
- `GEMINI_MODEL`（可选，默认 `gemini-3.1-flash-lite`）

手动触发 GitHub Actions 中的 **Deploy Worker** 工作流即可完成构建、测试、发布与公网自动化验收；或使用本地脚本独立验收已部署站点：

```bash
node scripts/verify-deployment.mjs https://vedio2report.tf08202000.workers.dev
```
