import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, it, vi } from "vitest";
import { events } from "../src/web/stream";

const script = buildSync({
  entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", target: "es2022",
}).outputFiles[0].text;
const api = "https://example.test/api/";

function startRuntime(upstream: (request: Request) => Promise<Response>, resourcePersistencePath?: string) {
  return new Miniflare(convertV4MiniflareOptions({
    host: "127.0.0.1", cf: false, compatibilityDate: "2026-06-01", modules: true, script, resourcePersistencePath,
    bindings: {GEMINI_API_KEY: "offline-fixture"},
    durableObjects: {
      ARTICLES: {className: "ArticleSession", useSQLite: true},
      CAPTION_CACHE: {className: "CaptionCache", useSQLite: true},
    },
    outboundService: upstream,
  }));
}

function submit(runtime: Miniflare, path: "captions" | "articles", videoId: string, requirements?: string) {
  return runtime.dispatchFetch(api + path, {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({url: "https://youtu.be/" + videoId, requirements}),
  });
}

function player(videoId: string, withCaptions: boolean) {
  const data = {
    playabilityStatus: {status: "OK"},
    videoDetails: {videoId, title: "合成短访谈：河岸取样", lengthSeconds: "45"},
    captions: {playerCaptionsTracklistRenderer: {captionTracks: withCaptions ? [{
      baseUrl: "https://www.youtube.com/api/timedtext?v=" + videoId + "&lang=zh", languageCode: "zh",
    }] : []}},
  };
  return new Response("<script>var ytInitialPlayerResponse = " + JSON.stringify(data) + ";</script>");
}

async function readArticle(response: Response, chapterTitle: string) {
  expect(response.status).toBe(200);
  const received = [];
  for await (const event of events(response)) received.push(event);
  expect(received[0]).toMatchObject({type: "meta", data: {cueCount: 2, durationSeconds: 45}});
  expect(received.at(-1)).toEqual({type: "done", data: {chapters: [{id: "ch-1", title: chapterTitle}]}});
  return received[0].data.articleId as string;
}

it("stops a matching, playable video with no caption tracks before download, article or 5W1H inference", async () => {
  const id = "NoC4pt10n01";
  const paths: string[] = [];
  const runtime = startRuntime(async request => {
    const url = new URL(request.url);
    paths.push(url.hostname + url.pathname);
    if (url.hostname === "www.youtube.com" && url.pathname === "/watch" && url.searchParams.get("v") === id)
      return player(id, false);
    return new Response(null, {status: 404});
  });
  try {
    for (const endpoint of ["captions", "articles"] as const) {
      const response = await submit(runtime, endpoint, id);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({code: "NO_CAPTIONS", error: expect.any(String)});
    }
    expect((await runtime.dispatchFetch(api + "captions/" + id)).status).toBe(404);
    expect(paths.length).toBeGreaterThan(0);
    expect([...new Set(paths)]).toEqual(["www.youtube.com/watch"]);
  } finally {
    await runtime.dispose();
  }
});

