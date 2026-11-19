import {describe, expect, it} from 'vitest'
import {requestedChapterCount, articleMode} from '../src/worker/transcript-intent'

describe('edited dialogue by default with explicit scope and verbatim options', () => {
  it.each(['', '给产品经理，保留发言口吻，分两章', '完整转写，不要压缩，不要只讨论收入',
    '不要写摘要，请用自然的中文', '不要把正文变成总结', '不应该压缩，应该全局转写', '不能只写总结，要逐字转写', '请逐段转写，每章末尾附上一句总结', '只保留原意，修正标点', '只翻译成中文', '只转写，不要总结', '每个章节都有一个 5W1H 总结',
    'For beginners, in two chapters, without a summary', 'Unabridged transcript; append a short summary',
  ])('transcribes all source material: %s', text => expect(articleMode(text)).not.toBe('adapted'))
  it.each(['只看定价', '只讨论产品定价，写两章', '只翻译最后十分钟', '请做一份会议纪要', '把采访写成三百字以内的摘要',
    '三百字概括', '总结成3条', '稍微总结一下并写成三百字以内的简报', 'Write a summary for a beginner', 'Only discuss pricing in two chapters',
  ])('honors explicit editorial scope: %s', text => expect(articleMode(text)).toBe('adapted'))
  it.each(['','面向中学生，分两章', '请整理成访谈稿，去掉口头禅', '压缩重复表达', '不要逐字翻译', '不是完全的全盘转写',
    'Use a clean transcript and remove false starts', 'A verbatim transcript, but remove all fillers',
    '不要写摘要，保留例子和追问', '请像杂志访谈一样润色', '稍微总结一下，不要完全转录', '不用完全逐字转录，按议题整理发言', '轻度整理', '略作总结', '再压缩一点，案例留一个',
    '稍作精简', '稍微总结，保留问答', '精简一些，尽量保留原话', 'lightly summarize while keeping the conversation',
  ])('keeps readable edited speech: %s', text => expect(articleMode(text)).toBe('edited'))
  it.each(['逐字转写', '请完整转录', '完全转录', '给我逐字稿，保留全部语气词', '一字不漏', '保留所有原话', '不要整理，请逐句翻译',
    '全文原样转录', 'word-for-word transcript', 'Verbatim transcript', 'Unabridged English transcript',
  ])('recognizes verbatim speech: %s', text => expect(articleMode(text)).toBe('verbatim'))
  it.each([['分两章', 2], ['分２个章节', 2], ['共十二章', 12], ['four chapters', 4],
    ['不要分两章，分三章', 3], ['第2章', undefined], ['3–5章', undefined], ['', undefined]
  ] as const)('reads requested chapter counts: %s', (text, count) => expect(requestedChapterCount(text)).toBe(count))
})
