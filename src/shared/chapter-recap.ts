// Gemini sometimes puts Markdown emphasis around the label or the entire quote.
export function chapterRecapText(line: string): string | undefined {
  const quote = /^>\s*(.*)$/.exec(line.trim())?.[1];
  if (!quote) return;
  const normalized = quote
    .replace(/^\*\*小结\s*([：:])\s*\*\*/, '小结$1')
    .replace(/^\*\*小结\*\*/, '小结')
    .replace(/^\*\*(小结\s*[：:].*)\*\*$/, '$1');
  return /^小结\s*[：:]\s*(.*)$/.exec(normalized)?.[1].trim() || undefined;
}
