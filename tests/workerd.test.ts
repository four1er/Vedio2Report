import { buildSync } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, it, vi } from "vitest";
import { events } from "../src/web/stream";

it("starts summaries without any click and finishes writing while a summary is running in workerd", async () => {
  const script = buildSync({
    entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", target: "es2022",
  }).outputFiles[0].text;
  const videoId = "AbC123deF45";
  const transcript = "研究员在清晨取样。";
  const first = "# 观察海洋\n\n## 采样方式\n\n" + transcript + "\n\n> 小结：研究员亲自取样。";
  const nextHeading = "\n\n## 采样时间\n";
  const summary = { who: "研究员", what: "取样", when: "清晨", where: "本章未提及", why: "本章未提及", how: "本章未提及" };
  const paths: string[] = [];
  let releaseSummary!: () => void;
  const holdSummary = new Promise<void>(resolve => { releaseSummary = resolve; });
  const summaryTitles: string[] = [];
  let finishWriting: (() => void) | undefined;
  function frame(text: string, finishReason?: string) {
    const candidate = {content: {parts: [{text}]}, finishReason};
    return new TextEncoder().encode("data: " + JSON.stringify({candidates: [candidate]}) + "\n\n");
  }

  // Only the upstream services are simulated. Requests cross a real Worker / SQLite DO boundary.
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: "127.0.0.1", cf: false, compatibilityDate: "2026-06-01", modules: true, script,
    bindings: { GEMINI_API_KEY: "local-test" },
    durableObjects: {
      ARTICLES: { className: "ArticleSession", useSQLite: true },
      CAPTION_CACHE: { className: "CaptionCache", useSQLite: true },
    },
    outboundService: async (request) => {
      const { hostname, pathname } = new URL(request.url);
      paths.push(pathname);
      if (hostname === "www.youtube.com" && pathname === "/watch") {
        const player = {
          videoDetails: { videoId, title: "观察海洋" },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [
            { baseUrl: "https://www.youtube.com/api/timedtext?v=" + videoId, languageCode: "zh" },
          ] } },
        };
        return new Response("<script>var ytInitialPlayerResponse = " + JSON.stringify(player) + "</script>");
      }
      if (hostname === "www.youtube.com" && pathname === "/api/timedtext")
        return Response.json({ events: [{ segs: [{ utf8: transcript }] }] });

      expect(hostname).toBe("generativelanguage.googleapis.com");
      const payload = await request.json() as { contents: { parts: { text: string }[] }[] };
      const material = JSON.parse(payload.contents[0].parts[0].text);
      expect(material.video.text).toBe(transcript);
      if (pathname.endsWith(":streamGenerateContent")) {
        expect(JSON.parse(payload.contents[0].parts[1].text).requirements).toBe("给中学生");
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(frame(first + nextHeading));
            finishWriting = () => {
              controller.enqueue(frame("\n研究员在清晨取样。\n\n> 小结：取样时间是清晨。", "STOP"));
              controller.close();
              finishWriting = undefined;
            };
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      expect(pathname).toMatch(/:generateContent$/);
      summaryTitles.push(material.chapter.title);
      if (material.chapter.title === "采样方式") {
        expect(material.article.trimEnd()).toBe(first);
        await holdSummary;
      } else {
        expect(material.chapter.title).toBe("采样时间");
        expect(material.article).toContain("取样时间是清晨");
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(summary) }] }, finishReason: "STOP" }] });
    },
  }));
  try {
    const base = "https://example.test/api/articles";
    const response = await runtime.dispatchFetch(base, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://youtu.be/" + videoId, requirements: "给中学生" }),
    });
    expect(response.status).toBe(200);
    const stream = events(response);
    const meta = (await stream.next()).value!;
    expect(meta).toMatchObject({type: "meta", data: {source: "youtube"}});
    expect((await stream.next()).value).toEqual({type: "delta", data: {text: first + nextHeading}});
    expect((await stream.next()).value).toEqual({type: "chapter", data: {id: "ch-1", title: "采样方式"}});
    const path = base + "/" + meta.data.articleId + "/chapters/ch-1/summary";
    // The first upstream inference must arrive before any GET or compatibility POST.
    await vi.waitFor(() => expect(summaryTitles).toEqual(["采样方式"]), {timeout: 8000});
    const simultaneous = await Promise.all([
      runtime.dispatchFetch(path),
      runtime.dispatchFetch(path, { method: "POST" }),
    ]);
    for (const response of simultaneous) {
      expect(response.status).toBe(202);
      expect(response.headers.get("Retry-After")).toBe("2");
      expect(await response.json()).toEqual({status: "running"});
    }
    expect(paths.filter(p => p.endsWith(":generateContent"))).toHaveLength(1);
    finishWriting!();
    expect((await stream.next()).value?.type).toBe("delta");
    expect((await stream.next()).value).toEqual({type: "chapter", data: {id: "ch-2", title: "采样时间"}});
    expect((await stream.next()).value?.type).toBe("done");
    expect((await stream.next()).done).toBe(true);
    const secondPath = path.replace("ch-1", "ch-2");
    const queued = await runtime.dispatchFetch(secondPath);
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({status: "pending"});
    expect(summaryTitles).toEqual(["采样方式"]);
    releaseSummary();
    await vi.waitFor(() => expect(summaryTitles).toEqual(["采样方式", "采样时间"]), {timeout: 8000});
    for (const cachedPath of [path, secondPath]) {
      await vi.waitFor(async () => {
        const cached = await runtime.dispatchFetch(cachedPath);
        expect(cached.status).toBe(200);
        expect(await cached.json()).toEqual(summary);
      });
    }
    expect(paths.filter(p => p.endsWith(":generateContent"))).toHaveLength(2);
  } finally {
    releaseSummary();
    finishWriting?.();
    await runtime.dispose();
  }
}, 25_000);
