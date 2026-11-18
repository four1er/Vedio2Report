import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { events } from '../src/web/stream.ts';

const records = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const deployed = records.findLast(row => row.type === 'deploy' && row.version === 1 && row.version_id);
const origin = deployed?.targets?.find(target => /^https:\/\/vedio2report\.[a-z0-9-]+\.workers\.dev$/.test(target));
assert.ok(origin, 'Wrangler did not report a deployed vedio2report workers.dev URL.');
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
assert.equal(article.status, 200, 'Article HTTP status');
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
    throw new Error('The Worker reported a generation error. Check the Gemini configuration and quota.');
  }
}
assert.ok(articleId && chapterId && /^##\s+.+/m.test(markdown) && /\p{Script=Han}/u.test(markdown),
  'Incomplete Chinese article, chapter headings, or completion event');
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const summary = await fetch(origin + '/api/articles/' + articleId + '/chapters/' + chapterId + '/summary', {
  method: 'POST', signal: AbortSignal.timeout(105_000),
});
assert.equal(summary.status, 200, '5W1H HTTP status');
const data = await summary.json();
for (const key of ['who', 'what', 'when', 'where', 'why', 'how']) {
  assert.ok(typeof data[key] === 'string' && data[key].trim(), 'Missing 5W1H field: ' + key);
}
const evidence = `视频 ${videoId}，字幕来源 ${source}，首个正文片段 ${firstDeltaMs} ms，全文 ${seconds} s，共 ${deltas} 个增量事件，首章 5W1H 六项齐全。`;
console.log(evidence);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `[打开已验证的公开 Worker](${origin})\n\n${evidence}\n`);
