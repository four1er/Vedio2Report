import { SUMMARY_KEYS, type ChapterMeta, type Summary5W1H } from '../shared/types'

export type SummaryLoader = (chapterId: string, signal: AbortSignal) => Promise<Summary5W1H>

const SUMMARY_LABELS: Record<(typeof SUMMARY_KEYS)[number], string> = {
  who: 'Who',
  what: 'What',
  when: 'When',
  where: 'Where',
  why: 'Why',
  how: 'How',
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}

function renderInline(target: HTMLElement, value: string): void {
  for (const part of value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      target.append(el('strong', part.slice(2, -2)))
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      target.append(el('code', part.slice(1, -1)))
    } else {
      target.append(document.createTextNode(part))
    }
  }
}

function renderSummaryTable(summary: Summary5W1H): HTMLElement {
  const table = el('dl')
  table.className = 'summary-grid'
  for (const key of SUMMARY_KEYS) {
    const row = el('div')
    row.className = 'summary-row'
    const dt = el('dt', SUMMARY_LABELS[key])
    const dd = el('dd', summary[key])
    row.append(dt, dd)
    table.append(row)
  }
  return table
}

function attachSummaryControl(
  heading: HTMLElement,
  chapterId: string,
  chapterTitle: string,
  loadSummary: SummaryLoader,
  articleSignal: AbortSignal,
): HTMLElement {
  const button = el('button', '5W1H')
  button.type = 'button'
  button.className = 'summary-toggle'
  button.dataset.state = 'ready-to-load'
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-label', `查看「${chapterTitle}」5W1H 总结`)

  const panel = el('div')
  panel.id = `summary-${chapterId}`
  panel.className = 'summary-box'
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-live', 'polite')
  panel.setAttribute('aria-label', `${chapterTitle} 5W1H 总结`)
  panel.hidden = true
  button.setAttribute('aria-controls', panel.id)

  let loaded = false
  let inflight: AbortController | undefined

  const triggerLoad = async () => {
    if (loaded || articleSignal.aborted) return
    inflight?.abort()
    const current = new AbortController()
    inflight = current
    const signal = AbortSignal.any([articleSignal, current.signal])

    button.dataset.state = 'loading'
    panel.setAttribute('aria-busy', 'true')
    const loadingNote = el('p', '正在结合整篇视频上下文提炼本章 5W1H 总结…')
    loadingNote.className = 'summary-loading'
    panel.replaceChildren(loadingNote)

    try {
      const data = await loadSummary(chapterId, signal)
      if (signal.aborted) return
      const header = el('div')
      header.className = 'summary-header'
      header.append(el('span', '5W1H 结构化总结'))
      panel.replaceChildren(header, renderSummaryTable(data))
      loaded = true
      button.dataset.state = 'loaded'
      button.textContent = '5W1H ✓'
    } catch (error) {
      if (signal.aborted) return
      button.dataset.state = 'error'
      const msg = error instanceof Error ? error.message : '本章 5W1H 总结生成失败。'
      const errWrap = el('div')
      errWrap.className = 'summary-error'
      const retry = el('button', '重试')
      retry.type = 'button'
      retry.className = 'summary-retry'
      retry.addEventListener('click', () => void triggerLoad())
      errWrap.append(el('span', msg), retry)
      panel.replaceChildren(errWrap)
    } finally {
      if (inflight === current) {
        inflight = undefined
        panel.setAttribute('aria-busy', 'false')
      }
    }
  }

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    button.setAttribute('aria-expanded', String(!panel.hidden))
    if (panel.hidden) {
      inflight?.abort()
      if (!loaded) button.dataset.state = 'ready-to-load'
      return
    }
    if (!loaded) void triggerLoad()
  })

  heading.append(button)
  return panel
}

