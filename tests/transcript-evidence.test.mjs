import { describe, expect, it } from 'vitest';
import { archiveUnitCount, verifyCoverage, verifyInterview, verifyLecture, verifyUnitOutput } from '../scripts/transcript-evidence.mjs';

describe('article generation acceptance', () => {
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

  it('lets edited acknowledgements follow grouped speech or a filler-only span while verbatim must emit prose per ID', () => {
    expect(() => verifyUnitOutput('edited', 2, '')).not.toThrow();
    expect(() => verifyUnitOutput('verbatim', 0, '')).not.toThrow();
    expect(() => verifyUnitOutput('verbatim', 2, '## 话题\n\n**讲者：** ')).toThrow(/without a paragraph/);
    expect(() => verifyUnitOutput('verbatim', 2, '**讲者：** 原始发言。')).not.toThrow();
  });

  it('keeps substantive interview evidence in the default edit and allows a shortened final exchange', () => {
    const spoken = '我们目前处于哪个阶段？从微处理器起步，这场技术变革已经走了八十年。加州 SB 1047 法案参考了欧洲立法，苹果推迟了上线。你愿意去火星吗？我不想离开加州，可能会用 VR 体验。';
    const section = {text: spoken, subtopics: ['市场与技术'], speakers: ['主持人：', '嘉宾：'], continuations: 1};
    expect(() => verifyInterview([section], 'edited')).not.toThrow();
    expect(() => verifyInterview([{...section, text: spoken.replace('苹果', '某个产品')}], 'edited')).toThrow(/product rollout/);
    const filler = '嗯，呃，你知道，话是这样。'.repeat(3);
    expect(() => verifyInterview([{...section, text: filler + spoken}], 'edited')).toThrow(/verbal filler/);
  });

  it('allows a real rhetorical question in a lecture and rejects invented interview roles', () => {
    const section = {text: '立方体投影的期望面积是多少？反复测量取平均值。', speakers: []};
    expect(() => verifyLecture('U3O1nzSojnc', [section])).not.toThrow();
    expect(() => verifyLecture('U3O1nzSojnc', [{...section, speakers: ['读者问：', '受访者：']}])).toThrow(/interview role/);
  });

  it('checks that the actual archived source survives the unit plan', async () => {
    const meta = {videoId: 'xRh2sVcNXQ8', source: 'archived-youtube', mode: 'edited', cueCount: 2801, lastCaptionSeconds: 4866};
    const count = await archiveUnitCount(meta);
    expect(count).toBeGreaterThan(1);
    expect(await archiveUnitCount({...meta, mode: 'verbatim'})).toBe(count);
    expect(await archiveUnitCount({...meta, source: 'youtube'})).toBeUndefined();
  });

  it('rejects invented opening questions and missing final speech even with every heading present', () => {
    // Minimal excerpts for the spot-check oracle. Unit coverage is tested separately.
    const speech = '客户付的钱进了银行账户。我们现在是第几局？这次影响可比蒸汽机。加州 SB 1047 法案参考了欧洲立法，苹果推迟了上线。你会选择人体冷冻吗？你打算去火星吗？我连加州都不想离开。我会报名，去火星得花半年。';
    const section = {subtopics: ['开场'], speakers: ['说话人甲', '说话人乙'], continuations: 1};
    const check = text => verifyInterview([{...section, text}], 'verbatim');
    expect(() => check(speech)).not.toThrow();
    expect(() => check('最近 AI 收入情况如何？' + speech)).toThrow(/unspoken question/);
    expect(() => check(speech.slice(0, speech.lastIndexOf('我会报名')))).toThrow(/six-month/);
    expect(() => check(speech.replace('1047', ''))).toThrow(/SB 1047/);
  });
});
