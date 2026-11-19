import {buildSync} from 'esbuild'
import {convertV4MiniflareOptions, Miniflare} from 'miniflare'
import {expect, it, vi} from 'vitest'

it('reads a pinned publisher track after YouTube verification and exposes the ready result in workerd', async () => {
  const id = 'U3O1nzSojnc'
  const base = 'https://example.test/api/captions'
  const calls: string[] = []
  const script = buildSync({entryPoints: ['src/worker/index.ts'], bundle: true, write: false, format: 'esm'}).outputFiles[0].text
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, host: '127.0.0.1', cf: false, compatibilityDate: '2026-06-01',
    durableObjects: {
      ARTICLES: {className: 'ArticleSession', useSQLite: true},
      CAPTION_CACHE: {className: 'CaptionCache', useSQLite: true},
    },
    outboundService: async request => {
      const url = new URL(request.url)
      calls.push(url.hostname + url.pathname)
      if (url.hostname === 'www.youtube.com' && url.pathname === '/watch')
        return Response.redirect('https://www.google.com/sorry/index', 302)
      if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('/video_url.txt'))
        return new Response('https://youtu.be/' + id)
      if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('/english/captions.srt'))
        return new Response('1\n00:00:00,000 --> 00:00:01,500\nA sentence.\n')
      return new Response('Unexpected upstream request', {status: 404})
    },
  }))
  try {
    const prepared = await runtime.dispatchFetch(base, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: 'https://youtu.be/' + id}),
    })
    expect(prepared.status).toBe(202)
    await vi.waitFor(async () => {
      const response = await runtime.dispatchFetch(base + '/' + id)
      expect(await response.json()).toMatchObject({status: 'ready', videoId: id, source: 'published-captions', cueCount: 1})
    }, {timeout: 6500, interval: 150})
    expect(calls).toHaveLength(3)
    expect(calls[1]).toMatch(/^raw\.githubusercontent\.com\/3b1b\/captions\/[a-f0-9]{40}\/2024\/shorts\/cube-shadow-puzzle\/video_url.txt$/)
    expect(calls[2]).toBe(calls[1].replace('video_url.txt', 'english/captions.srt'))
  } finally { await runtime.dispose() }
}, 12000)
