import { afterEach, describe, expect, it, vi } from "vitest";
import { getVideoSource, parseVideoId } from "../src/worker/captions";
import { writeArticle } from "../src/worker/gemini";
import type { Bindings } from "../src/worker/protocol";
const referenceVideoId = "xRh2sVcNXQ8";

const otherId = "fHsa9Dqm0CU";
const timedtextUrl = (id: string) => `https://www.youtube.com/api/timedtext?v=${id}&sig=unchanged`;

function watchPage(id: string, baseUrl = timedtextUrl(id), lengthSeconds?: string) {
  const player = {
    videoDetails: { videoId: id, title: '含有 "a}b" 的标题', lengthSeconds },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: baseUrl + "&lang=zh", kind: "asr", languageCode: "zh" },
      { baseUrl: baseUrl + "&lang=en", languageCode: "en" },
    ] } },
  };
  return new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`);
}

afterEach(() => vi.unstubAllGlobals());

describe("YouTube URLs", () => {
  it.each([
    `https://www.youtube.com/watch?v=${otherId}&t=100`,
    `https://youtu.be/${otherId}`,
    `https://m.youtube.com/shorts/${otherId}`,
    `https://youtube.com/live/${otherId}`,
    `https://www.youtube.com/embed/${otherId}`,
  ])("recognizes %s", url => expect(parseVideoId(url)).toBe(otherId));

  it.each([
    `https://www.youtube.com.attacker.example/watch?v=${otherId}`,
    `https://www.youtube.com@attacker.example/watch?v=${otherId}`,
    `https://cookie@www.youtube.com/watch?v=${otherId}`,
    `ftp://youtu.be/${otherId}`,
    `https://youtu.be:444/${otherId}`,
    `https://youtu.be/${otherId}/tail`,
    "https://www.youtube.com/watch?v=too-short",
  ])("rejects %s", url => expect(() => parseVideoId(url)).toThrow());
});

describe("caption acquisition", () => {
  it("extracts matching player data and human captions, combining only timed text segments", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(watchPage(otherId)).mockResolvedValueOnce(
      Response.json({ events: [{ tStartMs: 0 }, { segs: [{ utf8: "第一" }, { utf8: "句。" }] },
        { segs: [{ utf8: " \n" }] }, { segs: [{ utf8: "第二句。" }] }] }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await getVideoSource(otherId)).toEqual({ text: "第一句。\n第二句。", cueCount: 2, source: "youtube", title: '含有 "a}b" 的标题' });
    const track = new URL(fetcher.mock.calls[1][0]);
    expect(track.searchParams.get("fmt")).toBe("json3");
    expect(track.searchParams.get("sig")).toBe("unchanged");
    expect(track.searchParams.get("lang")).toBe("en");
    expect(fetcher.mock.calls[1][1].redirect).toBe("manual");
  });

  it("uses the live video's own duration and timed speech, ignoring events without speech", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(watchPage(otherId, timedtextUrl(otherId), "420"))
      .mockResolvedValueOnce(Response.json({events: [
        {segs: [{utf8: "开场。"}]},
        {tStartMs: 2000, dDurationMs: 2000, segs: [{utf8: "问好。"}]},
        {tStartMs: 359900, dDurationMs: 1250, segs: [{utf8: "再见。"}]},
        {tStartMs: 412000, dDurationMs: 1000, segs: [{utf8: " "}]},
      ]}));
    vi.stubGlobal("fetch", fetcher);
    expect(await getVideoSource(otherId)).toMatchObject({
      cueCount: 3, durationSeconds: 420, lastCaptionSeconds: 361,
      timeline: [{at: "0:02", firstCue: 2}, {at: "5:59", firstCue: 3}],
    });
  });

  it("refuses caption URLs outside the timedtext endpoint before fetching", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(watchPage(otherId, `https://evil.example/api/timedtext?v=${otherId}`));
    vi.stubGlobal("fetch", fetcher);
    await expect(getVideoSource(otherId)).rejects.toThrow("可读取的字幕");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves the complete matching archive offline and reports unavailable captions for other videos", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("blocked", {status: 429})));
    vi.stubGlobal("fetch", fetcher);
    const reference = await getVideoSource(referenceVideoId);
    expect(reference.source).toBe("archived-youtube");
    expect(reference).toMatchObject({durationSeconds: 4878, lastCaptionSeconds: 4866, cueCount: 2801});
    expect(reference.timeline).toHaveLength(12);
    expect(reference.timeline?.at(-1)).toMatchObject({at: "1:15:50"});
    expect(reference.text.split("\n")).toHaveLength(2801);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(getVideoSource(otherId)).rejects.toThrow("可读取的字幕");
  });

  it("rejects an oversized live transcript without sending it to Gemini", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(watchPage(otherId)).mockResolvedValueOnce(
      Response.json({events: [{segs: [{utf8: "文".repeat(34_000)}]}]}),
    ));
    await expect(getVideoSource(otherId)).rejects.toThrow("字幕过长");
  });
});

