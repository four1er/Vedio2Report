import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverCaptions, downloadCaptions, getVideoSource, parseVideoId } from "../src/worker/captions";
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

  it("reads the next verified track when the preferred track returns no text", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(watchPage(otherId))
      .mockResolvedValueOnce(Response.json({events: []}))
      .mockResolvedValueOnce(Response.json({events: [{segs: [{utf8: "当前视频的备用字幕。"}]}]}));
    vi.stubGlobal("fetch", fetcher);
    expect(await getVideoSource(otherId)).toMatchObject({source: "youtube", text: "当前视频的备用字幕。"});
    expect(fetcher.mock.calls.slice(1).map(([url]) => new URL(url).searchParams.get("lang"))).toEqual(["en", "zh"]);
  });

  it.each([
    [{playabilityStatus: {status: "LOGIN_REQUIRED"}}, "SOURCE_UNVERIFIED", "播放器要求登录"],
    [{videoDetails: {videoId: otherId}}, "SOURCE_UNVERIFIED", "播放器状态或字幕列表不完整"],
    [{videoDetails: {videoId: referenceVideoId}, playabilityStatus: {status: "OK"}}, "SOURCE_UNVERIFIED", "匹配的视频信息"],
    [{videoDetails: {videoId: otherId}, playabilityStatus: {status: "OK"}, captions: {}}, "SOURCE_UNVERIFIED", "播放器状态或字幕列表不完整"],
    [{videoDetails: {videoId: otherId}, playabilityStatus: {status: "OK"}}, "NO_CAPTIONS", "没有公开字幕轨"],
    [{videoDetails: {videoId: otherId}, playabilityStatus: {status: "OK"},
      captions: {playerCaptionsTracklistRenderer: {captionTracks: []}}}, "NO_CAPTIONS", "没有公开字幕轨"],
  ])("reports what the player actually returned", async (player, code, message) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("var ytInitialPlayerResponse = " + JSON.stringify(player)));
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverCaptions(otherId)).rejects.toMatchObject({code, status: 422, message: expect.stringContaining(message)});
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("distinguishes a blocked watch page from a listed track with no readable text", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, {status: 403}))
      .mockResolvedValueOnce(watchPage(otherId))
      .mockResolvedValueOnce(Response.json({events: []})).mockResolvedValueOnce(Response.json({events: []}));
    vi.stubGlobal("fetch", fetcher);
    await expect(getVideoSource(otherId)).rejects.toMatchObject({code: "SOURCE_UNVERIFIED", message: expect.stringContaining("观看页请求返回 HTTP 403")});
    await expect(getVideoSource(otherId)).rejects.toMatchObject({code: "TEMPORARY", status: 503, message: expect.stringContaining("字幕轨没有返回文字")});
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
    await expect(getVideoSource(otherId)).rejects.toMatchObject({code: "PERMANENT", message: expect.stringContaining("字幕过长")});
  });
});

