import {describe, expect, it} from 'vitest'
import {formatTranscriptUnit, TranscriptFormatError, TranscriptResponse, type TranscriptLayout} from '../src/worker/transcript-response'
import type {TranscriptUnit} from '../src/worker/transcript-plan'

const source = (id: number, text: string): TranscriptUnit => ({id, firstCue: id, lastCue: id, text})
const unit = (id: number, through: number, text = '已有正文。') => ({id, through, text, speaker: '', heading: ''})
const envelope = (units: unknown[]) => JSON.stringify({articleTitle: '记录', chapterTitle: '观察过程', units})
const layout = () => ({chapterTitle: '', speaker: '', heading: '', lastText: ''})

describe('editing contiguous caption ranges', () => {
  it('releases a grouped paragraph before STOP and holds the last range until its envelope is validated', () => {
    const decoder = new TranscriptResponse([source(6, 'First sentence.'), source(7, 'Its example.'), source(8, 'Thanks.')], true, true)
    const first = unit(6, 7, '这是一句话，带有“{例证}”。')
    const raw = envelope([first, unit(8, 8, '')])
    const split = raw.indexOf('"id":8')
    const early = [...decoder.append(raw.slice(0, split))]
    expect(early).toEqual([first])
    const rendered = formatTranscriptUnit(early[0], source(6, 'First sentence.'), decoder, layout(), undefined, true)
    expect(rendered).toContain('# 记录\n\n## 观察过程\n\n这是一句话')
    expect([...decoder.append(raw.slice(split))]).toEqual([])
    const silent = decoder.finish()
    const untouched = layout()
    expect(formatTranscriptUnit(silent, source(8, 'Thanks.'), decoder, untouched)).toBe('')
    expect(untouched).toEqual(layout())
  })

  it.each([
    [unit(1, 2), unit(2, 3)], [unit(1, 1), unit(3, 3)], [unit(1, 4)],
    [unit(1, 2)], [unit(1, 1), unit(2, 2), unit(3, 3), unit(4, 4)],
  ])('rejects missing, overlapping, extra and out-of-batch ranges', (...rows) => {
    const decoder = new TranscriptResponse([source(1, 'One.'), source(2, 'Two.'), source(3, 'Three.')], true, true)
    expect(() => { [...decoder.append(envelope(rows))]; decoder.finish() }).toThrow(TranscriptFormatError)
  })

  it.each(['No.', 'Only under five percent.', 'Yes, but only when the pressure drops.', 'Thanks for confirming 18.'])(
    'retains potentially substantive source even when a model calls it filler: %s', text => {
      const decoder = new TranscriptResponse([source(1, text)], true, true)
      expect(() => [...decoder.append(envelope([unit(1, 1, '')]))]).toThrow(TranscriptFormatError)
    })

  it('keeps a factual exchange separate after joining a greeting to the first substantive speech', () => {
    const input = [source(1, 'Host: Thanks for joining us.'), source(2, 'Lin: Does the limit apply?'), source(3, 'Sam: Only at night.')]
    const decoder = new TranscriptResponse(input, true, true)
    const row = {...unit(1, 3, '这个限制一直适用吗？'), speaker: 'Lin'}
    expect(() => [...decoder.append(envelope([row]))]).toThrow(TranscriptFormatError)
    const good = new TranscriptResponse(input, true, true)
    const output = {...row, turns: [{speaker: 'Sam', text: '只在夜间适用。'}]}
    expect([...good.append(envelope([output]))]).toEqual([])
    const markdown = formatTranscriptUnit(good.finish(), input[0], good, layout())
    expect(markdown).toContain('**Lin：** 这个限制一直适用吗？\n\n**Sam：** 只在夜间适用。')
    expect(markdown).not.toContain('Host')
  })
})

