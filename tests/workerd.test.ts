import { buildSync } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("runs live subtitle extraction, Gemini streaming and cached 5W1H in workerd", async () => {
  const script = buildSync({
    entryPoints: ["src/worker/index.ts"], bundle: true, write: false, format: "esm", target: "es2022",
  }).outputFiles[0].text;
  const videoId = "AbC123deF45";
  const transcript = "研究员在清晨取样。";
  const article = "# 观察海洋\n\n## 采样方式\n\n" + transcript;
  const summary = { who: "研究员", what: "取样", when: "清晨", where: "本章未提及", why: "本章未提及", how: "本章未提及" };
  const paths: string[] = [];

  // Only the upstream services are simulated. Requests cross a real Worker / SQLite DO boundary.
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: "127.0.0.1", cf: false, compatibilityDate: "2026-06-01", modules: true, script,
    bindings: { GEMINI_API_KEY: "local-test" },
    durableObjects: { ARTICLES: { className: "ArticleSession", useSQLite: true } },
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
        const chunks = [article.slice(0, 8), article.slice(8)].map((text, i) => {
          const candidate = { content: { parts: [{ text }] }, finishReason: i === 1 ? "STOP" : undefined };
          return "data: " + JSON.stringify({ candidates: [candidate] }) + "\n\n";
        });
        return new Response(chunks.join(""), { headers: { "Content-Type": "text/event-stream" } });
      }
      expect(pathname).toMatch(/:generateContent$/);
      expect(material.article).toBe(article);
      expect(material.chapter.title).toBe("采样方式");
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
    const events = (await response.text()).trim().split("\n\n").map(block => {
      const [event, data] = block.split("\n");
      return { event: event.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) };
    });
    expect(events.map(e => e.event)).toEqual(["meta", "delta", "delta", "done"]);
    expect(events[0].data.source).toBe("youtube");
    expect(events[1].data.text + events[2].data.text).toBe(article);
    const [{ id }] = events[3].data.chapters;
    const path = base + "/" + events[0].data.articleId + "/chapters/" + id + "/summary";
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await runtime.dispatchFetch(path, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(summary);
    }
    expect(paths.filter(p => p.endsWith(":generateContent"))).toHaveLength(1);
  } finally {
    await runtime.dispose();
  }
}, 15_000);
