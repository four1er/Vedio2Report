import './style.css';
import { applyIcons } from './icons';
import { createArticleRenderer, timestampSeconds, type Chapter } from './reader';
import { events, responseError, waitForRetry } from './stream';
import { loadSummary } from './summary';
import { sampleMarkdown, sampleChapters, sampleSummaries, sampleSource } from './sample';

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
let readerLifetime = new AbortController();
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
  readerLifetime.abort();
  readerLifetime = new AbortController();
  cancelAnimationFrame(frame);
  frame = 0;
  article.hidden = false;
  resultIsSample = sample;
  markdown = '';
  body.replaceChildren();
  copy.hidden = true;
  element('copy-label').textContent = '复制正文';
  element('reader-mode').textContent = sample ? '排版样稿 · 字幕节译' : '已录视频 · 根据字幕整理';
  title.textContent = sample ? '排版样稿' : '正在准备字幕…';
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
  const links = new Map<number, string>();
  displaySource(sampleSource, links);
  source.append(' · 两章问答与 5W1H 均为预置样稿');
  const render = createArticleRenderer(body, title, async id => sampleSummaries[id], links, readerLifetime.signal);
  render(markdown, sampleChapters);
  copy.hidden = false;
}
element('sample').addEventListener('click', showSample);
navSample.addEventListener('click', event => { event.preventDefault(); showSample(); });
navStudio.addEventListener('click', () => { switchNav(false); input.focus({ preventScroll: true }); });
element('fill').addEventListener('click', () => {
  input.value = 'https://www.youtube.com/watch?v=' + sampleSource.videoId;
  input.setCustomValidity('');
  element('url-hint').textContent = '已填入' + sampleSource.title + '。点击「开始生成」即可试写。';
  tell('');
  input.focus();
});
input.addEventListener('input', () => {
  input.setCustomValidity('');
  element('url-hint').textContent = '支持带字幕的 YouTube 公开视频。';
});
stop.addEventListener('click', () => pending?.abort());

function setBusy(busy: boolean) {
  submit.disabled = busy;
  stop.hidden = !busy;
  input.readOnly = busy;
  requirements.readOnly = busy;
  element<HTMLButtonElement>('fill').disabled = busy;
  element('submit-caption').textContent = busy ? '检查字幕中…' : '开始生成';
  stop.textContent = busy ? '取消' : '停止生成';
}
function sourceName(kind: string, downloaded?: boolean) {
  if (kind === 'cached') return 'W3C WAI 官方逐字稿';
  if (kind === 'archived-youtube') return 'YouTube 字幕存档';
  if (kind === 'published-captions') return '公开发布的字幕';
  if (kind === 'native-api') return '第三方服务提供的 YouTube 字幕';
  if (kind === 'youtube' && downloaded !== undefined) {
    return downloaded ? 'YouTube 视频字幕 · 已完整下载' : 'YouTube 视频字幕 · 已读取服务端下载缓存';
  }
  return kind === 'youtube' ? 'YouTube 视频字幕' : '视频字幕';
}
interface SourceMeta {
  source: string;
  videoId: string;
  title?: string;
  sourceUrl?: string;
  sourceLabel?: string;
  durationSeconds?: number;
  lastCaptionSeconds?: number;
  cueCount?: number;
  timeline?: {at: string; topic?: string}[];
}

async function prepareCaptions(url: string, signal: AbortSignal) {
  const check = () => fetch('/api/captions', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url}), signal,
  });
  let response = await check();
  let downloaded = false;
  let rechecked = false;
  for (;;) {
    if (!response.ok) throw await responseError(response, '字幕检查失败');
    const data = await response.json();
    if (!data || !/^[a-zA-Z0-9_-]{11}$/.test(data.videoId)) throw new Error('字幕状态无效，请重新检查。');
    if (response.status === 200 && data.status === 'ready') return {source: data as SourceMeta, downloaded};
    if (response.status !== 202 || !['checking', 'pending', 'running'].includes(data.status)) throw new Error('字幕状态无效，请重新检查。');
    downloaded = true;
    element('submit-caption').textContent = '准备字幕中…';
    if (data.status === 'checking') status.textContent = '正在等待字幕服务确认该视频是否有可读字幕…';
    else status.textContent = data.status === 'pending' ? '已确认有字幕，正在等待下载…' : '已确认有字幕，正在下载完整字幕文件…';
    await waitForRetry(response.headers.get('Retry-After'), signal);
    response = await fetch('/api/captions/' + data.videoId, {signal, cache: 'no-store'});
    if (response.status === 404 && !rechecked) {
      rechecked = true;
      downloaded = false;
      status.textContent = '正在重新检查字幕下载状态…';
      response = await check();
    }
  }
}

function timecode(seconds: number) {
  const total = Math.floor(seconds);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor(total / 60) % 60;
  const ss = String(total % 60).padStart(2, '0');
  return hh ? hh + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
}

function displaySource(meta: SourceMeta, links: Map<number, string>, downloaded?: boolean) {
  source.textContent = sourceName(meta.source, downloaded);
  if (meta.source === 'published-captions') {
    const label = meta.sourceLabel?.trim();
    let sourceUrl: URL | undefined;
    if (meta.sourceUrl && URL.canParse(meta.sourceUrl)) sourceUrl = new URL(meta.sourceUrl);
    if (sourceUrl?.protocol === 'https:' && !sourceUrl.username && !sourceUrl.password) {
      const credit = document.createElement('a');
      credit.href = sourceUrl.href;
      credit.target = '_blank';
      credit.rel = 'noopener noreferrer';
      credit.textContent = label || '字幕来源';
      source.append(' · ', credit);
    } else if (label) source.append(' · ', label);
  }
  topics.replaceChildren();
  links.clear();
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
  status.textContent = '正在检查可用字幕，确认后下载并开始写作…';
  let id = '';
  let captionsReady = false;
  const readyChapters: Chapter[] = [];
  let complete = false;
  const links = new Map<number, string>();
  const render = createArticleRenderer(body, title, (chapter, signal, onStatus) => loadSummary(id, chapter, signal, onStatus), links, readerLifetime.signal);
  function paint() {
    frame = 0;
    render(markdown, readyChapters);
  }
  function schedulePaint() {
    if (!frame) frame = requestAnimationFrame(paint);
  }
  try {
    const captions = await prepareCaptions(url, controller.signal);
    captionsReady = true;
    displaySource(captions.source, links, captions.downloaded);
    status.textContent = '字幕已就绪，正在连接 Gemini…';
    title.textContent = '正在准备文章…';
    element('submit-caption').textContent = '生成中…';
    stop.textContent = '停止生成';
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
        displaySource(data, links, captions.downloaded);
        status.textContent = '字幕已就绪，正在等待 Gemini 输出正文…';
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
    const message = controller.signal.aborted
      ? (captionsReady ? '已停止生成。' : '已取消本次字幕请求。')
      : error instanceof Error ? error.message : '网络连接失败，请重试。';
    if (markdown.trim()) {
      render(markdown, readyChapters);
      status.textContent = message + ' 已保留收到的正文片段。';
      copy.hidden = false;
    } else if (captionsReady) {
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
