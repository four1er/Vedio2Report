import { parseVideoId } from './captions'
import { ApiError, failure, readInput, requireEmptyBody } from './protocol'
import type { Bindings } from './protocol'
export { ArticleSession } from './session'

async function limitRequest(request: Request, env: Bindings) {
  if (env.GENERATION_LIMIT) {
    const key = request.headers.get('CF-Connecting-IP') || 'local'
    if (!(await env.GENERATION_LIMIT.limit({key})).success)
      throw new ApiError(429, '请求过于频繁，请稍后再试。')
  }
  if (!env.GEMINI_API_KEY?.trim()) throw new ApiError(503, '服务尚未配置 Gemini API 密钥。')
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
      const summary = /^\/api\/articles\/([a-f0-9]{64})\/chapters\/(ch-[1-9]\d{0,3})\/summary$/.exec(url.pathname)
      if (url.pathname !== '/api/articles' && !summary) throw new ApiError(404, '未找到该接口。')
      if (request.method !== 'POST') throw new ApiError(405, '该接口需要 POST 请求。')
      const origin = request.headers.get('Origin')
      if (origin && origin !== url.origin) throw new ApiError(403, '请在本站提交请求。')
      if (summary) {
        await requireEmptyBody(request)
        await limitRequest(request, env)
        let id: DurableObjectId
        try { id = env.ARTICLES.idFromString(summary[1]) }
        catch { throw new ApiError(404, '未找到该文章。') }
        return await env.ARTICLES.get(id).fetch('https://session/summary/' + summary[2], {method: 'POST'})
      }

      const input = await readInput(request)
      if (typeof input.url !== 'string' || input.url.length > 2048) throw new ApiError(400, '请输入有效的 YouTube 视频链接。')
      let videoId: string
      try { videoId = parseVideoId(input.url) }
      catch { throw new ApiError(400, '请输入有效的 YouTube 视频链接。') }
      if (input.requirements !== undefined && (typeof input.requirements !== 'string' || input.requirements.length > 2000))
        throw new ApiError(400, '生成要求最多支持 2000 个字符。')
      await limitRequest(request, env)
      const stub = env.ARTICLES.get(env.ARTICLES.newUniqueId())
      return await stub.fetch('https://session/generate', {
        method: 'POST',
        body: JSON.stringify({videoId, requirements: input.requirements?.trim() ?? ''}),
      })
    } catch (error) { return failure(error) }
  },
} satisfies ExportedHandler<Bindings>