describe('editorial titles and conversational continuity', () => {
  it.each([
    ['How did the industrial revolution change the cost of food?', '定价变化', true],
    ['采访', 'Where the price of technology is heading', true],
    ['NVIDIA', 'GPT-4', false], ['芯片上的 AI', '定价变化', false],
  ])('checks prose titles in the default output language', (articleTitle, chapterTitle, reject) => {
    function render(defaultChinese: boolean) {
      const decoder = new TranscriptResponse([source(1, 'Opening.')], defaultChinese, true)
      const response = JSON.stringify({articleTitle, chapterTitle, units: [unit(1, 1)]})
      return [...decoder.append(response), decoder.finish()]
    }
    if (reject) expect(() => render(true)).toThrow(/标题.*中文/u)
    else expect(render(true)).toHaveLength(1)
    expect(render(false)).toHaveLength(1)
  })

  it('checks the language of titles this envelope will publish, and still requires both header fields', () => {
    const english = 'How we measured the price of providing power'
    const raw = (articleTitle: string, chapterTitle: string, text = '后续正文。') =>
      JSON.stringify({articleTitle, chapterTitle, units: [unit(4, 4, text)]})
    const continuation = new TranscriptResponse([source(4, 'A further result.')], true, true, {article: false, chapter: false})
    expect([...continuation.append(raw(english, english)), continuation.finish()]).toHaveLength(1)
    const nextChapter = new TranscriptResponse([source(4, 'Next topic.')], true, true, {article: false, chapter: true})
    expect(() => [...nextChapter.append(raw(english, english))]).toThrow(/标题.*中文/u)
    const noVisibleTitles = new TranscriptResponse([source(4, '[Music]')], true, true)
    expect([...noVisibleTitles.append(raw(english, english, '')), noVisibleTitles.finish()][0].text).toBe('')
    const missingTitle = new TranscriptResponse([source(4, 'Further detail.')], true, true, {article: false, chapter: false})
    expect(() => [...missingTitle.append(raw(english, ''))]).toThrow(/缺少/u)
  })

  type Row = {source: string; speaker: string; text: string; heading: string; paragraphStart?: boolean;
    topicStart?: {kind: string; evidence: string; requirement?: string}}
  function renderDialogue(rows: Row[], requirements = '') {
    const inputs = rows.map((row, i) => source(i + 1, row.source))
    const state = layout()
    const records = rows.map(({source, ...row}, i) => ({...unit(i + 1, i + 1), ...row}))
    const decoder = new TranscriptResponse(inputs, true, true, undefined, requirements)
    return [...decoder.append(envelope(records)), decoder.finish()].map((item, i) =>
      formatTranscriptUnit(item, inputs[i], decoder, state)).join('')
  }

  it('may omit a standalone courtesy reaction between two distinct substantive turns', () => {
    const decoder = new TranscriptResponse([source(1, '>> Oh, fantastic!')], true, true)
    expect([...decoder.append(envelope([unit(1, 1, '')]))]).toEqual([])
    expect(decoder.finish().text).toBe('')
  })

  it('keeps the question and a multi-paragraph answer under one subheading until the next question', () => {
    const article = renderDialogue([
      {source: 'Amy: How do you test it?', speaker: 'Amy', text: '你们怎么测试？', heading: '如何验证'},
      {source: 'Sam: We compare with the reference.', speaker: 'Sam', text: '我们先和参考结果对照。', heading: '参考结果'},
      {source: 'Then we vary the temperature.', speaker: 'Sam', text: '接着改变温度。', heading: '温度的作用'},
      {source: 'Amy: What about the price?', speaker: 'Amy', text: '成本如何？', heading: '成本',
        topicStart: {kind: 'question', evidence: 'What about the price?'}},
    ])
    expect(article.match(/^### .+/gm)).toEqual(['### 如何验证', '### 成本'])
    expect(article.match(/\*\*Sam：\*\*/g)).toHaveLength(1)
    expect(article).toContain('对照。\n\n接着改变温度。')
  })

  it('continues the last question of a grouped turn across chapters and batches, including a short follow-up', () => {
    const state: TranscriptLayout = layout()
    const start = [source(1, 'Lee: The bridge has closed.'), source(2, 'Amy: What were the alternatives?')]
    const intro = new TranscriptResponse(start, true, true)
    const question = {...unit(1, 2, '桥已经关闭。'), speaker: 'Lee',
      turns: [{speaker: 'Amy', text: '当时有哪些选择？'}]}
    expect([...intro.append(envelope([question]))]).toEqual([])
    formatTranscriptUnit(intro.finish(), start[0], intro, state)
    expect(state.topic?.question).toBe('当时有哪些选择？')

    const nextChapter = {...layout(), speaker: state.speaker, topic: state.topic}
    const rows = [
      {source: 'Lee: We could repair the bridge.', speaker: 'Lee', text: '可以修桥。', heading: '修桥',
        topicStart: {kind: 'subject', evidence: 'repair the bridge'}},
      {source: '>> Lee: That would take two years.', speaker: '', text: '这需要两年。', heading: '工期',
        topicStart: {kind: 'subject', evidence: 'two years'}},
      {source: 'Closing it leaves the eastern route.', speaker: '', text: '另一种选择是绕东线。', heading: '绕道',
        paragraphStart: true},
      {source: 'Amy: Two years?', speaker: 'Amy', text: '两年？', heading: '时间'},
      {source: 'Lee: At least.', speaker: 'Lee', text: '至少。', heading: '时间下限'},
    ]
    const article = rows.map(({source: line, ...row}, i) => {
      const input = source(i + 3, line)
      const decoder = new TranscriptResponse([input], true, true)
      expect([...decoder.append(envelope([{...unit(input.id, input.id), paragraphStart: false, ...row}]))]).toEqual([])
      return formatTranscriptUnit(decoder.finish(), input, decoder, nextChapter)
    }).join('')
    expect(article).not.toContain('###')
    expect(article).toContain('**Lee：** 可以修桥。这需要两年。\n\n另一种选择是绕东线。\n\n**Amy：** 两年？\n\n**Lee：** 至少。')
  })

  it('can open a different speaker’s independent subject after a completed exchange crosses into a new chapter', () => {
    const state = {...layout(), speaker: 'Lee',
      topic: {heading: '桥梁维修', anchor: 'What needs repair?', question: '哪里需要修理？', answerSpeaker: 'Lee'}}
    const opening = source(10, 'Ada: Wetlands absorb floodwater.')
    const decoder = new TranscriptResponse([opening], true, true)
    const row = {...unit(10, 10, '湿地能吸收洪水。'), heading: '湿地的作用',
      topicStart: {kind: 'subject', evidence: 'Wetlands absorb floodwater'}}
    expect([...decoder.append(envelope([row]))]).toEqual([])
    expect(formatTranscriptUnit(decoder.finish(), opening, decoder, state)).toContain('### 湿地的作用\n\n**Ada：**')
    expect(state.topic.question).toBeUndefined()
  })

  it('keeps examples in lecture prose, and accepts a grounded new subject without a spoken transition phrase', () => {
    const article = renderDialogue([
      {source: 'Water has three phases.', speaker: '', text: '水有三种相态。', heading: '物质的相态'},
      {source: 'Ice expands.', speaker: '', text: '水结冰会膨胀。', heading: '结冰', paragraphStart: false},
      {source: 'This breaks the pipe.', speaker: '', text: '水管因此破裂。', heading: '水管', paragraphStart: false,
        topicStart: {kind: 'subject', evidence: 'an invented topic change'}},
      {source: 'El sonido es una onda.', speaker: '', text: '声音是一种波。', heading: '声音的传播',
        topicStart: {kind: 'subject', evidence: 'El sonido es una onda.'}},
    ])
    expect(article.match(/^### .+/gm)).toEqual(['### 物质的相态', '### 声音的传播'])
    expect(article).toContain('水有三种相态。水结冰会膨胀。水管因此破裂。')
  })

  it('honours a reader’s explicit request for a heading inside an answer', () => {
    const rows = [
      {source: 'Lin: How is it tested?', speaker: 'Lin', text: '怎么测试？', heading: '测试方法'},
      {source: 'Kai: Start with the dye.', speaker: 'Kai', text: '先加染料。', heading: '加染料',
        topicStart: {kind: 'requested', evidence: 'Start with the dye', requirement: '每个步骤加小标题'}},
    ]
    expect(renderDialogue(rows, '每个步骤加小标题').match(/^### .+/gm)).toEqual(['### 测试方法', '### 加染料'])
    expect(renderDialogue(rows, '用简体中文').match(/^### .+/gm)).toEqual(['### 测试方法'])
  })

  it('lets a question-shaped chapter title introduce the opening question unless the reader requests a heading', () => {
    const opening = source(1, 'Lin: How can we detect a leak?')
    const chapterTitle = '怎样检测泄漏？'
    const requirement = '提问前都加小标题'
    for (const requested of [false, true]) {
      const row = {...unit(1, 1, '怎样知道管道漏了？'), heading: '发现泄漏的方法', speaker: 'Lin',
        topicStart: {kind: requested ? 'requested' : 'question', evidence: 'detect a leak', requirement}}
      const decoder = new TranscriptResponse([opening], true, true, undefined, requested ? requirement : '')
      expect([...decoder.append(JSON.stringify({articleTitle: '管道检修', chapterTitle, units: [row]}))]).toEqual([])
      const markdown = formatTranscriptUnit(decoder.finish(), opening, decoder, layout())
      expect(markdown.includes('###')).toBe(requested)
      expect(markdown).toContain('**Lin：** 怎样知道管道漏了？')
    }
  })

  it('allows new subtopics in independent explanations and answer-only highlights', () => {
    for (const speaker of ['', 'Sam']) {
      const article = renderDialogue([
        {source: 'First let us define the problem.', speaker, text: '先来定义问题。', heading: '问题'},
        {source: 'On the other topic, here are the results.', speaker, text: '谈到另一个问题，这是我们的结果。', heading: '结果'},
      ])
      expect(article.match(/^### .+/gm)).toEqual(['### 问题', '### 结果'])
    }
  })
})

describe('speaker boundaries inside edited source ranges', () => {
  const group = (texts: string[], row: ReturnType<typeof unit> & {turns?: {speaker: string; text: string}[]}) => {
    const inputs = texts.map((text, i) => source(i + 1, text))
    const decoder = new TranscriptResponse(inputs, true, true)
    const records = [...decoder.append(envelope([row])), decoder.finish()]
    const state = layout()
    return records.map(record => formatTranscriptUnit(record, inputs[record.id - 1], decoder, state)).join('')
  }

  it('rejects merging three unsigned substantive speaker changes into a single named statement', () => {
    const inputs = ['>> I use the north entrance.', '>> I prefer the east entrance.', '>> I take the stairs.']
    const merged = {...unit(1, 3, '我走北门、东门，还会走楼梯。'), speaker: 'Ada'}
    expect(() => group(inputs, merged)).toThrow(TranscriptFormatError)
  })

  it('omits a simple courtesy but keeps the two substantive unsigned statements on different turns', () => {
    const inputs = ['>> The trial met its target.', '>> Thanks!', '>> The cost doubled.']
    const collapsed = {...unit(1, 3, '试验达到了目标，但成本翻了一倍。'), speaker: '发言人'}
    expect(() => group(inputs, collapsed)).toThrow(TranscriptFormatError)
    const split = {...unit(1, 3, '试验达到了目标。'), speaker: '未署名发言人',
      turns: [{speaker: '未署名发言人', text: '成本翻了一倍。'}]}
    expect(group(inputs, split)).toContain('**未署名发言人：** 试验达到了目标。\n\n**未署名发言人：** 成本翻了一倍。')
  })

  it('can combine ordinary lines from one identified speaker or a single unlabeled narrator', () => {
    const single = unit(1, 3, '我提出了方法，做了测试，再把结果提交给团队。')
    const statements = ['I proposed the method.', 'I tested it.', 'I shared the result with the team.']
    expect(group(statements.map(text => '>> Ada: ' + text), single)).toContain('**Ada：** ' + single.text)
    expect(group(statements, single)).toContain(single.text)
    expect(group(statements, single)).not.toContain('发言人')
  })
})
