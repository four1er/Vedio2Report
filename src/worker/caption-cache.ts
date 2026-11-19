import { CaptionSourceError, discoverCaptions, downloadCaptions } from './captions'
import type { CaptionDiscovery, CaptionErrorCode, Source } from './captions'
import { ApiError, failure, json } from './protocol'
import type { Bindings } from './protocol'

const cacheLifetime = 24 * 60 * 60_000
const failureLifetime = 30_000
const downloadLease = 30_000
const maxAttempts = 3

type Download = {
  status: 'pending' | 'running'
  discovery: CaptionDiscovery
  token: string
  attempt: number
  wakeAt: number
}
type Finished = {status: 'ready'; source: Source; expiresAt: number} |
  {status: 'failed'; code: CaptionErrorCode; message: string; httpStatus: number; expiresAt: number}
type Record = Download | Finished

function finished(record: Record): record is Finished {
  return record.status === 'ready' || record.status === 'failed'
}

function ready(source: Source): Finished {
  if (!source.text.trim()) throw new CaptionSourceError('TEMPORARY', '字幕轨已找到，但下载结果为空，请稍后再试。')
  return {status: 'ready', source, expiresAt: Date.now() + cacheLifetime}
}

async function save(tx: DurableObjectTransaction, record: Record) {
  await tx.put('captions', record)
  await tx.setAlarm(finished(record) ? record.expiresAt : record.wakeAt)
}

function present(record: Record, videoId: string, includeText: boolean): Response {
  if (record.status === 'failed') throw new CaptionSourceError(record.code, record.message, record.httpStatus)
  if (record.status === 'ready') {
    if (includeText) return json(record.source)
    const {title, source, cueCount, durationSeconds, lastCaptionSeconds} = record.source
    return json({status: 'ready', videoId, title, source, cueCount, durationSeconds, lastCaptionSeconds})
  }
  return json({status: record.status, videoId, title: record.discovery.title}, 202, {'Retry-After': '1'})
}

// Every video has one named object. Network I/O runs outside storage transactions.
export class CaptionCache {
  private discovery?: Promise<Record>
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const route = /^\/(prepare|status|source)\/([a-zA-Z0-9_-]{11})$/.exec(new URL(request.url).pathname)
      if (!route) throw new ApiError(404, '未找到该字幕任务。')
      const [, action, videoId] = route
      let record = await this.active()
      if (!record && action === 'prepare' && request.method === 'POST') {
        // Share discovery too: two readers arriving before the first track was found
        // must not submit two watch requests. The resulting download itself is durable.
        this.discovery ??= this.start(videoId).finally(() => { this.discovery = undefined })
        record = await this.discovery
      }
      if (!record) throw new ApiError(404, '字幕任务不存在或已过期，请重新检查字幕。')
      return present(record, videoId, action === 'source')
    } catch (error) { return failure(error) }
  }

  private async active(): Promise<Record | undefined> {
    const record = await this.state.storage.get<Record>('captions')
    if (record && (!finished(record) || record.expiresAt > Date.now())) return record
  }

  private async start(videoId: string): Promise<Record> {
    const existing = await this.active()
    if (existing) return existing
    const discovery = await discoverCaptions(videoId)
    // An inaccessible player or missing track throws before any task is written.
    const record: Record = discovery.kind === 'archive'
      ? ready(await downloadCaptions(discovery))
      : {status: 'pending', discovery, token: crypto.randomUUID(), attempt: 0, wakeAt: Date.now()}
    await this.state.storage.transaction(tx => save(tx, record))
    return record
  }

  async alarm(): Promise<void> {
    const claim = await this.state.storage.transaction(async tx => {
      const record = await tx.get<Record>('captions')
      if (!record) return
      if (finished(record)) {
        if (record.expiresAt <= Date.now()) await tx.delete('captions')
        else await tx.setAlarm(record.expiresAt)
        return
      }
      if (record.wakeAt > Date.now()) { await tx.setAlarm(record.wakeAt); return }
      if (record.attempt >= maxAttempts) {
        await save(tx, {status: 'failed', code: 'TEMPORARY', httpStatus: 503,
          message: '字幕下载多次中断，请稍后重新检查。', expiresAt: Date.now() + failureLifetime})
        return
      }
      record.status = 'running'
      record.attempt++
      record.wakeAt = Date.now() + downloadLease
      await save(tx, record)
      return record
    })
    if (!claim) return

    let next: Record
    try {
      // A signed timedtext URL can expire between attempts.
      const source = claim.attempt === 1 ? claim.discovery : await discoverCaptions(claim.discovery.videoId)
      next = ready(await downloadCaptions(source))
    } catch (error) {
      const reason = error instanceof CaptionSourceError ? error :
        new CaptionSourceError('TEMPORARY', '暂时无法下载字幕，请稍后再试。')
      if (reason.code === 'TEMPORARY' && claim.attempt < maxAttempts)
        next = {...claim, status: 'pending', wakeAt: Date.now() + 1000 * 2 ** (claim.attempt - 1)}
      else next = {status: 'failed', code: reason.code, message: reason.message,
        httpStatus: reason.status, expiresAt: Date.now() + failureLifetime}
    }
    await this.state.storage.transaction(async tx => {
      const current = await tx.get<Record>('captions')
      if (current?.status === 'running' && current.token === claim.token && current.attempt === claim.attempt)
        await save(tx, next)
    })
  }
}

export function captionStub(env: Bindings, videoId: string) {
  return env.CAPTION_CACHE.get(env.CAPTION_CACHE.idFromName(videoId))
}

export async function preparedSource(env: Bindings, videoId: string): Promise<Source> {
  const stub = captionStub(env, videoId)
  const prepare = await stub.fetch('https://captions/prepare/' + videoId, {method: 'POST'})
  if (!prepare.ok) throw await fromResponse(prepare)
  await prepare.body?.cancel()
  const deadline = Date.now() + 100_000
  let delay = 250
  for (;;) {
    const response = await stub.fetch('https://captions/source/' + videoId)
    if (response.status === 200) return await response.json() as Source
    if (response.status !== 202) throw await fromResponse(response)
    await response.body?.cancel()
    if (Date.now() > deadline) throw new CaptionSourceError('TEMPORARY', '字幕仍在后台下载，请稍后再试。')
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(4_000, 2 * delay)
  }
}

async function fromResponse(response: Response): Promise<Error> {
  const body = await response.json() as {error: string; code?: CaptionErrorCode}
  return body.code ? new CaptionSourceError(body.code, body.error, response.status) : new ApiError(response.status, body.error)
}
