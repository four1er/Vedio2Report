import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { events } from '../src/web/stream.ts';

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
  full: {type: 'boolean'}, default: {type: 'boolean'}, 'markdown-out': {type: 'string'}, 'expect-caption-error': {type: 'boolean'},
}});
assert.equal(positionals.length, 1, 'Pass one Worker URL or Wrangler deployment file.');
const fullInterview = values.full === true;
const defaultRequest = values.default === true;
const expectCaptionError = values['expect-caption-error'] === true;
assert.ok(!(defaultRequest && fullInterview), 'Choose --default for a general video or --full for the reference interview.');
assert.ok(!(expectCaptionError && fullInterview), '--expect-caption-error cannot verify a full article.');
const markdownOut = values['markdown-out'];
if (markdownOut !== undefined) assert.ok(fullInterview && markdownOut.trim(), '--markdown-out PATH requires --full');
const origin = await resolveOrigin(positionals[0]);
console.log('Public Worker:', origin);

const interviewId = 'xRh2sVcNXQ8';
const videoId = process.env.ACCEPTANCE_VIDEO_ID || interviewId;
if (fullInterview) assert.equal(videoId, interviewId, 'Full coverage check uses the reference interview');
assert.match(videoId, /^[A-Za-z0-9_-]{11}$/);

// Measure rendered prose in the viewport. A title, status change, or SSE frame
// alone does not establish that a reader saw any portion of a paragraph.
function observeReading(trackAnswers) {
  const body = document.querySelector('#body');
  const samples = [];
  window.readingSamples = samples;
  window.answerGrowth = [];
  const lastAnswers = new Map();
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
        for (;;) {
          const {value, done} = await reader.read();
          if (done) break;
          raw += value;
          if (!announceId) continue;
          const first = raw.split(/\r?\n\r?\n/);
          if (first.length > 1) {
            const data = first[0].split(/\r?\n/).find(line => line.startsWith('data:'));
            announceId(JSON.parse(data.slice(5)).articleId);
            announceId = undefined;
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
    let lastVisible = 0;
    let frame = 0;
    function sample() {
      frame = 0;
      let visible = 0;
      if (trackAnswers) {
        const turns = body.querySelectorAll('p.speaker-turn');
        turns.forEach((turn, index) => {
          const name = turn.querySelector('.speaker-label')?.textContent || '';
          if (!/^(?:Marc|Mark|马克|马可|安德森)/i.test(name.trim())) return;
          let para = turn, part = 0;
          do {
            const prose = (para === turn ? turn.querySelector('span') : para)?.textContent.trim();
            const key = index + '/' + part++;
            const last = lastAnswers.get(key);
            if (last && prose?.startsWith(last) && prose.length > last.length)
              window.answerGrowth.push({at: performance.now(), from: last.length, to: prose.length});
            if (prose) lastAnswers.set(key, prose);
            para = para.nextElementSibling;
          } while (para?.matches('p.speaker-continuation'));
        });
      }
      for (const para of body.querySelectorAll('p, li, blockquote')) {
        if (para.closest('.summary-box, .chapter-recap')) continue;
        const rect = para.getBoundingClientRect();
        if (rect.top >= innerHeight) break;
        if (rect.bottom <= 0) continue;
        const nodes = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
          for (let i = 0; i < node.length; i++) {
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const glyph = range.getBoundingClientRect();
            if (glyph.top >= innerHeight) break;
            if (glyph.height && glyph.top >= 0 && glyph.bottom <= innerHeight) visible++;
          }
        }
      }
      if (visible > lastVisible) samples.push({at: performance.now(), visible, total: body.innerText.length});
      lastVisible = visible;
    }
    new MutationObserver(() => {
      if (!window.firstSealed && body.querySelector('.chapter-head > .summary-toggle') && body.querySelector('.chapter-recap')) {
        window.firstSealed = {at: performance.now(), stillWriting: document.querySelector('#submit').disabled};
      }
      if (!frame) frame = requestAnimationFrame(sample);
    }).observe(body, {childList: true, subtree: true, characterData: true});
  }, {capture: true, once: true});
}

