import type { ArticleMeta, ParsedRequirements, Summary5W1H } from '../shared/types'
import type { VideoTranscript } from './captions'
import {
  parseUserRequirements,
  streamArticle,
  summarizeAllChapters5W1H,
  summarizeChapter5W1H,
} from './gemini'
import {
  ApiError,
  chapterHeadings,
  extractChapters,
  failure,
  hasParsedRequirements,
  json,
  type Bindings,
  type Chapter,
} from './protocol'

const SESSION_TTL_MS = 24 * 60 * 60_000
const PREWARM_DELAY_MS = 50
const MAX_BATCH_PREWARM_CHAPTERS = 40
const encoder = new TextEncoder()

interface StoredSession {
  videoId: string
  videoTitle: string
  requirements: string
  parsedRequirements?: ParsedRequirements
  prewarmPending?: boolean
  expiresAt: number
}

type SseEvent = [event: string, data: unknown]

function sseResponse(events: AsyncGenerator<SseEvent>, controller: AbortController): Response {
  const body = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const { value, done } = await events.next()
        if (controller.signal.aborted) return
        if (done) {
          output.close()
          return
        }
        const frame = `event: ${value[0]}\ndata: ${JSON.stringify(value[1])}\n\n`
        output.enqueue(encoder.encode(frame))
      } catch (error) {
        if (controller.signal.aborted) return
        const message = error instanceof ApiError ? error.message : '生成中断，请稍后重试。'
        output.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`))
        output.close()
      }
    },
    async cancel() {
      controller.abort()
      await events.return(undefined)
    },
  })

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * Per-article Durable Object:
 * 1. Persists full video transcript, generated article, and chapter boundaries server-side.
 * 2. Streams the main article via SSE while incrementally checkpointing completed chapters.
 * 3. Pre-warms all remaining chapter 5W1H summaries in one background batch call via alarm()
 *    after article completion, while keeping immediate on-demand generation & dedup fallback.
 */
export class ArticleSession {
  private readonly inflightSummaries = new Map<string, Promise<Summary5W1H>>()
  private activePrewarm?: {
    promise: Promise<Record<string, Summary5W1H>>
    chapterIds: ReadonlySet<string>
  }

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Bindings,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname
      if (path === '/generate' && request.method === 'POST') {
        const payload = (await request.json()) as { transcript: VideoTranscript; requirements: string }
        const controller = new AbortController()
        const events = this.generateStream(payload.transcript, payload.requirements, controller.signal)
        return sseResponse(events, controller)
      }

      const summaryMatch = /^\/summary\/(ch-[1-9]\d{0,3})$/.exec(path)
      if (summaryMatch) {
        return await this.handleSummary(summaryMatch[1], request.signal)
      }

      throw new ApiError(404, '未找到该会话接口。')
    } catch (error) {
      return failure(error)
    }
  }

  private async *generateStream(
    transcript: VideoTranscript,
    requirements: string,
    signal: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    const articleId = this.state.id.toString()
    const expiresAt = Date.now() + SESSION_TTL_MS

    const meta: ArticleMeta = {
      articleId,
      videoId: transcript.videoId,
      title: transcript.title,
      source: transcript.source,
      language: transcript.language,
      cueCount: transcript.cueCount,
      durationSeconds: transcript.durationSeconds,
      lastCaptionSeconds: transcript.lastCaptionSeconds,
      timeline: transcript.timeline,
    }
    yield ['meta', meta]

    // Persist full video context immediately so subsequent 5W1H requests always have full grounding.
    const session: StoredSession = {
      videoId: transcript.videoId,
      videoTitle: transcript.title,
      requirements,
      expiresAt,
    }
    await this.state.storage.put({
      session,
      transcript: transcript.text,
      article: '',
      chapters: [] as Chapter[],
    })
    await this.state.storage.setAlarm(expiresAt)

    // Step 1 (Option A): Parse optional natural-language requirements into the 4 bounded dimensions.
    let parsedRequirements: ParsedRequirements = { constraints: [] }
    if (requirements.trim()) {
      parsedRequirements = await parseUserRequirements(this.env, requirements, signal)
      if (hasParsedRequirements(parsedRequirements)) {
        session.parsedRequirements = parsedRequirements
        await this.state.storage.put('session', session)
        yield ['constraints', parsedRequirements]
      }
    }

    // Step 2: Stream main article Markdown from Gemini and checkpoint completed chapters on the fly.
    let article = ''
    let emittedChapters = 0
    let scannedUpTo = 0

    for await (const delta of streamArticle(this.env, transcript, requirements, parsedRequirements, signal)) {
      article += delta
      yield ['delta', { text: delta }]

      // Check only complete lines so partial headings split across chunks are never misread.
      const lastNewline = article.lastIndexOf('\n')
      if (lastNewline < scannedUpTo) continue
      const completePrefix = article.slice(0, lastNewline + 1)
      scannedUpTo = lastNewline + 1

      const headings = chapterHeadings(completePrefix)
      // Whenever N headings exist, the first N - 1 chapters are complete.
      const readyCount = headings.length - 1
      if (readyCount > emittedChapters) {
        const prefixUpToLastHeading = completePrefix.slice(0, headings[readyCount].index)
        const chapters = extractChapters(prefixUpToLastHeading)
        await this.state.storage.put({ article: prefixUpToLastHeading, chapters })
        for (let i = emittedChapters; i < chapters.length; i++) {
          yield ['chapter', { id: chapters[i].id, title: chapters[i].title }]
        }
        emittedChapters = chapters.length
      }
    }

    // Finalize full article and schedule one background batch 5W1H pre-warm via DO alarm().
    const finalChapters = extractChapters(article)
    if (!finalChapters.length) {
      throw new ApiError(502, '生成的文章未包含有效章节结构，请重试。')
    }
    session.prewarmPending = true
    await this.state.storage.put({ session, article, chapters: finalChapters })
    await this.state.storage.setAlarm(Date.now() + PREWARM_DELAY_MS)

    for (let i = emittedChapters; i < finalChapters.length; i++) {
      yield ['chapter', { id: finalChapters[i].id, title: finalChapters[i].title }]
    }

    yield ['done', { chapters: finalChapters.map(({ id, title }) => ({ id, title })) }]
  }

  private async handleSummary(chapterId: string, signal: AbortSignal): Promise<Response> {
    const cacheKey = `summary/${chapterId}`
    const prewarmBeforeRead = this.activePrewarm
    const stored = await this.state.storage.get(['session', 'transcript', 'article', 'chapters', cacheKey])
    const session = stored.get('session') as StoredSession | undefined

    if (!session || session.expiresAt <= Date.now()) {
      throw new ApiError(404, '文章会话不存在或已过期，请重新生成文章。', 'SESSION_EXPIRED')
    }

    const cached = stored.get(cacheKey) as Summary5W1H | undefined
    if (cached) {
      return json(cached, 200, { 'X-Summary-Cache': 'HIT' })
    }

    const chapters = (stored.get('chapters') as Chapter[] | undefined) ?? []
    const chapter = chapters.find(item => item.id === chapterId)
    if (!chapter) {
      throw new ApiError(404, '该章节尚未生成完成或不存在。', 'CHAPTER_NOT_FOUND')
    }

    // Piggyback on in-flight background batch pre-warm instead of firing a duplicate Gemini request.
    const prewarm = this.activePrewarm ?? prewarmBeforeRead
    if (prewarm?.chapterIds.has(chapterId)) {
      const batch = await raceAbort(prewarm.promise, signal)
      if (batch[chapterId]) {
        return json(batch[chapterId], 200, { 'X-Summary-Cache': 'HIT' })
      }
    }

    const transcriptText = (stored.get('transcript') as string | undefined) ?? ''
    const articleText = (stored.get('article') as string | undefined) ?? ''

    // Deduplicate concurrent clicks on the same chapter so Gemini is only called once.
    let pending = this.inflightSummaries.get(chapterId)
    if (!pending) {
      pending = (async () => {
        const result = await summarizeChapter5W1H(
          this.env,
          {
            videoTitle: session.videoTitle,
            transcriptText,
            articleText,
            chapter,
          },
          AbortSignal.timeout(60_000),
        )
        await this.state.storage.put(cacheKey, result)
        return result
      })().finally(() => {
        this.inflightSummaries.delete(chapterId)
      })
      this.inflightSummaries.set(chapterId, pending)
    }

    const summary = await raceAbort(pending, signal)
    return json(summary, 200, { 'X-Summary-Cache': 'MISS' })
  }

  async alarm(): Promise<void> {
    const session = await this.state.storage.get<StoredSession>('session')
    if (!session || session.expiresAt <= Date.now()) {
      await this.state.storage.deleteAll()
      return
    }

    if (!session.prewarmPending) {
      await this.state.storage.setAlarm(session.expiresAt)
      return
    }

    // Clear prewarmPending and restore 24h TTL cleanup alarm first so prewarm never retry-loops.
    session.prewarmPending = false
    await this.state.storage.put('session', session)
    await this.state.storage.setAlarm(session.expiresAt)

    const stored = await this.state.storage.get(['transcript', 'article', 'chapters'])
    const chapters = (stored.get('chapters') as Chapter[] | undefined) ?? []
    if (!chapters.length) return

    const existing = await this.state.storage.get(chapters.map(ch => `summary/${ch.id}`))
    const uncached = chapters
      .filter(ch => !existing.has(`summary/${ch.id}`) && !this.inflightSummaries.has(ch.id))
      .slice(0, MAX_BATCH_PREWARM_CHAPTERS)
    if (!uncached.length) return

    const transcriptText = (stored.get('transcript') as string | undefined) ?? ''
    const articleText = (stored.get('article') as string | undefined) ?? ''

    const chapterIds = new Set(uncached.map(ch => ch.id))
    const promise = (async (): Promise<Record<string, Summary5W1H>> => {
      try {
        const summaries = await summarizeAllChapters5W1H(
          this.env,
          {
            videoTitle: session.videoTitle,
            transcriptText,
            articleText,
            chapters: uncached,
          },
          AbortSignal.timeout(90_000),
        )
        const entries: Record<string, Summary5W1H> = {}
        for (const [id, summary] of Object.entries(summaries)) {
          entries[`summary/${id}`] = summary
        }
        if (Object.keys(entries).length > 0) {
          await this.state.storage.put(entries)
        }
        return summaries
      } catch {
        // Best-effort pre-warm: swallow failures so on-demand clicks still work cleanly.
        return {}
      }
    })().finally(() => {
      if (this.activePrewarm?.promise === promise) {
        this.activePrewarm = undefined
      }
    })

    this.activePrewarm = { promise, chapterIds }
    await promise
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      val => {
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
