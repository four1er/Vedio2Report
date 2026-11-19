import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { events } from '../src/web/stream.ts';
import { archiveUnitCount, verifyCoverage, verifyInterview } from './transcript-evidence.mjs';

const workerUrl = /^https:\/\/vedio2report\.[a-z0-9-]+\.workers\.dev$/;
async function resolveOrigin(input) {
  assert.ok(input, 'Pass a vedio2report workers.dev URL or a Wrangler deployment JSONL file.');
  if (input.startsWith('https://')) {
    const url = input.replace(/\/$/, '');
    assert.match(url, workerUrl, 'Expected the public vedio2report workers.dev URL');
    return url;
  }
  const records = (await readFile(input, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const deployed = records.findLast(row => row.type === 'deploy' && row.version === 1 && row.version_id);
  const url = deployed?.targets?.find(target => workerUrl.test(target));
  assert.ok(url, 'Wrangler did not report a deployed vedio2report workers.dev URL.');
  return url;
}
const {values, positionals} = parseArgs({allowPositionals: true, options: {
  url: {type: 'string'}, 'expect-source': {type: 'string'}, full: {type: 'boolean'}, default: {type: 'boolean'},
  adapted: {type: 'boolean'}, 'markdown-out': {type: 'string'}, 'events-out': {type: 'string'}, 'expect-caption-error': {type: 'boolean'},
}});
assert.equal(positionals.length, 1, 'Pass one Worker URL or Wrangler deployment file.');
const fullCoverage = values.full === true;
const expectCaptionError = values['expect-caption-error'] === true;
const constrained = values.adapted === true;
assert.ok([values.default, fullCoverage, constrained, expectCaptionError].filter(Boolean).length <= 1,
  'Choose one of --default (all captions), --full (also check publisher topics), --adapted or --expect-caption-error.');
const sources = ['youtube', 'cached', 'archived-youtube', 'published-captions', 'native-api'];
const expectedSource = values['expect-source'];
if (expectedSource !== undefined) assert.ok(!expectCaptionError && sources.includes(expectedSource), 'Choose a supported caption source for a successful run');
const markdownOut = values['markdown-out'];
const eventsOut = values['events-out'];
for (const path of [markdownOut, eventsOut]) {
  if (path !== undefined) assert.ok(!expectCaptionError && path.trim(), 'Output files require a path and an article generation run');
}
if (markdownOut) assert.notEqual(markdownOut, eventsOut, 'Markdown and raw SSE need separate output files');
const origin = await resolveOrigin(positionals[0]);
console.log('Public Worker:', origin);

// Keep testing the URL as entered (including short links, Shorts and live URLs).
const inputUrl = values.url || ('https://www.youtube.com/watch?v=' + (process.env.ACCEPTANCE_VIDEO_ID || 'fNk_zzaMoSs'));
const input = new URL(inputUrl);
assert.ok(['https:', 'http:'].includes(input.protocol) && !input.username && !input.password && !input.port);
const youtube = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(input.hostname);
let videoId;
if (input.hostname === 'youtu.be') videoId = input.pathname.match(/^\/([^/]+)\/?$/)?.[1];
else if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(input.hostname))
  videoId = input.pathname.match(/^\/embed\/([^/]+)\/?$/)?.[1];
else if (youtube) videoId = input.pathname === '/watch'
  ? input.searchParams.getAll('v').length === 1 && input.searchParams.get('v')
  : input.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/)?.[1];
assert.match(videoId || '', /^[A-Za-z0-9_-]{11}$/, 'Provide a YouTube video URL or an eleven-character ACCEPTANCE_VIDEO_ID');

