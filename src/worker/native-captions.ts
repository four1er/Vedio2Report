import { CaptionSourceError } from './caption-source'

export interface NativeTrack {
  videoId: string
  language?: string
  cues: {text: string; start?: number; duration?: number}[]
}

const endpoint = 'https://api.supadata.ai/v1/transcript'
const temporary = () => new CaptionSourceError('TEMPORARY', '现有字幕服务暂时无法返回完整结果，请稍后再试。')

function providerError(status: number, code: unknown) {
  if (status === 206 && code === 'transcript-unavailable')
    return new CaptionSourceError('NO_CAPTIONS', '字幕服务确认该视频没有可用的现有字幕。')
  if (status === 401 || status === 402 || status === 403)
    return new CaptionSourceError('SOURCE_UNVERIFIED', '字幕服务未授权此次读取，请检查服务端的访问权限或配额。')
  if (status === 404)
    return new CaptionSourceError('SOURCE_UNVERIFIED', '字幕服务未能公开读取该视频或任务。')
  return temporary()
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw providerError(response.status, undefined)
  const decoder = new TextDecoder()
  let bytes = 0, json = ''
  try {
    for (;;) {
      const {value, done} = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 5_000_000) {
        await reader.cancel()
        throw new CaptionSourceError('PERMANENT', '单份字幕服务响应超过 5 MB。')
      }
      json += decoder.decode(value, {stream: true})
    }
  } finally { reader.releaseLock() }
  let parsed: unknown
  try { parsed = JSON.parse(json + decoder.decode()) }
  catch { throw providerError(response.status, undefined) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw temporary()
  return parsed as Record<string, unknown>
}

function milliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && Number.isSafeInteger(Math.round(value)) ? Math.round(value) : undefined
}

function nativeTrack(videoId: string, payload: Record<string, unknown>): NativeTrack {
  if ((payload.videoId !== undefined && payload.videoId !== videoId) || !Array.isArray(payload.content)) throw temporary()
  const cues: NativeTrack['cues'] = []
  for (const item of payload.content) {
    if (typeof item?.text !== 'string') throw temporary()
    const text = item.text.replace(/\s+/g, ' ').trim()
    if (text) cues.push({text, start: milliseconds(item.offset), duration: milliseconds(item.duration)})
  }
  if (!cues.length) throw new CaptionSourceError('SOURCE_UNVERIFIED', '字幕服务返回了空字幕，无法确认有可读取的文字。')
  return {videoId, cues, language: typeof payload.lang === 'string' ? payload.lang : undefined}
}

const jobIdPattern = /^[a-zA-Z0-9_-]{1,128}$/

async function read(url: URL, key: string) {
  if (!key.trim()) throw new CaptionSourceError('SOURCE_UNVERIFIED', '服务端尚未配置现有字幕服务。')
  try {
    const response = await fetch(url, {headers: {'x-api-key': key.trim()}, redirect: 'manual', signal: AbortSignal.timeout(15_000)})
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new CaptionSourceError('TEMPORARY', '字幕服务返回了重定向，暂时无法读取该结果。')
    }
    const payload = await readPayload(response)
    if (!response.ok || response.status === 206) throw providerError(response.status, payload.error)
    return {status: response.status, payload}
  } catch (error) {
    if (error instanceof CaptionSourceError) throw error
    throw temporary()
  }
}

/** Submit once. The caller persists accepted job IDs before polling them. */
export async function discoverNative(videoId: string, key: string): Promise<NativeTrack | {jobId: string}> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new CaptionSourceError('PERMANENT', 'YouTube 视频 ID 无效。', 400)
  const url = new URL(endpoint)
  url.search = new URLSearchParams({url: 'https://www.youtube.com/watch?v=' + videoId, mode: 'native', text: 'false'}).toString()
  const {status, payload} = await read(url, key)
  if (status === 200) return nativeTrack(videoId, payload)
  if (status === 202 && typeof payload.jobId === 'string' && jobIdPattern.test(payload.jobId)) return {jobId: payload.jobId}
  throw temporary()
}

/** One read of a previously accepted job. Polling never submits a new transcript request. */
export async function pollNative(videoId: string, jobId: string, key: string): Promise<NativeTrack | undefined> {
  if (!jobIdPattern.test(jobId)) throw new CaptionSourceError('PERMANENT', '字幕服务任务编号无效。')
  const {payload: job} = await read(new URL(endpoint + '/' + jobId), key)
  if (job.status === 'completed') return nativeTrack(videoId, job)
  if (job.status === 'queued' || job.status === 'active') return
  if (job.status === 'failed') {
    const error = job.error
    const code = error && typeof error === 'object' && 'error' in error ? error.error : error
    if (code === 'transcript-unavailable') throw providerError(206, code)
    throw new CaptionSourceError('SOURCE_UNVERIFIED', '字幕服务已结束此次任务，未能取得可读取的现有字幕。')
  }
  throw temporary()
}
