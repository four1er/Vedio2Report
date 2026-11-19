import { cachedCaptions, cachedVideoId } from "./sample";
import interview from "./archives/xRh2sVcNXQ8.json";
import { ApiError } from "./protocol";

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubeHosts = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);
const invalidLink = "请输入有效的 YouTube 视频链接，例如 youtube.com/watch?v=… 或 youtu.be/…。";
export type CaptionErrorCode = "NO_CAPTIONS" | "SOURCE_UNVERIFIED" | "TEMPORARY" | "PERMANENT";
export class CaptionSourceError extends ApiError {
  constructor(readonly code: CaptionErrorCode, message: string, status = code === "TEMPORARY" ? 503 : 422) {
    super(status, message);
  }
}

function unavailable(reason: string, code: CaptionErrorCode = "SOURCE_UNVERIFIED"): CaptionSourceError {
  return new CaptionSourceError(code, "YouTube 未返回可读取的字幕。" + reason);
}

interface CaptionMark {at: string; firstCue: number; topic?: string}
export interface Source {
  source: "youtube" | "cached" | "archived-youtube";
  title: string;
  text: string;
  durationSeconds?: number;
  lastCaptionSeconds?: number;
  cueCount?: number;
  timeline?: CaptionMark[];
}
export type Video = Source & {videoId: string};

// Server-only: signed URLs are valid for limited time and must never be sent to the client.
interface LiveDiscovery {
  kind: "live";
  videoId: string;
  title: string;
  durationSeconds?: number;
  trackUrls: string[];
}
export type CaptionDiscovery = LiveDiscovery | {kind: "archive"; videoId: string; title: string};

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
  } else if (youtubeHosts.has(url.hostname)) {
    id = url.pathname === "/watch" ? url.searchParams.get("v") ?? undefined :
      /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !videoIdPattern.test(id)) throw new Error(invalidLink);
  return id;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}
interface Player {
  playabilityStatus?: {status?: string};
  videoDetails?: {videoId?: string; title?: string; lengthSeconds?: string};
  captions?: {playerCaptionsTracklistRenderer?: {captionTracks?: CaptionTrack[]}};
}

// The bootstrap object can contain nested JSON, quotes and braces in titles.
function playerFromHtml(html: string): Player {
  const marker = /(?:\bytInitialPlayerResponse\s*=|window\["ytInitialPlayerResponse"\]\s*=)\s*\{/g.exec(html);
  if (!marker) throw unavailable("观看页未提供播放器数据。");
  const start = marker.index + marker[0].length - 1;
  let depth = 0, quoted = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted && char === "\\") i++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === "{") depth++;
    else if (!quoted && char === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { break; }
    }
  }
  throw unavailable("观看页中的播放器数据无法解析。");
}

async function readLimited(res: Response, stage: "观看页" | "字幕轨"): Promise<string> {
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    const temporary = res.ok || res.status === 408 || res.status === 425 || res.status === 429 ||
      res.status >= 500 || (stage === "字幕轨" && [401, 403, 404, 410].includes(res.status));
    throw unavailable(`${stage}请求返回 HTTP ${res.status}。`, temporary ? "TEMPORARY" : "SOURCE_UNVERIFIED");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 5_000_000) {
        await reader.cancel();
        throw unavailable(stage + "超过 5 MB 读取上限。", "PERMANENT");
      }
      text += decoder.decode(value, {stream: true});
    }
  } finally {
    reader.releaseLock();
  }
}