// Measure rendered prose in the viewport. A title, status change, or SSE frame
// alone does not establish that a reader saw any portion of a paragraph.
function observeReading() {
  const body = document.querySelector('#body');
  const samples = [];
  window.readingSamples = samples;
  // Chromium can discard an SSE response from its DevTools body cache. Observe
  // a copy as it arrives and give the page the original Response immediately.
  const fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await fetch(...args);
    if (response.url === new URL('/api/articles', location.href).href) {
      let announceId;
      window.articleId = new Promise(resolve => { announceId = resolve; });
      const reader = response.clone().body.pipeThrough(new TextDecoderStream()).getReader();
      window.articleEvents = (async () => {
        let raw = '';
        let pending = '';
        for (;;) {
          const {value, done} = await reader.read();
          if (done) break;
          raw += value;
          if (window.recordArticleChunk) await window.recordArticleChunk(value);
          const frames = (pending + value).split(/\r?\n\r?\n/);
          pending = frames.pop();
          for (const frame of frames) {
            const type = /^event:\s*(\w+)/m.exec(frame)?.[1];
            if (!type) continue;
            window.lastArticleActivity = performance.now();
            if (type === 'meta' && announceId) {
              const data = frame.split(/\r?\n/).find(line => line.startsWith('data:'));
              announceId(JSON.parse(data.slice(5)).articleId);
              announceId = undefined;
            }
          }
        }
        reader.releaseLock();
        return raw;
      })();
    }
    return response;
  };
  document.querySelector('form').addEventListener('submit', () => {
    window.submittedAt = performance.now();
    window.lastArticleActivity = window.submittedAt;
    let lastVisible = 0;
    let frame = 0;
    function sample() {
      frame = 0;
      let visible = 0;
      for (const para of body.querySelectorAll('p, li, blockquote')) {
        if (para.closest('.summary-box, .chapter-recap')) continue;
        const rect = para.getBoundingClientRect();
        if (rect.top >= innerHeight) break;
        if (rect.bottom <= 0) continue;
        const nodes = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
          if (node.parentElement.closest('.speaker-label')) continue;
          for (let i = 0; i < node.length; i++) {
            if (!node.data[i].trim()) continue;
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const glyph = range.getBoundingClientRect();
            if (glyph.top >= innerHeight) break;
            if (glyph.height && glyph.top >= 0 && glyph.bottom <= innerHeight) visible++;
          }
        }
      }
      if (visible > lastVisible) {
        samples.push({at: performance.now(), visible});
        lastVisible = visible;
      }
    }
    new MutationObserver(() => {
      if (!window.firstSealed && body.querySelector('.chapter-head > .summary-toggle')) {
        window.firstSealed = performance.now();
      }
      if (!frame) frame = requestAnimationFrame(sample);
    }).observe(body, {childList: true, subtree: true, characterData: true});
  }, {capture: true, once: true});
}

// Read only rendered body text. Summary fields and recaps are separate from the prose.
function readChapters(headings) {
  return headings.map(heading => {
    const next = heading.nextElementSibling;
    const content = next.matches('.summary-box') ? next.nextElementSibling : next;
    const paragraphs = [...content.querySelectorAll('p:not(.chapter-recap), li, blockquote')];
    return {
      text: paragraphs.map(p => p.innerText.trim()).join('\n').trim(),
      subtopics: [...content.querySelectorAll('h4')].map(h => h.innerText.trim()),
      recaps: content.querySelectorAll('.chapter-recap').length,
      speakers: [...content.querySelectorAll('.speaker-turn > .speaker-label')].map(label => label.textContent.trim()),
      continuations: content.querySelectorAll('.speaker-continuation').length,
    };
  });
}

// An 81-minute interview can keep producing valid units well beyond a fixed
// overall timeout. Abort on a stalled SSE stream or stop as soon as the UI finishes.
async function waitForChapters(page, count) {
  const result = await page.waitForFunction(count => {
    if (!document.querySelector('#submit').disabled) return 'finished';
    if (count && document.querySelectorAll('.chapter-head > .summary-toggle').length >= count) return 'ready';
    if (performance.now() - window.lastArticleActivity > 240000) return 'stalled';
    return false;
  }, count, {timeout: 0, polling: 500});
  assert.notEqual(await result.jsonValue(), 'stalled', 'Article SSE has had no events for four minutes');
}

function checkSourceLinks(links, timeline, expectedId) {
  const toSeconds = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const validOffsets = new Set(timeline.map(mark => toSeconds(mark.at)));
  const offsets = links.map(href => {
    const link = new URL(href);
    assert.equal(link.origin + link.pathname, 'https://www.youtube.com/watch');
    assert.equal(link.searchParams.get('v'), expectedId);
    const t = link.searchParams.get('t');
    assert.match(t || '', /^\d+s?$/);
    const offset = Number(t.replace(/s$/, ''));
    assert.ok(validOffsets.has(offset), 'Chapter time link must come from a timestamp in this source');
    return offset;
  });
  if (fullCoverage && timeline.length > 1 && timeline.every(mark => mark.topic))
    assert.deepEqual(offsets, timeline.map(mark => toSeconds(mark.at)), 'Expected every publisher topic in chronological order');
}

