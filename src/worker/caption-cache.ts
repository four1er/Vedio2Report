import { fetchYouTubeCaptions, type VideoTranscript } from './captions'
import { ApiError, failure, json, type Bindings } from './protocol'

const CACHE_TTL_MS = 24 * 60 * 60_000

interface CachedEntry {
  transcript: VideoTranscript
  expiresAt: number
}

/**
 * Lightweight per-video Durable Object that caches resolved YouTube captions for 24h
 * and deduplicates concurrent caption fetches for the same video ID.
 */
export class CaptionCache {
  private inflight?: Promise<VideoTranscript>

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Pick<Bindings, 'PROXY_LIST'> = {},
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const match = /^\/captions\/([A-Za-z0-9_-]{11})$/.exec(new URL(request.url).pathname)
      if (!match) throw new ApiError(404, '未找到该字幕接口。')
      const videoId = match[1]

      const cached = await this.state.storage.get<CachedEntry>('entry')
      if (cached && cached.expiresAt > Date.now()) {
        return json(cached.transcript, 200, { 'X-Caption-Cache': 'HIT' })
      }

      this.inflight ??= this.loadAndCache(videoId).finally(() => {
        this.inflight = undefined
      })
      const transcript = await this.inflight
      return json(transcript, 200, { 'X-Caption-Cache': 'MISS' })
    } catch (error) {
      return failure(error)
    }
  }

  private async loadAndCache(videoId: string): Promise<VideoTranscript> {
    const transcript = await fetchYouTubeCaptions(videoId, { proxyList: this.env.PROXY_LIST })
    const expiresAt = Date.now() + CACHE_TTL_MS
    await this.state.storage.put('entry', { transcript, expiresAt } satisfies CachedEntry)
    await this.state.storage.setAlarm(expiresAt)
    return transcript
  }

  async alarm(): Promise<void> {
    const cached = await this.state.storage.get<CachedEntry>('entry')
    if (!cached || cached.expiresAt <= Date.now()) {
      await this.state.storage.deleteAll()
    } else {
      await this.state.storage.setAlarm(cached.expiresAt)
    }
  }
}

export async function getOrFetchCaptions(env: Bindings, videoId: string): Promise<VideoTranscript> {
  const stub = env.CAPTION_CACHE.get(env.CAPTION_CACHE.idFromName(videoId))
  const response = await stub.fetch(`https://captions/captions/${videoId}`)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null
    throw new ApiError(response.status, body?.error || '获取 YouTube 字幕失败。', body?.code)
  }
  return (await response.json()) as VideoTranscript
}
