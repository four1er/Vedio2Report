import { getOrFetchCaptions } from './caption-cache'
import { parseVideoId } from './captions'
import { ApiError, failure, json, readJsonBody, requireEmptyBody, type Bindings } from './protocol'
import { parseProxyList } from './proxy-http'

export { ArticleSession } from './session'
export { CaptionCache } from './caption-cache'

async function enforceRateLimit(
  request: Request,
  limiter?: { limit(options: { key: string }): Promise<{ success: boolean }> },
): Promise<void> {
  if (!limiter) return
  const key = request.headers.get('CF-Connecting-IP') || 'local'
  const result = await limiter.limit({ key })
  if (!result.success) {
    throw new ApiError(429, '请求过于频繁，请稍后再试。', 'RATE_LIMITED')
  }
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request)
      }

      // Same-origin protection for browser API requests
      const origin = request.headers.get('Origin')
      if (origin && origin !== url.origin) {
        throw new ApiError(403, '仅允许从本站发起请求。')
      }

      if (url.pathname === '/api/health') {
        if (request.method !== 'GET') throw new ApiError(405, '请使用 GET 访问健康检查。')
        return json({
          ok: true,
          hasGeminiKey: Boolean(env.GEMINI_API_KEY?.trim()),
          proxyCount: parseProxyList(env.PROXY_LIST).length,
        })
      }

      // Chapter 5W1H summary (strictly uses server-stored context, empty body enforced)
      const summaryMatch = /^\/api\/articles\/([a-f0-9]{64})\/chapters\/(ch-[1-9]\d{0,3})\/summary$/.exec(url.pathname)
      if (summaryMatch) {
        if (request.method !== 'POST' && request.method !== 'GET') {
          throw new ApiError(405, '请使用 POST 或 GET 获取章节 5W1H 总结。')
        }
        await requireEmptyBody(request)
        if (!env.GEMINI_API_KEY?.trim()) {
          throw new ApiError(503, '服务尚未配置 GEMINI_API_KEY。')
        }
        let sessionId: DurableObjectId
        try {
          sessionId = env.ARTICLES.idFromString(summaryMatch[1])
        } catch {
          throw new ApiError(404, '未找到对应的文章会话。')
        }
        return await env.ARTICLES.get(sessionId).fetch(`https://session/summary/${summaryMatch[2]}`)
      }

      // Main article generation (SSE stream)
      if (url.pathname === '/api/articles') {
        if (request.method !== 'POST') throw new ApiError(405, '请使用 POST 发起文章生成。')
        const input = await readJsonBody(request)
        if (typeof input.url !== 'string' || input.url.length > 2048) {
          throw new ApiError(400, '请输入有效的 YouTube 视频链接。')
        }
        if (
          input.requirements !== undefined &&
          (typeof input.requirements !== 'string' || input.requirements.length > 2000)
        ) {
          throw new ApiError(400, '自然语言生成要求最多支持 2000 个字符。')
        }

        const videoId = parseVideoId(input.url)
        await enforceRateLimit(request, env.GENERATION_LIMIT)
        if (!env.GEMINI_API_KEY?.trim()) {
          throw new ApiError(503, '服务尚未配置 GEMINI_API_KEY。')
        }

        // Resolve & cache YouTube captions before creating an article session
        const transcript = await getOrFetchCaptions(env, videoId)
        const stub = env.ARTICLES.get(env.ARTICLES.newUniqueId())
        return await stub.fetch('https://session/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript,
            requirements: (input.requirements ?? '').trim(),
          }),
        })
      }

      throw new ApiError(404, '未找到该接口。')
    } catch (error) {
      return failure(error)
    }
  },
} satisfies ExportedHandler<Bindings>
