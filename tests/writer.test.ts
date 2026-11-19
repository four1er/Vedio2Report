import { afterEach, describe, expect, it, vi } from "vitest";
import { getVideoSource, type Video } from "../src/worker/captions";
import { summarize, TransientError, writeArticle } from "../src/worker/gemini";
import type { ArticleUpdate } from "../src/worker/gemini";
import type { TranscriptInput } from "../src/worker/transcript-response";
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

type Row = {id: number; heading: string; speaker: string; text: string; turns?: {speaker: string; text: string}[]};
const spoken: Video = {...video, timeline: undefined, text: "Jen: Why twice?\nMark: I measured twice.\nAnd I checked."};
const articles = {articleTitle: "现场访谈", chapterTitle: "核对读数"};
const transcriptRows: Row[] = [
  {id: 1, heading: "测量的次数", speaker: "Jen", text: "为什么测两次？"},
  {id: 2, heading: "", speaker: "Mark", text: '我记录了“二次”读数。\n有条记录写着 "{2}"。'},
  {id: 3, heading: "", speaker: "Mark", text: "我又核对了一次。"},
];
function markdown(chunks: ArticleUpdate[]) {
  return chunks.filter((chunk): chunk is string => typeof chunk === "string").join("");
}
function progress(chunks: ArticleUpdate[]) {
  return chunks.flatMap(chunk => typeof chunk === "object" && "coverage" in chunk ? [chunk.coverage] : []);
}
function ends(chunks: ArticleUpdate[]) {
  return chunks.filter(chunk => typeof chunk === "object" && "chapterEnd" in chunk);
}
function echo(input: TranscriptInput) {
  return {
    ...articles, chapterTitle: input.topic || articles.chapterTitle,
    units: input.units.map(({id, text}) => ({id, heading: "", speaker: "", text})),
  };
}
function known(input: TranscriptInput) {
  return {...articles, units: input.units.map(({id}) => transcriptRows[id - 1])};
}
function mockWriter(reply: (input: TranscriptInput, n: number) => Response) {
  const requests: {input: TranscriptInput; url: string; instruction: string; mime?: string; requirements?: string}[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const [source, preferences] = body.contents[0].parts;
    const input = JSON.parse(source.text);
    requests.push({input, url, instruction: body.systemInstruction.parts[0].text,
      mime: body.generationConfig.responseMimeType, requirements: preferences && JSON.parse(preferences.text).requirements});
    return reply(input, requests.length);
  });
  vi.stubGlobal("fetch", fetcher);
  return requests;
}

