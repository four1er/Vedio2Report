import { afterEach, describe, expect, it, vi } from "vitest";
import { getVideoSource, type Video } from "../src/worker/captions";
import { summarize, writeArticle } from "../src/worker/gemini";
import type { Bindings } from "../src/worker/protocol";

const env = {GEMINI_API_KEY: "writer-test"} as Bindings;
const signal = () => new AbortController().signal;
const encoder = new TextEncoder();
const video: Video = {
  source: "youtube", videoId: "xRh2sVcNXQ8", title: "访谈",
  text: "Opening sentence.\nOpening detail.\nClosing sentence.",
  timeline: [{at: "0:00", firstCue: 1, topic: "Opening"}, {at: "1:15:50", firstCue: 3, topic: "Closing"}],
};
const first = {articleTitle: "访谈记录", title: "开场讨论", body: "先介绍观测背景，再说明方法。", recap: "本章交代观测方法。"};
const last = {title: "结束讨论", body: "最后核对数据。", recap: "本章确认观测结果。"};

afterEach(() => vi.unstubAllGlobals());

function event(data: unknown) {
  return "data: " + JSON.stringify(data) + "\n\n";
}

function frame(text: string, finishReason?: string) {
  return event({candidates: [{content: {parts: [{text}]}, finishReason}]});
}

