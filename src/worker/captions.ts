import type { CaptionSourceKind, TimelineMark } from '../shared/types'
import { ApiError } from './protocol'
import { createProxyFetcher, parseProxyList, type FetchLike, type SocketConnector } from './proxy-http'
import archive from './archives/xRh2sVcNXQ8.json'

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com'])
const MAX_CAPTION_BYTES = 512_000
const MAX_PROXIES_PER_REQUEST = 3
const PER_ATTEMPT_TIMEOUT_MS = 10_000

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip'
const CONSENT_COOKIE = 'CONSENT=PENDING+987; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg'

export interface CaptionCue {
  text: string
  startMs?: number
  durationMs?: number
}

export interface VideoTranscript {
  videoId: string
  title: string
  source: CaptionSourceKind
  language?: string
  text: string
  cueCount: number
  durationSeconds?: number
  lastCaptionSeconds?: number
  timeline?: TimelineMark[]
}

interface CaptionTrack {
  baseUrl?: string
  languageCode?: string
  kind?: string
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string }
  videoDetails?: {
    videoId?: string
    title?: string
    lengthSeconds?: string
    shortDescription?: string
  }
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[]
    }
  }
}

export function parseVideoId(input: string): string {
  const invalid = '请输入有效的 YouTube 视频链接，例如 youtube.com/watch?v=... 或 youtu.be/...'
  const trimmed = input.trim()
  if (VIDEO_ID_PATTERN.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new ApiError(400, invalid, 'INVALID_URL')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password) {
    throw new ApiError(400, invalid, 'INVALID_URL')
  }

  let id: string | undefined
  if (url.hostname === 'youtu.be') {
    id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1]
  } else if (url.hostname === 'www.youtube-nocookie.com' || url.hostname === 'youtube-nocookie.com') {
    id = /^\/embed\/([^/]+)\/?$/.exec(url.pathname)?.[1]
  } else if (YOUTUBE_HOSTS.has(url.hostname) || url.hostname === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      const ids = url.searchParams.getAll('v')
      id = ids.length === 1 ? ids[0] : undefined
    } else {
      id = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1]
    }
  }

  if (!id || !VIDEO_ID_PATTERN.test(id)) {
    throw new ApiError(400, invalid, 'INVALID_URL')
  }
  return id
}

