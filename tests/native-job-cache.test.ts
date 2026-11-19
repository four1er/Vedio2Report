import { afterEach, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { CaptionCache } from '../src/worker/caption-cache'
import { memoryStorage } from './memory-storage'

const videoId = 'AbC123deF45'
const jobId = 'job-server-only'
const key = 'local-provider-key'
const cue = '该视频的已发布字幕。'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['challenged player', 'unreadable track', 'expired job'])('keeps a single durable native lookup across restarts for a %s', async scenario => {
  const requests: string[] = []
  let polls = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push(url.origin + url.pathname)
    if (url.hostname === 'www.youtube.com' && url.pathname === '/watch') {
      if (scenario !== 'unreadable track') return Response.redirect('https://www.google.com/sorry/index')
      const player = {videoDetails: {videoId, title: '普通视频'}, playabilityStatus: {status: 'OK'},
        captions: {playerCaptionsTracklistRenderer: {captionTracks: [
          {languageCode: 'zh', baseUrl: 'https://www.youtube.com/api/timedtext?v=' + videoId},
        ]}}}
      return new Response('var ytInitialPlayerResponse = ' + JSON.stringify(player))
    }
    if (url.origin + url.pathname === 'https://www.youtube.com/api/timedtext')
      return new Response(null, {status: 503})
    expect(url.origin).toBe('https://api.supadata.ai')
    expect(new Headers(init?.headers).get('x-api-key')).toBe(key)
    if (url.pathname === '/v1/transcript') {
      expect(url.searchParams.get('url')).toBe('https://www.youtube.com/watch?v=' + videoId)
      expect(url.searchParams.get('mode')).toBe('native')
      return Response.json({jobId}, {status: 202})
    }
    expect(url.pathname).toBe('/v1/transcript/' + jobId)
    expect(url.search).toBe('')
    polls++
    if (polls === 1) return Response.json({status: 'queued'})
    if (polls === 2) return new Response(null, {status: 503})
    return Response.json({status: 'completed', content: [{text: cue, offset: 1500, duration: 1500}], lang: 'zh'})
  })

  // Keep persistent storage while discarding each in-memory DO instance.
  const storage = memoryStorage()
  const create = () => new CaptionCache({storage} as unknown as DurableObjectState, {SUPADATA_API_KEY: key})
  let cache = create()
  const request = (action: 'prepare' | 'source' | 'status') =>
    cache.fetch(new Request('https://captions/' + action + '/' + videoId, {method: action === 'prepare' ? 'POST' : 'GET'}))
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const alarm = async () => {
    const wake = await storage.getAlarm()
    expect(wake).not.toBeNull()
    clock.mockReturnValue(wake!)
    await cache.alarm()
  }

  const both = await Promise.all([request('prepare'), request('prepare')])
  for (const response of both) {
    expect(response.status).toBe(202)
    expect((await response.json()).status).toBe(scenario === 'unreadable track' ? 'pending' : 'checking')
  }
  if (scenario === 'expired job') {
    cache = create()
    clock.mockReturnValue(Date.now() + 86_400_000)
    await cache.alarm()
    const expired = await request('prepare')
    expect(expired.status).toBe(503)
    expect(await expired.json()).toMatchObject({code: 'TEMPORARY'})
    expect(requests).toEqual(['https://www.youtube.com/watch', 'https://api.supadata.ai/v1/transcript'])
    return
  }
  if (scenario === 'unreadable track') await alarm()
  for (let i = 0; i < 3; i++) {
    cache = create()
    const beforeRead = requests.length
    for (const action of ['prepare', 'status', 'source'] as const) {
      const response = await request(action)
      expect(response.status).toBe(202)
      const body = await response.text()
      expect(JSON.parse(body)).toMatchObject({status: 'checking', videoId})
      expect(body).not.toContain(jobId)
      expect(body).not.toContain(key)
      expect(body).not.toContain(cue)
    }
    expect(requests).toHaveLength(beforeRead)
    await alarm()
  }

  cache = create()
  const source = await request('source')
  expect(source.status).toBe(200)
  expect(await source.json()).toMatchObject({source: 'native-api', text: cue, cueCount: 1, lastCaptionSeconds: 3})
  const publicResult = await request('prepare')
  expect(await publicResult.json()).toMatchObject({videoId, status: 'ready', source: 'native-api'})
  expect(requests.filter(url => url === 'https://www.youtube.com/watch')).toHaveLength(1)
  expect(requests.filter(url => url === 'https://api.supadata.ai/v1/transcript')).toHaveLength(1)
  expect(polls).toBe(3)
})

it('finishes a native lookup via the public Worker and real SQLite alarms without forwarding its credential on redirects', async () => {
  const script = buildSync({entryPoints: ['src/worker/index.ts'], bundle: true, write: false,
    format: 'esm', target: 'es2022'}).outputFiles[0].text
  const calls: string[] = []
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', cf: false, compatibilityDate: '2026-06-01', modules: true, script,
    bindings: {SUPADATA_API_KEY: key},
    durableObjects: {ARTICLES: {className: 'ArticleSession', useSQLite: true}, CAPTION_CACHE: {className: 'CaptionCache', useSQLite: true}},
    outboundService: async request => {
      const url = new URL(request.url)
      calls.push(url.origin + url.pathname)
      if (url.origin === 'https://www.youtube.com' && url.pathname === '/watch')
        return Response.redirect('https://www.google.com/sorry/index')
      expect(url.origin).toBe('https://api.supadata.ai')
      expect(request.headers.get('x-api-key')).toBe(key)
      if (url.pathname === '/v1/transcript') {
        expect(url.searchParams.get('mode')).toBe('native')
        expect(url.searchParams.get('url')).toBe('https://www.youtube.com/watch?v=' + videoId)
        return Response.json({jobId}, {status: 202})
      }
      expect(url.pathname).toBe('/v1/transcript/' + jobId)
      if (calls.length === 3) return Response.redirect('https://elsewhere.example/credentials', 307)
      return Response.json({status: 'completed', content: [{text: cue, offset: 1000, duration: 2000}]})
    },
  }))
  const api = 'https://example.test/api/captions'
  try {
    const response = await runtime.dispatchFetch(api, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: 'https://youtu.be/' + videoId})})
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({status: 'checking', videoId})
    await vi.waitFor(async () => {
      const status = await runtime.dispatchFetch(api + '/' + videoId)
      const data = await status.json()
      expect(status.status, JSON.stringify({data, calls})).toBe(200)
      expect(data).toMatchObject({status: 'ready', source: 'native-api', cueCount: 1, lastCaptionSeconds: 3})
    }, {timeout: 20_000, interval: 250})
    expect(calls).toEqual(['https://www.youtube.com/watch', 'https://api.supadata.ai/v1/transcript',
      'https://api.supadata.ai/v1/transcript/' + jobId, 'https://api.supadata.ai/v1/transcript/' + jobId])
  } finally {
    await runtime.dispose()
  }
}, 25_000)
