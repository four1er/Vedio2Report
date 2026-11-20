import './style.css'
import { SUMMARY_KEYS, type ArticleMeta, type ChapterMeta, type ParsedRequirements, type Summary5W1H } from '../shared/types'
import { applyIcons } from './icons'
import { createArticleRenderer } from './reader'
import { parseSseEvents, readResponseError } from './stream'

applyIcons()

const DEMO_VIDEO_ID = 'xRh2sVcNXQ8'

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing DOM element: #${id}`)
  return node as T
}

const form = byId<HTMLFormElement>('generate')
const videoInput = byId<HTMLInputElement>('video')
const requirementsInput = byId<HTMLTextAreaElement>('requirements')
const submitBtn = byId<HTMLButtonElement>('submit')
const submitCaption = byId('submit-caption')
const stopBtn = byId<HTMLButtonElement>('stop')
const exportHtmlBtn = byId<HTMLButtonElement>('export-html')
const copyBtn = byId<HTMLButtonElement>('copy')
const copyLabel = byId('copy-label')
const feedback = byId('feedback')
const urlHint = byId('url-hint')
const fillBtn = byId<HTMLButtonElement>('fill')
const navStudio = byId<HTMLAnchorElement>('nav-studio')

const articleSection = byId('article')
const readerMode = byId('reader-mode')
const readerPulse = byId('reader-pulse')
const readerTitle = byId('reader-title')
const readerSource = byId('reader-source')
const readerConstraints = byId('reader-constraints')
const readerToc = byId<HTMLDetailsElement>('reader-toc')
const tocList = byId<HTMLOListElement>('toc-list')
const readerStatus = byId('reader-status')
const bodyContainer = byId('body')

let activeStream: AbortController | null = null
let articleLifetime = new AbortController()
let currentMarkdown = ''
let paintFrame = 0

function showFeedback(message: string) {
  feedback.hidden = !message
  feedback.textContent = message
}

function setBusy(busy: boolean) {
  submitBtn.disabled = busy
  stopBtn.hidden = !busy
  videoInput.readOnly = busy
  requirementsInput.readOnly = busy
  fillBtn.disabled = busy
  for (const chip of document.querySelectorAll<HTMLButtonElement>('.preset-chip')) {
    chip.disabled = busy
  }
  submitCaption.textContent = busy ? '正在生成中…' : '开始流式生成'
  readerPulse.classList.toggle('pulsing', busy)
}

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function sourceBadgeLabel(source: ArticleMeta['source']): string {
  switch (source) {
    case 'youtube-proxy':
      return 'YouTube 字幕（代理获取）'
    case 'youtube-direct':
      return 'YouTube 字幕（直连）'
    case 'archive':
      return '内置演示字幕兜底'
  }
}

function renderSourceMeta(meta: ArticleMeta) {
  readerSource.replaceChildren()
  const badge = document.createElement('span')
  badge.className = 'source-badge'
  badge.textContent = sourceBadgeLabel(meta.source)
  readerSource.append(badge)

  const link = document.createElement('a')
  link.href = `https://www.youtube.com/watch?v=${meta.videoId}`
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = meta.title
  readerSource.append(' · ', link)

  if (typeof meta.durationSeconds === 'number' && meta.durationSeconds > 0) {
    readerSource.append(` · 时长 ${formatDuration(meta.durationSeconds)}`)
  }
  if (typeof meta.cueCount === 'number' && meta.cueCount > 0) {
    readerSource.append(` · ${meta.cueCount.toLocaleString('zh-CN')} 条字幕`)
  }
}

function renderConstraints(parsed: ParsedRequirements) {
  readerConstraints.replaceChildren()
  const pills: Array<[string, string]> = []
  if (parsed.taskType) pills.push(['任务类型', parsed.taskType])
  if (parsed.outputStyle) pills.push(['输出风格', parsed.outputStyle])
  if (parsed.targetAudience) pills.push(['目标受众', parsed.targetAudience])
  for (const item of parsed.constraints) {
    pills.push(['约束条件', item])
  }
  if (!pills.length) {
    readerConstraints.hidden = true
    return
  }

  for (const [label, value] of pills) {
    const tag = document.createElement('span')
    tag.className = 'constraint-pill'
    const strong = document.createElement('strong')
    strong.textContent = label
    tag.append(strong, ' ', value)
    readerConstraints.append(tag)
  }
  readerConstraints.hidden = false
}

