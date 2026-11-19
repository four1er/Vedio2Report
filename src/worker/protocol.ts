import { SUMMARY_KEYS } from '../shared/types'
import type { ParsedRequirements, Summary5W1H } from '../shared/types'

export interface Bindings {
  ARTICLES: DurableObjectNamespace
  CAPTION_CACHE: DurableObjectNamespace
  ASSETS: Fetcher
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  PROXY_LIST?: string
  GENERATION_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  CAPTION_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  })
}

export function failure(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      error.status,
    )
  }
  return json({ error: '服务暂时不可用，请稍后重试。' }, 500)
}

export async function readJsonBody(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new ApiError(415, '请使用 application/json 格式提交请求。')
  }
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError(400, '请求内容为空。')
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new ApiError(413, '请求内容过长。')
      }
      text += decoder.decode(value, { stream: true })
    }
    const parsed: unknown = JSON.parse(text + decoder.decode())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, '请求中的 JSON 格式无效。')
  } finally {
    reader.releaseLock()
  }
}

/**
 * Enforces that chapter 5W1H requests never resend article/chapter text from the client.
 */
export async function requireEmptyBody(request: Request): Promise<void> {
  const reader = request.body?.getReader()
  if (!reader) return
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value.byteLength > 0) {
        await reader.cancel()
        throw new ApiError(400, '章节 5W1H 总结由服务端上下文生成，请勿重复提交文章内容。')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export interface Chapter {
  id: string
  title: string
  text: string
}

export function chapterHeadings(markdown: string): RegExpExecArray[] {
  return Array.from(markdown.matchAll(/^##[ \t]+(\S[^\r\n]*)\r?$/gm))
}

export function cleanHeadingTitle(raw: string): string {
  return raw.trim().replace(/^\*\*|\*\*$/g, '').trim()
}

export function extractChapters(article: string): Chapter[] {
  const headings = chapterHeadings(article)
  return headings
    .map((heading, index) => {
      const start = heading.index + heading[0].length
      const end = headings[index + 1]?.index ?? article.length
      const text = article.slice(start, end).trim()
      return {
        id: `ch-${index + 1}`,
        title: cleanHeadingTitle(heading[1]),
        text,
      }
    })
    .filter(chapter => chapter.text.length > 0)
}

export function validateSummary(value: unknown): Summary5W1H {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(502, '5W1H 总结格式异常，请重试。')
  }
  const input = value as Record<string, unknown>
  const summary = {} as Summary5W1H
  for (const key of SUMMARY_KEYS) {
    const field = input[key]
    if (typeof field !== 'string' || !field.trim() || field.length > 2000) {
      throw new ApiError(502, `5W1H 总结缺少有效字段：${key}。`)
    }
    summary[key] = field.trim()
  }
  return summary
}

export function normalizeParsedRequirements(value: unknown): ParsedRequirements {
  const empty: ParsedRequirements = { constraints: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty
  const raw = value as Record<string, unknown>
  const pick = (field: unknown): string | undefined => {
    if (typeof field !== 'string') return undefined
    const trimmed = field.trim()
    return trimmed && trimmed.length <= 200 ? trimmed : undefined
  }
  const constraints = Array.isArray(raw.constraints)
    ? raw.constraints
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => item.length > 0 && item.length <= 200)
        .slice(0, 8)
    : []
  return {
    taskType: pick(raw.taskType),
    outputStyle: pick(raw.outputStyle),
    targetAudience: pick(raw.targetAudience),
    constraints,
  }
}

export function hasParsedRequirements(req: ParsedRequirements): boolean {
  return Boolean(req.taskType || req.outputStyle || req.targetAudience || req.constraints.length)
}
