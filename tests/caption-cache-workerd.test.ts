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
  const editions = new Map([["只总结采访提问", "采访开场"], ["只总结实验步骤", "实验步骤"]]);
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
    const firstResponse = submit(runtime, "articles", id, "只总结采访提问");
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
    const second = await readArticle(await submit(runtime, "articles", id, "只总结实验步骤"), "实验步骤");
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

it("streams a 512 kB caption track through SQLite and summarizes a transcript larger than one storage value", async () => {
  const id = "L0ngC4pt10n";
  const caption = "A.".repeat(256_000);
  const translated = "水样已采集。";
  const expectedLength = translated.length * (caption.length / 2);
  let inputLength = 0;
  let nextUnit = 1;
  const summarized: string[] = [];
  const runtime = startRuntime(async request => {
    const endpoint = new URL(request.url);
    if (endpoint.pathname === "/watch") return player(id, true);
    if (endpoint.pathname === "/api/timedtext") return Response.json({events: [{segs: [{utf8: caption}]}]});
    const {contents} = await request.json() as {contents: {parts: {text: string}[]}[]};
    const material = JSON.parse(contents[0].parts[0].text);
    if (endpoint.pathname.endsWith(":streamGenerateContent")) {
      const title = material.units[0].id === 1 ? "第一章" : (material.chapterTitle || "第二章");
      const units = material.units.map((unit: {id: number; text: string}) => {
        expect(unit.id).toBe(nextUnit++);
        inputLength += unit.text.length;
        return {id: unit.id, heading: "", speaker: "", text: unit.text.replaceAll("A.", translated)};
      });
      const text = JSON.stringify({articleTitle: "采样记录", chapterTitle: title, units});
      const candidate = {content: {parts: [{text}]}, finishReason: "STOP"};
      return new Response("data: " + JSON.stringify({candidates: [candidate]}) + "\n\n");
    }
    expect(material.video.text).toBe(caption);
    if (material.chapter.id === "ch-2") {
      expect(material.article).toContain("## 第一章");
      expect(material.article).toContain("## 第二章");
      expect(material.article.split(translated).length - 1).toBe(caption.length / 2);
    }
    summarized.push(material.chapter.id);
    const summary = {who: "采样者", what: "采样", when: "未提及", where: "未提及", why: "未提及", how: "未提及"};
    return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
  });

  try {
    const response = await submit(runtime, "articles", id, "逐字转写，分成两章");
    expect(response.status).toBe(200);
    let received = 0;
    let articleId = "";
    let done;
    for await (const event of events(response)) {
      if (event.type === "meta") articleId = event.data.articleId;
      if (event.type === "error") throw new Error(event.data.message);
      if (event.type === "delta") received += event.data.text.length;
      if (event.type === "done") done = event.data;
    }
    expect(inputLength).toBe(caption.length);
    expect(received).toBeGreaterThan(expectedLength);
    expect(done?.coverage).toEqual({completed: nextUnit - 1, total: nextUnit - 1});
    expect(done.chapters).toHaveLength(2);
    await vi.waitFor(async () => {
      expect(summarized).toEqual(["ch-1", "ch-2"]);
      expect((await runtime.dispatchFetch(api + "articles/" + articleId + "/chapters/ch-2/summary")).status).toBe(200);
    }, {timeout: 8000});
  } finally {
    await runtime.dispose();
  }
}, 45_000);