it("submits the entire reference transcript once in chronological sections for a reader's requested task", async () => {
  const reference = await getVideoSource(referenceVideoId);
  const video = {...reference, videoId: referenceVideoId};
  const env = {GEMINI_API_KEY: "test"} as Bindings;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    const source = JSON.parse(payload.contents[0].parts[0].text).video;
    expect(source).not.toHaveProperty("text");
    expect(source).not.toHaveProperty("timeline");
    expect(source.segments.map((s: {at: string}) => s.at)).toEqual(reference.timeline?.map(mark => mark.at));
    expect(source.segments.map((s: {text: string}) => s.text).join("\n") === reference.text).toBe(true);
    expect(source.segments.at(-1).text).toContain("Mars");
    const frame = {candidates: [{content: {parts: [{text: "正文"}]}, finishReason: "STOP"}]};
    return new Response("data: " + JSON.stringify(frame) + "\n\n");
  });
  vi.stubGlobal("fetch", fetcher);
  const chunks = [];
  for await (const text of writeArticle(env, {video, requirements: "仅整理火星议题"}, new AbortController().signal)) chunks.push(text);
  expect(chunks).toEqual(["正文"]);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("preserves a genuine licensed transcript for the W3C video when YouTube is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
  const result = await getVideoSource("C4GIqWeywiI");
  expect(result.source).toBe("cached");
  expect(result.text?.split("\n")).toHaveLength(14);
  expect(result.text).toContain("Web Accessibility Evaluation Tools List");
});

it("counts non-BMP caption characters as four UTF-8 bytes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(watchPage(otherId)).mockResolvedValueOnce(
    Response.json({events: [{segs: [{utf8: "🔔".repeat(25_001)}]}]}),
  ));
  await expect(getVideoSource(otherId)).rejects.toThrow("字幕过长");
});

it.each([
  ["mismatched video id", timedtextUrl(referenceVideoId)],
  ["unrelated YouTube path", `https://www.youtube.com/redirect?v=${otherId}`],
  ["nonstandard port", `https://www.youtube.com:9876/api/timedtext?v=${otherId}`],
  ["userinfo", `https://unknown@www.youtube.com/api/timedtext?v=${otherId}`],
])("drops a track with %s", async (_label, captionUrl) => {
  const fetcher = vi.fn().mockResolvedValueOnce(watchPage(otherId, captionUrl));
  vi.stubGlobal("fetch", fetcher);
  await expect(getVideoSource(otherId)).rejects.toThrow("可读取的字幕");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].redirect).toBe("manual");
});

it.each(["watch", "track"])("rejects %s redirects without following Location", async stage => {
  const fetcher = vi.fn();
  if (stage === "track") fetcher.mockResolvedValueOnce(watchPage(otherId));
  fetcher.mockResolvedValueOnce(Response.redirect("https://untrusted.example/target", 302));
  vi.stubGlobal("fetch", fetcher);
  await expect(getVideoSource(otherId)).rejects.toThrow("可读取的字幕");
  expect(fetcher).toHaveBeenCalledTimes(stage === "watch" ? 1 : 2);
  expect(fetcher.mock.calls.every(([, options]) => options.redirect === "manual")).toBe(true);
});
