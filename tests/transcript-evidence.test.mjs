import { describe, expect, it } from 'vitest';
import { archiveUnitCount, verifyCoverage, verifyInterview } from '../scripts/transcript-evidence.mjs';

describe('default transcription acceptance', () => {
  it('requires an unbroken sequence from zero through completion', () => {
    const progress = n => ({completed: n, total: 3});
    const valid = [0, 1, 2, 3].map(progress);
    expect(verifyCoverage(valid, progress(3), 3)).toBe(3);
    expect(() => verifyCoverage([0, 1, 3].map(progress), progress(3))).toThrow(/Skipped/);
    expect(() => verifyCoverage([0, 1, 1, 2, 3].map(progress), progress(3))).toThrow(/duplicated/);
    expect(() => verifyCoverage(valid.slice(0, -1), progress(3))).toThrow(/stream ended/);
    expect(() => verifyCoverage(valid, undefined)).toThrow(/done event/);
    expect(() => verifyCoverage(valid, progress(3), 4)).toThrow(/archived captions/);
  });

  it('checks that the actual archived source survives the unit plan', async () => {
    const meta = {videoId: 'xRh2sVcNXQ8', source: 'archived-youtube', cueCount: 2801, lastCaptionSeconds: 4866};
    expect(await archiveUnitCount(meta)).toBeGreaterThan(1);
    expect(await archiveUnitCount({...meta, source: 'youtube'})).toBeUndefined();
  });

  it('rejects invented opening questions and missing final speech even with every heading present', () => {
    // Minimal excerpts for the spot-check oracle. Unit coverage is tested separately.
    const speech = '客户付的钱进了银行账户。我们现在是第几局？这次影响可比蒸汽机。加州 SB 1047 法案参考了欧洲立法，苹果推迟了上线。你会选择人体冷冻吗？你打算去火星吗？我连加州都不想离开。我会报名，去火星得花半年。';
    const section = {subtopics: ['开场'], speakers: ['说话人甲', '说话人乙'], continuations: 1};
    const check = text => verifyInterview([{...section, text}]);
    expect(() => check(speech)).not.toThrow();
    expect(() => check('最近 AI 收入情况如何？' + speech)).toThrow(/unspoken question/);
    expect(() => check(speech.slice(0, speech.lastIndexOf('我会报名')))).toThrow(/six-month/);
    expect(() => check(speech.replace('1047', ''))).toThrow(/SB 1047/);
  });
});