function renderMarkdownBlocks(raw: string, container: HTMLElement): void {
  const fragment = document.createDocumentFragment()
  let paragraph: string[] = []
  let speaker = ''
  let inSpeech = false
  let list: HTMLOListElement | HTMLUListElement | null = null

  const flush = () => {
    if (!paragraph.length) return
    const p = el('p')
    const text = paragraph.join(' ')
    if (speaker) {
      p.className = 'speaker-turn'
      const label = el('strong', speaker)
      label.className = 'speaker-label'
      const speech = el('span')
      renderInline(speech, text)
      p.append(label, ' ', speech)
      speaker = ''
    } else {
      if (inSpeech) p.className = 'speaker-continuation'
      renderInline(p, text)
    }
    fragment.append(p)
    paragraph = []
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }

    const heading = /^(#{3,6})[ \t]+(\S.*)$/.exec(line.trimEnd())
    const listItem = /^([-*+]\s+|\d+[.)]\s+)(.+)$/.exec(trimmed)
    const boldSpeaker = /^\*\*([^*：:\n]{1,36}?)(?:([：:])\*\*|\*\*\s*([：:]))\s*(.*)$/.exec(trimmed)
    const plainSpeaker = /^([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5·.\s]{0,20})([：:])\s+(.+)$/.exec(trimmed)

    if (heading) {
      flush()
      list = null
      inSpeech = false
      const h4 = el('h4')
      renderInline(h4, heading[2].replace(/^\*\*|\*\*$/g, '').trim())
      fragment.append(h4)
    } else if (listItem) {
      flush()
      const tag = /^\d/.test(listItem[1]) ? 'ol' : 'ul'
      if (!list || list.localName !== tag) {
        list = el(tag)
        if (list instanceof HTMLOListElement) list.start = parseInt(listItem[1], 10)
        fragment.append(list)
      }
      const li = el('li')
      renderInline(li, listItem[2])
      list.append(li)
    } else if (trimmed.startsWith('>')) {
      flush()
      list = null
      inSpeech = false
      const quote = el('blockquote')
      renderInline(quote, trimmed.slice(1).trim())
      fragment.append(quote)
    } else if (boldSpeaker) {
      flush()
      list = null
      speaker = boldSpeaker[1].trim() + (boldSpeaker[2] || boldSpeaker[3])
      inSpeech = true
      paragraph.push(boldSpeaker[4])
    } else if (plainSpeaker && !trimmed.startsWith('http')) {
      flush()
      list = null
      speaker = plainSpeaker[1].trim() + plainSpeaker[2]
      inSpeech = true
      paragraph.push(plainSpeaker[3])
    } else {
      list = null
      paragraph.push(trimmed)
    }
  }
  flush()

  // Patch DOM minimally so text selection and scrolling stay rock-steady while streaming
  const nextBlocks = Array.from(fragment.children)
  for (let i = 0; i < nextBlocks.length; i++) {
    const existing = container.children[i]
    if (!existing) container.append(nextBlocks[i])
    else if (!existing.isEqualNode(nextBlocks[i])) existing.replaceWith(nextBlocks[i])
  }
  while (container.children.length > nextBlocks.length) {
    container.lastElementChild?.remove()
  }
}

interface ChapterSection {
  heading: HTMLDivElement
  label: HTMLHeadingElement
  content: HTMLDivElement
  lastTitle: string
  lastText: string
  hasSummaryControl: boolean
}

export function createArticleRenderer(
  bodyTarget: HTMLElement,
  titleTarget: HTMLElement,
  tocDetails: HTMLDetailsElement,
  tocList: HTMLOListElement,
  loadSummary: SummaryLoader,
  articleSignal: AbortSignal,
) {
  const intro = el('div')
  bodyTarget.replaceChildren(intro)
  tocList.replaceChildren()
  tocDetails.hidden = true

  const sections: ChapterSection[] = []
  let lastIntro = ''

  return (markdown: string, readyChapters: ChapterMeta[]) => {
    const headings = Array.from(markdown.matchAll(/^##[ \t]+(\S[^\n]*)$/gm))
    const preface = markdown.slice(0, headings[0]?.index ?? markdown.length)

    if (preface !== lastIntro) {
      lastIntro = preface
      const h1 = /^#[ \t]+(\S[^\n]*)$/m.exec(preface)
      if (h1) {
        titleTarget.textContent = h1[1].trim().replace(/\*\*/g, '')
      }
      renderMarkdownBlocks(preface.replace(/^#[ \t]+\S[^\n]*$/m, ''), intro)
    }

    for (const [i, match] of headings.entries()) {
      const cleanTitle = match[1].trim().replace(/^\*\*|\*\*$/g, '').trim()
      const anchorId = `chapter-ch-${i + 1}`
      let section = sections[i]

      if (!section) {
        const heading = el('div')
        heading.className = 'chapter-head'
        heading.id = anchorId
        const label = el('h3')
        const content = el('div')
        content.className = 'chapter-body'
        heading.append(label)
        bodyTarget.append(heading, content)

        section = {
          heading,
          label,
          content,
          lastTitle: '',
          lastText: '',
          hasSummaryControl: false,
        }
        sections.push(section)

        const tocItem = el('li')
        const tocLink = el('a', cleanTitle)
        tocLink.href = `#${anchorId}`
        tocItem.append(tocLink)
        tocList.append(tocItem)
        tocDetails.hidden = false
        const summaryEl = tocDetails.querySelector('summary')
        if (summaryEl) summaryEl.textContent = `章节目录（${sections.length} 章）`
      }

      if (cleanTitle !== section.lastTitle) {
        section.label.replaceChildren()
        renderInline(section.label, cleanTitle)
        section.lastTitle = cleanTitle
        const tocLink = tocList.children[i]?.querySelector('a')
        if (tocLink) tocLink.textContent = cleanTitle
      }

      const start = match.index! + match[0].length
      const end = headings[i + 1]?.index ?? markdown.length
      const chapterBody = markdown.slice(start, end)
      if (chapterBody !== section.lastText) {
        renderMarkdownBlocks(chapterBody, section.content)
        section.lastText = chapterBody
      }

      const ready = readyChapters[i]
      if (ready && !section.hasSummaryControl) {
        const summaryBox = attachSummaryControl(
          section.heading,
          ready.id,
          ready.title,
          loadSummary,
          articleSignal,
        )
        section.heading.after(summaryBox)
        section.hasSummaryControl = true
      }
    }
  }
}
