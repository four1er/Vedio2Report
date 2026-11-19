import type { Video } from './captions'
import { preparedSource } from './caption-cache'
import { summarize, TransientError, writeArticle } from './gemini'
import { ApiError, chapterHeadings, extractChapters, failure, json, requireChapterRecap } from './protocol'
import type { Bindings, Summary, TranscriptCoverage } from './protocol'
import { requestsEditorialAdaptation } from './transcript-intent'

const lifetime = 24 * 60 * 60 * 1000
const encoder = new TextEncoder()
const summaryTimeout = 90_000
const maxAttempts = 3
// Each block fits comfortably inside a SQLite-backed Durable Object value even
// for multibyte text. Published blocks are immutable, so an alarm can read the
// snapshot named by its manifest while another chapter is being appended.
const blockSize = 64 * 1024
interface ArticleManifest {blocks: number; length: number}
type StoredArticle = string | ArticleManifest

async function saveArticle(tx: DurableObjectTransaction, article: string) {
  if (article.length <= blockSize) {
    await tx.put('article', article)
    return
  }
  const previous = await tx.get<StoredArticle>('article')
  const manifest = typeof previous === 'object' ? previous : {blocks: 0, length: 0}
  while (manifest.length < article.length) {
    let end = Math.min(manifest.length + blockSize, article.length)
    const last = article.charCodeAt(end - 1)
    if (end < article.length && last >= 0xd800 && last <= 0xdbff) end--
    await tx.put('article/' + manifest.blocks, article.slice(manifest.length, end))
    manifest.blocks++
    manifest.length = end
  }
  await tx.put('article', manifest)
}

async function readArticle(storage: DurableObjectStorage): Promise<string | undefined> {
  const stored = await storage.get<StoredArticle>('article')
  if (typeof stored !== 'object') return stored
  const blocks: string[] = []
  // Durable Objects permit up to 128 keys per get().
  for (let start = 0; start < stored.blocks; start += 128) {
    const keys = Array.from({length: Math.min(128, stored.blocks - start)}, (_, i) => 'article/' + (start + i))
    const values = await storage.get<string>(keys)
    for (const key of keys) {
      const block = values.get(key)
      if (typeof block !== 'string') throw new ApiError(502, '本章总结的原文上下文不完整。')
      blocks.push(block)
    }
  }
  return blocks.join('')
}
// Chapters are committed in order. One cursor bounds execution to one inference
// per article at a time, even across eviction, alarm redelivery and retries.
interface SummaryQueue {
  published: number
  next: number
  attempts: number
  running: boolean
  wakeAt: number
}
interface SummaryClaim {number: number; attempt: number}
const newQueue = (): SummaryQueue => ({published: 0, next: 1, attempts: 0, running: false, wakeAt: 0})

async function saveQueue(tx: DurableObjectTransaction, queue: SummaryQueue, expiresAt: number) {
  await tx.put('queue', queue)
  const due = queue.next <= queue.published ? Math.max(Date.now(), queue.wakeAt) : expiresAt
  await tx.setAlarm(Math.min(due, expiresAt))
}

function advance(queue: SummaryQueue) {
  queue.next++
  queue.attempts = 0
  queue.running = false
  queue.wakeAt = 0
}
interface Session { expiresAt: number; requirements: string }
type StreamEvent = [name: string, data: unknown]

