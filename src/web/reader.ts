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

export function renderArticle(raw: string, target: HTMLElement, title: HTMLElement, chapters: Chapter[] = [], load?: (id: string) => Promise<Summary>) {
  const fragment = document.createDocumentFragment();
  let paragraph: string[] = [];
  let list: HTMLOListElement | HTMLUListElement | null = null;
  let index = 0;
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
      if (heading[1].length === 1) { title.textContent = heading[2].replace(/\*\*/g, ''); continue; }
      if (heading[1].length === 2) {
        const wrapper = el('div');
        wrapper.className = 'chapter-head';
        const h3 = el('h3');
        inline(h3, heading[2]);
        wrapper.append(h3);
        fragment.append(wrapper);
        const chapter = chapters[index++];
        if (chapter && load) fragment.append(addSummary(wrapper, chapter, load));
      } else {
        const h4 = el('h4');
        inline(h4, heading[2]);
        fragment.append(h4);
      }
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
      const block = el('blockquote');
      inline(block, value.slice(1).trim());
      fragment.append(block);
    } else {
      list = null;
      paragraph.push(value);
    }
  }
  flush();
  target.replaceChildren(fragment);
}
