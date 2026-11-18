import { getCaptions } from './captions'
import { summarize, writeArticle } from './gemini'
import { ApiError, extractChapters, failure, json } from './protocol'
import type { Bindings, Chapter, Summary } from './protocol'

const lifetime = 24 * 60 * 60 * 1000
const encoder = new TextEncoder()
type Video = Awaited<ReturnType<typeof getCaptions>> & { videoId: string }
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
        let captions: Awaited<ReturnType<typeof getCaptions>>
        try { captions = await getCaptions(videoId) }
        catch (error) { throw new ApiError(422, error instanceof Error ? error.message : '无法读取视频字幕。') }
        if (!captions.text.trim() || encoder.encode(captions.text).length > 100_000)
          throw new ApiError(422, '字幕为空或过长，请更换视频。')
        const controller = new AbortController()
        const events = this.generate({...captions, videoId}, requirements, controller.signal)
        return eventStream(events, controller)
      }
      const match = /^\/summary\/(ch-[1-9]\d*)$/.exec(path)
      if (match) return json(await this.getSummary(match[1]))
      throw new ApiError(404, '未找到该接口。')
    } catch (error) { return failure(error) }
  }

  private async *generate(video: Video, requirements: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    yield ['meta', {articleId: this.state.id.toString(), videoId: video.videoId, source: video.source, title: video.title}]
    let article = ''
    for await (const text of writeArticle(this.env, {video, requirements}, signal)) {
      article += text
      if (article.length > 100_000) throw new ApiError(502, '生成文章过长，请缩小范围。')
      yield ['delta', {text}]
    }
    const chapters = extractChapters(article)
    const expiresAt = Date.now() + lifetime
    await this.state.storage.setAlarm(expiresAt)
    // Separate values keep each field below Durable Object storage value limits.
    await this.state.storage.put({session: {expiresAt, requirements}, video, article})
    yield ['done', {chapters: chapters.map(({id, title}) => ({id, title}))}]
  }

  private async getSummary(id: string): Promise<Summary> {
    // Check expiry even when a scheduled alarm is delivered late.
    const session = await this.state.storage.get<Session>('session')
    if (!session || session.expiresAt <= Date.now()) throw new ApiError(404, '文章还未完成或已过期，请重新生成。')
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
    if (!video || !article) throw new ApiError(404, '文章上下文已失效。')
    const chapter: Chapter | undefined = extractChapters(article).find(item => item.id === id)
    if (!chapter) throw new ApiError(404, '未找到该章节。')
    const result = await summarize(this.env, video, article, chapter, AbortSignal.timeout(90_000))
    if (session.expiresAt <= Date.now()) throw new ApiError(404, '文章已过期，请重新生成。')
    await this.state.storage.put('summary/' + id, result)
    return result
  }

  async alarm(): Promise<void> { await this.state.storage.deleteAll() }
}