function watchRedirect(location: string | null, from: URL, videoId: string): URL {
  if (!location || !URL.canParse(location, from)) throw unavailable("观看页跳转缺少有效地址。");
  const next = new URL(location, from);
  if (next.protocol !== "https:" || next.port || next.username || next.password)
    throw unavailable("观看页跳转地址不符合公开播放页格式。");
  const host = next.hostname;
  if (host === "consent.youtube.com" || host === "consent.google.com")
    throw unavailable("YouTube 将观看页转到了同意设置页面。");
  if (host === "accounts.google.com" || (youtubeHosts.has(host) && next.pathname === "/signin"))
    throw unavailable("YouTube 将观看页转到了登录页面。");
  if ((youtubeHosts.has(host) || host === "www.google.com" || host === "google.com") &&
      /^\/sorry(?:\/|$)/.test(next.pathname))
    throw unavailable("YouTube 将观看页转到了 Google 流量验证页面。");
  if (!youtubeHosts.has(host)) throw unavailable("观看页跳转到了未识别的外部页面。");

  const ids = next.searchParams.getAll("v");
  const pathId = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(next.pathname)?.[1];
  if (next.pathname !== "/watch" && !pathId)
    throw unavailable("观看页跳转到了 YouTube 的其他页面。");
  if ((pathId ?? ids[0]) !== videoId || ids.length > 1 || ids.some(id => id !== videoId))
    throw unavailable("观看页跳转后的链接未能匹配同一视频。");
  next.hash = "";
  return next;
}

async function readWatchPage(videoId: string, signal: AbortSignal): Promise<string> {
  let url = new URL(`https://www.youtube.com/watch?v=${videoId}&hl=en`);
  const seen = new Set<string>([url.href]);
  const maxRedirects = 3;
  for (;;) {
    const res = await fetch(url, {redirect: "manual", signal});
    if (![301, 302, 303, 307, 308].includes(res.status)) return readLimited(res, "观看页");
    await res.body?.cancel();
    url = watchRedirect(res.headers.get("Location"), url, videoId);
    if (seen.has(url.href)) throw unavailable("观看页发生循环跳转。");
    if (seen.size > maxRedirects) throw unavailable("观看页连续跳转次数过多。");
    seen.add(url.href);
  }
}

function rank(track: CaptionTrack): number {
  const lang = typeof track.languageCode === "string" ? track.languageCode.split("-")[0] : undefined;
  return (track.kind === "asr" ? 4 : 0) + (lang === "zh" ? 0 : lang === "en" ? 1 : 2);
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

function verifiedTrackUrl(baseUrl: string, videoId: string): URL | undefined {
  if (!URL.canParse(baseUrl)) return;
  const trackUrl = new URL(baseUrl);
  const ids = trackUrl.searchParams.getAll("v");
  if (trackUrl.protocol !== "https:" || !youtubeHosts.has(trackUrl.hostname) ||
      trackUrl.port || trackUrl.username || trackUrl.password || trackUrl.pathname !== "/api/timedtext" ||
      ids.length !== 1 || ids[0] !== videoId) return;
  trackUrl.searchParams.set("fmt", "json3");
  trackUrl.hash = "";
  return trackUrl;
}

function parseCues(raw: string) {
  const payload = JSON.parse(raw) as {
    events?: Array<{tStartMs?: number; dDurationMs?: number; segs?: Array<{utf8?: string}>}>;
  };
  if (!Array.isArray(payload?.events)) return [];
  return payload.events.map(event => ({
    text: Array.isArray(event?.segs) ? event.segs.map(s => typeof s?.utf8 === "string" ? s.utf8 : "")
      .join("").replace(/\s+/g, " ").trim() : "",
    start: event?.tStartMs, duration: event?.dDurationMs,
  })).filter(cue => cue.text);
}

function sourceFailure(error: unknown, reason: string): CaptionSourceError {
  if (error instanceof CaptionSourceError) return error;
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
    return unavailable("字幕获取超时，请稍后重试。", "TEMPORARY");
  return unavailable(reason, "TEMPORARY");
}

async function readTracks(discovery: LiveDiscovery, signal: AbortSignal) {
  let failure = unavailable("播放器列出的字幕地址无法与该视频匹配。");
  for (const baseUrl of discovery.trackUrls) {
    const url = verifiedTrackUrl(baseUrl, discovery.videoId);
    if (!url) continue;
    try {
      const res = await fetch(url, {redirect: "manual", signal});
      const cues = parseCues(await readLimited(res, "字幕轨"));
      if (cues.length) return cues;
      throw unavailable("播放器列出了字幕轨，但字幕轨没有返回文字。", "TEMPORARY");
    } catch (error) {
      if (signal.aborted) throw error;
      const next = sourceFailure(error, "播放器列出了字幕轨，但未能读取字幕数据。");
      // One retryable listed track is enough to justify rediscovery on the next attempt.
      if (failure.code !== "TEMPORARY" || next.code === "TEMPORARY") failure = next;
    }
  }
  throw failure;
}

async function discoverLive(videoId: string): Promise<LiveDiscovery> {
  const html = await readWatchPage(videoId, AbortSignal.timeout(10000));
  const player = playerFromHtml(html);
  const status = player.playabilityStatus?.status;
  if (status === "LOGIN_REQUIRED") throw unavailable("播放器要求登录后才能访问该视频。");
  if (status && status !== "OK") throw unavailable("播放器当前无法公开播放该视频。");
  if (player.videoDetails?.videoId !== videoId) throw unavailable("观看页没有提供与链接匹配的视频信息。");
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) {
    if (status === "OK" && (player.captions === undefined || Array.isArray(tracks)))
      throw unavailable("这次返回的播放器数据中没有公开字幕轨。", "NO_CAPTIONS");
    throw unavailable("播放器状态或字幕列表不完整，暂时无法确认是否有公开字幕轨。");
  }
  const ranked = tracks.filter(track => typeof track?.baseUrl === "string").sort((a, b) => rank(a) - rank(b));
  const urls = new Set<string>();
  for (const track of ranked) {
    const url = verifiedTrackUrl(track.baseUrl, videoId);
    if (url) urls.add(url.href);
  }
  if (!urls.size) throw unavailable("播放器列出的字幕地址无法与该视频匹配。");
  const discovery: LiveDiscovery = {
    kind: "live", videoId, title: player.videoDetails.title || "YouTube 视频", trackUrls: [...urls],
  };
  const length = Number(player.videoDetails.lengthSeconds);
  if (Number.isSafeInteger(length) && length > 0) discovery.durationSeconds = length;
  return discovery;
}