// Read the rendered chapter content only. Sidebar text, recap and expanded
// 5W1H fields must never count as an interviewer's question or a guest's answer.
function readChapters(headings) {
  return headings.map(heading => {
    const content = heading.nextElementSibling.matches('.summary-box')
      ? heading.nextElementSibling.nextElementSibling : heading.nextElementSibling;
    const turns = [];
    for (const p of content.querySelectorAll('p.speaker-turn, p.speaker-continuation')) {
      if (p.matches('.speaker-continuation')) {
        if (turns.length) turns.at(-1).paragraphs.push(p.innerText.trim());
        continue;
      }
      const label = p.querySelector(':scope > strong.speaker-label');
      const words = p.querySelector(':scope > span');
      if (label && words) turns.push({name: label.innerText.replace(/[：:]$/, '').trim(), paragraphs: [words.innerText.trim()]});
    }
    return {
      text: content.innerText,
      subtopics: [...content.querySelectorAll('h4')].map(h => h.innerText.trim()),
      recaps: content.querySelectorAll('.chapter-recap').length,
      paragraphs: [...content.querySelectorAll('p:not(.chapter-recap), li, blockquote')].filter(p => p.textContent.trim()).length,
      turns,
    };
  });
}

function verifyInterview(sections, markdown, timeline) {
  assert.equal(sections.length, 12);
  const raw = markdown.split(/^##[ \t]+/m).slice(1);
  assert.equal(raw.length, 12);
  const host = /^(?:Jen|John|主持人|珍|约翰)/i;
  const guest = /^(?:Mark|Marc|马克|马可|安德森)/i;
  const turnsAt = at => sections[timeline.findIndex(mark => mark.at === at)].turns;
  const words = turn => turn.paragraphs.join('\n');
  const spoken = turns => turns.map(words).join('\n');
  let multiTopic = 0, multiParagraph = 0;
  for (const [i, section] of sections.entries()) {
    const where = 'Chapter ' + (i + 1) + ' [' + timeline[i].at + ']';
    const subheads = [...raw[i].matchAll(/^###[ \t]+(.+)$/gm)];
    assert.ok(subheads.length && subheads.length === section.subtopics.length, where + ' needs rendered ### subheadings');
    assert.ok(section.subtopics.every(Boolean));
    if (subheads.length > 1) multiTopic++;
    assert.equal(section.recaps, 1, where + ' needs one recap');
    assert.ok(section.turns.some(t => host.test(t.name)) && section.turns.some(t => guest.test(t.name)), where + ' needs distinct host and guest speech');
    if (section.turns.some(t => guest.test(t.name) && t.paragraphs.filter(Boolean).length > 1)) multiParagraph++;
  }
  assert.ok(multiTopic > sections.length / 2, 'Expected multiple specific subtopics in most chapters');
  assert.ok(multiParagraph >= 2, 'Expected multi-paragraph guest answers across chapters');
  assert.ok(turnsAt('1:51').some(t => /^(?:Jen|珍)/i.test(t.name)), 'Expected Jen at 1:51');
  assert.ok(turnsAt('9:11').some(t => /^(?:John|约翰)/i.test(t.name)), 'Expected John at 9:11');

  const pricing = spoken(turnsAt('41:54'));
  assert.match(pricing, /用量|使用量|按量|按次|按使用|调用量|使用次数|消耗量|tokens?|词元/i, 'Pricing exchange should address usage');
  assert.match(pricing, /价值|成效|产出|成果|结果|效益|收益/, 'Pricing exchange should address value');
  const jobs = spoken(turnsAt('1:08:44'));
  assert.match(jobs, /就业|失业|工作|劳动力|岗位|饭碗|职业/, 'Expected the actual jobs discussion at 1:08:44');
  assert.match(jobs, /采纳|采用|民调|调查|使用|接受|普及|恐慌|担心|焦虑|离不开/, 'Expected discussion of attitudes toward adoption');

  const closing = turnsAt('1:15:50');
  let question;
  const rounds = [];
  for (const turn of closing) {
    if (host.test(turn.name) && /[？?]|是否|会不会|为什么|怎么|什么|如何/.test(words(turn))) question = words(turn);
    if (question && guest.test(turn.name)) {
      rounds.push({question, answer: words(turn)});
      question = undefined;
    }
  }
  assert.ok(rounds.length >= 2, 'Expected at least two distinct closing questions answered by Mark');
  assert.ok(rounds.some(round => /火星|Mars/i.test(round.question) && /不会|不太|可能不|大概不|恐怕不|不去|不想|不打算|没打算|不愿|不一定|大概率不|应该不|算了/.test(round.answer)),
    'Expected the interviewer to ask about Mars and Mark to say he probably would not go');
  assert.match(spoken(closing.filter(t => guest.test(t.name))), /加州|加利福尼亚|出门|离家|家门|家里|虚拟|\bVR\b|马斯克|埃隆|十年|10\s*年|往返/i,
    'Expected a substantive follow-up to the Mars answer');
  return {multiTopic, multiParagraph, rounds: rounds.length};
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

async function verifySummary(panel, data) {
  const labels = ['Who', 'What', 'When', 'Where', 'Why', 'How'];
  await panel.locator('dd').first().waitFor({timeout: 240000});
  assert.deepEqual(await panel.locator('dt').allTextContents(), labels);
  for (const [i, label] of labels.entries()) {
    const field = data[label.toLowerCase()];
    assert.ok(typeof field === 'string' && field.trim());
    assert.equal(await panel.locator('dd').nth(i).textContent(), field);
  }
  for (const key of ['what', 'why', 'how']) assert.match(data[key], /\p{Script=Han}/u);
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
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  if (videoId === interviewId) {
    await page.locator('#fill').click();
    assert.equal(await page.locator('#video').inputValue(), url);
  } else {
    await page.locator('#video').fill(url);
  }
  const scope = videoId === interviewId ? '只讨论受访者对 AI 产品定价的看法。' : '只讨论字幕中最主要的话题。';
  const requirements = fullInterview || defaultRequest || expectCaptionError ? '' : '写给刚入行的产品经理。' + scope + '写成两章中文问答，每章约两百字，先提出一个读者的问题，再回答这个问题。';
  await page.locator('#requirements').fill(requirements);
  await page.evaluate(observeReading, fullInterview);
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
  assert.equal(ready.text, undefined);
  const article = articleResponse ?? await page.waitForResponse(res => res.url() === api, {timeout: 210000});
  assert.ok(!articleStartedEarly, 'The page posted an article before it received ready captions');
  assert.equal(article.request().postDataJSON().requirements, requirements);
  if (article.status() !== 200) assert.fail('Article request returned HTTP ' + article.status() + ': ' + await article.text());
  const buttons = page.locator('.chapter-head > .summary-toggle');
  await page.waitForFunction(() =>
    document.querySelector('.chapter-head > .summary-toggle') || !document.querySelector('#submit').disabled,
    null, {timeout: 210000});
  if (!await buttons.count()) {
    const status = await page.locator('#reader-status').textContent();
    const feedback = await page.locator('#feedback').textContent();
    assert.fail('No chapter became available. ' + [status, feedback].filter(Boolean).join(' '));
  }
  assert.equal(summaryRequests.length, 0, 'The unopened page must not fetch a 5W1H');
  await page.locator('.chapter-recap').first().waitFor();
  const firstReadyMs = await page.evaluate(allowSingleChapter => {
    if (!allowSingleChapter && !window.firstSealed.stillWriting) throw new Error('First chapter only became usable after completion');
    return Math.round(window.firstSealed.at - window.submittedAt);
  }, defaultRequest);
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
  await page.waitForFunction(() => document.querySelectorAll('.chapter-head > .summary-toggle').length >= 2 ||
    !document.querySelector('#submit').disabled, null, {timeout: 240000});
  const hasSecond = await buttons.count() >= 2;
  let replayedPending;
  if (hasSecond) {
    replayedPending = await verifyPendingPanel(page, buttons.nth(1), secondPath);
    assert.ok(summaryRequests.length >= 3);
  } else {
    assert.ok(defaultRequest, 'Expected a second chapter');
  }
  for (const request of summaryRequests) {
    assert.ok(request.url() === path || request.url() === secondPath);
    assert.equal(request.method(), 'GET');
    assert.equal(request.postData(), null);
  }
  await page.waitForFunction(() => !document.querySelector('#submit').disabled, null,
    {timeout: fullInterview ? 600000 : 210000});
  assert.match(await page.locator('#reader-status').innerText(), /生成完成/, await page.locator('#feedback').textContent());

  const {partial, growingAnswers, durationMs} = await page.evaluate(api => {
    const end = performance.getEntriesByName(api).at(-1).responseEnd;
    const length = document.querySelector('#body').innerText.length;
    return {
      partial: window.readingSamples.filter(s => s.at < end && s.at < window.firstSummaryClickAt && s.total < length && s.visible >= 10)
        .map(s => ({ms: Math.round(s.at - window.submittedAt), chars: s.visible})),
      growingAnswers: window.answerGrowth.filter(s => s.at < end),
      durationMs: Math.round(end - window.submittedAt),
    };
  }, api);
  if (!defaultRequest) assert.ok(partial.length >= 2 && partial.at(-1).ms - partial[0].ms >= 200,
    'Expected growing paragraph text inside the viewport on separate frames before the HTTP response ended');

  let meta, chapters, deltas = 0;
  const markdownChunks = [];
  const closedChapters = [];
  const stream = new Response(await page.evaluate(() => window.articleEvents), {headers: article.headers()});
  for await (const {type, data} of events(stream)) {
    if (type === 'meta') meta = data;
    if (type === 'delta') { deltas++; markdownChunks.push(data.text); }
    if (type === 'chapter') closedChapters.push(data);
    if (type === 'done') chapters = data.chapters;
  }
  assert.equal(meta.videoId, videoId);
  assert.equal(meta.articleId, articleId);
  if (videoId === interviewId) {
    assert.equal(meta.source, 'archived-youtube');
    assert.equal(meta.durationSeconds, 4878);
    assert.equal(meta.lastCaptionSeconds, 4866);
    assert.equal(meta.cueCount, 2801);
    assert.equal(meta.timeline.length, 12);
  } else assert.ok(meta.source === 'youtube' || (videoId === 'C4GIqWeywiI' && meta.source === 'cached'));
  assert.ok(deltas >= (defaultRequest ? 1 : 2));
  assert.deepEqual(closedChapters, chapters, 'Each chapter should be announced when sealed');
  if (!meta.timeline?.length) {
    for (const {title} of chapters)
      assert.doesNotMatch(title, /\[\d{1,4}:\d{2}(?::\d{2})?\]/, 'A transcript without timecodes should produce untimed chapter titles');
  }
  assert.equal(await page.locator('.chapter-recap').count(), chapters.length, 'Missing automatic chapter recap');
  assert.ok(chapters.length > 0);
  if (!fullInterview && !defaultRequest) assert.equal(chapters.length, 2, 'Requested two chapters');
  const sections = await page.locator('.chapter-head').evaluateAll(readChapters);
  let interviewEvidence = '';
  if (fullInterview) {
    const markdown = markdownChunks.join('');
    if (markdownOut) {
      await writeFile(markdownOut, markdown);
      console.log('Full interview Markdown:', markdownOut);
    }
    console.log('全场章节', chapters.map(chapter => chapter.title).join(' / '));
    const links = await page.locator('.chapter-head a.chapter-time').evaluateAll(nodes => nodes.map(a => a.href));
    const timestamps = links.map(href => {
      const target = new URL(href);
      assert.equal(target.origin + target.pathname, 'https://www.youtube.com/watch');
      assert.equal(target.searchParams.get('v'), interviewId);
      const offset = target.searchParams.get('t');
      assert.match(offset || '', /^\d+s?$/);
      return Number(offset.replace(/s$/, ''));
    });
    const publisherStarts = meta.timeline.map(mark =>
      mark.at.split(':').reduce((total, part) => total * 60 + Number(part), 0));
    assert.deepEqual(timestamps, publisherStarts, 'Expected every publisher topic, in chronological order');
    const {multiTopic, multiParagraph, rounds} = verifyInterview(sections, markdown, meta.timeline);
    assert.ok(growingAnswers.length, 'Expected a single Mark answer paragraph to gain text on different frames before the article response ended');
    const growth = growingAnswers[0];
    interviewEvidence = `其中 ${multiTopic} 章含多个子标题，${multiParagraph} 章含跨段回答，收尾读到 ${rounds} 轮问答；流结束前同一回答段从 ${growth.from} 增长到 ${growth.to} 字符。`;
  } else if (defaultRequest) {
    for (const section of sections) {
      assert.ok(section.paragraphs > 0, 'Expected prose in each generated chapter');
      assert.equal(section.recaps, 1);
    }
  } else {
    for (const {text} of sections) {
      assert.match(text, /[？?][\s\S]*\p{Script=Han}[\s\S]{30}/u, 'Expected a question followed by an answer in each chapter');
      if (videoId === interviewId) assert.match(text, /定价|计价|收费|价格/);
    }
  }
  assert.equal(await buttons.count(), chapters.length);
  const viewportEvidence = partial.length > 1
    ? `首屏正文 ${partial[0].ms} ms 可读，结束前屏内正文从 ${partial[0].chars} 增至 ${partial.at(-1).chars} 个字符，共 ${partial.length} 次可见增长`
    : `结束前记录到 ${partial.length} 次屏内段落采样`;
  const pendingEvidence = !hasSecond ? '这次只生成一章，未测第二章的等待交互' : replayedPending ? '第二章已缓存，模拟一次 202 和一次 503 后，面板自动读到真实结果' : '第二章首次读取返回 202，下一次读取模拟一次 503，面板随后自动填入真实后台结果';
  const evidence = `视频 ${videoId}，来源 ${meta.source}，${viewportEvidence}。全文 ${durationMs} ms，${deltas} 个增量事件，共 ${chapters.length} 章。${interviewEvidence}首章封存在 ${firstReadyMs} ms 可见。页面从未读取 5W1H 时，独立 GET 已读到首章六项缓存；点击后显示了相同结果。${pendingEvidence}。`;
  console.log(evidence);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `[打开已验证的公开 Worker](${origin})\n\n${evidence}\n`);
}
try {
  await verifyPage(browser);
} finally {
  await browser.close();
}
