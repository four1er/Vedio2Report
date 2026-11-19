import {describe, expect, it} from 'vitest'
import {requestedChapterCount, requestsEditorialAdaptation} from '../src/worker/transcript-intent'

describe('full transcription unless the reader asks for a different deliverable', () => {
  it.each(['', '给产品经理，保留发言口吻，分两章', '完整转写，不要压缩，不要只讨论收入',
    '不要写摘要，请用自然的中文', '不要把正文变成总结', '不应该压缩，应该全局转写', '不能只写总结，要逐字转写', '请逐段转写，每章末尾附上一句总结', '只保留原意，修正标点', '只翻译成中文', '只转写，不要总结', '每个章节都有一个 5W1H 总结',
    'For beginners, in two chapters, without a summary', 'Unabridged transcript; append a short summary',
  ])('transcribes all source material: %s', text => expect(requestsEditorialAdaptation(text)).toBe(false))
  it.each(['只讨论产品定价，写两章', '只翻译最后十分钟', '请做一份会议纪要', '把采访写成三百字以内的摘要',
    'Write a summary for a beginner', 'Only discuss pricing in two chapters',
  ])('honors explicit editorial scope: %s', text => expect(requestsEditorialAdaptation(text)).toBe(true))
  it.each([['分两章', 2], ['分２个章节', 2], ['共十二章', 12], ['four chapters', 4],
    ['不要分两章，分三章', 3], ['第2章', undefined], ['3–5章', undefined], ['', undefined]
  ] as const)('reads requested chapter counts: %s', (text, count) => expect(requestedChapterCount(text)).toBe(count))
})
