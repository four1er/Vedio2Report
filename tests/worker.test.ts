import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { ArticleSession } from "../src/worker/index";
import { getVideoSource } from "../src/worker/captions";
import { ApiError } from "../src/worker/protocol";
import { chapterRecapText } from "../src/shared/chapter-recap";

vi.mock("../src/worker/captions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker/captions")>(),
  getVideoSource: vi.fn(),
}));

const url = "https://www.youtube.com/watch?v=xRh2sVcNXQ8";
const transcript = "字幕上下文：主持人介绍观测站，研究员解释海水温度。";
const firstPart = "# 海洋对话\n\n## 观测站\n\n主持人介绍海上的观测站。\n\n> 小结：观测站设在海上。";
const secondBody = "研究员分享温度记录。\n\n> **小结:** 记录展示海水温度变化。";
const secondPart = "\n\n## 温度记录\n\n" + secondBody;
const summary = {
  who: "主持人和研究员",
  what: "观测站",
  when: "字幕未提及",
  where: "海上",
  why: "监测海水变化",
  how: "连续记录温度",
};

function memoryStorage() {
  const records = new Map<string, unknown>();
  return {
    async get(key: string) { return structuredClone(records.get(key)); },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      for (const [name, data] of typeof key === "string" ? [[key, value] as const] : Object.entries(key)) {
        records.set(name, structuredClone(data));
      }
    },
    async deleteAll() { records.clear(); },
    async setAlarm() {},
  };
}

