import { describe, expect, it } from 'vitest'
import {
  fetchYouTubeCaptions,
  getArchivedTranscript,
  parseJson3Cues,
  parseVideoId,
  parseXmlCues,
} from '../src/worker/captions'
import type { FetchLike } from '../src/worker/proxy-http'

describe('parseVideoId', () => {
  it('accepts standard watch, short, shorts, live, embed, nocookie, and raw IDs', () => {
    const id = 'xRh2sVcNXQ8'
    expect(parseVideoId(id)).toBe(id)
    expect(parseVideoId(`https://www.youtube.com/watch?v=${id}&t=42s`)).toBe(id)
    expect(parseVideoId(`https://youtu.be/${id}`)).toBe(id)
    expect(parseVideoId(`https://www.youtube.com/shorts/${id}`)).toBe(id)
    expect(parseVideoId(`https://www.youtube.com/live/${id}`)).toBe(id)
    expect(parseVideoId(`https://www.youtube.com/embed/${id}`)).toBe(id)
    expect(parseVideoId(`https://www.youtube-nocookie.com/embed/${id}`)).toBe(id)
    expect(parseVideoId(`https://m.youtube.com/watch?v=${id}`)).toBe(id)
  })

  it('rejects non-YouTube URLs and malformed IDs', () => {
    expect(() => parseVideoId('https://example.com/watch?v=xRh2sVcNXQ8')).toThrow()
    expect(() => parseVideoId('https://www.youtube.com/watch?v=short')).toThrow()
    expect(() => parseVideoId('https://user:pass@www.youtube.com/watch?v=xRh2sVcNXQ8')).toThrow()
    expect(() => parseVideoId('not a url')).toThrow()
  })
})

describe('caption cue parsers', () => {
  it('parses json3 events cleanly', () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'Hello ' }, { utf8: 'world\n' }] },
        { tStartMs: 2500, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
        { tStartMs: 4000, dDurationMs: 3000, segs: [{ utf8: 'Second line' }] },
      ],
    })
    expect(parseJson3Cues(raw)).toEqual([
      { text: 'Hello world', startMs: 0, durationMs: 2500 },
      { text: 'Second line', startMs: 4000, durationMs: 3000 },
    ])
  })

  it('parses classic <text> and srv3 <p> XML captions with HTML entity decoding', () => {
    const xml = '<transcript><text start="1.2" dur="2.5">AI &amp; ML&#39;s &quot;future&quot;</text></transcript>'
    expect(parseXmlCues(xml)).toEqual([
      { text: 'AI & ML\'s "future"', startMs: 1200, durationMs: 2500 },
    ])

    const srv3 = '<timedtext><body><p t="5000" d="1500"><s>Line &lt;1&gt;</s></p></body></timedtext>'
    expect(parseXmlCues(srv3)).toEqual([{ text: 'Line <1>', startMs: 5000, durationMs: 1500 }])
  })
})

