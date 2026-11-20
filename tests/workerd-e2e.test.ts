import { buildSync } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { parseSseEvents } from '../src/web/stream'

const WORKER_SCRIPT = buildSync({
  entryPoints: ['src/worker/index.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
  external: ['cloudflare:sockets'],
}).outputFiles[0].text

function sseChunk(text: string, finishReason?: string): Uint8Array {
  const payload = { candidates: [{ content: { parts: [{ text }] }, finishReason }] }
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}

it('streams article with 4D constraints, supports mid-stream 5W1H, and batch pre-warms remaining chapters via DO alarm', async () => {
  const videoId = 'AbC123deF45'
  const transcriptText = 'Mark discussed consumer AI pricing at $200/month, GPU cost curves, and Mars colonization.'
  let youtubeCalls = 0
  let geminiIntentCalls = 0
  let singleSummaryCalls = 0
  let batchSummaryCalls = 0
  let batchRequestedIds: string[] = []

  let releaseRestChapters!: () => void
  const holdRestChapters = new Promise<void>(resolve => {
    releaseRestChapters = resolve
  })

  let signalBatchStarted!: () => void
  const batchStarted = new Promise<void>(resolve => {
    signalBatchStarted = resolve
  })
  let releaseBatchResponse!: () => void
  const holdBatchResponse = new Promise<void>(resolve => {
    releaseBatchResponse = resolve
  })

  const expectedSummary1 = {
    who: 'Mark',
    what: 'AI 行业的消费端与企业端商业化定价方式。',
    when: '当前 AI 商业化早期。',
    where: '消费者 AI 与企业 AI 市场。',
    why: '高价值直接转化为客户付费意愿。',
    how: '通过订阅制与按需 Token 计费变现。',
  }
  const expectedSummary2 = {
    who: 'Mark',
    what: '未来算力供给改善带来的成本下降。',
    when: '未来十年。',
    where: '数据中心与云基础设施领域。',
    why: '短缺资源终将在高需求驱动下走向过剩。',
    how: '通过 GPU 供给扩张降低单位推理成本。',
  }
  const expectedSummary3 = {
    who: 'Mark',
    what: '人类借助 AI 与机器人走向火星殖民的愿景。',
    when: '长期未来。',
    where: '太空探索与火星基地。',
    why: '技术进步持续拓展人类生存边界。',
    how: '结合人形机器人与 AI 完成前期建设。',
  }

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      cf: false,
      compatibilityDate: '2026-06-01',
      modules: true,
      script: WORKER_SCRIPT,
      bindings: {
        GEMINI_API_KEY: 'test-key',
      },
      durableObjects: {
        ARTICLES: { className: 'ArticleSession', useSQLite: true },
        CAPTION_CACHE: { className: 'CaptionCache', useSQLite: true },
      },
      outboundService: async request => {
        const url = new URL(request.url)

        if (url.hostname === 'www.youtube.com' && url.pathname === '/youtubei/v1/player') {
          youtubeCalls++
          return Response.json({
            playabilityStatus: { status: 'OK' },
            videoDetails: { videoId, title: 'AI Economics Talk', lengthSeconds: '180' },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  { baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en' },
                ],
              },
            },
          })
        }

        if (url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext') {
          return Response.json({ events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: transcriptText }] }] })
        }

        expect(url.hostname).toBe('generativelanguage.googleapis.com')
        const body = (await request.json()) as {
          contents: Array<{ parts: Array<{ text: string }> }>
        }
        const userPayload = JSON.parse(body.contents[0].parts[0].text)

        // 1. Intent parsing call (Option A)
        if (url.pathname.endsWith(':generateContent') && 'userInput' in userPayload) {
          geminiIntentCalls++
          return Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        taskType: '商业简报',
                        outputStyle: '精炼克制',
                        targetAudience: '产品经理',
                        constraints: ['聚焦定价策略', '分为三章'],
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          })
        }

        // 2. Streaming main article call
        if (url.pathname.endsWith(':streamGenerateContent')) {
          expect(userPayload.user_requirements.structured.targetAudience).toBe('产品经理')
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                sseChunk(
                  '# AI 经济观察\n\n## 定价模式\n\n**Mark:** 消费端订阅与企业按需 Token 并行。\n\n## 成本曲线\n',
                ),
              )
              await holdRestChapters
              controller.enqueue(
                sseChunk(
                  '\n**Mark:** 未来十年单位算力成本将持续塌陷。\n\n## 火星愿景\n\n**Mark:** AI 与机器人将协助开拓火星。',
                  'STOP',
                ),
              )
              controller.close()
            },
          })
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
        }

        // 3. Background single-call batch 5W1H pre-warm via DO alarm()
        if ('targetChapters' in userPayload) {
          batchSummaryCalls++
          expect(userPayload.fullTranscript).toContain(transcriptText)
          expect(userPayload.fullArticle).toContain('火星愿景')
          batchRequestedIds = (userPayload.targetChapters as Array<{ id: string }>).map(ch => ch.id)
          signalBatchStarted()
          await holdBatchResponse
          return Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        summaries: [
                          { chapterId: 'ch-2', ...expectedSummary2 },
                          { chapterId: 'ch-3', ...expectedSummary3 },
                        ],
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          })
        }

        // 4. On-demand single-chapter 5W1H call
        singleSummaryCalls++
        expect(userPayload.fullTranscript).toContain(transcriptText)
        expect(userPayload.fullArticle).toContain('定价模式')
        expect(userPayload.targetChapter.id).toBe('ch-1')
        return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(expectedSummary1) }] }, finishReason: 'STOP' }],
        })
      },
    }),
  )

  try {
    const healthRes = await mf.dispatchFetch('https://example.test/api/health')
    expect(healthRes.status).toBe(200)
    expect(await healthRes.json()).toEqual({ ok: true, hasGeminiKey: true, proxyCount: 0 })

    // Start article SSE generation
    const res = await mf.dispatchFetch('https://example.test/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `https://youtu.be/${videoId}`,
        requirements: '面向产品经理写一份精炼克制的商业简报，聚焦定价策略，分为三章。',
      }),
    })
    expect(res.status).toBe(200)

    const stream = parseSseEvents(res)
    const metaEv = (await stream.next()).value!
    expect(metaEv.type).toBe('meta')
    const articleId = (metaEv.data as { articleId: string }).articleId

    const constraintsEv = (await stream.next()).value!
    expect(constraintsEv.type).toBe('constraints')
    expect(constraintsEv.data).toEqual({
      taskType: '商业简报',
      outputStyle: '精炼克制',
      targetAudience: '产品经理',
      constraints: ['聚焦定价策略', '分为三章'],
    })

    const delta1 = (await stream.next()).value!
    expect(delta1.type).toBe('delta')

    const ch1Ready = (await stream.next()).value!
    expect(ch1Ready).toEqual({ type: 'chapter', data: { id: 'ch-1', title: '定价模式' } })

    // Reject non-empty body on 5W1H endpoint (must not re-submit article text)
    const badSummary = await mf.dispatchFetch(
      `https://example.test/api/articles/${articleId}/chapters/ch-1/summary`,
      { method: 'POST', body: JSON.stringify({ article: 'should reject' }) },
    )
    expect(badSummary.status).toBe(400)

    // Request ch-1 5W1H WHILE ch-2 & ch-3 are still streaming!
    const sum1Miss = await mf.dispatchFetch(
      `https://example.test/api/articles/${articleId}/chapters/ch-1/summary`,
      { method: 'POST' },
    )
    expect(sum1Miss.status).toBe(200)
    expect(sum1Miss.headers.get('X-Summary-Cache')).toBe('MISS')
    expect(await sum1Miss.json()).toEqual(expectedSummary1)

    // Second request hits Durable Object storage cache
    const sum1Hit = await mf.dispatchFetch(
      `https://example.test/api/articles/${articleId}/chapters/ch-1/summary`,
      { method: 'POST' },
    )
    expect(sum1Hit.status).toBe(200)
    expect(sum1Hit.headers.get('X-Summary-Cache')).toBe('HIT')
    expect(await sum1Hit.json()).toEqual(expectedSummary1)

    // Finish streaming ch-2 & ch-3; DO alarm() schedules batch pre-warm 50ms later
    releaseRestChapters()
    const rest = []
    for await (const ev of stream) rest.push(ev)
    expect(rest.some(e => e.type === 'chapter' && (e.data as { id: string }).id === 'ch-2')).toBe(true)
    expect(rest.some(e => e.type === 'chapter' && (e.data as { id: string }).id === 'ch-3')).toBe(true)
    expect(rest.at(-1)?.type).toBe('done')

    // Wait for background DO alarm to start ONE batch call covering only uncached chapters (ch-2, ch-3)
    await batchStarted
    expect(batchRequestedIds).toEqual(['ch-2', 'ch-3'])

    // Click ch-2 WHILE batch pre-warm is still in flight -> piggybacks without extra Gemini call
    const ch2InflightPromise = mf.dispatchFetch(
      `https://example.test/api/articles/${articleId}/chapters/ch-2/summary`,
      { method: 'POST' },
    )
    releaseBatchResponse()

    const ch2Res = await ch2InflightPromise
    expect(ch2Res.status).toBe(200)
    expect(ch2Res.headers.get('X-Summary-Cache')).toBe('HIT')
    expect(await ch2Res.json()).toEqual(expectedSummary2)

    // Click ch-3 (never clicked before) -> instant DO storage cache HIT with 0 extra Gemini calls
    const ch3Res = await mf.dispatchFetch(
      `https://example.test/api/articles/${articleId}/chapters/ch-3/summary`,
      { method: 'POST' },
    )
    expect(ch3Res.status).toBe(200)
    expect(ch3Res.headers.get('X-Summary-Cache')).toBe('HIT')
    expect(await ch3Res.json()).toEqual(expectedSummary3)

    expect(youtubeCalls).toBe(1)
    expect(geminiIntentCalls).toBe(1)
    expect(singleSummaryCalls).toBe(1) // only mid-stream ch-1
    expect(batchSummaryCalls).toBe(1) // single batch pre-warm for ch-2 & ch-3

    // Second article generation for the same video hits CaptionCache DO (0 new YouTube calls)
    const res2 = await mf.dispatchFetch('https://example.test/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://youtu.be/${videoId}`, requirements: '' }),
    })
    expect(res2.status).toBe(200)
    await res2.body?.cancel()
    expect(youtubeCalls).toBe(1)
  } finally {
    await mf.dispose()
  }
})