async function readReadySummary(page, path) {
  const deadline = Date.now() + 240000;
  for (;;) {
    const response = await page.request.get(path);
    const status = response.status();
    const data = await response.json();
    const retry = Number(response.headers()['retry-after']);
    await response.dispose();
    if (status === 200) return data;
    assert.equal(status, 202, 'Automatic 5W1H failed: ' + JSON.stringify(data));
    assert.ok(['pending', 'running'].includes(data.status));
    assert.ok(Date.now() < deadline, 'Timed out waiting for background 5W1H');
    await pause((Number.isFinite(retry) && retry > 0 ? retry : 2) * 1000);
  }
}

const labels = ['Who', 'What', 'When', 'Where', 'Why', 'How'];

function validateSix(data) {
  for (const label of labels) {
    const field = data[label.toLowerCase()];
    assert.ok(typeof field === 'string' && field.trim(), 'Missing ' + label + ' in background summary');
  }
  for (const key of ['what', 'why', 'how']) assert.match(data[key], /\p{Script=Han}/u);
}

async function verifySummary(panel, data) {
  validateSix(data);
  await panel.locator('dd').first().waitFor({timeout: 240000});
  assert.deepEqual(await panel.locator('dt').allTextContents(), labels);
  for (const [i, label] of labels.entries()) {
    assert.equal(await panel.locator('dd').nth(i).textContent(), data[label.toLowerCase()]);
  }
}

