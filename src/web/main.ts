import './style.css';
import { applyIcons } from './icons';
import { renderArticle, summaryKeys, type Chapter, type Summary } from './reader';
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
  article.hidden = false;
  resultIsSample = sample;
  markdown = '';
  body.replaceChildren();
  copy.hidden = true;
  element('copy-label').textContent = '复制正文';
  element('reader-mode').textContent = sample ? '示例文章' : '生成文章';
  title.textContent = sample ? '示例文章' : '正在准备文章…';
  source.textContent = '';
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
  renderArticle(markdown, body, title, sampleChapters, async id => sampleSummaries[id]);
  copy.hidden = false;
}
element('sample').addEventListener('click', showSample);
navSample.addEventListener('click', event => { event.preventDefault(); showSample(); });
navStudio.addEventListener('click', () => { switchNav(false); input.focus({ preventScroll: true }); });
element('fill').addEventListener('click', () => {
  input.value = 'https://www.youtube.com/watch?v=C4GIqWeywiI';
  input.setCustomValidity('');
  element('url-hint').textContent = '已填入 W3C 无障碍影片，可使用官方存档字幕。';
  tell('');
  input.focus();
});
input.addEventListener('input', () => {
  input.setCustomValidity('');
  element('url-hint').textContent = '支持带字幕的公开视频。';
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
  return 'YouTube 视频字幕';
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
  let chapters: Chapter[] | undefined;
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
        source.textContent = sourceName(data.source);
        if (data.title) source.append(document.createTextNode(' · ' + data.title));
        status.textContent = 'Gemini 正在写作，正文将实时出现…';
      } else if (type === 'delta' && typeof data.text === 'string') {
        markdown += data.text;
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderArticle(markdown, body, title); });
      } else if (type === 'error') {
        throw new Error(typeof data.message === 'string' ? data.message : '生成中断，请重试。');
      } else if (type === 'done') {
        chapters = data.chapters;
      }
    }
    if (!Array.isArray(chapters) || !id || !markdown.trim()) throw new Error('连接提前结束，请重新生成。');
    cancelAnimationFrame(frame);
    frame = 0;
    renderArticle(markdown, body, title, chapters, chapter => loadSummary(id, chapter));
    status.textContent = '生成完成 · ' + chapters.length + ' 个章节';
    copy.hidden = false;
  } catch (error) {
    cancelAnimationFrame(frame);
    frame = 0;
    const message = controller.signal.aborted ? '已停止生成。' : error instanceof Error ? error.message : '网络连接失败，请重试。';
    if (markdown.trim()) {
      renderArticle(markdown, body, title);
      status.textContent = message + ' 已保留收到的正文片段。';
      copy.hidden = false;
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
