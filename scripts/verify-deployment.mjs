import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { events, responseError } from '../src/web/stream.ts';

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

async function checkPage() {
  // A new workers.dev hostname can take a moment to resolve. Retry only this read.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(8_000) });
      assert.equal(response.status, 200, 'Homepage HTTP status');
      assert.match(await response.text(), /<title>声稿/);
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      await pause(3_000);
    }
  }
}

await checkPage();
const started = performance.now();
const archivedVideoId = 'C4GIqWeywiI';
const videoId = process.env.ACCEPTANCE_VIDEO_ID || archivedVideoId;
assert.match(videoId, /^[A-Za-z0-9_-]{11}$/, 'Expected an 11-character YouTube video ID');
const article = await fetch(origin + '/api/articles', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://youtu.be/' + videoId,
    requirements: '面向首次接触这个主题的读者，分两章写约四百字的中文导读，不添加字幕之外的事实。',
  }),
  signal: AbortSignal.timeout(210_000),
});
if (!article.ok) throw await responseError(article, '文章请求失败');
let articleId, chapterId, firstDeltaMs, source;
let deltas = 0, markdown = '';
for await (const { type, data } of events(article)) {
  if (type === 'meta') {
    assert.equal(data.videoId, videoId);
    assert.ok(data.source === 'youtube' || (videoId === archivedVideoId && data.source === 'cached'),
      'Expected real video captions or the matching W3C archive');
    source = data.source;
    assert.match(data.articleId, /^[a-f0-9]{64}$/);
    articleId = data.articleId;
  } else if (type === 'delta') {
    assert.ok(articleId && !chapterId && typeof data.text === 'string' && data.text.length, 'Unexpected article delta');
    firstDeltaMs ??= Math.round(performance.now() - started);
    deltas++;
    markdown += data.text;
  } else if (type === 'done') {
    assert.ok(deltas && !chapterId, 'Missing streamed content before completion');
    chapterId = data.chapters?.[0]?.id;
    assert.match(chapterId, /^ch-[1-9]\d*$/);
  } else if (type === 'error') {
    throw new Error(data.message || '文章生成中断');
  }
}
assert.ok(articleId && chapterId && /^##\s+.+/m.test(markdown) && /\p{Script=Han}/u.test(markdown),
  'Incomplete Chinese article, chapter headings, or completion event');
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const summary = await fetch(origin + '/api/articles/' + articleId + '/chapters/' + chapterId + '/summary', {
  method: 'POST', signal: AbortSignal.timeout(105_000),
});
if (!summary.ok) throw await responseError(summary, '首章 5W1H 请求失败');
const data = await summary.json();
for (const key of ['who', 'what', 'when', 'where', 'why', 'how']) {
  assert.ok(typeof data[key] === 'string' && data[key].trim(), 'Missing 5W1H field: ' + key);
}
const evidence = `视频 ${videoId}，字幕来源 ${source}，首个正文片段 ${firstDeltaMs} ms，全文 ${seconds} s，共 ${deltas} 个增量事件，首章 5W1H 六项齐全。`;
console.log(evidence);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `[打开已验证的公开 Worker](${origin})\n\n${evidence}\n`);