async function downloadLive(discovery: LiveDiscovery): Promise<Source> {
  const cues = await readTracks(discovery, AbortSignal.timeout(10000));
  const text = cues.map(cue => cue.text).join("\n");
  if (new TextEncoder().encode(text).byteLength > 100_000)
    throw new CaptionSourceError("PERMANENT", "字幕过长，请选择字幕在 100 KB 以内的视频。");
  const result: Source = {text, title: discovery.title, source: "youtube", cueCount: cues.length};
  if (discovery.durationSeconds !== undefined) result.durationSeconds = discovery.durationSeconds;
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

export async function discoverCaptions(videoId: string): Promise<CaptionDiscovery> {
  if (!videoIdPattern.test(videoId)) throw new CaptionSourceError("PERMANENT", invalidLink, 400);
  if (videoId === interview.videoId) return {kind: "archive", videoId, title: interview.title};
  try {
    return await discoverLive(videoId);
  } catch (error) {
    if (videoId === cachedVideoId) return {kind: "archive", videoId, title: cachedCaptions.title};
    throw sourceFailure(error, "暂时无法连接到 YouTube，请稍后重试。");
  }
}

export async function downloadCaptions(discovery: CaptionDiscovery): Promise<Source> {
  const {videoId} = discovery;
  if (!videoIdPattern.test(videoId)) throw new CaptionSourceError("PERMANENT", invalidLink, 400);
  if (discovery.kind === "archive") {
    if (videoId === interview.videoId) return {...interview, source: "archived-youtube"};
    if (videoId === cachedVideoId) return cachedCaptions;
    throw unavailable("没有与该视频 ID 匹配的字幕存档。", "PERMANENT");
  }
  try {
    return await downloadLive(discovery);
  } catch (error) {
    if (videoId === cachedVideoId) return cachedCaptions;
    throw sourceFailure(error, "暂时无法下载 YouTube 字幕，请稍后重试。");
  }
}

export async function getVideoSource(videoId: string): Promise<Source> {
  return downloadCaptions(await discoverCaptions(videoId));
}
