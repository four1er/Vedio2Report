import { afterEach, expect, it, vi } from 'vitest'
import { discoverNative, pollNative } from '../src/worker/native-captions'

const videoId = 'AbC123deF45'
const transcript = {lang: 'en', content: [
  {text: ' A public\ncaption ', offset: 40, duration: 410},
  {text: 'next line', offset: 1020, duration: 110},
]}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('sends only the exact YouTube URL in native mode and uses the downloaded timed captions once', async () => {
  const get = vi.fn<typeof fetch>().mockResolvedValue(Response.json(transcript))
  vi.stubGlobal('fetch', get)
  const track = await discoverNative(videoId, 'local-test')
  expect(track).toEqual({videoId, language: 'en', cues: [
    {text: 'A public caption', start: 40, duration: 410},
    {text: 'next line', start: 1020, duration: 110},
  ]})
  expect(get).toHaveBeenCalledTimes(1)
  const [input, init] = get.mock.calls[0]
  const url = new URL(String(input))
  expect(url.origin + url.pathname).toBe('https://api.supadata.ai/v1/transcript')
  expect(Object.fromEntries(url.searchParams)).toEqual({url: 'https://www.youtube.com/watch?v=' + videoId, mode: 'native', text: 'false'})
  expect(init).toMatchObject({redirect: 'manual', headers: {'x-api-key': 'local-test'}})
})

it('returns an accepted handle immediately and only reads that handle for later polls', async () => {
  const get = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({jobId: 'job-1'}, {status: 202}))
    .mockResolvedValueOnce(Response.json({status: 'active'}))
    .mockResolvedValueOnce(Response.json({status: 'completed', ...transcript}))
  vi.stubGlobal('fetch', get)
  expect(await discoverNative(videoId, 'local-test')).toEqual({jobId: 'job-1'})
  expect(get).toHaveBeenCalledTimes(1)
  expect(await pollNative(videoId, 'job-1', 'local-test')).toBeUndefined()
  expect((await pollNative(videoId, 'job-1', 'local-test'))?.cues).toHaveLength(2)
  expect(get.mock.calls.slice(1).map(([input]) => String(input))).toEqual(Array(2).fill('https://api.supadata.ai/v1/transcript/job-1'))
})

it.each([
  [206, {error: 'transcript-unavailable'}, 'NO_CAPTIONS'],
  [206, {}, 'TEMPORARY'],
  [404, {error: 'not-found'}, 'SOURCE_UNVERIFIED'],
  [403, {error: 'forbidden'}, 'SOURCE_UNVERIFIED'],
  [503, {error: 'transcript-unavailable'}, 'TEMPORARY'],
  [429, {error: 'rate-limit-exceeded'}, 'TEMPORARY'],
  [200, {content: []}, 'SOURCE_UNVERIFIED'],
  [200, {content: [{text: ' '}]}, 'SOURCE_UNVERIFIED'],
  [200, {...transcript, videoId: 'DifferentID'}, 'TEMPORARY'],
  [202, {jobId: 'https://example.test/steal'}, 'TEMPORARY'],
  [307, {}, 'TEMPORARY'],
] as const)('classifies status %s body %j as %s without falling back to AI transcription', async (status, body, code) => {
  const get = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, {status}))
  vi.stubGlobal('fetch', get)
  await expect(discoverNative(videoId, 'local-test')).rejects.toMatchObject({code})
  expect(get).toHaveBeenCalledTimes(1)
})

it('requires a valid video ID and a configured server-side key before contacting the provider', async () => {
  const get = vi.fn()
  vi.stubGlobal('fetch', get)
  await expect(discoverNative('https://example.test', 'local-test')).rejects.toMatchObject({status: 400})
  await expect(discoverNative(videoId, ' ')).rejects.toMatchObject({code: 'SOURCE_UNVERIFIED'})
  expect(get).not.toHaveBeenCalled()
})