function resetReader() {
  articleLifetime.abort()
  articleLifetime = new AbortController()
  cancelAnimationFrame(paintFrame)
  paintFrame = 0
  currentMarkdown = ''

  articleSection.hidden = false
  bodyContainer.replaceChildren()
  readerSource.replaceChildren()
  readerConstraints.replaceChildren()
  readerConstraints.hidden = true
  tocList.replaceChildren()
  readerToc.open = false
  readerToc.hidden = true
  copyBtn.hidden = true
  exportHtmlBtn.hidden = true
  copyLabel.textContent = '复制 Markdown'
  readerMode.textContent = 'Gemini 实时流式成稿'
  readerTitle.textContent = '正在获取视频字幕…'
  readerStatus.textContent = ''
  articleSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildStandaloneHtml(): string {
  const titleText = readerTitle.textContent?.trim() || '声稿文章'
  const clone = bodyContainer.cloneNode(true) as HTMLElement
  for (const btn of clone.querySelectorAll('.summary-toggle, .summary-retry')) btn.remove()
  for (const box of clone.querySelectorAll<HTMLElement>('.summary-box')) {
    if (box.hidden || !box.querySelector('.summary-grid')) box.remove()
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(titleText)}</title>
<style>
  body { margin: 0; background: #f8f7f2; color: #222421; font-family: Georgia, "Noto Serif CJK SC", "Songti SC", serif; line-height: 1.9; }
  main { max-width: 820px; margin: 36px auto; padding: 36px 44px; background: #fffefa; border: 1px solid #dcdad0; border-radius: 12px; }
  h1 { font-size: 34px; line-height: 1.38; margin: 0 0 12px; }
  .meta { font-family: system-ui, sans-serif; font-size: 13px; color: #64655e; margin-bottom: 24px; }
  .chapter-head { border-top: 1px solid #dcdad0; padding-top: 22px; margin-top: 28px; }
  h3 { font-size: 23px; margin: 0; }
  h4 { font-size: 19px; margin: 1.3em 0 0.5em; }
  p { margin: 0.9em 0; font-size: 17px; }
  .summary-box { margin: 14px 0 18px; background: #f6f3e9; border: 1px solid #e3decc; border-radius: 10px; padding: 14px 18px; font-family: system-ui, sans-serif; font-size: 14.5px; }
  .summary-header { font-size: 11px; font-weight: 700; color: #a23c25; margin-bottom: 6px; }
  .summary-grid { margin: 0; }
  .summary-row { display: grid; grid-template-columns: 74px 1fr; gap: 10px; padding: 7px 0; border-bottom: 1px solid #e2decb; }
  .summary-row:last-child { border-bottom: 0; }
  .summary-row dt { font-family: Georgia, serif; font-weight: 700; color: #a23c25; }
  .summary-row dd { margin: 0; }
  blockquote { margin: 1em 0; padding: 0.5em 1em; background: #f5f2e9; border-left: 3px solid #a23c25; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(titleText)}</h1>
  <p class="meta">${escapeHtml(readerSource.textContent?.trim() || '')}</p>
  ${clone.innerHTML}
</main>
</body>
</html>`
}

async function fetchChapterSummary(articleId: string, chapterId: string, signal: AbortSignal): Promise<Summary5W1H> {
  // Strictly sends only articleId + chapterId with an empty body (server uses stored context).
  const response = await fetch(
    `/api/articles/${encodeURIComponent(articleId)}/chapters/${encodeURIComponent(chapterId)}/summary`,
    { method: 'POST', cache: 'no-store', signal },
  )
  if (!response.ok) {
    throw await readResponseError(response, '获取章节 5W1H 总结失败')
  }
  const data = (await response.json()) as Partial<Summary5W1H>
  if (!data || SUMMARY_KEYS.some(key => typeof data[key] !== 'string' || !data[key]!.trim())) {
    throw new Error('服务端返回的 5W1H 数据结构不完整，请重试。')
  }
  return data as Summary5W1H
}

navStudio.addEventListener('click', () => {
  videoInput.focus({ preventScroll: true })
})

fillBtn.addEventListener('click', () => {
  videoInput.value = `https://www.youtube.com/watch?v=${DEMO_VIDEO_ID}`
  videoInput.setCustomValidity('')
  urlHint.textContent = '已填入《马克·安德森 2026 AI 展望》访谈链接，点击「开始流式生成」即可体验。'
  showFeedback('')
  videoInput.focus()
})

for (const chip of document.querySelectorAll<HTMLButtonElement>('.preset-chip')) {
  chip.addEventListener('click', () => {
    requirementsInput.value = chip.dataset.preset ?? ''
    requirementsInput.focus()
  })
}

videoInput.addEventListener('input', () => {
  videoInput.setCustomValidity('')
  urlHint.textContent = '支持任意公开且带字幕的 YouTube 链接（自动经代理池读取，演示视频内置兜底字幕）。'
})

stopBtn.addEventListener('click', () => activeStream?.abort())

copyBtn.addEventListener('click', async () => {
  if (!currentMarkdown) return
  try {
    await navigator.clipboard.writeText(currentMarkdown)
    copyLabel.textContent = '已复制 Markdown'
    setTimeout(() => {
      copyLabel.textContent = '复制 Markdown'
    }, 1800)
  } catch {
    showFeedback('浏览器未授予剪贴板权限，请手动选中正文复制。')
  }
})

exportHtmlBtn.addEventListener('click', () => {
  if (!currentMarkdown) return
  const html = buildStandaloneHtml()
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const safeName = (readerTitle.textContent?.trim() || 'article').replace(/[\\/:*?"<>|]/g, '_')
  link.href = url
  link.download = `${safeName}.html`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

function countProseChars(markdown: string): number {
  return markdown.replace(/[#*`>\s]/g, '').length
}

form.addEventListener('submit', async ev => {
  ev.preventDefault()
  if (activeStream) return

  const url = videoInput.value.trim()
  const requirements = requirementsInput.value.trim()
  const controller = new AbortController()
  activeStream = controller

  showFeedback('')
  setBusy(true)
  resetReader()
  readerStatus.textContent = '正在获取并校验 YouTube 字幕…'

  const startedAt = performance.now()
  let ttftSeconds: string | undefined
  let articleId = ''
  const readyChapters: ChapterMeta[] = []
  let completed = false

  const render = createArticleRenderer(
    bodyContainer,
    readerTitle,
    readerToc,
    tocList,
    (chapterId, signal) => fetchChapterSummary(articleId, chapterId, signal),
    articleLifetime.signal,
  )

  const schedulePaint = () => {
    if (paintFrame) return
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0
      render(currentMarkdown, readyChapters)
    })
  }

  try {
    const response = await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, requirements }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw await readResponseError(response, '文章生成请求失败')
    }

    for await (const event of parseSseEvents(response)) {
      if (event.type === 'meta') {
        const meta = event.data as ArticleMeta
        articleId = meta.articleId
        renderSourceMeta(meta)
        readerTitle.textContent = requirements ? '正在解析生成要求…' : '正在流式生成文章…'
        readerStatus.textContent = requirements
          ? '字幕已就绪，正在解析自然语言要求并开始流式生成…'
          : '字幕已就绪，Gemini 正在流式写作…'
      } else if (event.type === 'constraints') {
        renderConstraints(event.data as ParsedRequirements)
        readerStatus.textContent = '已应用上述生成要求，Gemini 正在流式写作…'
      } else if (event.type === 'delta') {
        const { text } = event.data as { text: string }
        if (!ttftSeconds) {
          ttftSeconds = ((performance.now() - startedAt) / 1000).toFixed(1)
        }
        currentMarkdown += text
        const chars = countProseChars(currentMarkdown).toLocaleString('zh-CN')
        readerStatus.textContent = `正在实时流式输出 · 首字 ${ttftSeconds}s · 已生成 ${chars} 字${readyChapters.length ? ` · ${readyChapters.length} 章可展开 5W1H` : ''}`
        schedulePaint()
      } else if (event.type === 'chapter') {
        readyChapters.push(event.data as ChapterMeta)
        schedulePaint()
      } else if (event.type === 'done') {
        const { chapters } = event.data as { chapters: ChapterMeta[] }
        readyChapters.splice(0, readyChapters.length, ...chapters)
        completed = true
        cancelAnimationFrame(paintFrame)
        paintFrame = 0
        render(currentMarkdown, readyChapters)
        const totalSec = ((performance.now() - startedAt) / 1000).toFixed(1)
        const chars = countProseChars(currentMarkdown).toLocaleString('zh-CN')
        readerStatus.textContent = `生成完成 · 共 ${chapters.length} 章 · ${chars} 字 · 耗时 ${totalSec}s${ttftSeconds ? `（首字 ${ttftSeconds}s）` : ''} · 点击章节旁 [5W1H] 查看总结`
        copyBtn.hidden = false
        exportHtmlBtn.hidden = false
      } else if (event.type === 'error') {
        const { message } = event.data as { message?: string }
        throw new Error(message || '生成过程中发生错误，请稍后重试。')
      }
    }

    if (!completed && !controller.signal.aborted) {
      throw new Error('生成流意外中断，请重新生成。')
    }
  } catch (error) {
    if (controller.signal.aborted) {
      readerStatus.textContent = currentMarkdown
        ? '已停止生成。已输出的内容与已完成章节仍可正常阅读。'
        : '已取消本次生成。'
      if (currentMarkdown) {
        copyBtn.hidden = false
        exportHtmlBtn.hidden = false
      }
    } else {
      const msg = error instanceof Error ? error.message : '请求失败，请稍后重试。'
      showFeedback(msg)
      readerStatus.textContent = ''
      if (!currentMarkdown) {
        articleSection.hidden = true
      } else {
        copyBtn.hidden = false
        exportHtmlBtn.hidden = false
      }
    }
  } finally {
    if (activeStream === controller) activeStream = null
    setBusy(false)
  }
})