describe('fetchYouTubeCaptions', () => {
  it('fetches via Android Innertube API and parses description chapters', async () => {
    const videoId = 'AbC123deF45'
    const mockFetch: FetchLike = async input => {
      const url = new URL(String(input))
      if (url.pathname === '/youtubei/v1/player') {
        return Response.json({
          playabilityStatus: { status: 'OK' },
          videoDetails: {
            videoId,
            title: 'Test Talk',
            lengthSeconds: '120',
            shortDescription: '0:00 Intro\n1:00 Deep Dive',
          },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                { baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en', kind: 'asr' },
                { baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=zh`, languageCode: 'zh' },
              ],
            },
          },
        })
      }
      expect(url.searchParams.get('lang')).toBe('zh')
      expect(url.searchParams.get('fmt')).toBe('json3')
      return Response.json({
        events: [
          { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: '大家好，欢迎来到今天的分享。' }] },
          { tStartMs: 35000, dDurationMs: 2000, segs: [{ utf8: '我们来看第二个核心问题。' }] },
        ],
      })
    }

    const result = await fetchYouTubeCaptions(videoId, { directFetch: mockFetch })
    expect(result.source).toBe('youtube-direct')
    expect(result.language).toBe('zh')
    expect(result.title).toBe('Test Talk')
    expect(result.cueCount).toBe(2)
    expect(result.timeline).toEqual([
      { at: '0:00', topic: 'Intro' },
      { at: '1:00', topic: 'Deep Dive' },
    ])
    expect(result.text).toContain('[0:00] 大家好')
    expect(result.text).toContain('[0:35] 我们来看第二个核心问题')
  })

  it('falls back to Watch Page + keyed Innertube when unkeyed Innertube is blocked', async () => {
    const videoId = 'XyZ987wVu65'
    const calls: string[] = []
    const mockFetch: FetchLike = async input => {
      const url = new URL(String(input))
      calls.push(url.pathname + url.search)
      if (url.pathname === '/youtubei/v1/player' && !url.searchParams.get('key')) {
        return Response.json({ playabilityStatus: { status: 'LOGIN_REQUIRED' } })
      }
      if (url.pathname === '/watch') {
        return new Response('<html><script>{"INNERTUBE_API_KEY":"key123"}</script></html>')
      }
      if (url.pathname === '/youtubei/v1/player' && url.searchParams.get('key') === 'key123') {
        return Response.json({
          playabilityStatus: { status: 'OK' },
          videoDetails: { videoId, title: 'Watch Fallback Talk', lengthSeconds: '60' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [{ baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en' }],
            },
          },
        })
      }
      // json3 empty -> XML fallback
      if (url.searchParams.get('fmt') === 'json3') return new Response('')
      return new Response('<transcript><text start="0" dur="3">Recovered via XML</text></transcript>')
    }

    const result = await fetchYouTubeCaptions(videoId, { directFetch: mockFetch })
    expect(result.title).toBe('Watch Fallback Talk')
    expect(result.text).toContain('Recovered via XML')
    expect(calls.some(c => c.includes('key=key123'))).toBe(true)
  })

  it('throws NO_CAPTIONS (422) when player confirms no caption tracks exist', async () => {
    const videoId = 'NoCap123456'
    const okNoTracks = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId, title: 'Silent Video' } }
    const mockFetch: FetchLike = async input => {
      const url = new URL(String(input))
      if (url.pathname === '/youtubei/v1/player') return Response.json(okNoTracks)
      return new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(okNoTracks)};</script>`)
    }

    await expect(fetchYouTubeCaptions(videoId, { directFetch: mockFetch })).rejects.toMatchObject({
      status: 422,
      code: 'NO_CAPTIONS',
    })
  })

  it('gracefully falls back to hardcoded reference archive for xRh2sVcNXQ8 when network is blocked', async () => {
    const blockedFetch: FetchLike = async () =>
      new Response(null, { status: 302, headers: { Location: 'https://www.google.com/sorry/index' } })

    const result = await fetchYouTubeCaptions('xRh2sVcNXQ8', { directFetch: blockedFetch })
    expect(result.source).toBe('archive')
    expect(result.cueCount).toBe(2801)
    expect(result.timeline?.length).toBe(12)
    expect(getArchivedTranscript('xRh2sVcNXQ8')?.videoId).toBe('xRh2sVcNXQ8')
  })

  it('rotates across configured proxies when a proxy connection fails before succeeding', async () => {
    const videoId = 'Prx12345678'
    const triedHosts: string[] = []
    const mockConnector = ({ hostname }: { hostname: string; port: number }) => {
      triedHosts.push(hostname)
      if (triedHosts.length === 1) {
        return {
          async read() {
            throw new Error('ECONNRESET')
          },
          async write() {},
          async close() {},
        }
      }
      // Second proxy returns 407 -> triggers fallback to directFetch which succeeds
      const reply = new TextEncoder().encode('HTTP/1.1 407 Proxy Auth Required\r\n\r\n')
      let sent = false
      return {
        async read() {
          if (sent) return null
          sent = true
          return reply
        },
        async write() {},
        async close() {},
      }
    }

    const directFetch: FetchLike = async input => {
      const url = new URL(String(input))
      if (url.pathname === '/youtubei/v1/player') {
        return Response.json({
          playabilityStatus: { status: 'OK' },
          videoDetails: { videoId, title: 'Fallback Success' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [{ baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en' }],
            },
          },
        })
      }
      return Response.json({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello after proxy rotation' }] }] })
    }

    const result = await fetchYouTubeCaptions(videoId, {
      proxyList: '10.0.0.1:8000:u1:p1\n10.0.0.2:8000:u2:p2',
      socketConnector: mockConnector,
      directFetch,
    })
    expect(new Set(triedHosts)).toEqual(new Set(['10.0.0.1', '10.0.0.2']))
    expect(result.text).toContain('Hello after proxy rotation')
  })
})