function eventStream(events: AsyncGenerator<StreamEvent>, controller: AbortController): Response {
  return new Response(new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const {value, done} = await events.next()
        if (controller.signal.aborted) return
        if (done) { output.close(); return }
        output.enqueue(encoder.encode('event: ' + value[0] + '\ndata: ' + JSON.stringify(value[1]) + '\n\n'))
      } catch (error) {
        if (controller.signal.aborted) return
        const message = error instanceof ApiError ? error.message : '生成中断，请重试。'
        output.enqueue(encoder.encode('event: error\ndata: ' + JSON.stringify({message}) + '\n\n'))
        output.close()
      }
    },
    async cancel() {
      controller.abort()
      await events.return(undefined)
    },
  }), {headers: {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff'}})
}

export class ArticleSession {
  constructor(private readonly state: DurableObjectState, private readonly env: Bindings) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname
      if (path === '/generate') {
        const {videoId, requirements} = await request.json() as {videoId: string; requirements: string}
        const source = await preparedSource(this.env, videoId)
        const controller = new AbortController()
        const events = this.generate({...source, videoId}, requirements, controller.signal)
        return eventStream(events, controller)
      }
      const match = /^\/summary\/(ch-[1-9]\d*)$/.exec(path)
      if (match) return await this.getSummary(match[1])
      throw new ApiError(404, '未找到该接口。')
    } catch (error) { return failure(error) }
  }

  private async *generate(video: Video, requirements: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    yield ['meta', {
      articleId: this.state.id.toString(), videoId: video.videoId, source: video.source, title: video.title,
      sourceUrl: video.sourceUrl, sourceLabel: video.sourceLabel,
      durationSeconds: video.durationSeconds, lastCaptionSeconds: video.lastCaptionSeconds, cueCount: video.cueCount,
      timeline: video.timeline?.map(({at, topic}) => ({at, topic})),
    }]
    const expiresAt = Date.now() + lifetime
    await this.state.storage.transaction(async tx => {
      await tx.put({session: {expiresAt, requirements}, video})
      await saveQueue(tx, newQueue(), expiresAt)
    })

    let article = ''
    let nextLine = 0
    let headingsSeen = 0
    let published = 0
    const fullTranscript = !requestsEditorialAdaptation(requirements)
    let coverage: TranscriptCoverage | undefined
    let publishedUnits = 0
    let publishedLength = 0
    const checkpoint = async (prefix: string) => {
      const chapter = extractChapters(prefix).at(-1)!
      if (fullTranscript) {
        if (!coverage || coverage.completed <= publishedUnits || chapter.id !== 'ch-' + (published + 1))
          throw new ApiError(502, '本章转写尚未完整。')
        publishedUnits = coverage.completed
      } else requireChapterRecap(chapter)
      await this.publish(prefix, published + 1, expiresAt, coverage)
      publishedLength = prefix.length
      published++
      return {id: chapter.id, title: chapter.title}
    }
    for await (const text of writeArticle(this.env, {video, requirements}, signal)) {
      if (typeof text !== 'string') {
        if ('coverage' in text) {
          const {completed, total} = text.coverage
          if (!fullTranscript || !Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(completed) ||
              completed > total || (coverage ? total !== coverage.total || completed !== coverage.completed + 1 : completed !== 0))
            throw new ApiError(502, '字幕转写进度异常，请重新生成。')
          coverage = {completed, total}
          yield ['coverage', coverage]
        } else {
          // A successfully finished topic has a confirmed boundary before the
          // next upstream request has produced a heading.
          yield ['chapter', await checkpoint(article)]
        }
        continue
      }
      if (fullTranscript && !coverage) throw new ApiError(502, '缺少待转写字幕的范围。')
      article += text
      yield ['delta', {text}]
      if (fullTranscript) continue
      // A heading can be split across deltas. Only examine lines whose newline
      // has arrived, retaining the unfinished line's starting offset.
      const newline = text.lastIndexOf('\n')
      if (newline < 0) continue
      const end = article.length - text.length + newline + 1
      for (const heading of chapterHeadings(article.slice(nextLine, end))) {
        if (headingsSeen++ <= published) continue
        const prefix = article.slice(0, nextLine + heading.index)
        yield ['chapter', await checkpoint(prefix)]
      }
      nextLine = end
    }
    if (fullTranscript && (!coverage || publishedUnits !== coverage.total || publishedLength !== article.length))
      throw new ApiError(502, '部分字幕尚未完成转写，请重新生成。')
    const chapters = extractChapters(article)
    const remaining = chapters.slice(published)
    for (const chapter of remaining) requireChapterRecap(chapter)
    if (remaining.length) await this.publish(article, chapters.length, expiresAt)
    for (const {id, title} of remaining) yield ['chapter', {id, title}]
    yield ['done', {chapters: chapters.map(({id, title}) => ({id, title})), ...(coverage && {coverage})}]
  }

  private async publish(article: string, count: number, expiresAt: number, coverage?: TranscriptCoverage) {
    await this.state.storage.transaction(async tx => {
      const queue = await tx.get<SummaryQueue>('queue')
      if (!queue || expiresAt <= Date.now()) throw new ApiError(404, '文章已过期。')
      await saveArticle(tx, article)
      if (coverage) await tx.put('coverage', coverage)
      queue.published = count
      await saveQueue(tx, queue, expiresAt)
    })
  }

  private async getSummary(id: string): Promise<Response> {
    const key = 'summary/' + id
    const failed = 'failed/' + id
    const values = await this.state.storage.get(['session', 'queue', key, failed])
    const session = values.get('session') as Session | undefined
    if (!session || session.expiresAt <= Date.now()) throw new ApiError(404, '未找到文章或文章已过期，请重新生成。')
    if (values.has(key)) return json(values.get(key))
    // Older sessions store failures as strings, including advice to retry. Re-reading
    // this endpoint cannot restart a finished task, regardless of its storage version.
    if (values.has(failed)) return json({
      code: 'SUMMARY_FAILED',
      error: '本章的 5W1H 未能生成。你可以继续阅读本章正文。',
      reason: values.get(failed),
    }, 502)
    const queue = values.get('queue') as SummaryQueue | undefined
    if (!queue) {
      const article = await readArticle(this.state.storage)
      if (article && extractChapters(article).some(chapter => chapter.id === id))
        throw new ApiError(409, '这篇旧文章没有预生成此章总结，请重新生成文章。')
    }
    const number = Number(id.slice(3))
    if (!queue || number > queue.published) throw new ApiError(404, '该章节尚未写完或不存在。')
    // While the upstream is backing off, subsequent chapters wait behind this job too.
    // A running job may finish at any moment; its wakeAt is only a crash watchdog.
    const nextCheck = Math.min(queue.wakeAt, session.expiresAt)
    const waitSeconds = queue.running ? 2 : Math.max(2, Math.ceil((nextCheck - Date.now()) / 1000))
    return json({status: number === queue.next && queue.running ? 'running' : 'pending'}, 202, {'Retry-After': String(waitSeconds)})
  }

  async alarm(): Promise<void> {
    const storage = this.state.storage
    const session = await storage.get<Session>('session')
    if (!session || session.expiresAt <= Date.now()) {
      await storage.deleteAll()
      return
    }

    const claim = await storage.transaction(async tx => {
      const queue = await tx.get<SummaryQueue>('queue')
      if (!queue) { await tx.setAlarm(session.expiresAt); return }
      if (queue.next > queue.published || queue.wakeAt > Date.now()) {
        await saveQueue(tx, queue, session.expiresAt)
        return
      }
      if (queue.attempts >= maxAttempts) {
        await tx.put('failed/ch-' + queue.next, '本章总结多次处理中断，请重新生成文章。')
        advance(queue)
        await saveQueue(tx, queue, session.expiresAt)
        return
      }
      queue.attempts++
      queue.running = true
      queue.wakeAt = Date.now() + summaryTimeout + 15_000
      // Persist the watchdog before making a request outside the Durable Object.
      await saveQueue(tx, queue, session.expiresAt)
      return {number: queue.next, attempt: queue.attempts}
    })
    if (!claim) return

    const id = 'ch-' + claim.number
    let result: Summary
    try {
      const [video, article] = await Promise.all([storage.get<Video>('video'), readArticle(storage)])
      const chapter = article && extractChapters(article).find(chapter => chapter.id === id)
      if (!video?.text || !article || !chapter) throw new ApiError(502, '本章总结的原文上下文不完整。')
      const deadline = Math.max(1, Math.min(summaryTimeout, session.expiresAt - Date.now()))
      result = await summarize(this.env, video, article, chapter, AbortSignal.timeout(deadline))
    } catch (error) {
      await this.finishSummary(claim, session.expiresAt, {error})
      return
    }
    await this.finishSummary(claim, session.expiresAt, {result})
  }

  private async finishSummary(claim: SummaryClaim, expiresAt: number, outcome: {result: Summary} | {error: unknown}) {
    await this.state.storage.transaction(async tx => {
      const queue = await tx.get<SummaryQueue>('queue')
      if (!queue || queue.next !== claim.number || queue.attempts !== claim.attempt || !queue.running) return
      if (expiresAt <= Date.now()) { await tx.setAlarm(Date.now()); return }
      const id = 'ch-' + claim.number
      if ('result' in outcome) {
        await tx.put('summary/' + id, outcome.result)
      } else {
        const {error} = outcome
        const transient = error instanceof TransientError || (error instanceof Error && error.name === 'TimeoutError')
        if (transient && claim.attempt < maxAttempts) {
          const delay = error instanceof TransientError ? error.delayMs : undefined
          queue.running = false
          queue.wakeAt = Date.now() + Math.max(delay ?? 0, 5_000 * 2 ** (claim.attempt - 1))
          await saveQueue(tx, queue, expiresAt)
          return
        }
        const message = error instanceof ApiError ? error.message : '本章总结生成失败。'
        await tx.put('failed/' + id, message)
      }
      advance(queue)
      await saveQueue(tx, queue, expiresAt)
    })
  }
}
