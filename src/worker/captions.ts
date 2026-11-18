import { cachedCaptions, cachedVideoId, sampleCaptions, sampleVideoId } from "./sample";

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubeHosts = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);
const invalidLink = "请输入有效的 YouTube 视频链接，例如 youtube.com/watch?v=… 或 youtu.be/…。";
const unavailable = "YouTube 暂时没有返回可读取的字幕。请确认视频公开且有字幕，或尝试示例链接。";

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
  videoDetails?: {videoId?: string; title?: string};
  captions?: {playerCaptionsTracklistRenderer?: {captionTracks?: CaptionTrack[]}};
}

// The bootstrap object can contain nested JSON, quotes and braces in titles.
function playerFromHtml(html: string): Player {
  const marker = /(?:\bytInitialPlayerResponse\s*=|window\["ytInitialPlayerResponse"\]\s*=)\s*\{/g.exec(html);
  if (!marker) throw new Error(unavailable);
  const start = marker.index + marker[0].length - 1;
  let depth = 0, quoted = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted && char === "\\") i++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === "{") depth++;
    else if (!quoted && char === "}" && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error(unavailable);
}

async function readLimited(url: string | URL, limit: number, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {redirect: "manual", signal});
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(unavailable);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error("字幕源文件过大，请换一个较短的视频。");
      }
      text += decoder.decode(value, {stream: true});
    }
  } finally {
    reader.releaseLock();
  }
}

function rank(track: CaptionTrack): number {
  const lang = track.languageCode?.split("-")[0];
  return (track.kind === "asr" ? 4 : 0) + (lang === "zh" ? 0 : lang === "en" ? 1 : 2);
}

async function liveCaptions(videoId: string) {
  const signal = AbortSignal.timeout(10000);
  const html = await readLimited(`https://www.youtube.com/watch?v=${videoId}&hl=en`, 5_000_000, signal);
  const player = playerFromHtml(html);
  if (player.videoDetails?.videoId !== videoId) throw new Error(unavailable);
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error(unavailable);
  const track = tracks.filter(t => typeof t?.baseUrl === "string").sort((a, b) => rank(a) - rank(b))[0];
  if (!track) throw new Error(unavailable);
  const trackUrl = new URL(track.baseUrl);
  if (trackUrl.protocol !== "https:" || !youtubeHosts.has(trackUrl.hostname) ||
      trackUrl.port || trackUrl.username || trackUrl.password || trackUrl.pathname !== "/api/timedtext" ||
      trackUrl.searchParams.get("v") !== videoId) throw new Error(unavailable);
  trackUrl.searchParams.set("fmt", "json3");
  const payload = JSON.parse(await readLimited(trackUrl, 5_000_000, signal)) as {
    events?: Array<{segs?: Array<{utf8?: string}>}>;
  };
  const lines = (payload.events ?? []).map(event => event.segs?.map(s => s.utf8 ?? "").join("")
      .replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = lines.join("\n");
  if (!text) throw new Error(unavailable);
  if (new TextEncoder().encode(text).byteLength > 100_000) throw new Error("字幕过长，请选择字幕在 100 KB 以内的视频。");
  return {text, title: player.videoDetails?.title || "YouTube 视频", source: "youtube"};
}

export async function getCaptions(videoId: string): Promise<{text: string; title: string; source: string}> {
  if (!videoIdPattern.test(videoId)) throw new Error(invalidLink);
  try {
    return await liveCaptions(videoId);
  } catch (err) {
    if (videoId === cachedVideoId) return cachedCaptions;
    if (videoId === sampleVideoId) return sampleCaptions;
    // Network and JSON parser exceptions can contain signed URLs or fragments of upstream HTML.
    if (err instanceof Error && /^字幕(源文件过大|过长)/.test(err.message)) throw err;
    throw new Error(unavailable);
  }
}
