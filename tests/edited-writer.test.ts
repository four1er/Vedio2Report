import {afterEach, describe, expect, it, vi} from 'vitest'
import {expectsChineseArticle} from '../src/worker/edited-response'
import {writeArticle, type ArticleUpdate} from '../src/worker/gemini'
import type {Video} from '../src/worker/caption-source'
import type {Bindings} from '../src/worker/protocol'
import type {TranscriptInput} from '../src/worker/transcript-response'

const env = {GEMINI_API_KEY: 'editor-test'} as Bindings
const base: Video = {source: 'youtube', title: 'Sensor calibration', videoId: 'testVideo01',
  text: 'Maya: Why take a second reading?\nLeo: Well, um, I used two sensors.\nThe second sensor detected a two-degree drift.\nMaya: Does the result hold outdoors?'}
const titles = {articleTitle: '如何复核温度', chapterTitle: '校准温度计'}
const signal = () => new AbortController().signal
const group = (id: number, through: number, text: string, speaker = '', heading = '') =>
  ({id, through, heading, speaker, text})

function frame(content: string, stop = false) {
  return 'data: ' + JSON.stringify({candidates: [{content: {parts: [{text: content}]}, ...(stop && {finishReason: 'STOP'})}]}) + '\n\n'
}
function complete(rows: object[]) {
  return new Response(frame(JSON.stringify({...titles, units: rows}), true))
}
function mock(reply: (input: TranscriptInput, n: number) => Response) {
  const requests: TranscriptInput[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body))
    const input = JSON.parse(payload.contents[0].parts[0].text) as TranscriptInput
    const itemSchema = payload.generationConfig.responseSchema.properties.units.items
    expect(itemSchema.required).toContain('through')
    const bounds = {minimum: input.units[0].id, maximum: input.units.at(-1)!.id}
    expect(itemSchema.properties.id).toMatchObject(bounds)
    expect(itemSchema.properties.through).toMatchObject(bounds)
    expect(input.units.every(unit => !('firstCue' in unit) && !('lastCue' in unit))).toBe(true)
    requests.push(input)
    return reply(input, requests.length)
  })
  return requests
}
function track() {
  const events: ArticleUpdate[] = []
  return {
    events,
    markdown: () => events.filter((e): e is string => typeof e === 'string').join(''),
    coverage: () => events.flatMap(e => typeof e !== 'string' && 'coverage' in e ? [e.coverage.completed] : []),
    chapters: () => events.filter(e => typeof e !== 'string' && 'chapterEnd' in e).length,
    async read(video = base) {
      for await (const event of writeArticle(env, {video}, signal())) events.push(event)
    },
  }
}
afterEach(() => vi.unstubAllGlobals())

