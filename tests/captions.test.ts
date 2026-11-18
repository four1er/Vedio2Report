import { afterEach, describe, expect, it, vi } from "vitest";
import { getVideoSource, parseVideoId } from "../src/worker/captions";
const referenceVideoId = "xRh2sVcNXQ8";

const otherId = "fHsa9Dqm0CU";
const timedtextUrl = (id: string) => `https://www.youtube.com/api/timedtext?v=${id}&sig=unchanged`;

function watchPage(id: string, baseUrl = timedtextUrl(id)) {
  const player = {
    videoDetails: { videoId: id, title: '含有 "a}b" 的标题' },
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
    expect(await getVideoSource(otherId)).toEqual({ text: "第一句。\n第二句。", source: "youtube", title: '含有 "a}b" 的标题' });
    const track = new URL(fetcher.mock.calls[1][0]);
    expect(track.searchParams.get("fmt")).toBe("json3");
    expect(track.searchParams.get("sig")).toBe("unchanged");
    expect(track.searchParams.get("lang")).toBe("en");
    expect(fetcher.mock.calls[1][1].redirect).toBe("manual");
  });

  it("refuses caption URLs outside the timedtext endpoint before fetching", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(watchPage(otherId, `https://evil.example/api/timedtext?v=${otherId}`));
    vi.stubGlobal("fetch", fetcher);
    expect(await getVideoSource(otherId)).toEqual({source: "youtube-video", title: ""});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("selects the original video for the reference interview and other unarchived videos", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("blocked", {status: 429}))));
    expect(await getVideoSource(referenceVideoId)).toEqual({source: "youtube-video", title: ""});
    expect(await getVideoSource(otherId)).toEqual({source: "youtube-video", title: ""});
  });

  it("switches to the original video if the full transcript exceeds the text budget", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(watchPage(otherId)).mockResolvedValueOnce(
      Response.json({events: [{segs: [{utf8: "文".repeat(34_000)}]}]}),
    ));
    expect(await getVideoSource(otherId)).toEqual({source: "youtube-video", title: ""});
  });
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
  expect(await getVideoSource(otherId)).toEqual({source: "youtube-video", title: ""});
});

it.each([
  ["mismatched video id", timedtextUrl(referenceVideoId)],
  ["unrelated YouTube path", `https://www.youtube.com/redirect?v=${otherId}`],
  ["nonstandard port", `https://www.youtube.com:9876/api/timedtext?v=${otherId}`],
  ["userinfo", `https://unknown@www.youtube.com/api/timedtext?v=${otherId}`],
])("drops a track with %s", async (_label, captionUrl) => {
  const fetcher = vi.fn().mockResolvedValueOnce(watchPage(otherId, captionUrl));
  vi.stubGlobal("fetch", fetcher);
  expect(await getVideoSource(otherId)).toEqual({source: "youtube-video", title: ""});
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].redirect).toBe("manual");
});

it.each(["watch", "track"])("rejects %s redirects without following Location", async stage => {
  const fetcher = vi.fn();
  if (stage === "track") fetcher.mockResolvedValueOnce(watchPage(otherId));
  fetcher.mockResolvedValueOnce(Response.redirect("https://untrusted.example/target", 302));
  vi.stubGlobal("fetch", fetcher);
  expect(await getVideoSource(otherId)).toEqual({source: "youtube-video", title: ""});
  expect(fetcher).toHaveBeenCalledTimes(stage === "watch" ? 1 : 2);
  expect(fetcher.mock.calls.every(([, options]) => options.redirect === "manual")).toBe(true);
});
