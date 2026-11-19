import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planTranscript } from '../src/worker/transcript-plan.ts';

// The protocol reports one acknowledged translation for each ordered source unit.
// Check the whole sequence so a jump from the first unit to the last cannot pass.
export function verifyCoverage(points, done, expectedTotal) {
  assert.ok(points.length, 'Full transcription did not report source-unit coverage');
  const total = points[0].total;
  assert.ok(Number.isSafeInteger(total) && total > 0, 'Expected a positive source-unit count');
  if (expectedTotal !== undefined) assert.equal(total, expectedTotal, 'Source-unit count differs from the archived captions');
  for (const [i, point] of points.entries()) {
    assert.equal(point.total, total, 'Source-unit count changed during the stream');
    assert.equal(point.completed, i, 'Skipped, duplicated or reordered a translated source unit');
  }
  assert.equal(points.length, total + 1, 'The stream ended before every source unit had a translation');
  assert.deepEqual(done, {completed: total, total}, 'Missing complete source-unit coverage on the done event');
  return total;
}

// Check details in the spoken paragraphs only. The original opening montage
// contains answers before the first host question. Accept alternate Chinese
// phrasings and speaker names, which are not embedded in these automatic captions.
export function verifyInterview(sections) {
  const body = sections.map(section => section.text).join('\n');
  const opening = /(?:银行|銀行)\s*(?:[账帐賬帳][户戶上]?|[户戶][头頭])|bank accounts?|(?:钱|錢|收入|资金).{0,8}(?:到账|入账|到帳|入帳)/i.exec(body);
  assert.ok(opening, 'Opening montage lost the detail about customer dollars reaching bank accounts (0:00)');
  assert.doesNotMatch(body.slice(0, opening.index), /[?？]/u, 'An unspoken question was inserted before the first montage answer');
  const host = /(?:第[几幾][个個]?(?:局|回合|[階阶]段)|哪一?[个個]?(?:[階阶]段|局|回合|步)|[什甚][么麼][样樣的]*[階阶]段|最[让讓令]?[您你人]?.{0,4}(?:[兴興][奋奮]|[激振][动動奮奋]|期待)|what inning)/i.exec(body.slice(opening.index + opening[0].length));
  assert.ok(host, 'Missing the host’s first actual question about the inning of the AI revolution (near 1:51)');
  const afterHost = body.slice(opening.index + opening[0].length + host.index + host[0].length);
  const bill = /(?:1[,.，]?047|一[千〇零]+四十七|一〇四七|一零四七)/.exec(afterHost);
  assert.ok(bill, 'Missing the discussion of California bill SB 1047 (32:46 chapter)');
  assert.match(afterHost.slice(0, bill.index), /(?:蒸汽(?:[机機]|[动動]力)|steam engine)/i, 'Missing the guest’s comparison with the steam engine');
  const afterBill = afterHost.slice(bill.index + bill[0].length);
  assert.match(afterBill.slice(0, 2500), /(?:苹果|蘋果|Apple|Meta|脸书|臉書)/i,
    'Missing the European product rollout example following SB 1047');
  const cryonics = /(?:冷[冻凍藏]|冰[冻凍封]|低[温溫].{0,8}(?:保存|休眠)|cryogen)/i.exec(afterBill);
  assert.ok(cryonics, 'Missing the question about cryogenic preservation (last chapter)');
  const afterCryonics = afterBill.slice(cryonics.index + cryonics[0].length);
  const mars = /(?:火星|Mars)/i.exec(afterCryonics);
  assert.ok(mars, 'Missing the final exchange about travelling to Mars');
  const closing = afterCryonics.slice(mars.index);
  assert.match(closing, /(?:虚拟现实|虛擬[實实]境|虛擬現實|虚拟实境|VR|加州|加利福尼亚|加利福尼亞|California)/i,
    'Missing the guest’s answer about California or visiting Mars in VR');
  assert.match(closing, /(?:[六6]\s*[个個]?\s*月|半年|six[-\s]months?)/i, 'Missing the closing six-month journey to Mars');

  assert.ok(sections.some(section => section.subtopics.length > 0), 'Expected subheadings inside the interview');
  const speakers = new Set(sections.flatMap(section => section.speakers));
  assert.ok(speakers.size >= 2, 'Expected at least two visibly distinguished speakers in the actual interview');
  assert.ok(sections.some(section => section.continuations > 0), 'Expected a long response to continue across paragraphs');
}

export async function archiveUnitCount(meta) {
  // Only compare the exact input when the deployed Worker used the same archive.
  // Native, publisher and YouTube captions can have different cue boundaries.
  if (meta.videoId !== 'xRh2sVcNXQ8' || meta.source !== 'archived-youtube') return;
  const file = new URL('../src/worker/archives/xRh2sVcNXQ8.json', import.meta.url);
  const video = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(meta.cueCount, video.cueCount);
  assert.equal(meta.lastCaptionSeconds, video.lastCaptionSeconds);
  const units = planTranscript(video).flatMap(ch => ch.batches.flat());
  const compact = text => text.replace(/\s+/gu, '');
  assert.ok(compact(units.map(unit => unit.text).join('')) === compact(video.text),
    'The planned source units omit or reorder text from the pinned captions');
  return units.length;
}
