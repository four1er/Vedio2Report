import { describe, expect, it } from 'vitest'
import type { Video } from '../src/worker/caption-source'
import { planTranscript } from '../src/worker/transcript-plan'

const base: Video = {title: '访谈', videoId: '12345678901', source: 'youtube', text: ''}
const compact = (text: string) => text.replace(/\s/gu, '')

function check(video: Video, chapterCount?: number) {
  const chapters = planTranscript(video, chapterCount)
  const batches = chapters.flatMap(chapter => chapter.batches)
  const units = batches.flat()
  expect(compact(units.map(unit => unit.text).join(''))).toBe(compact(video.text))
  expect(units.map(unit => unit.id)).toEqual(units.map((_, i) => i + 1))
  for (const batch of batches) {
    expect(batch.length).toBeGreaterThan(0)
    expect(batch.length).toBeLessThanOrEqual(20)
    expect(batch.reduce((n, unit) => n + unit.text.length, 0)).toBeLessThanOrEqual(3000)
    for (const unit of batch) {
      expect(unit.text.length).toBeLessThanOrEqual(380)
      expect(unit.firstCue).toBeLessThanOrEqual(unit.lastCue)
      expect(unit.text.isWellFormed()).toBe(true)
    }
  }
  return {chapters, batches, units}
}

describe('full transcript source coverage', () => {
  it('keeps repeated cues, groups short cues and separates explicit speaker turns even mid-cue', () => {
    const video = {...base, text: 'Jen: Why?\n>> yes\nyes\nso yes. >> Why again?\n\nMark: Because.'}
    const {units} = check(video)
    expect(units.map(u => [u.firstCue, u.lastCue, u.text])).toEqual([
      [1, 1, 'Jen: Why?'], [2, 4, '>> yes\nyes\nso yes.'], [4, 4, '>> Why again?'], [6, 6, 'Mark: Because.'],
    ])
  })

  it('keeps sentence-aligned cue cuts available for unmarked changes of speaker', () => {
    const {units} = check({...base, text: 'I will leave it\nthere.\nOur audience sent questions.\n请问第一个问题？\n我的回答很简单。'})
    expect(units.map(unit => unit.text)).toEqual([
      'I will leave it\nthere.', 'Our audience sent questions.', '请问第一个问题？', '我的回答很简单。',
    ])
  })

  it('splits oversized untimed captions, even a single line of surrogate pairs, without clipping the end', () => {
    const video = {...base, text: '开头。' + '🪐🌊'.repeat(9000) + '最后一句。'}
    const {chapters, batches, units} = check(video)
    expect(chapters.length).toBeGreaterThan(2)
    expect(chapters.every(ch => !ch.at)).toBe(true)
    expect(batches.length).toBeGreaterThan(chapters.length)
    expect(units.every(unit => unit.firstCue === 1 && unit.lastCue === 1)).toBe(true)
    expect(units.at(-1)?.text).toContain('最后一句。')
  })

  it('uses publisher topic boundaries and retains introductory cues before the first timecode', () => {
    const {chapters} = check({...base, text: 'intro\nfirst\nnext\nlast', timeline: [
      {firstCue: 2, at: '0:03', topic: '对话'}, {firstCue: 4, at: '6:50', topic: '结尾'},
      {firstCue: 10, at: '7:00', topic: '无对应字幕'},
    ]})
    expect(chapters.map(chapter => [chapter.at, chapter.topic])).toEqual([
      [undefined, undefined], ['0:03', '对话'], ['6:50', '结尾'],
    ])
    expect(chapters.map(chapter => chapter.batches.flat()[0].firstCue)).toEqual([1, 2, 4])
  })

  it('puts a complete question in its publisher chapter when the timestamp falls halfway through it', () => {
    const video = {...base, text: [
      'We checked our measurements.', 'The results agree.', '>> My next question concerns',
      'a second measurement. Does the', 'same method work here?', '>> We use a different sensor.',
    ].join('\n'), timeline: [{firstCue: 1, at: '0:00', topic: 'Results'}, {firstCue: 5, at: '8:15', topic: 'Sensors'}]}
    const {chapters} = check(video)
    expect(chapters.map(ch => ch.at)).toEqual(['0:00', '8:15'])
    expect(chapters[0].batches.flat().at(-1)?.lastCue).toBe(2)
    expect(chapters[1].batches[0][0]).toMatchObject({firstCue: 3, lastCue: 5})
    expect(chapters[1].batches[0][0].text).toBe('>> My next question concerns\na second measurement. Does the\nsame method work here?')
  })

  it('can start a timed chapter at a sentence inside a shared cue without losing either half', () => {
    const video = {...base, text: [
      'Start here.', 'We checked it. Next I want to ask', 'about your second', 'measurement?', '>> I counted twice.',
    ].join('\n'), lastCaptionSeconds: 1300, timeline: [
      {firstCue: 1, at: '0:00'}, {firstCue: 3, at: '5:00'}, {firstCue: 4, at: '10:00'},
      {firstCue: 5, at: '20:00'},
    ]}
    const {chapters} = check(video)
    expect(chapters.map(ch => ch.at)).toEqual(['0:00', '10:00'])
    expect(chapters[0].batches.flat().at(-1)).toMatchObject({lastCue: 2, text: 'We checked it.'})
    expect(chapters[1].batches[0][0]).toMatchObject({firstCue: 2, text: 'Next I want to ask\nabout your second\nmeasurement?'})
    const custom = check(video, 3).chapters
    expect(custom).toHaveLength(3)
    const times = custom.flatMap(chapter => chapter.at ? [chapter.at] : [])
    expect(new Set(times).size).toBe(times.length)
    expect(times.every(time => video.timeline.some(mark => mark.at === time))).toBe(true)
  })

  it('selects actual anchors on a long recording and keeps the short tail in the last chapter', () => {
    const video = {...base, text: 'start\nnext\nlate\nend', lastCaptionSeconds: 1250, timeline: [
      {firstCue: 1, at: '0:02'}, {firstCue: 2, at: '5:08'}, {firstCue: 3, at: '10:10'}, {firstCue: 4, at: '20:12'},
    ]}
    expect(check(video).chapters.map(ch => ch.at)).toEqual(['0:02', '10:10'])
  })

  it('rebalances whole units for an explicit chapter count and only labels genuine source boundaries', () => {
    const video = {...base, text: Array.from({length: 8}, (_, i) => '>> Turn ' + i).join('\n'), timeline: [
      {at: '0:01', firstCue: 1}, {at: '0:20', firstCue: 3}, {at: '0:55', firstCue: 8},
    ]}
    const {chapters} = check(video, 4)
    expect(chapters.map(ch => ch.batches.flat().map(unit => unit.id))).toEqual([[1, 2], [3, 4], [5, 6], [7, 8]])
    expect(chapters.map(ch => ch.at)).toEqual(['0:01', '0:20', undefined, undefined])
    expect(check(video, 10000).chapters).toHaveLength(8)
    expect(check({...base, text: ''}, 3).chapters).toHaveLength(0)
  })

  it('caps the row count when rapid speaker exchanges create many short units', () => {
    const {batches} = check({...base, text: Array(91).fill('>> 好。').join('\n')})
    expect(batches.map(batch => batch.length)).toEqual([20, 20, 20, 20, 11])
  })
})
