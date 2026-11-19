import { chapterRecapText } from '../shared/chapter-recap';

export interface Chapter { id: string; title: string }
export const summaryKeys = ['who', 'what', 'when', 'where', 'why', 'how'] as const;
export type Summary = Record<typeof summaryKeys[number], string>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

// The model supplies untrusted Markdown. Render a small subset using text nodes.
function inline(node: HTMLElement, value: string) {
  for (const part of value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) node.append(el('strong', part.slice(2, -2)));
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) node.append(el('code', part.slice(1, -1)));
    else node.append(document.createTextNode(part));
  }
}

function summaryList(summary: Summary) {
  const dl = el('dl');
  for (const key of summaryKeys) {
    const row = el('div');
    row.append(el('dt', key[0].toUpperCase() + key.slice(1)), el('dd', summary[key]));
    dl.append(row);
  }
  return dl;
}

function addSummary(heading: HTMLElement, chapter: Chapter, load: (id: string) => Promise<Summary>) {
  const button = el('button', '5W1H');
  button.type = 'button';
  button.className = 'summary-toggle';
  const box = el('div');
  box.id = 'summary-' + chapter.id;
  box.className = 'summary-box';
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', chapter.title + ' 5W1H 总结');
  box.hidden = true;
  button.setAttribute('aria-label', chapter.title + ' 5W1H 总结');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', box.id);
  let loaded = false;
  let loading = false;
  button.addEventListener('click', async () => {
    box.hidden = !box.hidden;
    button.setAttribute('aria-expanded', String(!box.hidden));
    if (box.hidden || loaded || loading) return;
    loading = true;
    box.setAttribute('aria-busy', 'true');
    box.textContent = '正在整理本章总结…';
    try {
      box.replaceChildren(summaryList(await load(chapter.id)));
      loaded = true;
    } catch (error) {
      const retry = el('button', '重试');
      retry.className = 'text-button';
      retry.addEventListener('click', () => { box.hidden = true; button.click(); });
      box.replaceChildren(el('span', (error instanceof Error ? error.message : '总结加载失败。') + ' '), retry);
    } finally {
      loading = false;
      box.setAttribute('aria-busy', 'false');
    }
  });
  heading.append(button);
  return box;
}

function renderBlocks(raw: string, target: HTMLElement) {
  const fragment = document.createDocumentFragment();
  let paragraph: string[] = [];
  let list: HTMLOListElement | HTMLUListElement | null = null;
  function flush() {
    if (!paragraph.length) return;
    const p = el('p');
    inline(p, paragraph.join(' '));
    fragment.append(p);
    paragraph = [];
  }
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) { flush(); list = null; continue; }
    const heading = /^(#{1,6})[ \t]+(\S.*)$/.exec(line.trimEnd());
    const item = /^([-*+]\s+|\d+[.)]\s+)(.+)$/.exec(value);
    if (heading) {
      flush();
      list = null;
      const h4 = el('h4');
      inline(h4, heading[2]);
      fragment.append(h4);
    } else if (item) {
      flush();
      const tag = /^\d/.test(item[1]) ? 'ol' : 'ul';
      if (!list || list.localName !== tag) { list = el(tag); fragment.append(list); }
      const li = el('li');
      inline(li, item[2]);
      list.append(li);
    } else if (value.startsWith('>')) {
      flush();
      list = null;
      const recap = chapterRecapText(value);
      if (recap !== undefined) {
        const block = el('p');
        block.className = 'chapter-recap';
        block.append(el('strong', '小结　'));
        inline(block, recap);
        fragment.append(block);
      } else {
        const block = el('blockquote');
        inline(block, value.slice(1).trim());
        fragment.append(block);
      }
    } else {
      list = null;
      paragraph.push(value);
    }
  }
  flush();
  target.replaceChildren(fragment);
}

export function timestampSeconds(stamp: string): number | undefined {
  if (!/^(?:\d{1,3}:[0-5]\d:[0-5]\d|\d{1,4}:[0-5]\d)$/.test(stamp)) return;
  return stamp.split(':').reduce((seconds, field) => seconds * 60 + Number(field), 0);
}

function renderChapterTitle(target: HTMLElement, value: string, links: ReadonlyMap<number, string>) {
  target.replaceChildren();
  const stamp = /^\[([\d:]+)\]\s+(.+)$/.exec(value);
  const seconds = stamp ? timestampSeconds(stamp[1]) : undefined;
  const href = seconds === undefined ? undefined : links.get(seconds);
  if (stamp && href) {
    const link = el('a', stamp[1]);
    link.className = 'chapter-time';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', '从 ' + stamp[1] + ' 播放原视频');
    target.append(link, ' ');
    inline(target, stamp[2]);
  } else {
    inline(target, value);
  }
}

interface ChapterView {
  heading: HTMLDivElement;
  label: HTMLHeadingElement;
  content: HTMLDivElement;
  lastTitle: string;
  lastText: string;
  hasSummary: boolean;
}

// Chapter controls stay mounted while newer text is streaming, including when
// an earlier summary request is still running or its button has keyboard focus.
export function createArticleRenderer(target: HTMLElement, title: HTMLElement, load: (id: string) => Promise<Summary>, links = new Map<number, string>()) {
  const intro = el('div');
  target.replaceChildren(intro);
  const views: ChapterView[] = [];
  let lastIntro = '';
  return (raw: string, chapters: Chapter[]) => {
    const headings = Array.from(raw.matchAll(/^##[ \t]+(\S[^\n]*)$/gm));
    const preface = raw.slice(0, headings[0]?.index ?? raw.length);
    if (preface !== lastIntro) {
      lastIntro = preface;
      const articleTitle = /^#[ \t]+(\S[^\n]*)$/m.exec(preface);
      if (articleTitle) title.textContent = articleTitle[1].trim().replace(/\*\*/g, '');
      renderBlocks(preface.replace(/^#[ \t]+\S[^\n]*$/m, ''), intro);
    }
    for (const [i, match] of headings.entries()) {
      let view = views[i];
      if (!view) {
        const heading = el('div');
        heading.className = 'chapter-head';
        const label = el('h3');
        const content = el('div');
        heading.append(label);
        target.append(heading, content);
        view = {heading, label, content, lastTitle: '', lastText: '', hasSummary: false};
        views.push(view);
      }
      const name = match[1].trim();
      if (name !== view.lastTitle) {
        renderChapterTitle(view.label, name, links);
        view.lastTitle = name;
      }
      const text = raw.slice(match.index + match[0].length, headings[i + 1]?.index);
      if (text !== view.lastText) {
        renderBlocks(text, view.content);
        view.lastText = text;
      }
      const chapter = chapters[i];
      if (chapter && chapter.title === name && !view.hasSummary) {
        view.heading.after(addSummary(view.heading, chapter, load));
        view.hasSummary = true;
      }
    }
  };
}