async function verifyPendingPanel(page, button, secondPath) {
  let replayedPending = false;
  let reads = 0;
  // A fast background job may be done before the reader opens chapter two.
  // In that case exercise one 202 explicitly, then use the real cached GET.
  await page.route(secondPath, async route => {
    if (++reads === 2) {
      await route.fulfill({status: 503, contentType: 'text/plain', headers: {'Retry-After': '1'},
        body: 'Upstream temporarily unavailable'});
      return;
    }
    const response = await route.fetch();
    if (response.status() === 200) {
      replayedPending = true;
      await route.fulfill({status: 202, contentType: 'application/json', headers: {'Retry-After': '1'},
        body: JSON.stringify({status: 'pending'})});
    } else {
      await route.fulfill({response});
    }
    await response.dispose();
  }, {times: 2});
  const firstRead = page.waitForResponse(res => res.url() === secondPath, {timeout: 30000});
  await button.click();
  assert.equal((await firstRead).status(), 202, 'Expected the initially opened second panel to be pending');
  const readyRead = page.waitForResponse(res => res.url() === secondPath && res.status() === 200, {timeout: 240000});
  const secondBox = page.locator('#summary-ch-2');
  assert.ok(await secondBox.isVisible());
  assert.equal(await button.getAttribute('data-state'), 'pending');
  const secondReady = await readyRead;
  assert.equal(reads, 2, 'Expected automatic recovery from the injected read failure');
  await verifySummary(secondBox, await secondReady.json());
  assert.equal(await button.getAttribute('aria-expanded'), 'true', 'The open pending panel should populate on its own');
  assert.equal(await button.getAttribute('data-state'), 'ready');
  return replayedPending;
}

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {channel: 'chrome'}),
  ...(proxy ? {proxy: {server: proxy}} : {}),
});
async function verifyPage(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await page.goto(origin, {waitUntil: 'domcontentloaded', timeout: 12000});
      assert.equal(response.status(), 200);
      assert.match(await page.title(), /^声稿/);
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      await pause(3000);
    }
  }
  const url = inputUrl;
  await page.locator('#video').fill(url);
  const requirements = constrained
    ? '写给刚接触本主题的读者。只讨论字幕中最主要的话题，写成两章中文问答，每章先列一个读者的问题，再根据原文回答。'
    : '';
  await page.locator('#requirements').fill(requirements);
  if (eventsOut) {
    await writeFile(eventsOut, '');
    await page.exposeFunction('recordArticleChunk', chunk => appendFile(eventsOut, chunk));
  }
  await page.evaluate(observeReading);
  const api = origin + '/api/articles';
  const prepare = origin + '/api/captions';
  const statusPath = prepare + '/' + videoId;
  const captionRequests = [];
  const articleRequests = [];
  const summaryRequests = [];
  let articleResponse;
  let captionsReady = false, articleStartedEarly = false;
  page.on('request', req => {
    if (req.url().endsWith('/summary')) summaryRequests.push(req);
    if (req.url() === prepare || req.url() === statusPath) captionRequests.push(req);
    if (req.url() === api) {
      articleRequests.push(req);
      if (!captionsReady) articleStartedEarly = true;
    }
  });
  page.on('response', res => {
    if (res.url() === api) articleResponse = res;
    if ((res.url() === prepare || res.url() === statusPath) && res.status() === 200) captionsReady = true;
  });
  // If the provider now has captions, report that the negative case changed
  // without paying for an article. Any attempted POST is still observable.
  if (expectCaptionError) await page.route(api, route => route.abort());
  const [prepared] = await Promise.all([
    page.waitForResponse(res => {
      if (res.url() === api) return true;
      if (res.url() !== prepare && res.url() !== statusPath) return false;
      // The UI rechecks an expired status URL once before it stops.
      if (res.url() === statusPath && res.status() === 404 && captionRequests.filter(req => req.url() === prepare).length === 1) return false;
      return res.status() !== 202;
    }, {timeout: 210000}),
    page.locator('#submit').click(),
  ]);
  assert.notEqual(prepared.url(), api, 'Article response arrived before caption readiness');
  assert.equal(captionRequests[0]?.method(), 'POST');
  for (const req of captionRequests) {
    if (req.url() === prepare) {
      assert.equal(req.method(), 'POST');
      assert.deepEqual(req.postDataJSON(), {url});
    } else {
      assert.equal(req.method(), 'GET');
    }
  }
  if (prepared.status() !== 200) {
    const failure = await prepared.json();
    if (!expectCaptionError) assert.fail('Caption check returned HTTP ' + prepared.status() + ': ' + JSON.stringify(failure));
    assert.ok(['NO_CAPTIONS', 'SOURCE_UNVERIFIED', 'TEMPORARY', 'PERMANENT'].includes(failure.code), 'Unexpected caption failure: ' + JSON.stringify(failure));
    assert.ok(typeof failure.error === 'string' && failure.error.trim());
    await page.waitForFunction(() => !document.querySelector('#submit').disabled, null, {timeout: 10000});
    assert.ok((await page.locator('#feedback').textContent()).includes(failure.error), 'The page should show the caption failure');
    assert.equal(articleRequests.length, 0, 'Caption failure must stop before POST /api/articles');
    assert.equal(summaryRequests.length, 0);
    console.log(`视频 ${videoId} 的字幕检查返回 HTTP ${prepared.status()}，分类 ${failure.code}。网页未提交文章生成。\n${failure.error}`);
    return;
  }
  assert.ok(!expectCaptionError, 'The caption source is ready; this video is no longer a negative fixture');
  const ready = await prepared.json();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.videoId, videoId);
  assert.equal(ready.text, undefined);
  const article = articleResponse ?? await page.waitForResponse(res => res.url() === api, {timeout: 210000});
  assert.ok(!articleStartedEarly, 'The page posted an article before it received ready captions');
  assert.equal(article.request().postDataJSON().requirements, requirements);
  if (article.status() !== 200) assert.fail('Article request returned HTTP ' + article.status() + ': ' + await article.text());
  const buttons = page.locator('.chapter-head > .summary-toggle');
  await waitForChapters(page, 1);
  if (!await buttons.count()) {
    const status = await page.locator('#reader-status').textContent();
    const feedback = await page.locator('#feedback').textContent();
    assert.fail('No chapter became available. ' + [status, feedback].filter(Boolean).join(' '));
  }
  assert.equal(summaryRequests.length, 0, 'The unopened page must not fetch a 5W1H');
  const firstReadyMs = await page.evaluate(() => Math.round(window.firstSealed - window.submittedAt));
  const articleId = await page.evaluate(() => window.articleId);
  assert.match(articleId, /^[a-f0-9]{64}$/);
  const chapterPath = n => api + '/' + articleId + '/chapters/ch-' + n + '/summary';
  const path = chapterPath(1);
  // This out-of-page GET can only read status or stored data. No reader has
  // opened the panel yet and the page itself has made zero summary requests.
  const precomputed = await readReadySummary(page, path);
  assert.equal(summaryRequests.length, 0, 'The page fetched a summary before the user clicked');
  await page.evaluate(() => { window.firstSummaryClickAt = performance.now(); });
  const [summary] = await Promise.all([
    page.waitForResponse(res => res.url() === path, {timeout: 30000}),
    buttons.first().click(),
  ]);
  assert.equal(summary.status(), 200, 'Opening a ready chapter should read the existing cache');
  assert.deepEqual(await summary.json(), precomputed);
  const firstBox = page.locator('#summary-ch-1');
  await verifySummary(firstBox, precomputed);
  await buttons.first().click();
  await buttons.first().click();
  assert.ok(await firstBox.isVisible());
  assert.equal(summaryRequests.length, 1, 'Reopening the same summary should use the browser cache');
  await buttons.first().click();

  const secondPath = chapterPath(2);
  await waitForChapters(page, 2);
  const hasSecond = await buttons.count() >= 2;
  let replayedPending;
  if (hasSecond) {
    replayedPending = await verifyPendingPanel(page, buttons.nth(1), secondPath);
    assert.ok(summaryRequests.length >= 3);
  } else {
    assert.ok(!constrained, 'The user requested two chapters');
  }
  for (const request of summaryRequests) {
    assert.ok(request.url() === path || request.url() === secondPath);
    assert.equal(request.method(), 'GET');
    assert.equal(request.postData(), null);
  }
  await waitForChapters(page, 0);
  assert.match(await page.locator('#reader-status').innerText(), /(?:生成|转写)完成/, await page.locator('#feedback').textContent());

  const {partial, durationMs} = await page.evaluate(api => {
    const end = performance.getEntriesByName(api).at(-1).responseEnd;
    return {
      partial: window.readingSamples.filter(s => s.at < end && s.at < window.firstSummaryClickAt)
        .map(s => ({ms: Math.round(s.at - window.submittedAt), chars: s.visible})),
      durationMs: Math.round(end - window.submittedAt),
    };
  }, api);
  let meta, done, deltas = 0;
  let unitText = '';
  const markdownChunks = [];
  const closedChapters = [];
  const coverage = [];
  const stream = new Response(await page.evaluate(() => window.articleEvents), {headers: article.headers()});
  for await (const {type, data} of events(stream)) {
    if (type === 'meta') meta = data;
    if (type === 'delta') {
      deltas++;
      markdownChunks.push(data.text);
      if (!constrained) unitText += data.text;
    }
    if (type === 'chapter') closedChapters.push(data);
    assert.ok(!done, 'Received an article event after done');
    if (type === 'coverage') {
      if (data.completed > 0) {
        const prose = unitText.replace(/^#{1,6}[ \t]+[^\n]*$/gm, '').replace(/^\*\*[^\n*]{1,64}[：:]\*\*\s*/gm, '').trim();
        assert.ok(prose, 'Source unit ' + data.completed + ' was marked complete without a paragraph delta');
      }
      coverage.push(data);
      unitText = '';
    }
    if (type === 'error') assert.fail(data.message || 'The article stream reported an error');
    if (type === 'done') done = data;
  }
  assert.ok(meta && done, 'Article stream ended before meta and done');
  const chapters = done.chapters;
  const markdown = markdownChunks.join('');
  if (markdownOut) {
    await writeFile(markdownOut, markdown);
    console.log('Article Markdown:', markdownOut);
  }
  let total;
  if (!constrained) {
    total = verifyCoverage(coverage, done.coverage, await archiveUnitCount(meta));
    const display = page.locator('#reader-coverage');
    assert.ok(await display.isVisible(), 'Expected visible final caption progress');
    assert.match(await display.innerText(), new RegExp('\\b' + total + '\\s*/\\s*' + total + '\\b'));
  }
  // For a single-unit caption the entire spoken sentence may arrive in one
  // frame. All longer runs must show actual prose growing before completion.
  if (total !== 1) {
    assert.ok(partial.length >= 2 && partial.at(-1).chars > partial[0].chars && partial.at(-1).ms > partial[0].ms,
      'Expected visible paragraph text to grow on separate frames before the article response ended');
  }
  assert.equal(meta.videoId, videoId);
  assert.equal(meta.articleId, articleId);
  assert.equal(meta.source, ready.source, 'The article must use the source prepared for the submitted video');
  assert.ok(sources.includes(meta.source), 'Unexpected caption source ' + meta.source);
  if (expectedSource) assert.equal(meta.source, expectedSource, 'Expected the article to use the requested caption source');
  if (meta.sourceUrl) {
    assert.equal(new URL(meta.sourceUrl).protocol, 'https:');
    const credits = await page.locator('#reader-source a').evaluateAll(nodes => nodes.map(a => a.href));
    assert.ok(credits.includes(new URL(meta.sourceUrl).href), 'Expected a visible source credit linking to the verified captions');
  }
  assert.ok(deltas >= (total === 1 ? 1 : 2), 'Expected streamed text deltas for the video');
  assert.deepEqual(closedChapters, chapters, 'Each chapter should be announced when sealed');
  if (!meta.timeline?.length) {
    for (const {title} of chapters)
      assert.doesNotMatch(title, /\[\d{1,4}:\d{2}(?::\d{2})?\]/, 'A transcript without timecodes should produce untimed chapter titles');
  }
  assert.ok(chapters.length > 0);
  if (constrained) assert.equal(chapters.length, 2, 'Requested two chapters');
  const sections = await page.locator('.chapter-head').evaluateAll(readChapters);
  const rawChapters = markdown.split(/^##[ \t]+/m).slice(1);
  assert.equal(rawChapters.length, chapters.length);
  assert.equal(sections.length, chapters.length);
  const links = await page.locator('.chapter-head a.chapter-time').evaluateAll(nodes => nodes.map(a => a.href));
  checkSourceLinks(links, meta.timeline || [], videoId);
  for (const [i, section] of sections.entries()) {
    if (!constrained) assert.equal(section.recaps, 0, 'A full transcript should keep editorial summaries out of the dialogue');
    assert.match(section.text, /\p{Script=Han}/u, 'Expected readable Chinese prose in each chapter');
    assert.equal(section.subtopics.length, [...rawChapters[i].matchAll(/^###[ \t]+\S/gm)].length, 'Every subheading should render');
    if (constrained) assert.match(section.text, /[？?][\s\S]*\p{Script=Han}/u, 'Expected a reader question followed by an answer');
  }
  if (!constrained && videoId === 'xRh2sVcNXQ8') verifyInterview(sections);
  // Remaining chapters have never been opened. Read their real background results too.
  for (let n = 3; n <= chapters.length; n++) validateSix(await readReadySummary(page, chapterPath(n)));
  assert.equal(await buttons.count(), chapters.length);
  const viewportEvidence = partial.length >= 2
    ? `首屏正文 ${partial[0].ms} ms 可读，结束前屏内正文从 ${partial[0].chars} 增至 ${partial.at(-1).chars} 个字符，共 ${partial.length} 次可见增长`
    : '字幕只有一个转写单元，未测得分帧正文增长';
  const pendingEvidence = !hasSecond ? '这次只生成一章，未测第二章的等待交互' : replayedPending ? '第二章已缓存，模拟一次 202 和一次 503 后，面板自动读到真实结果' : '第二章首次读取返回 202，下一次读取模拟一次 503，面板随后自动填入真实后台结果';
  const coverageEvidence = constrained ? '已验证按要求改写的两章问答' : `按序确认 ${total}/${total} 个字幕单元`;
  const evidence = `视频 ${videoId}，来源 ${meta.source}，${viewportEvidence}。全文 ${durationMs} ms，${deltas} 个增量事件，共 ${chapters.length} 章，${coverageEvidence}。全部章节均读到六项后台结果。首章封存在 ${firstReadyMs} ms 可见。页面从未读取 5W1H 时，独立 GET 已读到首章六项缓存，点击后显示了相同结果。${pendingEvidence}。`;
  console.log(evidence);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `[打开已验证的公开 Worker](${origin})\n\n${evidence}\n`);
}
try {
  await verifyPage(browser);
} finally {
  await browser.close();
}
