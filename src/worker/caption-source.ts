import { ApiError } from "./protocol";

export const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
export const youtubeHosts = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);
export const invalidLink = "请输入有效的 YouTube 视频链接，例如 youtube.com/watch?v=… 或 youtu.be/…。";
export type CaptionErrorCode = "NO_CAPTIONS" | "SOURCE_UNVERIFIED" | "TEMPORARY" | "PERMANENT";
export class CaptionSourceError extends ApiError {
  constructor(readonly code: CaptionErrorCode, message: string, status = code === "TEMPORARY" ? 503 : 422, readonly restricted = false) {
    super(status, message);
  }
}

export function unavailable(reason: string, code: CaptionErrorCode = "SOURCE_UNVERIFIED", restricted = false): CaptionSourceError {
  return new CaptionSourceError(code, "YouTube 未返回可读取的字幕。" + reason, undefined, restricted);
}

interface CaptionMark {at: string; firstCue: number; topic?: string}
export interface Source {
  source: "youtube" | "cached" | "archived-youtube" | "published-captions" | "native-api";
  sourceUrl?: string;
  sourceLabel?: string;
  title: string;
  text: string;
  durationSeconds?: number;
  lastCaptionSeconds?: number;
  cueCount?: number;
  timeline?: CaptionMark[];
}
export type Video = Source & {videoId: string};

export function parseVideoId(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(invalidLink);
  }
  if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password) {
    throw new Error(invalidLink);
  }
  let id: string | undefined;
  if (url.hostname === "youtu.be") {
    id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  } else if (["www.youtube-nocookie.com", "youtube-nocookie.com"].includes(url.hostname)) {
    id = /^\/embed\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  } else if (youtubeHosts.has(url.hostname) || url.hostname === "music.youtube.com") {
    id = url.pathname === "/watch" ? (url.searchParams.getAll("v").length === 1 ? url.searchParams.get("v")! : undefined) :
      /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !videoIdPattern.test(id)) throw new Error(invalidLink);
  return id;
}

function clockTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

function validMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface CaptionCue {text: string; start?: number; duration?: number}

export function sourceFromCues(cues: CaptionCue[], metadata: Omit<Source, "text">): Source {
  if (!cues.length || !cues.some(cue => cue.text.trim()))
    throw unavailable("字幕文件没有可读正文。", "TEMPORARY");
  const text = cues.map(cue => cue.text).join("\n");
  if (new TextEncoder().encode(text).byteLength > 512_000)
    throw new CaptionSourceError("PERMANENT", "字幕过长，请选择字幕在 512 KB 以内的视频。");
  const result: Source = {...metadata, text, cueCount: cues.length};
  const last = cues[cues.length - 1];
  if (validMs(last.start) && validMs(last.duration)) {
    const end = Math.floor((last.start + last.duration) / 1000);
    if (result.durationSeconds === undefined || end <= result.durationSeconds) result.lastCaptionSeconds = end;
  }
  // Bound the metadata even for unusually long or discontinuous caption tracks.
  const latestMs = cues.reduce((latest, cue) => validMs(cue.start) ? Math.max(latest, cue.start) : latest, 0);
  const spacing = Math.max(300_000, Math.ceil(latestMs / 32));
  const marks: CaptionMark[] = [];
  let nextMs = 0;
  for (const [i, cue] of cues.entries()) {
    if (validMs(cue.start) && cue.start >= nextMs) {
      marks.push({at: clockTime(Math.floor(cue.start / 1000)), firstCue: i + 1});
      nextMs = cue.start + spacing;
    }
  }
  if (marks.length) result.timeline = marks;
  return result;
}
