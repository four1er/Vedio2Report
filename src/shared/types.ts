export const SUMMARY_KEYS = ['who', 'what', 'when', 'where', 'why', 'how'] as const

export type SummaryKey = (typeof SUMMARY_KEYS)[number]
export type Summary5W1H = Record<SummaryKey, string>

export interface ParsedRequirements {
  taskType?: string
  outputStyle?: string
  targetAudience?: string
  constraints: string[]
}

export type CaptionSourceKind = 'youtube-proxy' | 'youtube-direct' | 'archive'

export interface TimelineMark {
  at: string
  firstCue?: number
  topic?: string
}

export interface ChapterMeta {
  id: string
  title: string
}

export interface ArticleMeta {
  articleId: string
  videoId: string
  title: string
  source: CaptionSourceKind
  language?: string
  cueCount?: number
  durationSeconds?: number
  lastCaptionSeconds?: number
  timeline?: TimelineMark[]
}
