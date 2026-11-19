import './style.css';
import { applyIcons } from './icons';
import { createArticleRenderer, timestampSeconds, summaryKeys, type Chapter, type Summary } from './reader';
import { events, responseError } from './stream';
import { sampleMarkdown, sampleChapters, sampleSummaries } from './sample';

applyIcons();
function element<T extends HTMLElement = HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error('缺少界面组件 ' + id);
  return node as T;
}
const form = element<HTMLFormElement>('generate');
const input = element<HTMLInputElement>('video');
const requirements = element<HTMLTextAreaElement>('requirements');
const submit = element<HTMLButtonElement>('submit');
const stop = element<HTMLButtonElement>('stop');
const copy = element<HTMLButtonElement>('copy');
const feedback = element('feedback');
const article = element('article');
const title = element('reader-title');
const body = element('body');
const status = element('reader-status');
const source = element('reader-source');
const timeline = element<HTMLDetailsElement>('reader-timeline');
const topics = element<HTMLOListElement>('timeline-topics');
const navSample = element<HTMLAnchorElement>('nav-sample');
const navStudio = element<HTMLAnchorElement>('nav-studio');
let pending: AbortController | null = null;
let markdown = '';
let frame = 0;
let resultIsSample = false;

function tell(message: string) {
  feedback.hidden = !message;
  feedback.textContent = message;
}
function switchNav(sample: boolean) {
  navSample.classList.toggle('selected', sample);
  navStudio.classList.toggle('selected', !sample);
}
function openResult(sample: boolean) {
  cancelAnimationFrame(frame);
  frame = 0;
  article.hidden = false;
  resultIsSample = sample;
  markdown = '';
  body.replaceChildren();
  copy.hidden = true;
  element('copy-label').textContent = '复制正文';
  element('reader-mode').textContent = sample ? '排版样稿' : '已录视频 · 字幕记录';
  title.textContent = sample ? '排版样稿' : '正在准备文章…';
  source.textContent = '';
  topics.replaceChildren();
  timeline.open = false;
  timeline.hidden = true;
  status.textContent = '';
  switchNav(sample);
  article.scrollIntoView({ block: 'start' });
  title.focus({ preventScroll: true });
}
function showSample() {
  if (pending) { tell('正在生成文章。如需切换到示例，请先停止生成。'); feedback.scrollIntoView({ block: 'center' }); return; }
  openResult(true);
  markdown = sampleMarkdown;
  source.textContent = '原创试读稿 · 正文和六项总结均为预置示例。';
  const render = createArticleRenderer(body, title, async id => sampleSummaries[id]);
  render(markdown, sampleChapters);
  copy.hidden = false;
}
element('sample').addEventListener('click', showSample);
navSample.addEventListener('click', event => { event.preventDefault(); showSample(); });
navStudio.addEventListener('click', () => { switchNav(false); input.focus({ preventScroll: true }); });
element('fill').addEventListener('click', () => {
  input.value = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';
  input.setCustomValidity('');
  element('url-hint').textContent = '已填入马克·安德森访谈，原片时长 1 小时 21 分 18 秒。';
  tell('');
  input.focus();
});
input.addEventListener('input', () => {
  input.setCustomValidity('');
  element('url-hint').textContent = '支持带字幕的 YouTube 公开视频。';
});
stop.addEventListener('click', () => pending?.abort());

async function loadSummary(articleId: string, chapterId: string): Promise<Summary> {
  const response = await fetch('/api/articles/' + encodeURIComponent(articleId) + '/chapters/' + encodeURIComponent(chapterId) + '/summary', { method: 'POST' });
  if (!response.ok) throw await responseError(response, '暂时无法生成总结');
  const data = await response.json();
  if (!data || summaryKeys.some(key => typeof data[key] !== 'string' || !data[key].trim())) throw new Error('总结格式异常，请重试。');
  return data;
}
function setBusy(busy: boolean) {
  submit.disabled = busy;
  stop.hidden = !busy;
  input.readOnly = busy;
  requirements.readOnly = busy;
  element<HTMLButtonElement>('fill').disabled = busy;
  element('submit-caption').textContent = busy ? '生成中…' : '开始生成';
}
function sourceName(kind: string) {
  if (kind === 'cached') return 'W3C WAI 官方存档字幕';
  if (kind === 'archived-youtube') return 'YouTube 英文字幕存档';
  return 'YouTube 视频字幕';
}
interface SourceMeta {
  source: string;
  videoId: string;
  title?: string;
  durationSeconds?: number;
  lastCaptionSeconds?: number;
  cueCount?: number;
  timeline?: {at: string; topic?: string}[];
}

function timecode(seconds: number) {
  const total = Math.floor(seconds);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor(total / 60) % 60;
  const ss = String(total % 60).padStart(2, '0');
  return hh ? hh + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
}

