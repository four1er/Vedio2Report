import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const videoId = 'xRh2sVcNXQ8';
const title = "Marc Andreessen's 2026 Outlook: AI Timelines, US vs. China, and The Price of AI";
const filename = "Marc Andreessen's 2026 Outlook_ AI Timelines, US vs. China, and The Price of AI (xRh2sVcNXQ8).md";
const archiveUrl = 'https://raw.githubusercontent.com/ledeeden/yt-subtitle-fetcher/af5881fc6d633c7a08ab760af0fd2cafbe1e8b9a/data/a16z/' + encodeURIComponent(filename);
const dir = new URL('../src/worker/archives/', import.meta.url);
const output = new URL(videoId + '.json', dir);
const textHash = '49757a31b1d37a0d0cceaf5e7640e97465ec3917dd9eced91bd37f49642185ec';
const hash = data => createHash('sha256').update(data).digest('hex');

async function prepare() {
  const existing = await readFile(output, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing) {
    const cached = JSON.parse(existing);
    if (cached.videoId === videoId && cached.title === title && hash(cached.text) === textHash) return;
  }

  const response = await fetch(archiveUrl, {signal: AbortSignal.timeout(30000)});
  assert.ok(response.ok, 'Could not download the reference subtitles: HTTP ' + response.status);
  const file = await response.text();
  assert.equal(hash(file), '13e94db108a969516cb3cb05eae75151f9d027e72860c627dd495391e7e9e22b');
  assert.ok(file.includes('video_id: "' + videoId + '"'));
  const section = file.split('<!-- YOUTUBE_TRANSCRIPT_START -->')[1].split('<!-- YOUTUBE_TRANSCRIPT_END -->')[0];
  const cues = Array.from(section.matchAll(/^(\d\d:\d\d:\d\d) --> (\d\d:\d\d:\d\d)\n([^\n]+)$/gm));
  assert.equal(cues.length, 2801);
  assert.equal(cues[0][1], '00:00:00');
  assert.equal(cues.at(-1)[2], '01:21:06');
  const text = cues.map(cue => cue[3].trim()).join('\n');
  assert.equal(hash(text), textHash);

  await mkdir(dir, {recursive: true});
  const tmp = new URL(videoId + '.' + process.pid + '.tmp', dir);
  await writeFile(tmp, JSON.stringify({videoId, title, text}));
  await rename(tmp, output);
  console.log('Prepared ' + videoId + ': ' + cues.length + ' English subtitle cues.');
}

await prepare();