describe('source-grounded edited articles', () => {
  it('uses Chinese for a default article and honours explicit output languages', () => {
    expect(expectsChineseArticle('')).toBe(true)
    expect(expectsChineseArticle('给初学者，保留数字')).toBe(true)
    expect(expectsChineseArticle('write this in English')).toBe(false)
    expect(expectsChineseArticle('请用荷兰语写')).toBe(false)
    expect(expectsChineseArticle('请用中文写')).toBe(true)
    expect(expectsChineseArticle('用中文整理，英文商标保留')).toBe(true)
    expect(expectsChineseArticle('保留术语的原拼写，专名用英文')).toBe(true)
    expect(expectsChineseArticle('For beginners, keep brand names in English')).toBe(true)
    expect(expectsChineseArticle('英文输出，保留产品名')).toBe(false)
  })

  it('publishes a polished question and a joined answer before the last turn and before STOP', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    const requests = mock(() => new Response(new ReadableStream({start(controller) { upstream = controller }})))
    const article = track()
    const reading = article.read()
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].units.map(u => u.id)).toEqual([1, 2, 3, 4])
    const rows = [group(1, 1, '为什么要再测一次？', 'Maya', '测量误差'),
      group(2, 3, '我用了两个传感器。第二个测出了两度偏差。', 'Leo'),
      group(4, 4, '在室外这个结果还成立吗？', 'Maya')]
    const reply = JSON.stringify({...titles, units: rows})
    const cut = reply.indexOf(JSON.stringify(rows[2]))
    upstream.enqueue(encoder.encode(frame(reply.slice(0, cut))))
    await vi.waitFor(() => expect(article.coverage()).toEqual([0, 1, 2, 3]))
    expect(article.markdown()).toContain('**Maya：** 为什么要再测一次？\n\n**Leo：** 我用了两个传感器。第二个测出了两度偏差。')
    expect(article.chapters()).toBe(0)
    upstream.enqueue(encoder.encode(frame(reply.slice(cut), true)))
    upstream.close()
    await reading
    expect(article.markdown()).toContain('**Maya：** 在室外这个结果还成立吗？')
    expect(article.markdown()).not.toMatch(/小结|5W1H/)
    expect(article.coverage()).toEqual([0, 1, 2, 3, 4])
    expect(article.chapters()).toBe(1)
  })

  it('restarts a malformed merged response at the first uncovered ID, without replaying a published paragraph', async () => {
    const video = {...base, text: 'Start here.\nMeasure twice.\nWait ten minutes.\nCheck again.'}
    const requests = mock((input, n) => n === 1 ?
      complete([group(1, 2, '先测两次。'), group(4, 4, '重新核对。')]) :
      complete([group(input.units[0].id, input.units.at(-1)!.id, '等待十分钟后重新核对。')]))
    const article = track()
    await article.read(video)
    expect(requests.map(input => input.units.map(unit => unit.id))).toEqual([[1, 2, 3, 4], [3, 4]])
    expect(article.markdown().match(/先测两次/g)).toHaveLength(1)
    expect(article.coverage()).toEqual([0, 1, 2, 3, 4])
    expect(article.chapters()).toBe(1)
  })

  it('passes an open question across a publisher chapter cut without repeating a subheading over the answer', async () => {
    const video = {...base, text: 'Maya: What did the sensor measure?\nFirst I used two sensors.\nThey differed by two degrees.',
      timeline: [{at: '0:00', firstCue: 1, topic: 'Question'}, {at: '1:00', firstCue: 2, topic: 'Results'}]}
    const requests = mock(input => {
      const first = input.units[0].id
      return first === 1
        ? complete([group(1, 1, '测出了什么？', 'Maya', '测量结果')])
        : complete([group(first, input.units.at(-1)!.id, '两个传感器测出了两度偏差。', 'Leo', '对比传感器')])
    })
    const article = track()
    await article.read(video)
    expect(requests[1]).toMatchObject({previousTopic: {question: '测出了什么？'}})
    expect(article.markdown().match(/^### .+$/gm)).toEqual(['### 测量结果'])
    expect(article.chapters()).toBe(2)
  })

  it('recovers from successive title, speaker-boundary and range errors by isolating one unit', async () => {
    const video = {...base, text: 'Maya: Why ask twice?\nLeo: I compared the cost.\nThe change was small.\nOnly in good weather.'}
    const requests = mock((input, n) => {
      if (n === 1) return new Response(frame(JSON.stringify({...titles,
        chapterTitle: 'Can Companies Recover Their Cost Of Production In The Winter?',
        units: [group(1, 1, '为什么问两次？'), group(2, 4, '我比较过成本。')]}), true))
      if (n === 2) return complete([group(1, 2, '为什么问两次？', 'Maya')])
      if (n === 3) return complete([group(1, 2, '为什么问两次？', 'Maya')])
      if (input.units[0].id === 1) return complete([group(1, 1, '为什么问两次？', 'Maya')])
      return complete([group(input.units[0].id, input.units.at(-1)!.id, '我比较过成本，只有好天气的变化很小。', 'Leo')])
    })
    const article = track()
    await article.read(video)
    expect(requests.slice(0, 4).map(input => input.units.map(unit => unit.id))).toEqual([[1, 2, 3, 4], [1, 2], [1], [1]])
    expect(requests[2].repair).not.toContain('1 至 2')
    expect(article.coverage()).toEqual([0, 1, 2, 3, 4])
    expect(article.markdown().match(/为什么问两次/g)).toHaveLength(1)
  })

  it('preserves coverage while genuine filler-only chapters create neither Markdown nor chapter jobs', async () => {
    const video = {...base, text: '[Music]\nDrift happens when the sensor gets warm.\n[Music]', timeline: [
      {at: '0:00', firstCue: 1, topic: 'Intro'}, {at: '0:05', firstCue: 2, topic: 'Sensor drift'},
      {at: '0:55', firstCue: 3, topic: 'Credits'},
    ]}
    mock(input => { const {id} = input.units[0]; return complete([group(id, id, id === 2 ? '传感器受热时会发生漂移。' : '')]) })
    const article = track()
    await article.read(video)
    expect(article.markdown()).toBe('# 如何复核温度\n\n## [0:05] 校准温度计\n\n传感器受热时会发生漂移。')
    expect(article.coverage()).toEqual([0, 1, 2, 3])
    expect(article.chapters()).toBe(1)
  })

  it('repairs an empty record that tries to drop the speaker’s substantive qualification', async () => {
    const video = {...base, text: 'This estimate holds only in dry conditions.'}
    const requests = mock((_input, n) => complete([group(1, 1, n === 1 ? '' : '这个估计只适用于干燥条件。')]))
    const article = track()
    await article.read(video)
    expect(requests).toHaveLength(2)
    expect(article.markdown()).toContain('只适用于干燥条件')
    expect(article.coverage()).toEqual([0, 1])
  })

  it('finishes an all-noise source with an explicit message and no empty article', async () => {
    mock(() => complete([group(1, 1, '')]))
    const article = track()
    await expect(article.read({...base, text: '[Music]'})).rejects.toThrow('没有可整理成正文的实质发言')
    expect(article.markdown()).toBe('')
    expect(article.chapters()).toBe(0)
  })
})
