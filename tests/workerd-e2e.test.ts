import { buildSync } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { parseSseEvents } from '../src/web/stream'

function sseChunk(text: string, finishReason?: string): Uint8Array {
  const payload = { candidates: [{ content: { parts: [{ text }] }, finishReason }] }
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}

it('streams article with 4D parsed constraints, checkpoints chapters early, and serves cached on-demand 5W1H from DO context', async () => {
  const script = buildSync({
    entryPoints: ['src/worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    external: ['cloudflare:sockets'],
  }).outputFiles[0].text

  const videoId = 'AbC123deF45'
  const transcriptText = 'Mark discussed consumer AI pricing at $200/month and enterprise token billing.'
  let youtubeCalls = 0
  let geminiIntentCalls = 0
  let geminiSummaryCalls = 0
  let releaseSecondChapter!: () => void
  const holdSecondChapter = new Promise<void>(resolve => {
    releaseSecondChapter = resolve
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

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      cf: false,
      compatibilityDate: '2026-06-01',
      modules: true,
      script,
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
          generationConfig?: { responseSchema?: { required?: string[] } }
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
                        constraints: ['聚焦定价策略', '分为两章'],
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
              await holdSecondChapter
              controller.enqueue(sseChunk('\n**Mark:** 未来十年单位算力成本将持续塌陷。', 'STOP'))
              controller.close()
            },
          })
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
        }

        // 3. On-demand 5W1H summary call
        geminiSummaryCalls++
        expect(userPayload.fullTranscript).toContain(transcriptText)
        expect(userPayload.fullArticle).toContain('定价模式')
        const isCh1 = userPayload.targetChapter.id === 'ch-1'
        const reply = isCh1 ? expectedSummary1 : expectedSummary2
        return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] }, finishReason: 'STOP' }],
        })
      },
    }),
  )

  try {
    // Health check
    const healthRes = await mf.dispatchFetch('https://example.test/api/health')
    expect(healthRes.status).toBe(200)
    expect(await healthRes.json()).toEqual({ ok: true, hasGeminiKey: true, proxyCount: 0 })

    // Start article SSE generation
    const res = await mf.dispatchFetch('https://example.test/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `https://youtu.be/${videoId}`,
        requirements: '面向产品经理写一份精炼克制的商业简报，聚焦定价策略，分为两章。',
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
      constraints: ['聚焦定价策略', '分为两章'],
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

    // Request ch-1 5W1H WHILE ch-2 is still streaming!
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

    // Release ch-2 and finish stream
    releaseSecondChapter()
    const rest = []
    for await (const ev of stream) rest.push(ev)
    expect(rest.some(e => e.type === 'chapter' && (e.data as { id: string }).id === 'ch-2')).toBe(true)
    expect(rest.at(-1)?.type).toBe('done')

    // Concurrent clicks on ch-2 deduplicate to 1 Gemini call
    const [rA, rB] = await Promise.all([
      mf.dispatchFetch(`https://example.test/api/articles/${articleId}/chapters/ch-2/summary`, { method: 'POST' }),
      mf.dispatchFetch(`https://example.test/api/articles/${articleId}/chapters/ch-2/summary`, { method: 'POST' }),
    ])
    expect(rA.status).toBe(200)
    expect(rB.status).toBe(200)
    expect(await rA.json()).toEqual(expectedSummary2)
    expect(await rB.json()).toEqual(expectedSummary2)

    expect(youtubeCalls).toBe(1)
    expect(geminiIntentCalls).toBe(1)
    expect(geminiSummaryCalls).toBe(2) // exactly 1 for ch-1 + 1 for ch-2

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

it('returns 422 NO_CAPTIONS without calling Gemini when video has no caption tracks', async () => {
  const script = buildSync({
    entryPoints: ['src/worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    external: ['cloudflare:sockets'],
  }).outputFiles[0].text

  let geminiCalls = 0
  const videoId = 'NoSub123456'
  const okNoTracks = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId, title: 'Music Only' } }

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      cf: false,
      compatibilityDate: '2026-06-01',
      modules: true,
      script,
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