function formatClock(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = String(sec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

export function parseJson3Cues(raw: string): CaptionCue[] {
  const payload = JSON.parse(raw) as {
    events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>
  }
  if (!Array.isArray(payload?.events)) return []
  const cues: CaptionCue[] = []
  for (const ev of payload.events) {
    if (!Array.isArray(ev?.segs)) continue
    const text = ev.segs
      .map(seg => (typeof seg?.utf8 === 'string' ? seg.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    cues.push({
      text,
      startMs: typeof ev.tStartMs === 'number' && ev.tStartMs >= 0 ? ev.tStartMs : undefined,
      durationMs: typeof ev.dDurationMs === 'number' && ev.dDurationMs >= 0 ? ev.dDurationMs : undefined,
    })
  }
  return cues
}

export function parseXmlCues(raw: string): CaptionCue[] {
  const cues: CaptionCue[] = []
  const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/g
  for (const match of raw.matchAll(textRegex)) {
    const attrs = match[1]
    const content = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    if (!content) continue
    const startSec = Number(/\bstart="([^"]+)"/.exec(attrs)?.[1])
    const durSec = Number(/\bdur="([^"]+)"/.exec(attrs)?.[1])
    cues.push({
      text: content,
      startMs: Number.isFinite(startSec) ? Math.round(startSec * 1000) : undefined,
      durationMs: Number.isFinite(durSec) ? Math.round(durSec * 1000) : undefined,
    })
  }
  if (cues.length > 0) return cues

  // srv3 XML format: <p t="1234" d="567">...
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/g
  for (const match of raw.matchAll(pRegex)) {
    const attrs = match[1]
    const content = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    if (!content) continue
    const tMs = Number(/\bt="(\d+)"/.exec(attrs)?.[1])
    const dMs = Number(/\bd="(\d+)"/.exec(attrs)?.[1])
    cues.push({
      text: content,
      startMs: Number.isFinite(tMs) ? tMs : undefined,
      durationMs: Number.isFinite(dMs) ? dMs : undefined,
    })
  }
  return cues
}

function parseDescriptionChapters(description?: string): TimelineMark[] | undefined {
  if (!description) return undefined
  const marks: TimelineMark[] = []
  for (const line of description.split(/\r?\n/)) {
    const match = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[-–—|:]\s*)?(.+?)\s*$/.exec(line)
    if (!match) continue
    const topic = match[2].trim()
    if (topic.length < 2 || topic.length > 120) continue
    marks.push({ at: match[1], topic })
  }
  return marks.length >= 2 ? marks.slice(0, 30) : undefined
}

function buildTimestampedText(cues: CaptionCue[]): string {
  const lines: string[] = []
  let nextMarkMs = 0
  for (const cue of cues) {
    if (typeof cue.startMs === 'number' && cue.startMs >= nextMarkMs) {
      lines.push(`[${formatClock(cue.startMs / 1000)}] ${cue.text}`)
      nextMarkMs = cue.startMs + 30_000
    } else {
      lines.push(cue.text)
    }
  }
  return lines.join('\n')
}

function buildTranscriptFromCues(
  cues: CaptionCue[],
  meta: {
    videoId: string
    title: string
    source: CaptionSourceKind
    language?: string
    durationSeconds?: number
    timeline?: TimelineMark[]
  },
): VideoTranscript {
  const text = buildTimestampedText(cues)
  if (new TextEncoder().encode(text).byteLength > MAX_CAPTION_BYTES) {
    throw new ApiError(422, '该视频字幕体积超过 512 KB 上限，请选择时长更适中的视频。', 'CAPTION_TOO_LARGE')
  }
  const last = cues[cues.length - 1]
  const lastCaptionSeconds =
    typeof last?.startMs === 'number'
      ? Math.floor((last.startMs + (last.durationMs ?? 0)) / 1000)
      : undefined

  return {
    videoId: meta.videoId,
    title: meta.title || 'YouTube 视频',
    source: meta.source,
    language: meta.language,
    text,
    cueCount: cues.length,
    durationSeconds: meta.durationSeconds,
    lastCaptionSeconds,
    timeline: meta.timeline,
  }
}

function rankTrack(track: CaptionTrack): number {
  const lang = track.languageCode?.split('-')[0].toLowerCase()
  const isAsr = track.kind === 'asr' ? 10 : 0
  const langScore = lang === 'zh' ? 0 : lang === 'en' ? 1 : 2
  return isAsr + langScore
}

function normalizeTimedTextUrl(baseUrl: string, videoId: string, format?: 'json3'): URL | undefined {
  if (!URL.canParse(baseUrl)) return undefined
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname) || url.pathname !== '/api/timedtext') {
    return undefined
  }
  const vParams = url.searchParams.getAll('v')
  if (vParams.length !== 1 || vParams[0] !== videoId) return undefined
  if (format) url.searchParams.set('fmt', format)
  else url.searchParams.delete('fmt')
  url.hash = ''
  return url
}

function extractPlayerFromHtml(html: string): PlayerResponse | undefined {
  const marker = /(?:\bytInitialPlayerResponse\s*=|window\["ytInitialPlayerResponse"\]\s*=)\s*\{/g.exec(html)
  if (!marker) return undefined
  const start = marker.index + marker[0].length - 1
  let depth = 0
  let inString = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inString && ch === '\\') {
      i++
    } else if (ch === '"') {
      inString = !inString
    } else if (!inString && ch === '{') {
      depth++
    } else if (!inString && ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1)) as PlayerResponse
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const INNERTUBE_CLIENTS = [
  {
    name: 'ANDROID',
    version: '20.10.38',
    userAgent: ANDROID_UA,
  },
  {
    name: 'IOS',
    version: '20.10.4',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)',
  },
] as const

async function callInnertubePlayer(
  doFetch: FetchLike,
  videoId: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<PlayerResponse | undefined> {
  const endpoint = apiKey
    ? `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`
    : 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'

  let lastResponse: PlayerResponse | undefined
  for (const client of INNERTUBE_CLIENTS) {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.userAgent,
        Origin: 'https://www.youtube.com',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: client.name,
            clientVersion: client.version,
            hl: 'en',
            gl: 'US',
          },
        },
        videoId,
      }),
      signal,
    }).catch(() => undefined)

    if (!response?.ok) continue
    const parsed = (await response.json().catch(() => undefined)) as PlayerResponse | undefined
    if (!parsed) continue
    lastResponse = parsed
    const tracks = parsed.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) return parsed
  }
  return lastResponse
}