function fixture() {
  const sessions = new Map<string, ArticleSession>();
  const bindings = {
    GEMINI_API_KEY: "unit-test-only",
    ARTICLES: {
      newUniqueId: () => crypto.randomUUID().replaceAll("-", "").repeat(2),
      idFromString: (id: string) => id,
      get(id: string) {
        let session = sessions.get(id);
        if (!session) {
          type Args = ConstructorParameters<typeof ArticleSession>;
          session = new ArticleSession({ id, storage: memoryStorage() } as unknown as Args[0], bindings as unknown as Args[1]);
          sessions.set(id, session);
        }
        return {
          fetch: (input: RequestInfo | URL, init?: RequestInit) => session.fetch(new Request(input, init)),
        };
      },
    },
  };
  vi.mocked(getVideoSource).mockResolvedValue({ title: "海洋对话", text: transcript, source: "youtube" });
  return {
    bindings,
    post(path: string, body?: unknown) {
      const req = new Request(new URL(path, "https://example.test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return worker.fetch(req, bindings as unknown as Parameters<typeof worker.fetch>[1]);
    },
  };
}

function geminiFrame(text: string, finishReason?: string) {
  const candidate = { content: { parts: [{ text }] }, finishReason };
  return new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [candidate] })}\r\n\r\n`);
}

function readEvents(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  return {
    async next() {
      for (;;) {
        const end = /\r?\n\r?\n/.exec(pending);
        if (end) {
          const block = pending.slice(0, end.index);
          pending = pending.slice(end.index + end[0].length);
          const tag = /^event: *(.+)$/m.exec(block);
          const data = /^data: *(.*)$/m.exec(block);
          if (tag && data) return { event: tag[1].trim(), data: JSON.parse(data[1]) };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE ended before expected event");
        pending += value;
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Worker article workflow", () => {
  it("sends only text for the archived interview, its summary, and any translation", async () => {
    const app = fixture();
    vi.mocked(getVideoSource).mockResolvedValueOnce({
      source: "archived-youtube", title: "访谈", text: transcript,
      durationSeconds: 4878, lastCaptionSeconds: 4866, cueCount: 2801,
      timeline: [{at: "00:00:00", firstCue: 1, topic: "开场"}],
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const parts = (await req.json()).contents[0].parts;
      expect(parts).toEqual([{text: expect.any(String)}]);
      const material = JSON.parse(parts[0].text);
      requests.push(req.url);
      if (material.summary) {
        expect(material.summary.what).toBe("Ocean monitoring");
        return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
      }
      expect(material.video.segments).toEqual([{at: "00:00:00", topic: "开场", text: transcript}]);
      expect(material.video.text).toBeUndefined();
      if (req.url.includes(":streamGenerateContent")) return new Response(geminiFrame(firstPart, "STOP"));
      expect(material.chapter.title).toBe("观测站");
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify({...summary, what: "Ocean monitoring"})}]}, finishReason: "STOP"}]});
    });
    const events = readEvents(await app.post("/api/articles", {url}));
    const meta = await events.next();
    expect(meta.data.source).toBe("archived-youtube");
    expect(meta.data).toMatchObject({durationSeconds: 4878, lastCaptionSeconds: 4866, cueCount: 2801});
    expect(meta.data.timeline).toEqual([{at: "00:00:00", topic: "开场"}]);
    expect(meta.data.text).toBeUndefined();
    expect((await events.next()).data.text).toBe(firstPart);
    expect(await events.next()).toEqual({event: "chapter", data: {id: "ch-1", title: "观测站"}});
    expect((await events.next()).event).toBe("done");
    const path = `/api/articles/${meta.data.articleId}/chapters/ch-1/summary`;
    expect(await (await app.post(path)).json()).toEqual(summary);
    expect(await (await app.post(path)).json()).toEqual(summary);
    expect(requests).toHaveLength(3);
  });

  it("makes a closed chapter available across split headings before the next chapter finishes", async () => {
    const app = fixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(stream) { controller = stream; },
    });
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      calls.push({ url: req.url, body: await req.text() });
      if (req.url.includes(":streamGenerateContent")) {
        return new Response(upstream, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(summary) }] }, finishReason: "STOP" }] });
    });
    const requirements = "给中学生阅读，用简明的问答形式";
    const res = await app.post("/api/articles", { url, requirements });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const events = readEvents(res);
    const meta = await events.next();
    expect(meta.event).toBe("meta");

    const frame = geminiFrame(firstPart);
    const split = frame.findIndex((byte) => byte > 127) + 1;
    controller.enqueue(frame.slice(0, split));
    controller.enqueue(frame.slice(split));
    expect(await events.next()).toMatchObject({ event: "delta", data: { text: firstPart } });

    expect(calls[0].body).toContain(requirements);
    expect(calls[0].body).toContain(transcript);

    const base = `/api/articles/${meta.data.articleId}/chapters/`;
    const path = base + "ch-1/summary";
    for (const piece of ["\r\n\r\n#", "# 温度", "记录\r"]) {
      controller.enqueue(geminiFrame(piece));
      expect(await events.next()).toEqual({event: "delta", data: {text: piece}});
    }
    expect((await app.post(path)).status).toBe(404);
    controller.enqueue(geminiFrame("\n"));
    expect((await events.next()).event).toBe("delta");
    expect(await events.next()).toEqual({event: "chapter", data: {id: "ch-1", title: "观测站"}});
    expect((await app.post(base + "ch-2/summary")).status).toBe(404);
    const result = await app.post(path);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(summary);
    expect(calls[1].url).toContain(":generateContent");
    expect(calls[1].body).toContain(transcript);
    expect(calls[1].body).toContain("主持人介绍海上的观测站");
    expect(JSON.parse(calls[1].body).contents[0].parts[0].text).not.toContain("温度记录");

    controller.enqueue(geminiFrame("\r\n" + secondBody, "STOP"));
    controller.close();
    expect((await events.next()).event).toBe("delta");
    expect(await events.next()).toEqual({event: "chapter", data: {id: "ch-2", title: "温度记录"}});
    const done = await events.next();
    expect(done).toMatchObject({ event: "done", data: { chapters: [
      { id: "ch-1", title: "观测站" }, { id: "ch-2", title: "温度记录" },
    ] } });
    expect(await (await app.post(path)).json()).toEqual(summary);
    expect((await app.post(path, { article: "客户端提交的伪造上下文" })).status).toBe(400);
    expect(calls).toHaveLength(2);
  });

  it("retains only the closed chapter after a later upstream truncation", async () => {
    const app = fixture();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes(":streamGenerateContent")) {
        return new Response(geminiFrame(firstPart + secondPart));
      }
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
    });
    const events = readEvents(await app.post("/api/articles", {url}));
    const meta = await events.next();
    expect((await events.next()).event).toBe("delta");
    expect(await events.next()).toEqual({event: "chapter", data: {id: "ch-1", title: "观测站"}});
    expect((await events.next()).event).toBe("error");
    const base = `/api/articles/${meta.data.articleId}/chapters/`;
    expect((await app.post(base + "ch-1/summary")).status).toBe(200);
    expect((await app.post(base + "ch-2/summary")).status).toBe(404);
  });

  it("publishes a finished topic before the next upstream request returns any text", async () => {
    const app = fixture();
    vi.mocked(getVideoSource).mockResolvedValueOnce({
      source: "archived-youtube", title: "海洋对话", text: "研究员介绍观测站。\n研究员说明采样。",
      timeline: [
        {at: "00:00", firstCue: 1, topic: "观测站"},
        {at: "05:00", firstCue: 2, topic: "采样"},
      ],
    });
    let articleCalls = 0;
    let signalNextRequest!: () => void;
    const nextRequested = new Promise<void>(resolve => { signalNextRequest = resolve; });
    let finishNext!: (response: Response) => void;
    const nextResponse = new Promise<Response>(resolve => { finishNext = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!new Request(input, init).url.includes(":streamGenerateContent"))
        return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
      if (++articleCalls === 1) {
        const topic = {articleTitle: "海洋对话", title: "观测站", body: "研究员介绍观测站。", recap: "观测站设在海上。"};
        return new Response(geminiFrame(JSON.stringify(topic), "STOP"));
      }
      signalNextRequest();
      return nextResponse;
    });
    const events = readEvents(await app.post("/api/articles", {url}));
    const meta = await events.next();
    let event = await events.next();
    while (event.event === "delta") event = await events.next();
    expect(event).toMatchObject({event: "chapter", data: {id: "ch-1"}});
    const next = events.next();
    await nextRequested;
    const base = `/api/articles/${meta.data.articleId}/chapters/`;
    expect(await (await app.post(base + "ch-1/summary")).json()).toEqual(summary);
    expect((await app.post(base + "ch-2/summary")).status).toBe(404);
    finishNext(new Response(null, {status: 403}));
    event = await next;
    while (event.event === "delta") event = await events.next();
    expect(event.event).toBe("error");
    expect((await app.post(base + "ch-1/summary")).status).toBe(200);
    expect((await app.post(base + "ch-2/summary")).status).toBe(404);
  });

  it.each([
    ["missing on the last chapter", "研究员介绍测量频率。"],
    ["empty at the next heading", "研究员介绍测量频率。\n\n> **小结：**  \n\n## 第三章\n\n开始讨论盐度。"],
    ["followed by more prose", "> 小结：每天测量。\n\n接着又讨论其他内容。"],
  ])("reports an error and retains valid chapters when the recap is %s", async (_label, body) => {
    const app = fixture();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes(":streamGenerateContent"))
        return new Response(geminiFrame(firstPart + "\n\n## 温度记录\n\n" + body, "STOP"));
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
    });
    const events = readEvents(await app.post("/api/articles", {url}));
    const meta = await events.next();
    expect((await events.next()).event).toBe("delta");
    expect(await events.next()).toMatchObject({event: "chapter", data: {id: "ch-1"}});
    expect(await events.next()).toMatchObject({event: "error", data: {message: expect.stringMatching(/温度记录.*章末小结.*重新生成/)}});
    const base = `/api/articles/${meta.data.articleId}/chapters/`;
    expect((await app.post(base + "ch-1/summary")).status).toBe(200);
    expect((await app.post(base + "ch-2/summary")).status).toBe(404);
  });

  it("can summarize a stored article from before chapter recaps were required", async () => {
    const storage = memoryStorage();
    await storage.put({
      session: {expiresAt: Date.now() + 86_400_000, requirements: ""},
      video: {text: transcript, source: "youtube", videoId: "xRh2sVcNXQ8"},
      article: "# 海洋对话\n\n## 旧版章节\n\n本章只有正文。",
    });
    type Args = ConstructorParameters<typeof ArticleSession>;
    const session = new ArticleSession({storage} as unknown as Args[0], {GEMINI_API_KEY: "test"} as Args[1]);
    vi.stubGlobal("fetch", async () => Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]}));
    const response = await session.fetch(new Request("https://session/summary/ch-1", {method: "POST"}));
    expect(await response.json()).toEqual(summary);
  });

  it("reports an upstream truncation without making a partial article available for summaries", async () => {
    const app = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(geminiFrame(firstPart), {
      headers: { "Content-Type": "text/event-stream" },
    })));
    const events = readEvents(await app.post("/api/articles", { url }));
    const meta = await events.next();
    expect(meta.event).toBe("meta");
    expect((await events.next()).event).toBe("delta");
    expect((await events.next()).event).toBe("error");
    const result = await app.post(`/api/articles/${meta.data.articleId}/chapters/ch-1/summary`);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-YouTube URL before fetching captions", async () => {
    const app = fixture();
    const res = await app.post("/api/articles", { url: "https://example.org/watch?v=xRh2sVcNXQ8" });
    expect(res.status).toBe(400);
    expect(getVideoSource).not.toHaveBeenCalled();
  });

  it("ends an unavailable-caption request before calling Gemini", async () => {
    const app = fixture();
    vi.mocked(getVideoSource).mockRejectedValueOnce(new ApiError(422, "暂时无法读取字幕。"));
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const result = await app.post("/api/articles", {url});
    expect(result.status).toBe(422);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns an actionable service error when the Gemini key is absent", async () => {
    const app = fixture();
    app.bindings.GEMINI_API_KEY = "";
    const res = await app.post("/api/articles", { url });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("unit-test-only");
  });
});

it.each([
  ["> 小结：观测海水。", "观测海水。"],
  ["> 小结: **连续测量**", "**连续测量**"],
  ["> **小结：** 观测海水。", "观测海水。"],
  ["> **小结**: 观测海水。", "观测海水。"],
  ["> **小结：观测海水。**", "观测海水。"],
  ["> **小结：** ", undefined],
  ["小结：正文中的普通句子。", undefined],
])("recognizes a complete recap line in %s", (line, expected) => {
  expect(chapterRecapText(line!)).toBe(expected);
});
