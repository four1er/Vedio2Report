import { afterEach, expect, it, vi } from 'vitest'
import { discoverPublished, downloadPublished } from '../src/worker/published-captions'

afterEach(() => vi.unstubAllGlobals())

const id = 'U3O1nzSojnc'
const discovered = discoverPublished(id)!
const syntheticSrt = '1\r\n00:00:00,250 --> 00:00:01,500\r\nAn <i>example</i>.\r\n\r\n2\r\n00:00:04,100 --> 00:00:06,850\r\nOne more\r\nline.\r\n'

it('discovers two unrelated published tracks using metadata alone', () => {
  vi.stubGlobal('fetch', vi.fn())
  expect(discovered).toEqual({kind: 'published', videoId: id, title: 'The cube shadow puzzle'})
  expect(discoverPublished('xJwkj25fFK4')?.title).toContain('Mandelbrot')
  expect(discoverPublished('constructor')).toBeUndefined()
  expect(discoverPublished('00000000000')).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})

it('checks the publisher’s video association and downloads its separate, pinned SRT', async () => {
  const http = vi.fn().mockResolvedValueOnce(new Response('https://youtube.com/shorts/' + id))
    .mockResolvedValueOnce(new Response(syntheticSrt))
  vi.stubGlobal('fetch', http)
  const source = await downloadPublished(discovered)
  expect(source).toMatchObject({source: 'published-captions', text: 'An example.\nOne more line.',
    title: 'The cube shadow puzzle', cueCount: 2, lastCaptionSeconds: 6})
  expect(source.durationSeconds).toBeUndefined()
  expect(source.sourceUrl).toMatch(/^https:\/\/github.com\/3b1b\/captions\/blob\/[a-f0-9]{40}\/2024\/shorts\/cube-shadow-puzzle\/english\/captions.srt$/)
  const base = source.sourceUrl!.replace('github.com/3b1b/captions/blob', 'raw.githubusercontent.com/3b1b/captions').replace('/english/captions.srt', '')
  expect(http.mock.calls.map(([url]) => url)).toEqual([base + '/video_url.txt', base + '/english/captions.srt'])
})

it('rejects another video’s published captions before any subtitle download', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('https://youtu.be/xJwkj25fFK4')))
  await expect(downloadPublished(discovered)).rejects.toMatchObject({code: 'SOURCE_UNVERIFIED'})
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(['', '1\nnot a timestamp\ninvalid track', syntheticSrt + '\n3\n00:00:07,000 --> 00:00:08,000\n'])(
  'rejects an empty, malformed or partially readable track', async srt => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('https://youtu.be/' + id))
      .mockResolvedValueOnce(new Response(srt)))
    await expect(downloadPublished(discovered)).rejects.toMatchObject({code: 'SOURCE_UNVERIFIED'})
  })

it('retains actual speech when a published SRT has an inverted timestamp', async () => {
  const track = '1\n00:00:04,000 --> 00:00:01,000\nAn observation.'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('https://youtu.be/' + id))
    .mockResolvedValueOnce(new Response(track)))
  const source = await downloadPublished(discovered)
  expect(source.text).toBe('An observation.')
  expect(source.cueCount).toBe(1)
  expect(source.lastCaptionSeconds).toBeUndefined()
  expect(source.timeline).toBeUndefined()
})

it('keeps a temporary download failure eligible for the existing background retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('https://youtu.be/' + id))
    .mockResolvedValueOnce(new Response(null, {status: 503})))
  await expect(downloadPublished(discovered)).rejects.toMatchObject({code: 'TEMPORARY'})
})


it('rejects redirects and partial HTTP 206 responses without reading a different or incomplete file', async () => {
  for (const response of [
    Response.redirect('https://example.test/other-video.srt'),
    new Response(syntheticSrt, {status: 206}),
  ]) {
    const http = vi.fn().mockResolvedValueOnce(new Response('https://youtu.be/' + id)).mockResolvedValueOnce(response)
    vi.stubGlobal('fetch', http)
    await expect(downloadPublished(discovered)).rejects.toMatchObject({code: 'TEMPORARY'})
    expect(http.mock.calls.every(([, options]) => options.redirect === 'manual')).toBe(true)
    expect(http).toHaveBeenCalledTimes(2)
  }
})