function complete(fields: object) {
  return new Response(frame(JSON.stringify(fields), "STOP"));
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("chronological chapter writing", () => {
  it("requests all 12 original intervals in order, sending each subtitle exactly once", async () => {
    const source = await getVideoSource("xRh2sVcNXQ8");
    const requested: {text: string; at: string; topic: string}[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain(":streamGenerateContent?alt=sse");
      const payload = JSON.parse(String(init.body));
      expect(payload.generationConfig.responseMimeType).toBe("application/json");
      expect(payload.contents[0].parts).toHaveLength(1);
      const input = JSON.parse(payload.contents[0].parts[0].text);
      expect(input.sourceTitle).toBe(source.title);
      expect(input).not.toHaveProperty("video");
      requested.push(input);
      const n = requested.length;
      return complete({
        ...(n === 1 && {articleTitle: "全场访谈"}),
        title: "话题" + n, body: "受访者解释第" + n + "段的讨论。", recap: "第" + n + "段核心观点。",
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const events = await collect(writeArticle(env, {video: {...source, videoId: "xRh2sVcNXQ8"}}, signal()));
    expect(requested.length).toBe(12);
    expect(requested.map(({at, topic}) => ({at, topic}))).toEqual(source.timeline?.map(({at, topic}) => ({at, topic})));
    expect(requested.map(({text}) => text).join("\n") === source.text).toBe(true);
    expect(requested.at(-1)?.text).toContain("Mars");

    const chapterTexts: string[] = [];
    let pendingText = "";
    for (const delta of events) {
      if (typeof delta === "string") pendingText += delta;
      else {
        expect(delta).toEqual({chapterEnd: true});
        chapterTexts.push(pendingText.trim());
        pendingText = "";
      }
    }
    expect(chapterTexts).toHaveLength(12);
    expect(pendingText.trim()).toBe("");
    expect(chapterTexts[0]).toMatch(/^# 全场访谈\n/);
    for (const [i, mark] of source.timeline!.entries()) {
      expect(chapterTexts[i]).toContain("## [" + mark.at + "] 话题" + (i + 1) + "\n");
      expect(chapterTexts[i].split("\n").at(-1)).toBe("> 小结：第" + (i + 1) + "段核心观点。");
    }
  });

  it("streams a partial JSON body to the reader and commits a chapter only after its STOP", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({start(c) { controller = c; }}));
    const fetcher = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(complete(last));
    vi.stubGlobal("fetch", fetcher);
    // Quotes are escaped in model JSON and a new SSE frame can start halfway through that escape.
    const special = {...first, body: '受访者说"请看图"。'};
    const raw = JSON.stringify(special);
    const split = raw.indexOf('说') + 2;
    const chunks: (string | {chapterEnd: true})[] = [];
    const reading = (async () => {
      for await (const delta of writeArticle(env, {video}, signal())) chunks.push(delta);
    })();

    try {
      controller.enqueue(encoder.encode(frame(raw.slice(0, split))));
      await vi.waitFor(() => expect(chunks.join("")).toContain("受访者说"));
      expect(chunks).not.toContainEqual({chapterEnd: true});
      expect(fetcher).toHaveBeenCalledTimes(1);
      controller.enqueue(encoder.encode(frame(raw.slice(split))));
      await vi.waitFor(() => expect(chunks.join("")).toContain(special.body));
      expect(chunks).not.toContainEqual({chapterEnd: true});
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      controller.enqueue(encoder.encode(frame("", "STOP")));
      controller.close();
      await reading;
    }
    expect(chunks.filter(chunk => typeof chunk !== "string")).toEqual([{chapterEnd: true}, {chapterEnd: true}]);
    expect(chunks.join("").split(special.body)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", JSON.stringify({articleTitle: first.articleTitle, title: first.title, body: first.body})],
    ["blank", JSON.stringify({...first, recap: "   "})],
    ["truncated", JSON.stringify(first).slice(0, -1)],
  ])("never publishes a chapter with a %s recap or response", async (_reason, raw) => {
    const fetcher = vi.fn(async () => new Response(frame(raw, "STOP")));
    vi.stubGlobal("fetch", fetcher);
    const emitted = [];
    await expect((async () => {
      for await (const delta of writeArticle(env, {video}, signal())) emitted.push(delta);
    })()).rejects.toThrow();
    expect(emitted).not.toContainEqual({chapterEnd: true});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])("recovers from a transient HTTP %i before publishing a topic", async status => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("", {status, headers: {"retry-after": "0"}}))
      .mockResolvedValueOnce(complete(first)).mockResolvedValueOnce(complete(last));
    vi.stubGlobal("fetch", fetcher);
    const chunks = await collect(writeArticle(env, {video}, signal()));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(chunks.filter(chunk => typeof chunk !== "string")).toHaveLength(2);
    expect(chunks.join("").split(first.body)).toHaveLength(2);
    expect(chunks.join("").split(last.body)).toHaveLength(2);
  });

  it.each(["", '{"articleTitle":"尚未显示'])("retries an in-stream error before any user-visible text (prefix %j)", async prefix => {
    const unavailable = {error: {code: 503, status: "UNAVAILABLE", message: "model overloaded"}};
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(frame(prefix) + event(unavailable)))
      .mockResolvedValueOnce(complete(first)).mockResolvedValueOnce(complete(last));
    vi.stubGlobal("fetch", fetcher);
    const chunks = await collect(writeArticle(env, {video}, signal()));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(chunks.join("")).not.toContain("尚未显示");
    expect(chunks.filter(chunk => typeof chunk !== "string")).toEqual([{chapterEnd: true}, {chapterEnd: true}]);
  });

  it("keeps Markdown-style opening lines in model prose from introducing extra headings or recaps", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(complete({...first, body: "## 模型提供的正文"}))
      .mockResolvedValueOnce(complete({...last, body: "> 引述研究员原话。"}));
    vi.stubGlobal("fetch", fetcher);
    const chunks = await collect(writeArticle(env, {video}, signal()));
    const lines = chunks.filter(chunk => typeof chunk === "string").join("").split("\n");
    expect(lines.filter(line => line.startsWith("## "))).toEqual(["## [0:00] " + first.title, "## [1:15:50] " + last.title]);
    expect(lines.filter(line => line.startsWith("> "))).toEqual(["> 小结：" + first.recap, "> 小结：" + last.recap]);
    expect(lines).toContain("模型提供的正文");
    expect(lines).toContain("引述研究员原话。");
  });

  it("preserves the first chapter's completion and never replays visible text when a later stream fails", async () => {
    const partial = JSON.stringify(last).split(',"recap"')[0];
    const error = event({error: {code: 503, status: "UNAVAILABLE", message: "test upstream disconnect"}});
    const fetcher = vi.fn().mockResolvedValueOnce(complete(first)).mockResolvedValueOnce(new Response(frame(partial) + error));
    vi.stubGlobal("fetch", fetcher);
    const chunks = [];
    await expect((async () => {
      for await (const delta of writeArticle(env, {video}, signal())) chunks.push(delta);
    })()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(chunks.filter(chunk => typeof chunk !== "string")).toEqual([{chapterEnd: true}]);
    expect(chunks.join("").split(last.body)).toHaveLength(2);
  });
});

it("also retries a temporary HTTP failure on the non-streaming 5W1H endpoint", async () => {
  const summary = {
    who: "研究员", what: "核对观测数据。", when: "本章未提及", where: "本章未提及",
    why: "确认数据准确。", how: "逐项核对。",
  };
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("", {status: 503, headers: {"retry-after": "0"}}))
    .mockResolvedValueOnce(Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]}));
  vi.stubGlobal("fetch", fetcher);
  const result = await summarize(env, video, last.body, {id: "ch-2", title: last.title, text: last.body}, signal());
  expect(result).toEqual(summary);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([url]) => String(url).includes(":generateContent"))).toBe(true);
});

describe("unstructured article streaming", () => {
  it.each([
    ["an explicit reader constraint", video, "只讲最后的数据，限一章。"],
    ["a video without a publisher outline", {...video, timeline: undefined}, ""],
    ["timing anchors without publisher topics", {...video, timeline: video.timeline?.map(({at, firstCue}) => ({at, firstCue}))}, ""],
  ] as const)("keeps one true text stream for %s", async (_description, source, requirements) => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      const parts: {text: string}[] = payload.contents[0].parts;
      const {video: input} = JSON.parse(parts[0].text);
      const transcript = input.text ?? input.segments.map((part: {text: string}) => part.text).join("\n");
      expect(transcript).toBe(source.text);
      if (requirements) expect(parts.some(part => JSON.parse(part.text).requirements === requirements)).toBe(true);
      return new Response(frame("## 章节\n\n") + frame("真实内容。", "STOP"));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await collect(writeArticle(env, {video: source, requirements}, signal()))).toEqual(["## 章节\n\n", "真实内容。"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
