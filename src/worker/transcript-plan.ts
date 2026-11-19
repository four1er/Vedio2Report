import type { Video } from './caption-source'

export interface TranscriptUnit {
  id: number
  firstCue: number
  lastCue: number
  text: string
}
export interface TranscriptChapter {
  at?: string
  topic?: string
  batches: TranscriptUnit[][]
}

const maxUnit = 380
const maxBatch = 3000
const maxUnitsPerBatch = 20
const maxUntimedChapter = 14_000

type Mark = {firstCue: number; offset?: number; at?: string; topic?: string}
type Fragment = {cue: number; text: string}

function seconds(at: string) {
  return at.split(':').reduce((total, field) => total * 60 + Number(field), 0)
}

function timeline(video: Video, count: number) {
  const marks: NonNullable<Video['timeline']> = []
  for (const mark of video.timeline ?? []) {
    if (!Number.isInteger(mark.firstCue) || mark.firstCue < 1 || mark.firstCue > count ||
        !/^(?:\d+:[0-5]\d|\d+:[0-5]\d:[0-5]\d)$/.test(mark.at)) continue
    const last = marks.at(-1)
    if (!last || (mark.firstCue > last.firstCue && seconds(mark.at) > seconds(last.at))) marks.push(mark)
  }
  return marks
}

function boundaries(video: Video, marks: NonNullable<Video['timeline']>): Mark[] {
  const start: Mark = marks[0]?.firstCue === 1 ? marks[0] : {firstCue: 1}
  if (!marks.length) return [start]
  if (marks.every(mark => mark.topic?.trim())) return start === marks[0] ? marks : [start, ...marks]

  const end = video.lastCaptionSeconds ?? video.durationSeconds ?? seconds(marks[marks.length - 1].at)
  let previous = seconds(marks[0].at)
  if (end - previous < 900) return [start]
  const interval = Math.max(600, (end - previous) / 12)
  const chosen = [start]
  for (const mark of marks.slice(1)) {
    const time = seconds(mark.at)
    if (time - previous >= interval && end - time >= 180) {
      chosen.push(mark)
      previous = time
    }
  }
  return chosen
}

