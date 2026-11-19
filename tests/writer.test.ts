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

function referenceTurns(n: number) {
  const turns = n === 1 ? [
    ["AI 公司的收入与产品形态", "收入增长说明什么？", "收入来自客户需求，产品形态还会变化。"],
    ["风险投资的多种策略", "哪些路线值得下注？", "每条有可能成功的路线都可以探索。"],
    ["公众态度与实际使用", "民调能反映 AI 使用情况吗？", "调查中的焦虑与实际使用行为有差异。"],
  ] : n === 12 ? [
    ["改变看法", "最近有什么事情改变了你的看法？", "年轻人常让我重新考虑什么是可能的。"],
    ["去火星吗？", "如果有机会，你会去火星吗？", "我大概不会，可能通过 VR 去。我不愿离开加州。"],
  ] : [["议题细节", "这段讨论的核心判断是什么？", "需要结合具体的观察来判断。"]];
  const host = n <= 2 ? "Jen" : n === 3 ? "John" : "主持人";
  return turns.flatMap(([heading, question, answer]) => [
    "### " + heading, "**" + host + "：** " + question, "**Mark：** " + answer,
  ]).join("\n\n");
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("chronological chapter writing", () => {
  it("requests all 12 original intervals in order, sending each subtitle exactly once", async () => {
    const source = await getVideoSource("xRh2sVcNXQ8");
    const requested: {text: string; at: string; topic: string; editorNotes?: string}[] = [];
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
        ...(n === 1 && {articleTitle: "全场访谈", lead: "Mark 与主持人讨论 AI。"}),
        title: "话题" + n, body: referenceTurns(n), recap: "第" + n + "段核心观点。",
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const events = await collect(writeArticle(env, {video: {...source, videoId: "xRh2sVcNXQ8"}}, signal()));
    expect(requested.length).toBe(12);
    expect(requested.map(({at, topic}) => ({at, topic}))).toEqual(source.timeline?.map(({at, topic}) => ({at, topic})));
    expect(requested.map(({text}) => text).join("\n") === source.text).toBe(true);
    const [opening, inning, funding] = requested;
    expect(opening.editorNotes).toMatch(/Jen.{0,4}问/);
    expect(opening.editorNotes).toMatch(/Mark/);
    expect(opening.editorNotes).toMatch(/摘录|整理/);
    expect(inning.editorNotes).toMatch(/Jen.{0,4}问/);
    expect(inning.editorNotes).toMatch(/Mark/);
    expect(funding.editorNotes).toMatch(/John.{0,4}问/);
    expect(funding.editorNotes).toMatch(/Mark/);
    const closing = requested.at(-1)!;
    expect(closing.editorNotes).toMatch(/火星/);
    expect(requested.slice(3).every(({editorNotes}) => editorNotes?.includes("主持人"))).toBe(true);
    expect(closing.text).toMatch(/last\s+question do you plan to go to Mars/);
    expect(closing.text.trimEnd()).toMatch(/six-month journey to\s+Mars, so I will be just fine\.$/);

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
    expect(chapterTexts[0]).toMatch(/整理/);
    for (const [i, mark] of source.timeline!.entries()) {
      expect(chapterTexts[i]).toContain("## [" + mark.at + "] 话题" + (i + 1) + "\n");
      expect(chapterTexts[i].split("\n").at(-1)).toBe("> 小结：第" + (i + 1) + "段核心观点。");
    }
  });

  it.each([
    ["only editorial paraphrase", 1, first.body],
    ["an opening question without its verified answer", 1, referenceTurns(1).replace(/\*\*Mark：\*\* [^\n]+$/, "有些人更关心实际行为。")],
    ["the wrong host for the funding discussion", 3, referenceTurns(3).replace("**John：**", "**Jen：**")],
    ["a lightning round without the final Mars question", 12, referenceTurns(12).replaceAll("火星", "太空站")],
  ] as const)("does not publish an archive chapter with %s", async (_description, chapter, invalidBody) => {
    const videoId = "xRh2sVcNXQ8";
    const source = await getVideoSource(videoId);
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      return complete({...first, body: n === chapter ? invalidBody : referenceTurns(n)});
    }));
    const emitted = [];
    await expect((async () => {
      for await (const value of writeArticle(env, {video: {...source, videoId}}, signal())) emitted.push(value);
    })()).rejects.toThrow();
    expect(emitted.filter(value => typeof value !== "string")).toHaveLength(chapter - 1);
  });

  it("attributes neutral host turns only at the verified question positions as the archive streams", async () => {
    const videoId = "xRh2sVcNXQ8";
    const source = await getVideoSource(videoId);
    const followup = "\n\n**主持人：** 能举个例子吗？\n\n**Mark：** 我认为可以继续观察。";
    const neutralOpening = referenceTurns(1).replaceAll("**Jen：**", "**主持人：**")
      .replace("\n\n### 风险投资", followup + "\n\n### 风险投资");
    const openingJson = JSON.stringify({...first, body: neutralOpening});
    const firstQuestion = "收入增长说明什么？";
    const openingCut = openingJson.indexOf(firstQuestion) + firstQuestion.length;
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const firstResponse = new Response(new ReadableStream<Uint8Array>({start(c) { upstream = c; }}));
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) return firstResponse;
      const body = referenceTurns(n).replace(/\*\*(Jen|John)：\*\*/g, "**主持人：**")
        .replace("这段讨论的核心判断是什么？", "请谈谈您做出判断的依据。") +
        (n <= 3 ? "\n\n### 后续追问" + followup : "");
      const fields = JSON.stringify({...last, body});
      return new Response(fields.match(/.{1,7}/gs)!.map(part => frame(part)).join("") + frame("", "STOP"));
    }));
    const chapters: string[] = [];
    let pending = "";
    const reading = (async () => {
      for await (const value of writeArticle(env, {video: {...source, videoId}}, signal())) {
        if (typeof value === "string") pending += value;
        else { chapters.push(pending); pending = ""; }
      }
    })();
    try {
      for (const part of openingJson.slice(0, openingCut).match(/.{1,7}/gs)!)
        upstream.enqueue(encoder.encode(frame(part)));
      await vi.waitFor(() => expect(pending).toContain("**Jen：** " + firstQuestion));
      expect(pending).not.toContain("**主持人：**");
      expect(chapters).toHaveLength(0);
    } finally {
      upstream.enqueue(encoder.encode(frame(openingJson.slice(openingCut), "STOP")));
      upstream.close();
      await reading;
    }
    const labels = (chapter: string) => [...chapter.matchAll(/^\*\*(Jen|John|主持人)：\*\*/gm)].map(match => match[1]);
    expect(chapters).toHaveLength(12);
    expect(labels(chapters[0])).toEqual(["Jen", "主持人", "Jen", "Jen"]);
    expect(labels(chapters[1])).toEqual(["Jen", "主持人"]);
    expect(labels(chapters[2])).toEqual(["John", "主持人"]);
    expect(chapters.slice(3).every(chapter => labels(chapter).length > 0 &&
      labels(chapter).every(name => name === "主持人"))).toBe(true);
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
    const body = ["> 引述研究员原话。", "### 数据口径", "**Jen**: 数据准确吗？", "Mark: 核对数据。",
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
    expect(lines).toContain("**Jen：** 数据准确吗？");
    expect(lines).toContain("**Mark：** 核对数据。");
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
      .replace("[01:15] ", hasTimes ? "[1:15] " : "")
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