describe("discovering and downloading captions independently", () => {
  it("discovers verified tracks without downloading them and keeps metadata through serialization", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(watchPage(otherId, timedtextUrl(otherId), "93"))
      .mockResolvedValueOnce(Response.json({events: [{tStartMs: 1_000, dDurationMs: 700,
        segs: [{utf8: "这是一条字幕。"}]}]}));
    vi.stubGlobal("fetch", fetcher);
    const discovery = await discoverCaptions(otherId);
    expect(discovery).toMatchObject({kind: "live", videoId: otherId, durationSeconds: 93,
      trackUrls: [timedtextUrl(otherId) + "&lang=en&fmt=json3", timedtextUrl(otherId) + "&lang=zh&fmt=json3"]});
    expect(fetcher).toHaveBeenCalledOnce();
    const source = await downloadCaptions(JSON.parse(JSON.stringify(discovery)));
    expect(source).toMatchObject({source: "youtube", durationSeconds: 93, cueCount: 1, lastCaptionSeconds: 1, text: "这是一条字幕。"});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks for a fresh attempt when discovering is rate limited or signed tracks have expired", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, {status: 429}))
      .mockResolvedValueOnce(watchPage(otherId)).mockImplementation(() => Promise.resolve(new Response(null, {status: 403})));
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverCaptions(otherId)).rejects.toMatchObject({code: "TEMPORARY", status: 503});
    const discovery = await discoverCaptions(otherId);
    await expect(downloadCaptions(discovery)).rejects.toMatchObject({code: "TEMPORARY", status: 503});
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("revalidates stored URLs and rejects an archive ID with no matching transcript", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const mismatched = {kind: "live" as const, videoId: otherId, title: "", trackUrls: [timedtextUrl(referenceVideoId)]};
    await expect(downloadCaptions(mismatched)).rejects.toMatchObject({code: "SOURCE_UNVERIFIED"});
    await expect(downloadCaptions({kind: "archive", videoId: otherId, title: ""})).rejects.toMatchObject({code: "PERMANENT"});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses W3C's matching archive if discovery succeeded but the subsequent download failed", async () => {
    const id = "C4GIqWeywiI";
    const fetcher = vi.fn().mockResolvedValueOnce(watchPage(id)).mockRejectedValue(new Error("track network failure"));
    vi.stubGlobal("fetch", fetcher);
    const discovery = await discoverCaptions(id);
    expect(discovery.kind).toBe("live");
    expect(await downloadCaptions(discovery)).toMatchObject({source: "cached", text: expect.stringContaining("Web Accessibility Evaluation Tools List")});
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
  fetcher.mockImplementation(() => Promise.resolve(Response.redirect("https://untrusted.example/target", 302)));
  vi.stubGlobal("fetch", fetcher);
  await expect(getVideoSource(otherId)).rejects.toThrow("可读取的字幕");
  expect(fetcher).toHaveBeenCalledTimes(stage === "watch" ? 1 : 3);
  expect(fetcher.mock.calls.every(([url]) => new URL(url).hostname === "www.youtube.com")).toBe(true);
  expect(fetcher.mock.calls.every(([, options]) => options.redirect === "manual")).toBe(true);
});

describe("YouTube watch redirects", () => {
  const redirect = (location: string, status = 302) => new Response(null, {status, headers: {Location: location}});

  it("follows relative and canonical HTTPS locations only for the same video", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(redirect("/shorts/" + otherId))
      .mockResolvedValueOnce(redirect("https://m.youtube.com/watch?v=" + otherId, 308))
      .mockResolvedValueOnce(watchPage(otherId))
      .mockResolvedValueOnce(Response.json({events: [{segs: [{utf8: "原视频字幕。"}]}]}));
    vi.stubGlobal("fetch", fetcher);
    expect(await getVideoSource(otherId)).toMatchObject({source: "youtube", text: "原视频字幕。"});
    expect(fetcher.mock.calls.slice(1, 3).map(([url]) => String(url))).toEqual([
      "https://www.youtube.com/shorts/" + otherId, "https://m.youtube.com/watch?v=" + otherId,
    ]);
    expect(fetcher.mock.calls.every(([, options]) => options.redirect === "manual")).toBe(true);
  });

  it.each([
    ["https://consent.youtube.com/m?continue=secret", "同意设置页面"],
    ["https://accounts.google.com/ServiceLogin?continue=secret", "登录页面"],
    ["https://www.google.com/sorry/index?continue=secret", "流量验证页面"],
    ["/sorry?continue=secret", "流量验证页面"],
    ["/redirect?dest=secret", "YouTube 的其他页面"],
    ["https://accounts.google.com.unknown.example/ServiceLogin?continue=secret", "外部页面"],
    ["/watch?v=" + referenceVideoId, "匹配同一视频"],
    ["/watch?v=" + otherId + "&v=" + referenceVideoId, "匹配同一视频"],
    ["http://www.youtube.com/watch?v=" + otherId, "公开播放页格式"],
    ["https://www.youtube.com:8443/watch?v=" + otherId, "公开播放页格式"],
    ["https://secret@www.youtube.com/watch?v=" + otherId, "公开播放页格式"],
  ])("stops at %s and returns a redacted reason", async (location, reason) => {
    const fetcher = vi.fn().mockResolvedValueOnce(redirect(location));
    vi.stubGlobal("fetch", fetcher);
    const attempt = getVideoSource(otherId);
    await expect(attempt).rejects.toThrow(reason);
    await expect(attempt).rejects.not.toThrow(/secret|unknown\.example|continue=/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stops at a repeated location or after three canonical redirects", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(redirect("#same-page"));
    vi.stubGlobal("fetch", fetcher);
    await expect(getVideoSource(otherId)).rejects.toThrow("循环跳转");
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear().mockImplementation((url: URL) =>
      Promise.resolve(redirect("/watch?v=" + otherId + "&hop=" + (Number(url.searchParams.get("hop")) + 1))));
    await expect(getVideoSource(otherId)).rejects.toThrow("跳转次数过多");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
