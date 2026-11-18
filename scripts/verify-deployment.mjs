import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
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
const origin = await resolveOrigin(process.argv[2]);
console.log('Public Worker:', origin);

const interviewId = 'xRh2sVcNXQ8';
const videoId = process.env.ACCEPTANCE_VIDEO_ID || interviewId;
assert.match(videoId, /^[A-Za-z0-9_-]{11}$/);

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
      window.articleEvents = response.clone().text();
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
      for (const para of body.querySelectorAll('p, li, blockquote')) {
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
      if (!frame) frame = requestAnimationFrame(sample);
    }).observe(body, {childList: true, subtree: true, characterData: true});
  }, {capture: true, once: true});
}

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {channel: 'chrome'}),
  ...(proxy ? {proxy: {server: proxy}} : {}),
});
try {
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
  const requirements = '写给刚入行的产品经理。' + scope + '写成两章中文问答，每章约两百字，先提出一个读者的问题，再回答这个问题。';
  await page.locator('#requirements').fill(requirements);
  await page.evaluate(observeReading);
  const api = origin + '/api/articles';
  const summaryRequests = [];
  page.on('request', req => {
    if (req.url().endsWith('/summary')) summaryRequests.push(req);
  });
  const [article] = await Promise.all([
    page.waitForResponse(res => res.url() === api, {timeout: 210000}),
    page.locator('#submit').click(),
  ]);
  assert.equal(article.request().postDataJSON().requirements, requirements);
  assert.equal(article.status(), 200, 'Article request failed');
  await page.waitForFunction(() => !document.querySelector('#submit').disabled, null, {timeout: 210000});
  assert.match(await page.locator('#reader-status').innerText(), /生成完成/, await page.locator('#feedback').textContent());

  const {partial, durationMs} = await page.evaluate(api => {
    const end = performance.getEntriesByName(api).at(-1).responseEnd;
    const length = document.querySelector('#body').innerText.length;
    return {
      partial: window.readingSamples.filter(s => s.at < end && s.total < length && s.visible >= 10)
        .map(s => ({ms: Math.round(s.at - window.submittedAt), chars: s.visible})),
      durationMs: Math.round(end - window.submittedAt),
    };
  }, api);
  assert.ok(partial.length >= 2 && partial.at(-1).ms - partial[0].ms >= 200,
    'Expected growing paragraph text inside the viewport on separate frames before the HTTP response ended');

  let meta, chapters, deltas = 0;
  const stream = new Response(await page.evaluate(() => window.articleEvents), {headers: article.headers()});
  for await (const {type, data} of events(stream)) {
    if (type === 'meta') meta = data;
    if (type === 'delta') deltas++;
    if (type === 'done') chapters = data.chapters;
  }
  assert.equal(meta.videoId, videoId);
  assert.match(meta.articleId, /^[a-f0-9]{64}$/);
  if (videoId === interviewId) assert.equal(meta.source, 'archived-youtube');
  else assert.ok(meta.source === 'youtube' || (videoId === 'C4GIqWeywiI' && meta.source === 'cached'));
  assert.ok(deltas >= 2);
  assert.equal(chapters.length, 2, 'Requested two chapters');
  const prose = await page.locator('#body').innerText();
  if (videoId === interviewId) assert.match(prose, /定价|计价|收费/);
  const sections = await page.locator('.chapter-head').evaluateAll(headings => headings.map(heading => {
    let text = heading.querySelector('h3').innerText + '\n';
    for (let node = heading.nextElementSibling; node && !node.classList.contains('chapter-head'); node = node.nextElementSibling) {
      if (!node.hidden) text += node.innerText + '\n';
    }
    return text;
  }));
  for (const text of sections) {
    assert.match(text, /[？?][\s\S]*\p{Script=Han}[\s\S]{30}/u, 'Expected a question followed by an answer in each chapter');
  }
  const buttons = page.locator('.chapter-head > .summary-toggle');
  assert.equal(await buttons.count(), chapters.length);
  assert.equal(summaryRequests.length, 0, 'Summary must be generated on demand');
  const path = api + '/' + meta.articleId + '/chapters/' + chapters[0].id + '/summary';
  const [summary] = await Promise.all([
    page.waitForResponse(res => res.url() === path, {timeout: 105000}),
    buttons.first().click(),
  ]);
  assert.equal(summary.status(), 200, '5W1H HTTP status');
  assert.equal(summary.request().method(), 'POST');
  assert.equal(summary.request().postData(), null);
  const data = await summary.json();
  const box = page.locator('.summary-box:visible');
  await box.locator('dd').first().waitFor();
  const labels = ['Who', 'What', 'When', 'Where', 'Why', 'How'];
  assert.deepEqual(await box.locator('dt').allTextContents(), labels);
  for (const [i, label] of labels.entries()) {
    const field = data[label.toLowerCase()];
    assert.ok(typeof field === 'string' && field.trim());
    assert.equal(await box.locator('dd').nth(i).textContent(), field);
  }
  for (const key of ['what', 'why', 'how']) assert.match(data[key], /\p{Script=Han}/u);
  const evidence = `视频 ${videoId}，来源 ${meta.source}，首屏正文 ${partial[0].ms} ms 可读，结束前屏内正文从 ${partial[0].chars} 增至 ${partial.at(-1).chars} 个字符，共 ${partial.length} 次可见增长。全文 ${durationMs} ms，${deltas} 个增量事件，两章问答及首章 5W1H 验收通过。`;
  console.log(evidence);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `[打开已验证的公开 Worker](${origin})\n\n${evidence}\n`);
} finally {
  await browser.close();
}
