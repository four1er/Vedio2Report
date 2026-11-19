// All ordinary writing preferences keep the complete video in scope. A reader
// can separately request either a verbatim rendition or a scoped adaptation.
const narrowerSource = [
  /(?:只|仅|僅)(?:需|要)?(?:转写|翻译|整理|讨论|介绍|看|讲|写|分析|涵盖|关注|包含|保留|提取)(?!\s*(?:全(?:篇|片|文|场|部)|整(?:场|段|篇)|原(?:话|文|意)|(?:成|为)?(?:中|英|日|德|法|西班牙)文|[，。；,;]|$))/i,
  /(?:聚焦|专注于|限定于|限于)/i,
  /\b(?:only (?:transcribe|translate|discuss|cover|include|keep|extract)|focus (?:only )?on|limit the (?:transcript|article|output) to)\b/i,
];
const derivedDeliverable = [
  /摘要|总结|總結|概要|概述|概括|梗概|提要|纪要|紀要|简报|简写|精简|浓缩|压缩|壓縮/i,
  /(?:提炼|提取)(?:出)?(?:主要|关键|核心|重点|要点)|(?:改写|写成|生成|撰写)(?:一[篇份个])?(?:新闻稿|报告|评论|社交媒体帖|读者问答|常见问题|FAQ)/i,
  /(?:不超过|不超過|限定在?|控制在?|最多|大?约|限|用)\s*[\d一二三四五六七八九十百千两]+\s*(?:个)?字|[\d一二三四五六七八九十百千两]+\s*字(?:左右|以内|以內)/i,
  /\b(?:summary|summari[sz]e|abridg(?:e|ed)|condense|tl;?dr|meeting minutes|key takeaways|executive brief|under \d+ words)\b/i,
];
const wholeTranscript = [
  /(?:全篇|全片|全程|全局|完整|全文|逐字|逐句|逐段|从头到尾)(?:地|进行|的)?(?:中文)?(?:转写|转录|翻译|轉寫|轉錄|翻譯)|(?:转写|翻译)(?:全文|全片|全篇)/i,
  /\b(?:verbatim|unabridged|full transcript(?:ion)?|transcribe the (?:entire|whole|full) (?:video|interview))\b/i,
];

function negated(prefix: string) {
  return /(?:不是(?:完全)?(?:的)?|不需要|不要|不能|不应(?:该)?|无需|不用|不可|禁止|别|避免|不必|请勿|不|勿)(?:把[^，。；]{0,14}(?:变成|写成|改成)|完全|一定要|再|直接|生成|写成|写|做|进行|任何|一份|\s)*$/.test(prefix)
    || /\b(?:no|never|without|do not|don't|avoid|not)\s+(?:(?:provide|write|give|just|only|a|an|any)\s+)*$/i.test(prefix);
}

function affirmative(clause: string, patterns: RegExp[]) {
  return patterns.some(pattern => Array.from(clause.matchAll(new RegExp(pattern.source, 'gi')))
    .some(match => !negated(clause.slice(0, match.index))));
}

const cleanupPreferences = [
  /(?:稍微|稍作|稍加|稍稍|适当|适度|轻度|轻微|略作|略加|略微|稍)(?:地|做些|做点|做个)?(?:整理|归纳|提炼|小结|总结|概括|精简|压缩)(?:一下|一些)?/i,
  /(?:总结|概括|精简|压缩|整理)(?:一点点|一小点|一点|一些)|精简(?:一下)?口语/i,
  /\b(?:lightly|gently|slightly)\s+(?:summari[sz]e|condense|abridge|edit)\b/i,
  /(?:删(?:去|除|掉)|去(?:除|掉)|合(?:并|併)|精简|压缩|略去|省略|减少)(?:掉|无意义的|重复的|无效的)?(?:口头禅|语气词|口头重复|重复|赘述|寒暄|停顿)/i,
  /\b(?:remove|cut|omit|merge)\s+(?:the |all )?(?:fillers?|repetition|false starts)\b/i,
];
function requestedAdaptation(clauses: string[]): boolean {
  const narrow = clauses.some(c => affirmative(c, narrowerSource)
    && !/(?:只|仅)(?:需|要)?保留(?:原意|原话|原文|说话人|发言人|标点|格式|语气|口吻)/.test(c));
  if (narrow) return true;
  if (clauses.some(c => affirmative(c, wholeTranscript))) return false;
  // “Slightly condense the interview” is a preference about the edited
  // prose. A separate deliverable or length instruction in the same clause
  // still applies after removing these editing phrases.
  const deliverables = clauses.map(clause => cleanupPreferences.reduce(
    (rest, pattern) => rest.replace(new RegExp(pattern.source, 'gi'), ' '), clause));
  return deliverables.some(c => !/(?:章末|每章末尾|章节末尾|文末|另附|附上|at the end|append a)/i.test(c)
    && !/(?:章节|每(?:个)?章|按钮|面板).{0,20}5w1h|5w1h.{0,12}(?:按钮|面板)/i.test(c)
    && affirmative(c, derivedDeliverable));
}

const verbatimPreferences = [
  /逐字|逐句(?:转写|转录|翻译|照录)|(?:按|保留|照录)(?:全部|所有)?原话(?:逐句|逐字|原样)|原样(?:转写|转录|照录|翻译)|(?:完全|完整(?:无删减)?|全盘|全量)(?:转写|转录)|一字不(?:落|漏|删)/i,
  /(?:保留|照录)(?:全部|所有|每一句)原话|(?:保留|记录|照录)(?:所有|全部|每个)?(?:语气词|口头禅|口头停顿|口吃|结巴)|不(?:要|得|能)?删减(?:任何|原话|一个字)/i,
  /\b(?:verbatim|word[- ]for[- ]word|unabridged|include (?:every|all) (?:fillers?|false starts))\b/i,
];
export type ArticleMode = 'edited' | 'verbatim' | 'adapted';
export function articleMode(requirements = ''): ArticleMode {
  const clauses = requirements.normalize('NFKC').split(/[，。,;；!?！？\n]/).map(c => c.trim());
  if (requestedAdaptation(clauses)) return 'adapted';
  if (clauses.some(c => affirmative(c, verbatimPreferences)) && !clauses.some(c => affirmative(c, cleanupPreferences))) return 'verbatim';
  return 'edited';
}

const chapterWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function chineseCount(value: string) {
  const digit = (c: string) => '零一二三四五六七八九'.indexOf(c.replace(/[两兩]/, '二'));
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return (tens ? digit(tens) : 1) * 10 + (ones ? digit(ones) : 0);
  }
  return value.length === 1 ? digit(value) : NaN;
}

export function requestedChapterCount(requirements = ''): number | undefined {
  let count: number | undefined;
  const text = requirements.normalize('NFKC');
  const number = /(?:分(?:为|為|成)?|划分为|写成|共|整理为|输出|用)?\s*([0-9]{1,2}|[一二三四五六七八九十两兩]{1,3})\s*(?:个|個)?(?:章(?:节|節)?)|\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+chapters?\b/gi;
  for (const match of text.matchAll(number)) {
    const before = text.slice(0, match.index);
    if (negated(before) || /(?:第|[\d一二三四五六七八九十两兩–—~至到-])\s*$/.test(before)) continue;
    const value = (match[1] ?? match[2]).toLowerCase();
    const parsed = /^\d+$/.test(value) ? Number(value) : match[1] ? chineseCount(value) : chapterWords.indexOf(value) + 1;
    if (parsed >= 1 && parsed <= 99) count = parsed;
  }
  return count;
}
