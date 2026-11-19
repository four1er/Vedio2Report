import { chapterRecapText } from '../shared/chapter-recap'

export type Summary = Record<'who' | 'what' | 'when' | 'where' | 'why' | 'how', string>
export interface TranscriptCoverage {completed: number; total: number}
export const dimensions = ['who', 'what', 'when', 'where', 'why', 'how'] as const

export interface Bindings {
  CAPTION_CACHE: DurableObjectNamespace
  CAPTION_LIMIT?: { limit(options: {key: string}): Promise<{success: boolean}> }
  ARTICLES: DurableObjectNamespace
  ASSETS: Fetcher
  GEMINI_API_KEY?: string
  SUPADATA_API_KEY?: string
  GEMINI_MODEL?: string
  GENERATION_LIMIT?: { limit(options: {key: string}): Promise<{success: boolean}> }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {status, headers: {...headers, 'Cache-Control': 'no-store'}})
}

export function failure(error: unknown): Response {
  return error instanceof ApiError
    ? json({error: error.message, code: 'code' in error && typeof error.code === 'string' ? error.code : undefined}, error.status)
    : json({error: '请求暂时无法完成，请稍后再试。'}, 500)
}

// Bound the body even when the browser uses chunked transfer encoding.
export async function readInput(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    throw new ApiError(415, '请使用 JSON 格式提交。')
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError(400, '请求内容为空。')
  const decoder = new TextDecoder()
  let body = '', bytes = 0
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16_384) {
        await reader.cancel()
        throw new ApiError(413, '提交的内容过长。')
      }
      body += decoder.decode(value, {stream: true})
    }
    const data: unknown = JSON.parse(body + decoder.decode())
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    return data as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, '请求中的 JSON 无效。')
  } finally { reader.releaseLock() }
}

export async function requireEmptyBody(request: Request): Promise<void> {
  // workerd can represent a zero-byte POST as a readable stream.
  const reader = request.body?.getReader()
  if (!reader) return
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) return
      if (value.byteLength) {
        await reader.cancel()
        throw new ApiError(400, '章节总结只需要文章和章节标识。')
      }
    }
  } finally { reader.releaseLock() }
}

export interface Chapter {id: string; title: string; text: string}

// Validate a newly completed chapter before it is stored and queued for summarization.
export function requireChapterRecap(chapter: Chapter): void {
  const lastBreak = chapter.text.lastIndexOf('\n')
  if (lastBreak < 0 || !chapterRecapText(chapter.text.slice(lastBreak + 1)))
    throw new ApiError(502, '“' + chapter.title + '”缺少完整的正文或章末小结，请重新生成。')
}

export function chapterHeadings(text: string) {
  return text.matchAll(/^##[ \t]+(\S[^\r\n]*)\r?$/gm)
}

export function extractChapters(article: string): Chapter[] {
  const headings = Array.from(chapterHeadings(article))
  const titleCount = article.match(/^#[ \t]+\S/gm)?.length
  if (!article.trimStart().startsWith('# ') || titleCount !== 1 || headings.length === 0)
    throw new ApiError(502, '模型未生成完整的章节结构，请重新生成。')
  return headings.map((heading, i) => {
    const text = article.slice(heading.index! + heading[0].length, headings[i + 1]?.index).trim()
    if (!text) throw new ApiError(502, '模型返回了空章节，请重新生成。')
    return {id: 'ch-' + (i + 1), title: heading[1].trim(), text}
  })
}

export function parseSummary(value: unknown): Summary {
  if (!value || typeof value !== 'object') throw new ApiError(502, '总结格式异常，请重试。')
  const input = value as Record<string, unknown>
  const result = {} as Summary
  for (const key of dimensions) {
    const field = input[key]
    if (typeof field !== 'string' || !field.trim() || field.length > 2000)
      throw new ApiError(502, '总结格式异常，请重试。')
    result[key] = field.trim()
  }
  return result
}