it('falls back seamlessly to deduplicated on-demand 5W1H when background batch pre-warm fails', async () => {
  const videoId = 'Fallback123'
  let batchAttempts = 0
  let singleAttempts = 0
  let signalBatchDone!: () => void
  const batchDone = new Promise<void>(resolve => {
    signalBatchDone = resolve
  })

  const fallbackSummary = {
    who: '主讲人',
    what: '后台预热失败后自动降级为单章按需总结。',
    when: '当前阶段。',
    where: '服务端 Durable Object。',
    why: '保障配额受限时用户仍可按需获取总结。',
    how: '捕获批量预热异常并回退单章请求与并发去重。',
  }

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      cf: false,
      compatibilityDate: '2026-06-01',
      modules: true,
      script: WORKER_SCRIPT,
      bindings: { GEMINI_API_KEY: 'test-key' },
      durableObjects: {
        ARTICLES: { className: 'ArticleSession', useSQLite: true },
        CAPTION_CACHE: { className: 'CaptionCache', useSQLite: true },
      },
      outboundService: async request => {
        const url = new URL(request.url)
        if (url.hostname === 'www.youtube.com' && url.pathname === '/youtubei/v1/player') {
          return Response.json({
            playabilityStatus: { status: 'OK' },
            videoDetails: { videoId, title: 'Fallback Test', lengthSeconds: '90' },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  { baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en' },
                ],
              },
            },
          })
        }
        if (url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext') {
          return Response.json({ events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Fallback transcript.' }] }] })
        }
        if (url.pathname.endsWith(':streamGenerateContent')) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(sseChunk('# 降级测试\n\n## 第一章\n\n内容正文。', 'STOP'))
              controller.close()
            },
          })
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
        }

        const body = (await request.json()) as { contents: Array<{ parts: Array<{ text: string }> }> }
        const userPayload = JSON.parse(body.contents[0].parts[0].text)

        if ('targetChapters' in userPayload) {
          batchAttempts++
          signalBatchDone()
          return new Response(JSON.stringify({ error: { code: 429, message: 'quota' } }), { status: 429 })
        }

        singleAttempts++
        return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(fallbackSummary) }] }, finishReason: 'STOP' }],
        })
      },
    }),
  )

  try {
    const res = await mf.dispatchFetch('https://example.test/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://youtu.be/${videoId}`, requirements: '' }),
    })
    expect(res.status).toBe(200)

    let articleId = ''
    for await (const ev of parseSseEvents(res)) {
      if (ev.type === 'meta') articleId = (ev.data as { articleId: string }).articleId
    }
    expect(articleId).toMatch(/^[a-f0-9]{64}$/)

    // Wait for background batch pre-warm to fail with 429 (exactly 1 attempt, no retry loop)
    await batchDone
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(batchAttempts).toBe(1)

    // Concurrent user clicks fall back to on-demand single-chapter generation & deduplicate to 1 call
    const [rA, rB] = await Promise.all([
      mf.dispatchFetch(`https://example.test/api/articles/${articleId}/chapters/ch-1/summary`, { method: 'POST' }),
      mf.dispatchFetch(`https://example.test/api/articles/${articleId}/chapters/ch-1/summary`, { method: 'POST' }),
    ])
    expect(rA.status).toBe(200)
    expect(rB.status).toBe(200)
    expect(await rA.json()).toEqual(fallbackSummary)
    expect(await rB.json()).toEqual(fallbackSummary)
    expect(singleAttempts).toBe(1)
  } finally {
    await mf.dispose()
  }
})

it('returns 422 NO_CAPTIONS without calling Gemini when video has no caption tracks', async () => {
  let geminiCalls = 0
  const videoId = 'NoSub123456'
  const okNoTracks = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId, title: 'Music Only' } }

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      cf: false,
      compatibilityDate: '2026-06-01',
      modules: true,
      script: WORKER_SCRIPT,
      bindings: { GEMINI_API_KEY: 'test-key' },
      durableObjects: {
        ARTICLES: { className: 'ArticleSession', useSQLite: true },
        CAPTION_CACHE: { className: 'CaptionCache', useSQLite: true },
      },
      outboundService: async request => {
        const url = new URL(request.url)
        if (url.hostname === 'generativelanguage.googleapis.com') {
          geminiCalls++
          return new Response('should not be called', { status: 500 })
        }
        if (url.pathname === '/youtubei/v1/player') return Response.json(okNoTracks)
        return new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(okNoTracks)};</script>`)
      },
    }),
  )

  try {
    const res = await mf.dispatchFetch('https://example.test/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'NO_CAPTIONS' })
    expect(geminiCalls).toBe(0)
  } finally {
    await mf.dispose()
  }
})