const speakerStart = /^(?:>>|(?:\*\*)?[\p{L}][\p{L}\p{M} .’'-]{0,28}[：:])/u
const sentenceEnd = /[.!?。！？][”’"'）)»]*$/u
const independentStart = /^[“‘"'（(¿¡]*[\p{Lu}\p{Lt}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

// The timestamp is the publisher's chapter link. It can point into the middle
// of a question. Move the *text* cut back to its nearby onset, keeping the
// original link and original cue numbers, even when the onset is mid-cue.
function alignChapterStarts(lines: string[], marks: Mark[]) {
  return marks.map((mark, index) => {
    if (!index) return mark
    const current = lines[mark.firstCue - 1].trim()
    if (speakerStart.test(current) ||
        (sentenceEnd.test(lines[mark.firstCue - 2].trim()) && independentStart.test(current))) return mark

    let sentence: {firstCue: number; offset: number} | undefined
    let chars = 0
    const lower = Math.max(mark.firstCue - 8, marks[index - 1].firstCue + 1)
    for (let cue = mark.firstCue - 1; cue >= lower; cue--) {
      const line = lines[cue - 1]
      chars += line.length
      if (chars > maxUnit) break
      const marker = line.lastIndexOf('>>')
      if (marker >= 0 || speakerStart.test(line.trimStart()))
        return {...mark, firstCue: cue, offset: Math.max(marker, 0)}

      if (!sentence) {
        // Some captions put a full stop and the start of the next sentence on
        // the same line. Searching backward retains its exact character offset.
        for (const match of line.matchAll(/[。！？][”’"'）)»]*\s*|[.!?][”’"'）)»]*\s+/gu)) {
          const offset = match.index + match[0].length
          if (independentStart.test(line.slice(offset))) sentence = {firstCue: cue, offset}
        }
        if (!sentence && sentenceEnd.test(lines[cue - 2].trim()) && independentStart.test(line.trimStart()))
          sentence = {firstCue: cue, offset: 0}
      }
    }
    return sentence ? {...mark, ...sentence} : mark
  })
}

// A long unpunctuated subtitle still has to fit the translation output budget.
// Prefer a sentence ending, then a word boundary, and never split a surrogate pair.
function cut(text: string, start: number) {
  const remaining = text.length - start
  if (remaining <= maxUnit) return text.length
  const size = remaining < maxUnit + 90 ? Math.ceil(remaining / 2) : maxUnit
  const window = text.slice(start, start + size)
  const ends = window.matchAll(/[。！？…]|[.!?]["'’”)]*(?=\s)/gu)
  let sentence = 0
  for (const match of ends) sentence = match.index + match[0].length
  if (sentence >= size / 2) return start + sentence
  const word = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'), window.lastIndexOf('\t'))
  if (word >= size / 2) return start + word
  return start + size - (/[\uD800-\uDBFF]/.test(window[size - 1]) ? 1 : 0)
}

function* unitsForTurn(turn: Fragment[], firstId: number): Generator<TranscriptUnit> {
  const text = turn.map(part => part.text).join('\n')
  let position = 0
  const ends = turn.map(part => {
    position += part.text.length + 1
    return position - 1
  })
  let cue = 0
  let id = firstId
  for (let start = 0; start < text.length;) {
    while (start < text.length && /\s/.test(text[start])) start++
    if (start === text.length) break
    const end = cut(text, start)
    const unit = text.slice(start, end).trimEnd()
    while (ends[cue] <= start) cue++
    const firstCue = turn[cue].cue
    while (ends[cue] < start + unit.length) cue++
    yield {id: id++, firstCue, lastCue: turn[cue].cue, text: unit}
    start = end
  }
}

function sectionUnits(lines: string[], first: Mark, end: Mark, firstId: number): TranscriptUnit[] {
  const units: TranscriptUnit[] = []
  let turn: Fragment[] = []
  function flush() {
    for (const unit of unitsForTurn(turn, firstId + units.length)) units.push(unit)
    turn = []
  }
  const afterLastCue = end.firstCue + (end.offset ? 1 : 0)
  for (let cue = first.firstCue; cue < afterLastCue; cue++) {
    const line = lines[cue - 1].slice(cue === first.firstCue ? first.offset ?? 0 : 0, cue === end.firstCue ? end.offset : undefined)
    // Embedded change markers can occur mid-cue. Keep them in the source text.
    for (const fragment of line.split(/(?=>>)/u)) {
      const text = fragment.trim()
      if (!text) continue
      // A complete sentence ending at a cue cut can be the last sentence of
      // an unmarked speaker. Give the following sentence its own attribution.
      const previous = turn.at(-1)
      const sentenceStart = previous && previous.cue < cue && sentenceEnd.test(previous.text) && independentStart.test(text)
      if (sentenceStart || speakerStart.test(text)) flush()
      turn.push({cue, text})
    }
  }
  flush()
  return units
}

function batchUnits(units: TranscriptUnit[]) {
  const batches: TranscriptUnit[][] = []
  let size = 0
  for (const unit of units) {
    let batch = batches.at(-1)
    if (!batch || batch.length >= maxUnitsPerBatch || size + unit.text.length > maxBatch) {
      batch = []
      batches.push(batch)
      size = 0
    }
    batch.push(unit)
    size += unit.text.length
  }
  return batches
}

// Keep each reader-requested chapter contiguous. Balance the amount of speech and
// reserve at least one source unit for every remaining chapter.
function balancedGroups(units: TranscriptUnit[], count: number): TranscriptUnit[][] {
  const groups: TranscriptUnit[][] = []
  let remainingSize = units.reduce((sum, unit) => sum + unit.text.length, 0)
  let first = 0
  for (let left = Math.min(count, units.length); left > 1; left--) {
    const target = remainingSize / left
    let end = first + 1
    let size = units[first].text.length
    while (end < units.length - left + 1 && size + units[end].text.length / 2 <= target) {
      size += units[end++].text.length
    }
    groups.push(units.slice(first, end))
    remainingSize -= size
    first = end
  }
  if (first < units.length) groups.push(units.slice(first))
  return groups
}

export function planTranscript(video: Video, chapterCount?: number): TranscriptChapter[] {
  const lines = video.text.split(/\r?\n/)
  const marks = timeline(video, lines.length)
  const anchors = boundaries(video, marks)
  const sections = alignChapterStarts(lines, anchors)
  const chapterLinks = new Map<number, Mark>()
  let groups: TranscriptUnit[][] = []
  let firstId = 1
  for (const [i, mark] of sections.entries()) {
    const units = sectionUnits(lines, mark, sections[i + 1] ?? {firstCue: lines.length + 1}, firstId)
    if (units.length && mark.at) chapterLinks.set(units[0].id, mark)
    firstId += units.length
    let group: TranscriptUnit[] = []
    let size = 0
    for (const unit of units) {
      if (!group.length || (!mark.topic && size + unit.text.length > maxUntimedChapter)) {
        group = []
        groups.push(group)
        size = 0
      }
      group.push(unit)
      size += unit.text.length
    }
  }

  if (chapterCount && Number.isInteger(chapterCount) && chapterCount > 0 && chapterCount !== groups.length) {
    groups = balancedGroups(groups.flat(), chapterCount)
  }
  // In a reader-requested layout, another genuine source anchor may coincide
  // with a new chapter. A moved publisher link belongs only to its aligned unit.
  const anchoredTimes = new Set(anchors.map(mark => mark.at))
  const byCue = new Map(marks.filter(mark => !anchoredTimes.has(mark.at)).map(mark => [mark.firstCue, mark]))
  let coveredCue = 0
  return groups.map(group => {
    const first = group[0].firstCue
    const mark = chapterLinks.get(group[0].id) ?? (first > coveredCue ? byCue.get(first) : undefined)
    coveredCue = group[group.length - 1].lastCue
    return {at: mark?.at, topic: mark?.topic, batches: batchUnits(group)}
  })
}