function displaySource(meta: SourceMeta, links: Map<number, string>) {
  source.textContent = sourceName(meta.source);
  const video = /^[a-zA-Z0-9_-]{11}$/.test(meta.videoId) ? 'https://www.youtube.com/watch?v=' + meta.videoId : '';
  if (video) {
    const link = document.createElement('a');
    link.href = video;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = meta.title || '查看原视频';
    source.append(' · ', link);
  }
  if (typeof meta.durationSeconds === 'number' && Number.isFinite(meta.durationSeconds) && meta.durationSeconds > 0) {
    source.append(' · 原片时长 ' + timecode(meta.durationSeconds));
  }
  if (typeof meta.lastCaptionSeconds === 'number' && Number.isFinite(meta.lastCaptionSeconds) && meta.lastCaptionSeconds >= 0) {
    source.append(' · 字幕截至 ' + timecode(meta.lastCaptionSeconds));
  }
  if (typeof meta.cueCount === 'number' && Number.isSafeInteger(meta.cueCount) && meta.cueCount > 0) {
    source.append(' · ' + meta.cueCount.toLocaleString('zh-CN') + ' 条字幕');
  }
  if (video && Array.isArray(meta.timeline)) {
    for (const entry of meta.timeline) {
      const seconds = timestampSeconds(entry.at);
      if (seconds === undefined) continue;
      const href = video + '&t=' + seconds + 's';
      links.set(seconds, href);
      if (!entry.topic) continue;
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const time = document.createElement('time');
      time.dateTime = 'PT' + seconds + 'S';
      time.textContent = entry.at;
      link.append(time, entry.topic);
      item.append(link);
      topics.append(item);
    }
  }
  timeline.hidden = !topics.childElementCount;
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (pending) return;
  const url = input.value.trim();
  const controller = new AbortController();
  pending = controller;
  setBusy(true);
  tell('');
  openResult(false);
  status.textContent = '正在获取字幕并连接 Gemini…';
  let id = '';
  const readyChapters: Chapter[] = [];
  let complete = false;
  const links = new Map<number, string>();
  const render = createArticleRenderer(body, title, chapter => loadSummary(id, chapter), links);
  function paint() {
    frame = 0;
    render(markdown, readyChapters);
  }
  function schedulePaint() {
    if (!frame) frame = requestAnimationFrame(paint);
  }
  try {
    const response = await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, requirements: requirements.value.trim() }),
      signal: controller.signal,
    });
    if (!response.ok) throw await responseError(response, '生成失败');
    for await (const event of events(response)) {
      const { type, data } = event;
      if (type === 'meta') {
        id = data.articleId;
        displaySource(data, links);
        status.textContent = '已取得字幕，正在等待 Gemini 输出正文…';
      } else if (type === 'delta' && typeof data.text === 'string') {
        if (!markdown) status.textContent = 'Gemini 正在写作…';
        markdown += data.text;
        schedulePaint();
      } else if (type === 'chapter' && data.id === 'ch-' + (readyChapters.length + 1) && typeof data.title === 'string') {
        readyChapters.push({id: data.id, title: data.title});
        status.textContent = '已完成 ' + readyChapters.length + ' 章，可展开 5W1H';
        schedulePaint();
      } else if (type === 'error') {
        throw new Error(typeof data.message === 'string' ? data.message : '生成中断，请重试。');
      } else if (type === 'done') {
        if (!Array.isArray(data.chapters)) throw new Error('章节信息缺失，请重新生成。');
        readyChapters.splice(0, readyChapters.length, ...data.chapters);
        complete = true;
      }
    }
    if (!complete || !readyChapters.length || !id || !markdown.trim()) throw new Error('连接提前结束，请重新生成。');
    cancelAnimationFrame(frame);
    paint();
    status.textContent = '生成完成 · ' + readyChapters.length + ' 个章节';
    copy.hidden = false;
  } catch (error) {
    cancelAnimationFrame(frame);
    frame = 0;
    const message = controller.signal.aborted ? '已停止生成。' : error instanceof Error ? error.message : '网络连接失败，请重试。';
    if (markdown.trim()) {
      render(markdown, readyChapters);
      status.textContent = message + ' 已保留收到的正文片段。';
      copy.hidden = false;
    } else if (id) {
      title.textContent = '视频字幕记录';
      status.textContent = message;
    } else {
      article.hidden = true;
      tell(message);
      feedback.scrollIntoView({ block: 'nearest' });
    }
  } finally {
    pending = null;
    setBusy(false);
  }
});
copy.addEventListener('click', async () => {
  const text = markdown;
  const sample = resultIsSample;
  try {
    await navigator.clipboard.writeText(text);
    if (text === markdown && sample === resultIsSample) element('copy-label').textContent = '已复制';
  } catch {
    element('copy-label').textContent = '请选中正文复制';
  }
});