it("downloads once for concurrent callers, persists the captions across a restart and keeps each article's 5W1H separate", async () => {
  const id = "R1v3rT4lk01";
  const questions = "采访员问：如何取样？";
  const answers = "采样员答：清晨在河岸采两份水样。";
  const transcript = questions + "\n" + answers;
  const editions = new Map([["侧重采访提问", "采访开场"], ["侧重实验步骤", "实验步骤"]]);
  const paths: string[] = [];
  const summaryCalls: string[] = [];
  let youtubeOffline = false;
  let release!: () => void;
  const holdDownload = new Promise<void>(resolve => { release = resolve; });
  const disk = await mkdtemp(join(tmpdir(), "caption-cache-workerd-"));
  const upstream = async (request: Request) => {
    const url = new URL(request.url);
    paths.push(url.hostname + url.pathname);
    if (url.hostname === "www.youtube.com") {
      if (youtubeOffline) return new Response("simulated provider outage", {status: 503});
      expect(url.searchParams.get("v")).toBe(id);
      if (url.pathname === "/watch") return player(id, true);
      expect(url.pathname).toBe("/api/timedtext");
      expect(url.searchParams.get("fmt")).toBe("json3");
      await holdDownload;
      return Response.json({events: [
        {tStartMs: 0, dDurationMs: 9500, segs: [{utf8: questions}]},
        {tStartMs: 10_000, dDurationMs: 12_000, segs: [{utf8: "采样员答：清晨在河岸"}, {utf8: "采两份水样。"}]},
      ]});
    }
    expect(url.hostname).toBe("generativelanguage.googleapis.com");
    const {contents} = await request.json() as {contents: {parts: {text: string}[]}[]};
    const parts = contents[0].parts;
    const material = JSON.parse(parts[0].text);
    expect(material.video.text ?? material.video.segments.map((s: {text: string}) => s.text).join("\n")).toBe(transcript);
    if (url.pathname.endsWith(":streamGenerateContent")) {
      const title = editions.get(JSON.parse(parts[1].text).requirements);
      expect(title).toBeDefined();
      const text = "# 河岸采访\n\n## " + title + "\n\n" + transcript + "\n\n> 小结：取样安排在清晨。";
      const candidate = {content: {parts: [{text}]}, finishReason: "STOP"};
      return new Response("data: " + JSON.stringify({candidates: [candidate]}) + "\n\n", {headers: {"Content-Type": "text/event-stream"}});
    }
    expect(url.pathname).toMatch(/:generateContent$/);
    const title = material.chapter.title;
    expect([...editions.values()]).toContain(title);
    expect(material.article).toContain("## " + title);
    for (const other of editions.values()) if (other !== title) expect(material.article).not.toContain("## " + other);
    summaryCalls.push(title);
    const summary = {who: "采访员和采样员", what: title, when: "清晨", where: "河岸", why: "本章未提及", how: "采两份水样"};
    return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
  };

  let runtime = startRuntime(upstream, disk);
  const captionStatus = api + "captions/" + id;
  const getSummary = (article: string) => runtime.dispatchFetch(api + "articles/" + article + "/chapters/ch-1/summary");
  try {
    const concurrent = await Promise.all([submit(runtime, "captions", id), submit(runtime, "captions", id)]);
    expect(concurrent.map(response => response.status)).toEqual([202, 202]);
    const downloadPath = "www.youtube.com/api/timedtext";
    await vi.waitFor(() => expect(paths).toContain(downloadPath));
    // The download HTTP connection is open. A separate public GET reads the
    // durable task written before it started, without seeing any caption data.
    const running = await runtime.dispatchFetch(captionStatus);
    expect(running.status).toBe(202);
    expect(await running.json()).toMatchObject({videoId: id, status: "running"});
    expect(paths).toEqual(["www.youtube.com/watch", downloadPath]);
    const firstResponse = submit(runtime, "articles", id, "侧重采访提问");
    release();
    const first = await readArticle(await firstResponse, "采访开场");
    await vi.waitFor(async () => expect(await (await getSummary(first)).json()).toMatchObject({what: "采访开场"}));
    const ready = await runtime.dispatchFetch(captionStatus);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({status: "ready", videoId: id, title: "合成短访谈：河岸取样",
      source: "youtube", cueCount: 2, durationSeconds: 45, lastCaptionSeconds: 22});
    await runtime.dispose();
    // A fresh workerd process can only reuse persisted SQLite data.
    youtubeOffline = true;
    runtime = startRuntime(upstream, disk);
    expect((await submit(runtime, "captions", id)).status).toBe(200);
    const second = await readArticle(await submit(runtime, "articles", id, "侧重实验步骤"), "实验步骤");
    expect(second).not.toBe(first);
    await vi.waitFor(async () => expect(await (await getSummary(second)).json()).toMatchObject({what: "实验步骤"}));
    expect(await (await getSummary(first)).json()).toMatchObject({what: "采访开场"});
    expect(summaryCalls).toEqual(["采访开场", "实验步骤"]);
    expect(paths.filter(path => path.startsWith("www.youtube.com/"))).toEqual(["www.youtube.com/watch", downloadPath]);
  } finally {
    release();
    await runtime.dispose();
    await rm(disk, {recursive: true, force: true});
  }
}, 25_000);
