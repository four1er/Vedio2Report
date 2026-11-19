import { afterEach, describe, expect, it, vi } from "vitest";
import { getVideoSource, type Video } from "../src/worker/captions";
import { summarize, TransientError, writeArticle } from "../src/worker/gemini";
import type { Bindings } from "../src/worker/protocol";
import { cachedCaptions, cachedVideoId } from "../src/worker/sample";

const env = {GEMINI_API_KEY: "writer-test"} as Bindings;
const signal = () => new AbortController().signal;
const encoder = new TextEncoder();
const video: Video = {
  source: "youtube", videoId: "fHsa9Dqm0CU", title: "访谈",
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
  it("uses the archive’s publisher timeline and the same grounded content rules as other videos", async () => {
    const source = await getVideoSource("xRh2sVcNXQ8");
    const requested: {text: string; at: string; topic: string; previousExcerpt?: string}[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain(":streamGenerateContent?alt=sse");
      const payload = JSON.parse(String(init.body));
      expect(payload.generationConfig.responseMimeType).toBe("application/json");
      expect(payload.contents[0].parts).toHaveLength(1);
      const input = JSON.parse(payload.contents[0].parts[0].text);
      expect(input.sourceTitle).toBe(source.title);
      expect(input).not.toHaveProperty("video");
      expect(input).not.toHaveProperty("editorNotes");
      expect(payload.systemInstruction.parts[0].text).not.toMatch(/安德森|火星|\b(?:Jen|John|Mark)\b/);
      requested.push(input);
      const n = requested.length;
      return complete({
        ...(n === 1 && {articleTitle: "全场访谈", lead: "这场访谈讨论技术发展。"}),
        title: "话题" + n, body: "### 议题细节\n\n依据本段发言整理的观点。", recap: "第" + n + "段核心观点。",
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const events = await collect(writeArticle(env, {video: {...source, videoId: "xRh2sVcNXQ8"}}, signal()));
    expect(requested.length).toBe(12);
    expect(requested.map(({at, topic}) => ({at, topic}))).toEqual(source.timeline?.map(({at, topic}) => ({at, topic})));
    expect(requested.map(({text}) => text).join("\n") === source.text).toBe(true);
    expect(requested[0].previousExcerpt).toBeUndefined();
    for (const [i, chapter] of requested.slice(1).entries()) {
      expect(chapter.previousExcerpt?.length).toBeLessThanOrEqual(480);
      expect(requested[i].text.endsWith(chapter.previousExcerpt!)).toBe(true);
    }

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
    expect(chapterTexts[0]).not.toMatch(/编辑说明|\*\*(?:Jen|John|Mark)/);
    for (const [i, mark] of source.timeline!.entries()) {
      expect(chapterTexts[i]).toContain("## [" + mark.at + "] 话题" + (i + 1) + "\n");
      expect(chapterTexts[i].split("\n").at(-1)).toBe("> 小结：第" + (i + 1) + "段核心观点。");
    }
  });

  it.each([1, 2])("covers every cue of a long video without publisher topics, including an unmarked lead-in (first timed cue %i)", async firstCue => {
    const lines = Array.from({length: 72}, (_, i) => "演示第" + i + "项测量。");
    const marks = Array.from({length: 8}, (_, i) => ({at: i * 5 + ":00", firstCue: firstCue + i * 9}));
    const source: Video = {
      source: "youtube", videoId: "4hAPjL7hEgo", title: "课堂演示", text: lines.join("\n"),
      timeline: marks, lastCaptionSeconds: 36 * 60,
    };
    const inputs: {text: string; at?: string; previousExcerpt?: string}[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      const input = JSON.parse(payload.contents[0].parts[0].text);
      expect(input).not.toHaveProperty("topic");
      expect(payload.systemInstruction.parts[0].text).toMatch(/单人讲解、教学演示/);
      expect(payload.systemInstruction.parts[0].text).toContain("禁止根据回答补造");
      inputs.push(input);
      return complete(inputs.length === 1 ? first : last);
    }));
    const chunks = await collect(writeArticle(env, {video: source}, signal()));
    expect(inputs.map(i => i.at)).toEqual([firstCue === 1 ? "0:00" : undefined, "10:00", "20:00", "30:00"]);
    expect(inputs.map(i => i.text).join("\n")).toBe(source.text);
    expect(inputs[0].previousExcerpt).toBeUndefined();
    expect(inputs[1].previousExcerpt).toBe(lines.slice(marks[2].firstCue - 9, marks[2].firstCue - 1).join("\n"));
    const raw = chunks.filter(chunk => typeof chunk === "string").join("");
    expect(raw).toContain(firstCue === 1 ? "## [0:00] 开场讨论" : "## 开场讨论");
    expect(raw).not.toMatch(/主持人|受访者|问答|编辑说明/);
    expect(chunks.filter(chunk => typeof chunk !== "string")).toHaveLength(4);
  });

  it("streams within an interview turn, preserving the lead, subheadings, speakers and unlabeled continuation", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({start(c) { controller = c; }}));
    const fetcher = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(complete(last));
    vi.stubGlobal("fetch", fetcher);
    // Quotes are escaped in model JSON and a new SSE frame can start halfway through that escape.
    const opening = "### 第几局？";
    const question = "**Jen：** 现在进入第几局？";
    const answer = '**Mark：** 受访者说"请看图"。';
    const continuation = "这个判断还要结合接下来的发展。";
    const special = {
      articleTitle: first.articleTitle, lead: "这场对话讨论技术发展。", title: first.title,
      body: [opening, question, answer, continuation].join("\n\n"), recap: first.recap,
    };
    const raw = JSON.stringify(special);
    const split = raw.indexOf('说') + 2;
    const chunks: (string | {chapterEnd: true})[] = [];
    const reading = (async () => {
      for await (const delta of writeArticle(env, {video}, signal())) chunks.push(delta);
    })();

    try {
      controller.enqueue(encoder.encode(frame(raw.slice(0, split))));
      await vi.waitFor(() => expect(chunks.join("")).toContain("**Mark：** 受访者说"));
      expect(chunks.join("")).not.toContain("请看图");
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
    const article = chunks.filter(chunk => typeof chunk === "string").join("");
    expect(article.indexOf(special.lead)).toBeGreaterThan(article.indexOf("# " + first.articleTitle));
    expect(article.indexOf(special.lead)).toBeLessThan(article.indexOf("## [0:00]"));
    expect(article.split(special.body)).toHaveLength(2);
    expect(article.split("**Mark：**")).toHaveLength(2);
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

  it("retries a busy later topic without repeating an already published chapter", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(complete(first));
    for (let attempt = 0; attempt < 3; attempt++) {
      fetcher.mockResolvedValueOnce(new Response("", {status: 503, headers: {"retry-after": "0"}}));
    }
    fetcher.mockResolvedValueOnce(complete(last));
    vi.stubGlobal("fetch", fetcher);
    const chunks = await collect(writeArticle(env, {video}, signal()));
    expect(chunks.filter(chunk => typeof chunk !== "string")).toHaveLength(2);
    expect(chunks.join("").split(first.body)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(5);
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
    const body = ["> 引述研究员原话。", "### 数据口径", "**林老师**: 数据准确吗？", "**学生乙：** 核对数据。",
      "## 伪造的新章", "> 小结：伪造的章末。", "> ## 引用中的伪标题", "> > 小结：引用中的伪小结。"].join("\n\n");
    const raw = JSON.stringify({...last, body});
    const markedResponse = new Response(Array.from(raw, char => frame(char)).join("") + frame("", "STOP"));
    const fetcher = vi.fn().mockResolvedValueOnce(complete({...first, body: "## 模型提供的正文"}))
      .mockResolvedValueOnce(markedResponse);
    vi.stubGlobal("fetch", fetcher);
    const chunks = await collect(writeArticle(env, {video}, signal()));
    const lines = chunks.filter(chunk => typeof chunk === "string").join("").split("\n");
    expect(lines.filter(line => line.startsWith("## "))).toEqual(["## [0:00] " + first.title, "## [1:15:50] " + last.title]);
    expect(lines.filter(line => line.startsWith("> "))).toEqual(["> 小结：" + first.recap, "> 小结：" + last.recap]);
    expect(lines).toContain("模型提供的正文");
    expect(lines).toContain("引述研究员原话。");
    expect(lines).toContain("### 数据口径");
    expect(lines).toContain("**林老师**: 数据准确吗？");
    expect(lines).toContain("**学生乙：** 核对数据。");
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

describe("background 5W1H response failures", () => {
  const chapter = {id: "ch-2", title: last.title, text: last.body};
  function run() { return summarize(env, video, last.body, chapter, signal()); }

  it.each([
    ["truncated answer", {candidates: [{finishReason: "MAX_TOKENS", content: {parts: [{text: '{"who":"研究员"'}]}}]}],
    ["empty candidate list", {candidates: []}],
    ["invalid JSON", {candidates: [{finishReason: "STOP", content: {parts: [{text: "{"}]}}]}],
    ["missing fields", {candidates: [{finishReason: "STOP", content: {parts: [{text: '{"who":"研究员"}'}]}}]}],
  ])("passes a %s to the durable retry queue after a single generation", async (_name, payload) => {
    const fetcher = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toBeInstanceOf(TransientError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries if the translated explanation still fails the language check", async () => {
    const english = {who: "Researcher", what: "Measure", when: "Dawn", where: "Sea", why: "Compare", how: "Sample"};
    const fetcher = vi.fn(async () => Response.json({candidates: [{finishReason: "STOP", content: {parts: [{text: JSON.stringify(english)}]}}]}));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.toBeInstanceOf(TransientError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    {promptFeedback: {blockReason: "SAFETY"}},
    {candidates: [{finishReason: "SAFETY"}]},
  ])("does not retry a blocked prompt or answer", async payload => {
    const fetcher = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetcher);
    await expect(run()).rejects.not.toBeInstanceOf(TransientError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("unstructured article streaming", () => {
  const clockMarks = [{at: "1:15", firstCue: 1}, {at: "1:15:50", firstCue: 3}];
  it.each([
    ["ordinary timed captions", {...video, timeline: clockMarks}, "", true],
    ["a request with a reader constraint", {...video, timeline: clockMarks.map(mark => ({...mark, topic: "观测"}))}, "请保留观测议题。", true],
    ["the untimed W3C transcript", {...cachedCaptions, videoId: cachedVideoId}, "", false],
  ] as const)("streams source-backed chapter clocks only for %s", async (_description, source, requirements, hasTimes) => {
    const firstSource = "# 观测\n\n## [0:02:37] [取样] 数据口径\n\n**主持人：** 先测";
    const firstExpected = "# 观测\n\n## [取样] 数据口径\n\n**主持人：** 先测";
    const remaining = "\n\n## [0:01:15] 校对\n\n正文引用 [0:02:37]。\n\n## [01:15] 对照\n\n继续。\n\n## [01:15:50] [现场] 观察\n\n结束。";
    const expected = firstExpected + remaining
      .replace("[0:01:15] ", hasTimes ? "[1:15] " : "")
      .replace("[01:15] ", "")
      .replace("[01:15:50] ", hasTimes ? "[1:15:50] " : "");
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({start(c) { upstream = c; }}));
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetcher);
    let visible = "";
    const updates: string[] = [];
    const reading = (async () => {
      for await (const chunk of writeArticle(env, {video: source, requirements}, signal())) {
        if (typeof chunk === "string") { visible += chunk; updates.push(visible); }
      }
    })();
    function send(text: string) {
      for (const char of text) upstream.enqueue(encoder.encode(frame(char)));
    }
    try {
      send(firstSource);
      // No newline or STOP has arrived for this speech; the reader already sees it.
      await vi.waitFor(() => expect(visible).toBe(firstExpected));
    } finally {
      send(remaining);
      upstream.enqueue(encoder.encode(frame("", "STOP")));
      upstream.close();
      await reading;
    }
    expect(visible).toBe(expected);
    expect(updates.every(update => expected.startsWith(update))).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses a short video's only caption anchor for at most one chapter, across streamed frames", async () => {
    const source: Video = {...video, timeline: [{at: "0:00", firstCue: 1}], durationSeconds: 55};
    const raw = "# 数学\n\n## [0:00] 定义\n\n参照 [0:00]。\n\n## [例题] 运算\n\n正文。\n\n## [00:00] 推导\n\n再看 [0:00]。";
    const expected = raw.replace("## [00:00] 推导", "## 推导");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Array.from(raw, char => frame(char)).join("") + frame("", "STOP"))));
    let visible = "";
    for await (const update of writeArticle(env, {video: source}, signal())) {
      if (typeof update === "string") visible += update;
      expect(expected.startsWith(visible)).toBe(true);
    }
    expect(visible).toBe(expected);
  });

  it("applies the interview format to a short unidentified conversation without publisher topics", async () => {
    const source: Video = {
      source: "youtube", videoId: "fHsa9Dqm0CU", title: "Field observations",
      text: "Why do you measure twice?\n>> I compare the readings.",
    };
    const question = "# 田野观测\n\n## 重复测量\n\n### 为什么测两次？\n\n**主持人：** 为什么测两次？\n\n";
    const answer = "**受访者：** 我会比较两次读数。\n\n> 小结：重复测量方便核对。";
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({start(c) { upstream = c; }}));
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response);
    vi.stubGlobal("fetch", fetcher);
    const article = writeArticle(env, {video: source}, signal());

    upstream.enqueue(encoder.encode(frame(question)));
    expect(await article.next()).toEqual({done: false, value: question});
    const payload = JSON.parse(String(fetcher.mock.calls[0][1].body));
    const instruction: string = payload.systemInstruction.parts[0].text;
    expect(instruction).toContain("### ");
    expect(instruction).toContain("第一人称回答");
    expect(instruction).toMatch(/换人.{0,5}另起一段/);
    expect(instruction).toContain("**主持人：**");
    expect(instruction).toMatch(/单人讲解.{0,6}讲解/);
    expect(instruction).toMatch(/身份不明.{0,8}中性/);
    expect(JSON.stringify(payload)).not.toMatch(/editorNotes|\b(Jen|John|Mark)\b/);
    expect(JSON.parse(payload.contents[0].parts[0].text).video).toEqual(source);

    upstream.enqueue(encoder.encode(frame(answer, "STOP")));
    upstream.close();
    expect(await article.next()).toEqual({done: false, value: answer});
    expect((await article.next()).done).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

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