async function fetchTrackCues(
  doFetch: FetchLike,
  videoId: string,
  tracks: CaptionTrack[],
  signal: AbortSignal,
): Promise<{ cues: CaptionCue[]; language?: string } | undefined> {
  const ranked = tracks
    .filter((t): t is CaptionTrack & { baseUrl: string } => typeof t?.baseUrl === 'string')
    .sort((a, b) => rankTrack(a) - rankTrack(b))

  for (const track of ranked.slice(0, 4)) {
    const json3Url = normalizeTimedTextUrl(track.baseUrl, videoId, 'json3')
    if (json3Url) {
      try {
        const res = await doFetch(json3Url, { headers: { 'User-Agent': ANDROID_UA }, signal })
        if (res.ok) {
          const raw = await res.text()
          if (raw.trim().startsWith('{')) {
            const cues = parseJson3Cues(raw)
            if (cues.length > 0) return { cues, language: track.languageCode }
          }
        }
      } catch {
        // try XML fallback below
      }
    }

    const xmlUrl = normalizeTimedTextUrl(track.baseUrl, videoId)
    if (xmlUrl) {
      try {
        const res = await doFetch(xmlUrl, { headers: { 'User-Agent': ANDROID_UA }, signal })
        if (res.ok) {
          const raw = await res.text()
          if (raw.includes('<text') || raw.includes('<p ')) {
            const cues = parseXmlCues(raw)
            if (cues.length > 0) return { cues, language: track.languageCode }
          }
        }
      } catch {
        // try next track
      }
    }
  }
  return undefined
}

function checkPlayability(player: PlayerResponse | undefined, videoId: string): {
  ok: boolean
  noCaptions: boolean
  blocked: boolean
  tracks: CaptionTrack[]
} {
  if (!player) return { ok: false, noCaptions: false, blocked: true, tracks: [] }
  const status = player.playabilityStatus?.status
  if (status === 'LOGIN_REQUIRED' || status === 'ERROR' || status === 'UNPLAYABLE') {
    return { ok: false, noCaptions: false, blocked: true, tracks: [] }
  }
  if (player.videoDetails?.videoId && player.videoDetails.videoId !== videoId) {
    return { ok: false, noCaptions: false, blocked: true, tracks: [] }
  }
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  if (status === 'OK' && tracks.length === 0) {
    return { ok: true, noCaptions: true, blocked: false, tracks: [] }
  }
  return { ok: tracks.length > 0, noCaptions: false, blocked: false, tracks }
}

async function fetchViaTransport(
  doFetch: FetchLike,
  videoId: string,
  source: CaptionSourceKind,
): Promise<VideoTranscript> {
  const signal = AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS)

  // Step 1: Fast path — Android Innertube player API
  let player = await callInnertubePlayer(doFetch, videoId, undefined, signal).catch(() => undefined)
  let check = checkPlayability(player, videoId)

  // Step 2: Watch page fallback (extracts INNERTUBE_API_KEY + ytInitialPlayerResponse)
  if (!check.ok) {
    const watchRes = await doFetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: CONSENT_COOKIE,
      },
      redirect: 'manual',
      signal,
    })

    if ([301, 302, 303, 307, 308].includes(watchRes.status)) {
      const location = watchRes.headers.get('location') ?? ''
      if (location.includes('/sorry') || location.includes('accounts.google.com')) {
        throw new ApiError(503, 'YouTube 触发了人机验证或访问限制。', 'BLOCKED')
      }
    }
    if (!watchRes.ok) {
      throw new ApiError(503, `YouTube 返回状态码 ${watchRes.status}。`, 'UPSTREAM_ERROR')
    }
    const html = await watchRes.text()
    if (html.includes('/sorry/index') || html.includes('g-recaptcha')) {
      throw new ApiError(503, 'YouTube 触发了人机验证。', 'BLOCKED')
    }

    const apiKey = /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/.exec(html)?.[1]
    if (apiKey) {
      const keyedPlayer = await callInnertubePlayer(doFetch, videoId, apiKey, signal).catch(() => undefined)
      const keyedCheck = checkPlayability(keyedPlayer, videoId)
      if (keyedCheck.ok || keyedCheck.noCaptions) {
        player = keyedPlayer
        check = keyedCheck
      }
    }

    if (!check.ok && !check.noCaptions) {
      const htmlPlayer = extractPlayerFromHtml(html)
      const htmlCheck = checkPlayability(htmlPlayer, videoId)
      if (htmlCheck.ok || htmlCheck.noCaptions) {
        player = htmlPlayer
        check = htmlCheck
      }
    }
  }

  if (check.noCaptions) {
    throw new ApiError(422, '该 YouTube 视频没有可用的公开字幕轨。', 'NO_CAPTIONS')
  }
  if (!check.ok || !player) {
    throw new ApiError(503, '暂时无法从 YouTube 获取播放器字幕信息。', 'BLOCKED')
  }

  const downloaded = await fetchTrackCues(doFetch, videoId, check.tracks, signal)
  if (!downloaded) {
    throw new ApiError(503, '已找到字幕轨，但未能读取字幕内容。', 'EMPTY_TRACK')
  }

  const lengthSeconds = Number(player.videoDetails?.lengthSeconds)
  const durationSeconds = Number.isSafeInteger(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds : undefined
  const timeline = parseDescriptionChapters(player.videoDetails?.shortDescription)

  return buildTranscriptFromCues(downloaded.cues, {
    videoId,
    title: player.videoDetails?.title || 'YouTube 视频',
    source,
    language: downloaded.language,
    durationSeconds,
    timeline,
  })
}