describe("explicit verbatim transcript writing", () => {
  it("submits all archive captions in order and publishes each source section exactly once", async () => {
    const videoId = "xRh2sVcNXQ8";
    const source = await getVideoSource(videoId);
    const requests = mockWriter(input => complete({...echo(input), units: input.units.map(({id}) => ({
      id, speaker: "", heading: "", text: "第" + id + "段。“记录每次测量使用的仪器和方法，观察读数的变化并记录原始数值，然后再次校准设备。”",
    }))}));
    const events = await collect(writeArticle(env, {requirements: "逐字转写", video: {...source, videoId}}, signal()));
    const units = requests.flatMap(r => r.input.units);
    const compact = (text: string) => text.replace(/\s/gu, "");
    expect(compact(units.map(u => u.text).join("")) === compact(source.text)).toBe(true);
    expect(units.map(u => u.id)).toEqual(units.map((_, i) => i + 1));
    expect(units[0].firstCue).toBe(1);
    expect(units.at(-1)?.lastCue).toBe(source.cueCount);
    expect(requests.length).toBeGreaterThan(source.timeline!.length);
    expect(requests.every(r => r.url.includes(":streamGenerateContent?alt=sse") && r.mime === "application/json")).toBe(true);
    expect(requests.every(r => r.input.sourceTitle === source.title && !("video" in r.input))).toBe(true);
    expect(requests[0].instruction).not.toMatch(/安德森|\b(?:Jen|John|Mark)\b/);
    expect(requests[0].instruction).toMatch(/人名和产品专名.*保留原文拼写/);
    expect(requests[0].instruction).toMatch(/型号与版本号照录原文.*不同版本逐一保留/);
    expect(requests[1].input.previousExcerpt).toBe(requests[0].input.units.at(-1)?.text);
    const article = markdown(events);
    expect(article.match(/^# /gm)).toHaveLength(1);
    expect(article.match(/^## .+/gm)).toEqual(source.timeline!.map(mark => "## [" + mark.at + "] " + mark.topic));
    expect(article).not.toContain("> 小结：");
    expect(ends(events)).toHaveLength(source.timeline!.length);
    expect(progress(events)).toEqual(Array.from({length: units.length + 1}, (_, completed) => ({completed, total: units.length})));
  });

  it("keeps the next batch's unseen speech out of context, including when a turn ends mid-sentence", async () => {
    // The row cap makes this a two-batch chapter. Each phrase occurs only once.
    const text = Array.from({length: 21}, (_, i) => ">> unique utterance " + (i + 1) + " for the class").join("\n");
    const requests = mockWriter(input => complete(echo(input)));
    await collect(writeArticle(env, {requirements: "逐字转写", video: {...spoken, text}}, signal()));
    expect(requests).toHaveLength(2);
    const [first, second] = requests.map(request => request.input);
    expect(JSON.stringify(first)).not.toContain("unique utterance 21");
    expect(first).not.toHaveProperty("previousTranslation");
    expect(second.previousExcerpt).toContain("unique utterance 20");
    expect(second.previousTranslation).toContain("unique utterance 20");
    expect(second.units.map(unit => unit.id)).toEqual([21]);
  });

  it("repairs a shifted row alone before displaying names copied from the next row, preserving authentic repetition", async () => {
    const repeated = ">> I compared QuantaBus with NanoDock.";
    const video = {...spoken, text: [">> We checked the pressure.", repeated, repeated].join("\n")};
    const requests = mockWriter((input, n) => complete({
      ...articles, units: input.units.map(unit => ({
        id: unit.id, heading: "", speaker: "", text: unit.id === 1 && n > 1 ? "我们核对了压力。" : "我对照了 QuantaBus 和 NanoDock。",
      })),
    }));
    const events = await collect(writeArticle(env, {requirements: "逐字转写", video}, signal()));
    expect(requests.map(r => r.input.units.map(unit => unit.id))).toEqual([[1, 2, 3], [1], [2, 3]]);
    expect(JSON.stringify(requests[1].input)).not.toContain("NanoDock");
    const body = markdown(events);
    expect(body.indexOf("核对了压力")).toBeLessThan(body.indexOf("QuantaBus"));
    expect(body.match(/QuantaBus/g)).toHaveLength(2);
    expect(progress(events).map(p => p.completed)).toEqual([0, 1, 2, 3]);
  });

  it("retries a substituted spelling in a translated product list with the actual source names", async () => {
    const video = {...spoken, text: "We used RedBus and Pyro, then MonoFab and TX."};
    const requests = mockWriter((input, n) => complete({
      ...articles, units: [{id: input.units[0].id, heading: "", speaker: "",
        text: n === 1 ? "我们使用了 RedBus 和 Pyro，还有 MonoFab 和 Texagon。" : "我们使用了 RedBus 和 Pyro，还有 MonoFab 和 TX。"}],
    }));
    const article = markdown(await collect(writeArticle(env, {requirements: "逐字转写", video}, signal())));
    expect(requests).toHaveLength(2);
    expect(requests[1].input.repair).toContain("RedBus、Pyro、MonoFab、TX");
    expect(article).toContain("MonoFab 和 TX");
    expect(article).not.toContain("Texagon");
  });

  it.each([
    "我们使用了红色总线和派罗，还有 MonoFab 与 TX。",
    "We used RedBus and Pyro, then MonoFab and an alternative term.",
  ])("accepts ordinary translated names and prose outside mixed-script lists", async translation => {
    const video = {...spoken, text: "We used RedBus and Pyro, then MonoFab and TX."};
    const requests = mockWriter(input => complete({...articles, units: [
      {id: input.units[0].id, heading: "", speaker: "", text: translation},
    ]}));
    expect(markdown(await collect(writeArticle(env, {requirements: "逐字转写", video}, signal())))).toContain(translation);
    expect(requests).toHaveLength(1);
  });

  it("retries a full English passage in default Chinese mode without changing a requested English transcript or a model list", async () => {
    const source = "We use the pressure gauge to measure how the air moves through the machine, and we record the results of the experiment.";
    const translated = "我们用压力计测量空气在机器里的流动情况，并记录实验结果。";
    const requests = mockWriter((input, n) => complete({...articles, units: [
      {id: 1, heading: "", speaker: "", text: n === 2 ? translated : input.units[0].text},
    ]}));
    const render = async (text: string, requirements = "逐字转写") => markdown(await collect(writeArticle(env, {video: {...spoken, text}, requirements}, signal())));
    expect(await render(source)).toContain(translated);
    expect(requests).toHaveLength(2);
    expect(requests[1].input.repair).toContain("叙述必须译成中文");
    expect(await render(source, "逐字转写，请输出英文。")).toContain(source);
    const models = "AB-100, CD-200, ".repeat(8) + "TX";
    expect(await render(models)).toContain(models);
    expect(requests).toHaveLength(4);
  });

  it.each(["逐字转写，面向高中生，使用自然些的措辞。", "不要总结，逐字转写。", "逐字转写，分为两章。"])(
    "retains every source unit when the reader asks %s", async requirements => {
      const requests = mockWriter(input => complete(echo(input)));
      const chunks = await collect(writeArticle(env, {video: spoken, requirements}, signal()));
      expect(requests.flatMap(r => r.input.units.map(u => u.id))).toEqual([1, 2, 3]);
      expect(requests.every(r => r.requirements === requirements)).toBe(true);
      expect(ends(chunks)).toHaveLength(requirements.includes("两章") ? 2 : 1);
      expect(progress(chunks).at(-1)).toEqual({completed: 3, total: 3});
      expect(markdown(chunks)).not.toMatch(/\[\d+:\d+\]/);
  });

  it("preserves a monologue or an answer-only source without assigning an interviewer", async () => {
    const source = {...spoken, text: "I saw three marks.\nI counted them again."};
    const requests = mockWriter(input => complete({...articles, units: input.units.map(({id}) => ({
      id, heading: "三处读数", speaker: "", text: "我看到了三处标记。\n\n我又数了一遍。",
    }))}));
    const article = markdown(await collect(writeArticle(env, {requirements: "逐字转写", video: source}, signal())));
    expect(article).toContain("### 三处读数\n\n我看到了三处标记。\n\n我又数了一遍。");
    expect(article).not.toMatch(/主持人|受访者|编辑说明|\*\*/);
    expect(requests[0].instruction).toMatch(/禁止根据回答补造问题/);
  });

  it("streams checked speech before STOP but holds partial JSON and the last record until completion", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({start(controller) { upstream = controller; }}));
    const requests = mockWriter(() => response);
    const chunks: ArticleUpdate[] = [];
    const reading = (async () => {
      for await (const chunk of writeArticle(env, {requirements: "逐字转写", video: spoken}, signal())) chunks.push(chunk);
    })();
    const output = JSON.stringify({...articles, units: transcriptRows});
    const split = output.indexOf('"{2}') - 1;
    try {
      upstream.enqueue(encoder.encode(frame(output.slice(0, split))));
      await vi.waitFor(() => expect(markdown(chunks)).toContain("**Jen：** 为什么测两次？"));
      expect(markdown(chunks)).not.toContain("**Mark");
      upstream.enqueue(encoder.encode(frame(output.slice(split))));
      await vi.waitFor(() => expect(markdown(chunks)).toContain('有条记录写着 "{2}"。'));
      expect(markdown(chunks)).not.toContain(transcriptRows[2].text);
      expect(ends(chunks)).toHaveLength(0);
    } finally {
      upstream.enqueue(encoder.encode(frame("", "STOP")));
      upstream.close();
      await reading;
    }
    const article = markdown(chunks);
    expect(article).toBe('# 现场访谈\n\n## 核对读数\n\n### 测量的次数\n\n**Jen：** 为什么测两次？\n\n**Mark：** 我记录了“二次”读数。\n\n有条记录写着 "{2}"。\n\n我又核对了一次。');
    expect(progress(chunks).map(p => p.completed)).toEqual([0, 1, 2, 3]);
    expect(ends(chunks)).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("keeps anonymous >> interjections separate, carries their unfinished speech and honors explicit source names", async () => {
    const longTurn = ">> " + "carry this thought forward ".repeat(16) + "to its end.";
    const video = {...spoken, text: ["Rae: First.", longTurn, ">> I agree.", ">> Jo: Last."].join("\n")};
    const longFirst = "把这个想法保持下来，沿着此前的讨论继续往下说，也考虑大家先前的看法，然后我们还应该";
    const rows = [
      ["Rae", "第一个想法。"], ["Rae", longFirst], ["Rae", "沿着原有思路，把整段想说的话说完。"],
      ["", "我也同意。"], ["Rae", "这是最后一句。"],
    ];
    mockWriter(input => complete({...articles, units: input.units.map(({id}) => ({
      id, heading: "", speaker: rows[id - 1][0], text: rows[id - 1][1],
    }))}));
    const article = markdown(await collect(writeArticle(env, {requirements: "逐字转写", video}, signal())));
    expect(article).toContain("**Rae：** 第一个想法。\n\n**未署名发言人：** " + longFirst + "沿着原有思路，把整段想说的话说完。");
    expect(article).toContain("\n\n**未署名发言人：** 我也同意。\n\n**Jo：** 这是最后一句。");
    expect(article.match(/未署名发言人/g)).toHaveLength(2);
  });

  it("keeps multiple turns in a single mapped unit and the last speaker's continuation", async () => {
    const source = {...spoken, text: "Ada: Is it time? Lin said yes, but Jo objected.\nJo: I need another minute."};
    const units: Row[] = [
      {id: 1, heading: "复核时间", speaker: "Ada", text: "时间到了吗？", turns: [
        {speaker: "Lin", text: "是的。"}, {speaker: "Jo", text: "我还没核对完。"},
      ]}, {id: 2, heading: "", speaker: "Jo", text: "我还需要一分钟。"},
    ];
    mockWriter(() => complete({...articles, units}));
    const chunks = await collect(writeArticle(env, {requirements: "逐字转写", video: source}, signal()));
    expect(markdown(chunks)).toContain("**Ada：** 时间到了吗？\n\n**Lin：** 是的。\n\n**Jo：** 我还没核对完。\n\n我还需要一分钟。");
    expect(progress(chunks).map(p => p.completed)).toEqual([0, 1, 2]);
  });

  it.each(["missing", "duplicated", "reordered", "empty", "truncated", "token limit", "late disconnect"])(
    "resumes after a %s row or stream without republishing its validated prefix", async failure => {
      const requests = mockWriter((input, n) => {
        if (n > 1) return complete(known(input));
        const output = known(input);
        if (failure === "late disconnect") return new Response(frame(JSON.stringify(output)) +
          event({error: {code: 503, status: "UNAVAILABLE", details: [{retryDelay: "0s"}]}}));
        if (failure === "token limit" || failure === "truncated") {
          return new Response(frame(JSON.stringify(output).slice(0, -1), failure === "token limit" ? "MAX_TOKENS" : "STOP"));
        }
        const [a, b, c] = output.units;
        const bad = failure === "missing" ? [a, c] : failure === "duplicated" ? [a, a, c] :
          failure === "reordered" ? [a, c, b] : [a, {...b, text: "  "}, c];
        return complete({...articles, units: bad});
      });
      const chunks = await collect(writeArticle(env, {requirements: "逐字转写", video: spoken}, signal()));
      expect(requests[1].input.units[0].id).toBe(["truncated", "token limit", "late disconnect"].includes(failure) ? 3 : 2);
      expect(requests.slice(1).every(r => r.input.units.every(unit => unit.id > 1))).toBe(true);
      expect(progress(chunks).map(p => p.completed)).toEqual([0, 1, 2, 3]);
      for (const expected of ["为什么测两次？", "我记录了“二次”读数。", "我又核对了一次。"])
        expect(markdown(chunks).split(expected)).toHaveLength(2);
      expect(ends(chunks)).toHaveLength(1);
  });

  it("does not lose the unsent tail when a failed batch must be subdivided", async () => {
    const source = {...spoken, text: Array.from({length: 11}, (_, i) => ">> 唯一发言 " + (i + 1) + "。").join("\n")};
    const requests = mockWriter((input, n) => {
      if (n > 1) return complete(echo(input));
      const output = echo(input);
      return complete({...output, units: [output.units[0], output.units[6]]});
    });
    const chunks = await collect(writeArticle(env, {requirements: "逐字转写", video: source}, signal()));
    expect(requests[1].input.units.length).toBeLessThan(10);
    expect(requests.slice(1).flatMap(r => r.input.units.map(unit => unit.id))).toEqual(
      Array.from({length: 10}, (_, i) => i + 2));
    expect(progress(chunks).map(p => p.completed)).toEqual(Array.from({length: 12}, (_, i) => i));
    expect(markdown(chunks).match(/唯一发言/g)).toHaveLength(11);
    expect(ends(chunks)).toHaveLength(1);
  });

  it("keeps stray model Markdown in speech from manufacturing a new chapter", async () => {
    const source = {...spoken, text: "The source quotes a heading and a paragraph."};
    mockWriter(input => complete({...articles, units: input.units.map(({id}) => ({
      id, heading: "原话里的标题", speaker: "", text: "# 另一个标题\n## 伪造的章节\n> ## 引用中的标题",
    }))}));
    const chunks = await collect(writeArticle(env, {requirements: "逐字转写", video: source}, signal()));
    const article = markdown(chunks);
    expect(article.match(/^# .+$/gm)).toEqual(["# 现场访谈"]);
    expect(article.match(/^## .+$/gm)).toEqual(["## 核对读数"]);
    expect(article).toContain("另一个标题\n\n伪造的章节\n\n引用中的标题");
    expect(ends(chunks)).toHaveLength(1);
  });

  it("bounds repeated invalid responses and never reports the final missing source unit as complete", async () => {
    const requests = mockWriter(input => complete({...articles, units: input.units.slice(0, -1).map(({id}) => transcriptRows[id - 1])}));
    const chunks: ArticleUpdate[] = [];
    await expect((async () => {
      for await (const chunk of writeArticle(env, {requirements: "逐字转写", video: spoken}, signal())) chunks.push(chunk);
    })()).rejects.toThrow();
    expect(ends(chunks)).toHaveLength(0);
    expect(progress(chunks).at(-1)).toEqual({completed: 2, total: 3});
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThan(8);
    expect(markdown(chunks)).not.toContain(transcriptRows[2].text);
  });

  it.each([429, 503])("retries transient HTTP %i without duplicating dialogue", async status => {
    const requests = mockWriter((input, n) => n === 1
      ? new Response("", {status, headers: {"retry-after": "0"}}) : complete(known(input)));
    const chunks = await collect(writeArticle(env, {requirements: "逐字转写", video: spoken}, signal()));
    expect(requests).toHaveLength(2);
    expect(progress(chunks).map(p => p.completed)).toEqual([0, 1, 2, 3]);
  });

  it("reports the provider's long quota backoff before sending a second request", async () => {
    const requests = mockWriter(() => Response.json(
      {error: {details: [{retryDelay: "42375s"}]}}, {status: 429}));
    await expect(collect(writeArticle(env, {video: spoken}, signal()))).rejects.toThrow("约 12 小时后再试");
    expect(requests).toHaveLength(1);
  });

  it("retains a completed chapter when the provider permanently rejects the next one", async () => {
    const requests = mockWriter((input, n) => n === 1 ? complete(echo(input)) : new Response("", {status: 403}));
    const chunks: ArticleUpdate[] = [];
    await expect((async () => {
      for await (const chunk of writeArticle(env, {requirements: "逐字转写", video}, signal())) chunks.push(chunk);
    })()).rejects.toThrow();
    expect(ends(chunks)).toHaveLength(1);
    expect(requests).toHaveLength(2);
    const completed = requests[0].input.units.length;
    expect(progress(chunks).at(-1)).toEqual({completed, total: completed + requests[1].input.units.length});
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

describe("explicitly scoped Markdown streaming", () => {
  const clockMarks = [{at: "1:15", firstCue: 1}, {at: "1:15:50", firstCue: 3}];
  it.each([
    ["ordinary timed captions", {...video, timeline: clockMarks}, "只讨论测量。", true],
    ["a request with a reader constraint", {...video, timeline: clockMarks.map(mark => ({...mark, topic: "观测"}))}, "只讨论观测议题。", true],
    ["the untimed W3C transcript", {...cachedCaptions, videoId: cachedVideoId}, "只总结操作步骤。", false],
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
    for await (const update of writeArticle(env, {video: source, requirements: "只讨论数学。"}, signal())) {
      if (typeof update === "string") visible += update;
      expect(expected.startsWith(visible)).toBe(true);
    }
    expect(visible).toBe(expected);
  });

  it.each([
    ["an explicit reader constraint", video, "只讲最后的数据，限一章。"],
    ["a video without a publisher outline", {...video, timeline: undefined}, "只讨论最后的数据。"],
    ["timing anchors without publisher topics", {...video, timeline: video.timeline?.map(({at, firstCue}) => ({at, firstCue}))}, "只讨论最后的数据。"],
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
    const chunks = await collect(writeArticle(env, {video: source, requirements}, signal()));
    expect(markdown(chunks)).toBe("## 章节\n\n真实内容。");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
