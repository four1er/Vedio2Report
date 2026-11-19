import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptionCache } from "../src/worker/caption-cache";
import { CaptionSourceError, discoverCaptions, downloadCaptions } from "../src/worker/captions";
import { memoryStorage } from "./memory-storage";

vi.mock("../src/worker/captions", async (original) => ({
  ...await original<typeof import("../src/worker/captions")>(),
  discoverCaptions: vi.fn(),
  downloadCaptions: vi.fn(),
}));

const videoId = "AbC123deF45";
const track = {kind: "live" as const, videoId, title: "长访谈",
  trackUrls: ["https://www.youtube.com/api/timedtext?v=" + videoId + "&sig=first"]};
const captions = {title: track.title, source: "youtube" as const, text: "第一条完整字幕\n最后一条完整字幕", cueCount: 2};
function fixture() {
  const storage = memoryStorage();
  const instance = () => new CaptionCache({storage} as unknown as DurableObjectState);
  let cache = instance();
  async function request(path: "prepare" | "source" | "status") {
    return cache.fetch(new Request("https://captions/" + path + "/" + videoId, {method: path === "prepare" ? "POST" : "GET"}));
  }
  vi.mocked(discoverCaptions).mockResolvedValue(track);
  vi.mocked(downloadCaptions).mockResolvedValue(captions);
  return {storage, request, alarm: () => cache.alarm(), restart() { cache = instance(); }};
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("durable caption downloads", () => {
  it.each(["NO_CAPTIONS", "SOURCE_UNVERIFIED"] as const)("does not create a task for %s", async (code) => {
    const app = fixture();
    vi.mocked(discoverCaptions).mockRejectedValueOnce(new CaptionSourceError(code, "播放器结果"));
    const response = await app.request("prepare");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({code, error: "播放器结果"});
    expect(await app.storage.get("captions")).toBeUndefined();
    expect(await app.storage.getAlarm()).toBeNull();
    expect((await app.request("status")).status).toBe(404);
    expect(downloadCaptions).not.toHaveBeenCalled();
  });

  it("stores the job before downloading, refreshes a failed signed URL after eviction, and expires the full cached text", async () => {
    const app = fixture();
    const newer = {...track, trackUrls: [track.trackUrls[0].replace("first", "refreshed")]};
    vi.mocked(discoverCaptions).mockResolvedValueOnce(track).mockResolvedValueOnce(newer);
    vi.mocked(downloadCaptions).mockRejectedValueOnce(new CaptionSourceError("TEMPORARY", "字幕签名过期"));
    const both = await Promise.all([app.request("prepare"), app.request("prepare")]);
    for (const pending of both) {
      expect(pending.status).toBe(202);
      expect(await pending.json()).toEqual({status: "pending", videoId, title: track.title});
    }
    expect(discoverCaptions).toHaveBeenCalledTimes(1);
    expect(downloadCaptions).not.toHaveBeenCalled();
    await app.alarm();
    expect(downloadCaptions).toHaveBeenCalledWith(track, {});
    const retryAt = (await app.storage.getAlarm())!;
    app.restart();
    await app.alarm();
    expect(downloadCaptions).toHaveBeenCalledTimes(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(retryAt);
    await app.alarm();
    expect(downloadCaptions).toHaveBeenLastCalledWith(newer, {});
    const expected = {status: "ready", videoId, title: captions.title, source: "youtube", cueCount: 2};
    expect(await (await app.request("status")).json()).toEqual(expected);
    expect(await (await app.request("prepare")).json()).toEqual(expected);
    expect(await (await app.request("source")).json()).toEqual(captions);
    const expiresAt = (await app.storage.getAlarm())!;
    expect(expiresAt - retryAt).toBe(86_400_000);
    clock.mockReturnValue(expiresAt);
    expect((await app.request("status")).status).toBe(404);
    await app.alarm();
    expect(await app.storage.get("captions")).toBeUndefined();
    expect((await app.request("prepare")).status).toBe(202);
    expect(discoverCaptions).toHaveBeenCalledTimes(3);
  });

  it("ends after three temporary download failures without exposing partial captions or retrying on reads", async () => {
    const app = fixture();
    vi.mocked(downloadCaptions).mockRejectedValue(new CaptionSourceError("TEMPORARY", "下载中断"));
    const clock = vi.spyOn(Date, "now");
    await app.request("prepare");
    for (let i = 0; i < 3; i++) {
      clock.mockReturnValue((await app.storage.getAlarm())!);
      await app.alarm();
    }
    app.restart();
    for (const route of ["source", "status", "prepare"] as const) {
      const response = await app.request(route);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({error: "下载中断", code: "TEMPORARY"});
    }
    expect(downloadCaptions).toHaveBeenCalledTimes(3);
  });

  it("reclaims an interrupted download while rejecting the stale writer", async () => {
    const app = fixture();
    let finish!: (value: typeof captions) => void;
    let notify!: () => void;
    const fetching = new Promise<void>(resolve => { notify = resolve; });
    vi.mocked(downloadCaptions).mockImplementationOnce(async () => {
      notify();
      return await new Promise<typeof captions>(resolve => { finish = resolve; });
    });
    await app.request("prepare");
    const interrupted = app.alarm();
    await fetching;
    expect(await (await app.request("status")).json()).toEqual({status: "running", videoId, title: track.title});
    app.restart();
    await app.alarm();
    expect(downloadCaptions).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue((await app.storage.getAlarm())!);
    await app.alarm();
    finish({...captions, text: "过时的响应"});
    await interrupted;
    expect(await (await app.request("source")).json()).toEqual(captions);
  });
});