export function getArchivedTranscript(videoId: string): VideoTranscript | undefined {
  if (videoId !== archive.videoId) return undefined
  const lines = archive.text.split('\n')
  const markMap = new Map<number, string>()
  for (const item of archive.timeline ?? []) {
    if (item.firstCue > 0) {
      markMap.set(item.firstCue - 1, `[${item.at}${item.topic ? ' ' + item.topic : ''}]`)
    }
  }
  const formatted = lines
    .map((line, idx) => (markMap.has(idx) ? `${markMap.get(idx)}\n${line}` : line))
    .join('\n')

  return {
    videoId: archive.videoId,
    title: archive.title,
    source: 'archive',
    language: 'en',
    text: formatted,
    cueCount: archive.cueCount,
    durationSeconds: archive.durationSeconds,
    lastCaptionSeconds: archive.lastCaptionSeconds,
    timeline: archive.timeline?.map(({ at, topic, firstCue }) => ({ at, topic, firstCue })),
  }
}

function pickRandomSubset<T>(items: T[], limit: number): T[] {
  const copy = items.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, limit)
}

export interface FetchCaptionsOptions {
  proxyList?: string
  directFetch?: FetchLike
  socketConnector?: SocketConnector
}

/**
 * Fetches YouTube captions using:
 * 1. Rotating Webshare proxies via Cloudflare TCP Sockets (`cloudflare:sockets`) + TLS 1.3
 * 2. Direct `fetch()` fallback
 * 3. Hardcoded reference archive fallback for the demo video (`xRh2sVcNXQ8`)
 */
export async function fetchYouTubeCaptions(
  videoId: string,
  options: FetchCaptionsOptions = {},
): Promise<VideoTranscript> {
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new ApiError(400, '无效的 YouTube 视频 ID。', 'INVALID_URL')
  }

  const proxies = pickRandomSubset(parseProxyList(options.proxyList), MAX_PROXIES_PER_REQUEST)
  let lastError: unknown

  // 1. Try rotating Webshare proxies over Cloudflare Worker TCP Sockets
  for (const proxy of proxies) {
    try {
      const proxyFetcher = createProxyFetcher(proxy, options.socketConnector)
      return await fetchViaTransport(proxyFetcher, videoId, 'youtube-proxy')
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'NO_CAPTIONS' || error.code === 'CAPTION_TOO_LARGE')) {
        throw error
      }
      lastError = error
    }
  }

  // 2. Fallback to direct fetch
  const direct = options.directFetch ?? globalThis.fetch.bind(globalThis)
  try {
    return await fetchViaTransport(direct, videoId, 'youtube-direct')
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'NO_CAPTIONS' || error.code === 'CAPTION_TOO_LARGE')) {
      throw error
    }
    lastError = error
  }

  // 3. Hardcoded fallback for the reference demo video
  const archived = getArchivedTranscript(videoId)
  if (archived) return archived

  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(
    503,
    '暂时无法获取该视频的 YouTube 字幕（可能触发了验证限制或网络超时）。请稍后重试，或点击「填入示例链接」体验内置演示视频。',
    'CAPTION_UNAVAILABLE',
  )
}
