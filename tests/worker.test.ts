import { memoryStorage } from "./memory-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { ArticleSession } from "../src/worker/index";
import { preparedSource } from "../src/worker/caption-cache";
import { ApiError } from "../src/worker/protocol";
import * as gemini from "../src/worker/gemini";
import { chapterRecapText } from "../src/shared/chapter-recap";

vi.mock("../src/worker/caption-cache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker/caption-cache")>(),
  preparedSource: vi.fn(),
}));

const url = "https://www.youtube.com/watch?v=xRh2sVcNXQ8";
const scopedRequirements = "只总结海洋监测。";
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

function fixture() {
  const sessions = new Map<string, ArticleSession>();
  const stores = new Map<string, ReturnType<typeof memoryStorage>>();
  const bindings = {
    GEMINI_API_KEY: "unit-test-only",
    GENERATION_LIMIT: {limit: vi.fn(async () => ({success: true}))},
    ARTICLES: {
      newUniqueId: () => crypto.randomUUID().replaceAll("-", "").repeat(2),
      idFromString: (id: string) => id,
      get(id: string) {
        let session = sessions.get(id);
        if (!session) {
          type Args = ConstructorParameters<typeof ArticleSession>;
          const storage = stores.get(id) ?? memoryStorage();
          stores.set(id, storage);
          session = new ArticleSession({ id, storage } as unknown as Args[0], bindings as unknown as Args[1]);
          sessions.set(id, session);
        }
        return {
          fetch: (input: RequestInfo | URL, init?: RequestInit) => session.fetch(new Request(input, init)),
        };
      },
    },
  };
  vi.mocked(preparedSource).mockResolvedValue({ title: "海洋对话", text: transcript, source: "youtube" });
  return {
    bindings,
    stores,
    alarm(id: string) { return sessions.get(id)!.alarm(); },
    restart(id: string) { sessions.delete(id); bindings.ARTICLES.get(id); },
    get(path: string) {
      return worker.fetch(new Request(new URL(path, "https://example.test")), bindings as unknown as Parameters<typeof worker.fetch>[1]);
    },
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Worker article workflow", () => {
  it("sends only text for the archived interview, its summary, and any translation", async () => {
    const app = fixture();
    vi.mocked(preparedSource).mockResolvedValueOnce({
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
      if (req.url.includes(":streamGenerateContent")) {
        expect(material.units.map((unit: {text: string}) => unit.text)).toEqual([transcript]);
        const response = {articleTitle: "海洋对话", chapterTitle: "观测站",
          units: [{id: material.units[0].id, heading: "观测站介绍", speaker: "主持人", text: transcript}]};
        return new Response(geminiFrame(JSON.stringify(response), "STOP"));
      }
      expect(material.video.segments).toEqual([{at: "00:00:00", topic: "开场", text: transcript}]);
      expect(material.video.text).toBeUndefined();
      expect(material.chapter.title).toMatch(/观测站$/);
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify({...summary, what: "Ocean monitoring"})}]}, finishReason: "STOP"}]});
    });
    const events = readEvents(await app.post("/api/articles", {url}));
    const meta = await events.next();
    expect(meta.data.source).toBe("archived-youtube");
    expect(meta.data).toMatchObject({durationSeconds: 4878, lastCaptionSeconds: 4866, cueCount: 2801});
    expect(meta.data.timeline).toEqual([{at: "00:00:00", topic: "开场"}]);
    expect(meta.data.text).toBeUndefined();
    const received = [];
    do {
      const event = await events.next();
      expect(event.event).not.toBe("error");
      received.push(event);
    } while (received.at(-1)!.event !== "done");
    const progress = received.filter(event => event.event === "coverage").map(event => event.data);
    expect(progress[0]).toEqual({completed: 0, total: 1});
    expect(progress.at(-1)).toEqual({completed: 1, total: 1});
    expect(received.at(-1)!.data.coverage).toEqual(progress.at(-1));
    const markdown = received.filter(event => event.event === "delta").map(event => event.data.text).join("");
    expect(markdown).toContain(transcript);
    expect(markdown).not.toContain("> 小结");
    expect(await app.stores.get(meta.data.articleId)!.get("coverage")).toEqual(progress.at(-1));
    expect(received.find(event => event.event === "chapter")?.data).toMatchObject({id: "ch-1", title: expect.stringMatching(/观测站$/)});
    const path = `/api/articles/${meta.data.articleId}/chapters/ch-1/summary`;
    expect((await app.get(path)).status).toBe(202);
    expect(requests).toHaveLength(1);
    await app.alarm(meta.data.articleId);
    expect(await (await app.get(path)).json()).toEqual(summary);
    expect(await (await app.post(path)).json()).toEqual(summary);
    expect(requests).toHaveLength(3);
  });

  it.each(["incomplete", "unsealed", "skipped ID", "missing plan"])("never marks an %s transcript as finished", async failure => {
    const app = fixture();
    vi.spyOn(gemini, "writeArticle").mockImplementation(async function* () {
      if (failure !== "missing plan") yield {coverage: {completed: 0, total: 2}};
      yield "# 观察海洋\n\n## 水质\n\n主持人：今天测量水质。";
      if (failure !== "skipped ID") yield {coverage: {completed: 1, total: 2}};
      if (failure !== "incomplete") {
        yield "我们再查一次。";
        yield {coverage: {completed: 2, total: 2}};
      }
      if (failure !== "unsealed") yield {chapterEnd: true};
    });
    const events = readEvents(await app.post("/api/articles", {url}));
    const meta = await events.next();
    let event;
    do {
      event = await events.next();
      expect(event.event).not.toBe("done");
    } while (event.event !== "error");
    const path = "/api/articles/" + meta.data.articleId + "/chapters/ch-1/summary";
    expect((await app.get(path)).status).toBe(failure === "incomplete" ? 202 : 404);
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
    const requirements = "只总结海洋监测，给中学生阅读，用简明的问答形式";
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
    expect(await (await app.get(path)).json()).toEqual({status: "pending"});
    await app.alarm(meta.data.articleId);
    const result = await app.get(path);
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
    const events = readEvents(await app.post("/api/articles", {url, requirements: scopedRequirements}));
    const meta = await events.next();
    expect((await events.next()).event).toBe("delta");
    expect(await events.next()).toEqual({event: "chapter", data: {id: "ch-1", title: "观测站"}});
    expect((await events.next()).event).toBe("error");
    const base = `/api/articles/${meta.data.articleId}/chapters/`;
    await app.alarm(meta.data.articleId);
    expect((await app.get(base + "ch-1/summary")).status).toBe(200);
    expect((await app.post(base + "ch-2/summary")).status).toBe(404);
  });

  it("publishes a finished topic before the next upstream request returns any text", async () => {
    const app = fixture();
    vi.mocked(preparedSource).mockResolvedValueOnce({
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
        const topic = {articleTitle: "海洋对话", chapterTitle: "观测站", units: [
          {id: 1, heading: "观测站介绍", speaker: "研究员", text: "研究员介绍观测站。"},
        ]};
        return new Response(geminiFrame(JSON.stringify(topic), "STOP"));
      }
      signalNextRequest();
      return nextResponse;
    });
    const events = readEvents(await app.post("/api/articles", {url: "https://youtu.be/AbC123deF45"}));
    const meta = await events.next();
    let event = await events.next();
    while (["delta", "coverage"].includes(event.event)) event = await events.next();
    expect(event).toMatchObject({event: "chapter", data: {id: "ch-1"}});
    const next = events.next();
    await nextRequested;
    const base = `/api/articles/${meta.data.articleId}/chapters/`;
    await app.alarm(meta.data.articleId);
    expect(await (await app.get(base + "ch-1/summary")).json()).toEqual(summary);
    expect((await app.post(base + "ch-2/summary")).status).toBe(404);
    finishNext(new Response(null, {status: 403}));
    event = await next;
    while (["delta", "coverage"].includes(event.event)) event = await events.next();
    expect(event.event).toBe("error");
    await app.alarm(meta.data.articleId);
    expect((await app.get(base + "ch-1/summary")).status).toBe(200);
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
    const events = readEvents(await app.post("/api/articles", {url, requirements: scopedRequirements}));
    const meta = await events.next();
    expect((await events.next()).event).toBe("delta");
    expect(await events.next()).toMatchObject({event: "chapter", data: {id: "ch-1"}});
    expect(await events.next()).toMatchObject({event: "error", data: {message: expect.stringMatching(/温度记录.*章末小结.*重新生成/)}});
    const base = `/api/articles/${meta.data.articleId}/chapters/`;
    await app.alarm(meta.data.articleId);
    expect((await app.get(base + "ch-1/summary")).status).toBe(200);
    expect((await app.post(base + "ch-2/summary")).status).toBe(404);
  });

  it("reads existing legacy summaries and reports legacy chapters without a cache", async () => {
    const storage = memoryStorage();
    await storage.put({
      session: {expiresAt: Date.now() + 86_400_000, requirements: ""},
      video: {text: transcript, source: "youtube", videoId: "xRh2sVcNXQ8"},
      article: "# 海洋对话\n\n## 旧版章节\n\n本章只有正文。",
    });
    type Args = ConstructorParameters<typeof ArticleSession>;
    const session = new ArticleSession({storage} as unknown as Args[0], {} as Args[1]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const read = (id: number) => session.fetch(new Request("https://session/summary/ch-" + id));
    expect((await read(1)).status).toBe(409);
    expect((await read(2)).status).toBe(404);
    await storage.put("summary/ch-1", summary);
    expect(await (await read(1)).json()).toEqual(summary);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an upstream truncation without making a partial article available for summaries", async () => {
    const app = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(geminiFrame(firstPart), {
      headers: { "Content-Type": "text/event-stream" },
    })));
    const events = readEvents(await app.post("/api/articles", {url, requirements: scopedRequirements}));
    const meta = await events.next();
    expect(meta.event).toBe("meta");
    expect((await events.next()).event).toBe("delta");
    expect((await events.next()).event).toBe("error");
    const result = await app.post(`/api/articles/${meta.data.articleId}/chapters/ch-1/summary`);
    expect(result.ok).toBe(false);
  });

  it("persists a scheduled retry across eviction, polls without charging generation quota, and runs the next chapter", async () => {
    const app = fixture();
    let calls = 0;
    const clock = vi.spyOn(Date, "now");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes(":streamGenerateContent"))
        return new Response(geminiFrame(firstPart + secondPart, "STOP"));
      if (++calls === 1) return new Response(null, {status: 429, headers: {"Retry-After": "70"}});
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
    });
    const stream = readEvents(await app.post("/api/articles", {url, requirements: scopedRequirements}));
    const id = (await stream.next()).data.articleId;
    while ((await stream.next()).event !== "done") { /* consume SSE */ }
    const path = "/api/articles/" + id + "/chapters/ch-1/summary";
    const start = Date.now();
    await app.alarm(id);
    const scheduled = (await app.stores.get(id)!.getAlarm())!;
    expect(scheduled).toBeGreaterThanOrEqual(start + 70_000);
    app.restart(id);
    await app.alarm(id);
    clock.mockReturnValue(scheduled - 65_000);
    for (const waitingPath of [path, path.replace("ch-1", "ch-2"), path]) {
      const pending = await app.get(waitingPath);
      expect(pending.status).toBe(202);
      expect(pending.headers.get("Retry-After")).toBe("65");
      expect(await pending.json()).toEqual({status: "pending"});
    }
    expect(calls).toBe(1);
    clock.mockReturnValue(scheduled);
    await Promise.all([app.alarm(id), app.alarm(id)]);
    expect(await (await app.get(path)).json()).toEqual(summary);
    expect(calls).toBe(2);
    await app.alarm(id);
    app.bindings.GEMINI_API_KEY = "";
    expect(await (await app.get(path.replace("ch-1", "ch-2"))).json()).toEqual(summary);
    expect(calls).toBe(3);
    expect(app.bindings.GENERATION_LIMIT.limit).toHaveBeenCalledTimes(1);
  });

  it("recovers an interrupted running job after its lease and ignores a stale completion", async () => {
    const app = fixture();
    let reported!: () => void;
    const started = new Promise<void>(resolve => { reported = resolve; });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes(":streamGenerateContent")) return new Response(geminiFrame(firstPart, "STOP"));
      const what = ++calls === 1 ? "旧任务的回答" : "恢复后的回答";
      if (calls === 1) { reported(); await hold; }
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify({...summary, what})}]}, finishReason: "STOP"}]});
    });
    const stream = readEvents(await app.post("/api/articles", {url, requirements: scopedRequirements}));
    const id = (await stream.next()).data.articleId;
    while ((await stream.next()).event !== "done") { /* consume SSE */ }
    const interrupted = app.alarm(id);
    await started;
    const path = "/api/articles/" + id + "/chapters/ch-1/summary";
    const wakeAt = (await app.stores.get(id)!.getAlarm())!;
    app.restart(id);
    await app.alarm(id);
    expect(calls).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(wakeAt);
    await app.alarm(id);
    release();
    await interrupted;
    await app.alarm(id);
    expect(await (await app.get(path)).json()).toEqual({...summary, what: "恢复后的回答"});
    expect(calls).toBe(2);
  });

  it("records a terminal failure and proceeds to the next chapter", async () => {
    const app = fixture();
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes(":streamGenerateContent"))
        return new Response(geminiFrame(firstPart + secondPart, "STOP"));
      if (++calls === 1) return new Response(null, {status: 403});
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
    });
    const stream = readEvents(await app.post("/api/articles", {url, requirements: scopedRequirements}));
    const id = (await stream.next()).data.articleId;
    while ((await stream.next()).event !== "done") { /* consume SSE */ }
    await app.alarm(id);
    await app.alarm(id);
    const path = "/api/articles/" + id + "/chapters/ch-1/summary";
    const failure = await app.get(path);
    expect(failure.status).toBe(502);
    expect(await failure.json()).toMatchObject({code: "SUMMARY_FAILED", error: expect.stringContaining("继续阅读本章正文")});
    expect((await app.get(path.replace("ch-1", "ch-2"))).status).toBe(200);
    expect((await app.post(path)).status).toBe(502);
    expect(calls).toBe(2);
  });

  it.each([true, false])("automatically retries truncated 5W1H up to a fixed limit (provider recovers: %s)", async (recovers) => {
    const app = fixture();
    const clock = vi.spyOn(Date, "now");
    let summaryCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes(":streamGenerateContent"))
        return new Response(geminiFrame(firstPart, "STOP"));
      summaryCalls++;
      const complete = recovers && summaryCalls > 1;
      const candidate = {content: {parts: [{text: complete ? JSON.stringify(summary) : "{"}]}, finishReason: complete ? "STOP" : "MAX_TOKENS"};
      return Response.json({candidates: [candidate]});
    });
    const stream = readEvents(await app.post("/api/articles", {url, requirements: scopedRequirements}));
    const id = (await stream.next()).data.articleId;
    while ((await stream.next()).event !== "done") { /* consume SSE */ }
    const store = app.stores.get(id)!;
    const path = "/api/articles/" + id + "/chapters/ch-1/summary";
    const attempts = recovers ? 2 : 3;
    for (let i = 1; i <= attempts; i++) {
      await app.alarm(id);
      expect(summaryCalls).toBe(i);
      if (i < attempts) {
        expect((await app.get(path)).status).toBe(202);
        expect(summaryCalls).toBe(i);
        app.restart(id);
        clock.mockReturnValue((await store.getAlarm())!);
      }
    }
    await app.alarm(id);
    const final = await app.get(path);
    expect(final.status).toBe(recovers ? 200 : 502);
    expect(await final.json()).toMatchObject(recovers ? summary : {code: "SUMMARY_FAILED"});
    expect(summaryCalls).toBe(attempts);
  });

  it("returns an actionable terminal result for a failed chapter saved before the upgrade", async () => {
    const app = fixture();
    const id = "a".repeat(64);
    app.bindings.ARTICLES.get(id);
    const store = app.stores.get(id)!;
    const expiresAt = Date.now() + 60000;
    await store.put({session: {expiresAt}, "failed/ch-1": "总结格式异常，请重试。"});
    await store.setAlarm(expiresAt);
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const path = "/api/articles/" + id + "/chapters/ch-1/summary";
    for (const response of [await app.get(path), await app.post(path)]) {
      expect(response.status).toBe(502);
      const body = await response.json() as {code: string; error: string};
      expect(body.code).toBe("SUMMARY_FAILED");
      expect(body.error).not.toContain("重试");
    }
    expect(await store.getAlarm()).toBe(expiresAt);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("expires an in-flight summary and prevents its late result from recreating a deleted session", async () => {
    const app = fixture();
    let finish!: () => void;
    const response = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.includes(":streamGenerateContent")) return new Response(geminiFrame(firstPart, "STOP"));
      started();
      await response;
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify(summary)}]}, finishReason: "STOP"}]});
    });
    const stream = readEvents(await app.post("/api/articles", {url, requirements: scopedRequirements}));
    const id = (await stream.next()).data.articleId;
    while ((await stream.next()).event !== "done") { /* consume SSE */ }
    const path = "/api/articles/" + id + "/chapters/ch-1/summary";
    const working = app.alarm(id);
    await starting;
    const {expiresAt} = await app.stores.get(id)!.get("session") as {expiresAt: number};
    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    expect((await app.get(path)).status).toBe(404);
    await app.alarm(id);
    finish();
    await working;
    for (const key of ["session", "article", "video", "queue", "summary/ch-1"]) expect(await app.stores.get(id)!.get(key)).toBeUndefined();
    expect((await app.get(path)).status).toBe(404);
  });

  it("limits new caption checks independently and lets readers poll without a Gemini key or generation quota", async () => {
    const app = fixture();
    const id = "AbC123deF45";
    const fetch = vi.fn(async () => Response.json({status: "pending", videoId: id}, {status: 202}));
    const limit = vi.fn().mockResolvedValueOnce({success: true}).mockResolvedValue({success: false});
    const idFromName = vi.fn(value => value);
    Object.assign(app.bindings, {
      CAPTION_LIMIT: {limit},
      CAPTION_CACHE: {idFromName, get: () => ({fetch})},
      GEMINI_API_KEY: "",
    });
    for (const query of ["/api/captions/" + id, "/api/captions/" + id])
      expect((await app.get(query)).status).toBe(202);
    expect(limit).not.toHaveBeenCalled();
    expect((await app.post("/api/captions", {url: "https://youtu.be/" + id})).status).toBe(202);
    expect((await app.post("/api/captions", {url: "https://youtu.be/" + id})).status).toBe(429);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(app.bindings.GENERATION_LIMIT.limit).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(idFromName.mock.calls).toEqual([[id], [id], [id]]);
  });

  it("rejects a non-YouTube URL before fetching captions", async () => {
    const app = fixture();
    const res = await app.post("/api/articles", { url: "https://example.org/watch?v=xRh2sVcNXQ8" });
    expect(res.status).toBe(400);
    expect(preparedSource).not.toHaveBeenCalled();
  });

  it("ends an unavailable-caption request before calling Gemini", async () => {
    const app = fixture();
    vi.mocked(preparedSource).mockRejectedValueOnce(new ApiError(422, "暂时无法读取字幕。"));
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
