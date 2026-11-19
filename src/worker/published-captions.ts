import { CaptionSourceError, parseVideoId, sourceFromCues, type Source } from './caption-source'
import index from './published-index.json'

// Only ID, publisher path and title are shipped. All caption text stays at its
// source until the per-video download job runs. The index and URLs share a revision.
const {revision} = index
const lessons: Record<string, string[]> = index.lessons

export interface PublishedDiscovery {
  kind: 'published'
  videoId: string
  title: string
}

export function discoverPublished(videoId: string): PublishedDiscovery | undefined {
  if (!Object.hasOwn(lessons, videoId)) return
  return {kind: 'published', videoId, title: lessons[videoId][1]}
}

async function readFile(url: string, limit: number, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {signal, redirect: 'manual'})
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel()
    throw new CaptionSourceError('TEMPORARY', '暂时无法下载发布者的字幕文件。')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: false})
  let size = 0, text = ''
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new CaptionSourceError('PERMANENT', '发布者的字幕文件超过读取上限。')
      }
      text += decoder.decode(value, {stream: true})
    }
  } finally { reader.releaseLock() }
}

function parseSrt(srt: string) {
  const stamp = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/
  function milliseconds(value: string): number {
    const match = stamp.exec(value)
    if (!match) return NaN
    const [, h, m, s, ms] = match
    return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms)
  }
  return srt.replace(/\r\n?/g, '\n').trim().split(/\n[\t ]*\n+/).map(block => {
    const [sequence, times, ...lines] = block.split('\n')
    const [from, to] = (times ?? '').trim().split(/\s+-->\s+/)
    const start = milliseconds(from), end = milliseconds(to)
    const text = lines.join(' ').replace(/<\/?[ibu]>/gi, '').replace(/\s+/g, ' ').trim()
    if (!/^\d+$/.test(sequence.trim()) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !text)
      throw new CaptionSourceError('SOURCE_UNVERIFIED', '发布者的字幕文件不含完整可读的时间条目。')
    // Some publisher cues have an inverted interval. Preserve the speech and
    // keep the unusable interval out of the source timeline.
    return end < start ? {text} : {text, start, duration: end - start}
  })
}

export async function downloadPublished(discovery: PublishedDiscovery): Promise<Source> {
  const {videoId} = discovery
  if (!Object.hasOwn(lessons, videoId)) throw new CaptionSourceError('SOURCE_UNVERIFIED', '没有与该视频对应的发布者字幕记录。')
  const [path, title] = lessons[videoId]
  const base = 'https://raw.githubusercontent.com/3b1b/captions/' + revision + '/' + path
  const signal = AbortSignal.timeout(12_000)
  try {
    const videoUrl = await readFile(base + '/video_url.txt', 256, signal)
    let associatedId: string | undefined
    try { associatedId = parseVideoId(videoUrl.trim()) } catch { /* verify the ID below */ }
    if (associatedId !== videoId) throw new CaptionSourceError('SOURCE_UNVERIFIED', '发布者标注的视频与所提交的链接不匹配。')
    const track = await readFile(base + '/english/captions.srt', 2_000_000, signal)
    return sourceFromCues(parseSrt(track), {
      source: 'published-captions', title, sourceLabel: '3Blue1Brown 发布的英文字幕',
      sourceUrl: 'https://github.com/3b1b/captions/blob/' + revision + '/' + path + '/english/captions.srt',
    })
  } catch (error) {
    if (error instanceof CaptionSourceError) throw error
    throw new CaptionSourceError('TEMPORARY', '暂时无法读取发布者的字幕文件，请稍后重试。')
  }
}
