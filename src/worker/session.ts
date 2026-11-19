import { getVideoSource, type Video } from './captions'
import { summarize, writeArticle } from './gemini'
import { ApiError, chapterHeadings, extractChapters, failure, json, requireChapterRecap } from './protocol'
import type { Bindings, Chapter, Summary } from './protocol'

const lifetime = 24 * 60 * 60 * 1000
const encoder = new TextEncoder()
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
  private pending = new Map<string, Promise<Summary>>()
  constructor(private readonly state: DurableObjectState, private readonly env: Bindings) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname
      if (path === '/generate') {
        const {videoId, requirements} = await request.json() as {videoId: string; requirements: string}
        const source = await getVideoSource(videoId)
        const controller = new AbortController()
        const events = this.generate({...source, videoId}, requirements, controller.signal)
        return eventStream(events, controller)
      }
      const match = /^\/summary\/(ch-[1-9]\d*)$/.exec(path)
      if (match) return json(await this.getSummary(match[1]))
      throw new ApiError(404, '未找到该接口。')
    } catch (error) { return failure(error) }
  }

  private async *generate(video: Video, requirements: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    yield ['meta', {
      articleId: this.state.id.toString(), videoId: video.videoId, source: video.source, title: video.title,
      durationSeconds: video.durationSeconds, lastCaptionSeconds: video.lastCaptionSeconds, cueCount: video.cueCount,
      timeline: video.timeline?.map(({at, topic}) => ({at, topic})),
    }]
    const expiresAt = Date.now() + lifetime
    await this.state.storage.setAlarm(expiresAt)
    await this.state.storage.put({session: {expiresAt, requirements}, video})

    let article = ''
    let nextLine = 0
    let headingsSeen = 0
    let published = 0
    const checkpoint = async (prefix: string) => {
      const chapter = extractChapters(prefix).at(-1)!
      requireChapterRecap(chapter)
      await this.state.storage.put('article', prefix)
      published++
      return {id: chapter.id, title: chapter.title}
    }
    for await (const text of writeArticle(this.env, {video, requirements}, signal)) {
      // A separate, successfully finished topic request has a confirmed boundary
      // even when the next upstream request has not produced a heading yet.
      if (typeof text !== 'string') {
        yield ['chapter', await checkpoint(article)]
        continue
      }
      article += text
      if (article.length > 100_000) throw new ApiError(502, '生成文章过长，请缩小范围。')
      yield ['delta', {text}]
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
    const chapters = extractChapters(article)
    const remaining = chapters.slice(published)
    for (const chapter of remaining) requireChapterRecap(chapter)
    if (remaining.length) await this.state.storage.put('article', article)
    for (const {id, title} of remaining) yield ['chapter', {id, title}]
    yield ['done', {chapters: chapters.map(({id, title}) => ({id, title}))}]
  }

  private async getSummary(id: string): Promise<Summary> {
    // Check expiry even when a scheduled alarm is delivered late.
    const session = await this.state.storage.get<Session>('session')
    if (!session || session.expiresAt <= Date.now()) throw new ApiError(404, '未找到文章或文章已过期，请重新生成。')
    const cached = await this.state.storage.get<Summary>('summary/' + id)
    if (cached) return cached
    const running = this.pending.get(id)
    if (running) return running
    const task = this.createSummary(id, session)
    this.pending.set(id, task)
    try { return await task } finally { this.pending.delete(id) }
  }

  private async createSummary(id: string, session: Session): Promise<Summary> {
    const [video, article] = await Promise.all([
      this.state.storage.get<Video>('video'), this.state.storage.get<string>('article'),
    ])
    if (!video) throw new ApiError(404, '文章上下文已失效。')
    if (!article) throw new ApiError(404, '该章节尚未写完或不存在。')
    const chapter: Chapter | undefined = extractChapters(article).find(item => item.id === id)
    if (!chapter) throw new ApiError(404, '该章节尚未写完或不存在。')
    // Sessions from the former video-input path stored an ID without caption text.
    const context = video.text ? video : {...await getVideoSource(video.videoId), videoId: video.videoId}
    const result = await summarize(this.env, context, article, chapter, AbortSignal.timeout(90_000))
    if (session.expiresAt <= Date.now()) throw new ApiError(404, '文章已过期，请重新生成。')
    await this.state.storage.put('summary/' + id, result)
    return result
  }

  async alarm(): Promise<void> { await this.state.storage.deleteAll() }
}
