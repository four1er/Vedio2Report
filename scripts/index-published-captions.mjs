// Maintainer operation, never run during install or a user's request.
// Usage: node scripts/index-published-captions.mjs /path/to/3b1b/captions COMMIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const [, , checkout, revision] = process.argv;
assert.ok(checkout && /^[a-f0-9]{40}$/.test(revision), 'Supply the local caption repository and a full commit hash.');
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
const files = new Set(git('ls-tree', '-r', '--name-only', revision).split('\n'));
const catalog = JSON.parse(git('show', revision + ':app/src/data/lessons.json'));
const lessons = new Map();
for (const {path, title} of catalog) {
  assert.ok(/^\d{4}\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path) && typeof title === 'string' && title.trim());
  if (!files.has(path + '/video_url.txt') || !files.has(path + '/english/captions.srt')) continue;
  const url = git('show', revision + ':' + path + '/video_url.txt').trim();
  const videoId = /^https:\/\/(?:youtu\.be\/|(?:www\.)?youtube\.com\/(?:shorts\/|watch\?v=))([a-zA-Z0-9_-]{11})$/.exec(url)?.[1];
  assert.ok(videoId && !lessons.has(videoId), 'Invalid or repeated publisher video ID for ' + path);
  lessons.set(videoId, [path, title]);
}
assert.ok(lessons.size, 'The catalog has no matching English subtitle tracks.');
const rows = Array.from(lessons.keys()).sort().map(id => '    ' + JSON.stringify(id) + ': ' + JSON.stringify(lessons.get(id)));
const manifest = '{\n  "revision": ' + JSON.stringify(revision) + ',\n  "lessons": {\n' + rows.join(',\n') + '\n  }\n}\n';
await writeFile(new URL('../src/worker/published-index.json', import.meta.url), manifest);
console.log('Indexed ' + lessons.size + ' creator-published caption tracks at ' + revision + '.');
