import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadSummary } from '../src/web/summary';

const chapterPath = '/api/articles/article-id/chapters/ch-2/summary';
const saved = {who: '人物', what: '事件', when: '时间', where: '地点', why: '起因', how: '过程'};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('recovers an interrupted read, an HTML gateway outage and a pending job using only GET', async () => {
  const get = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(new Response('Bad gateway', {status: 503, headers: {'Retry-After': '4'}}))
    .mockResolvedValueOnce(Response.json({status: 'running'}, {status: 202, headers: {'Retry-After': '2'}}))
    .mockResolvedValueOnce(Response.json(saved));
  vi.stubGlobal('fetch', get);
  const status = vi.fn();
  const result = loadSummary('article-id', 'ch-2', new AbortController().signal, status);
  await vi.advanceTimersByTimeAsync(1000);
  expect(get).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3999);
  expect(get).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(status.mock.calls).toEqual([['reconnecting'], ['reconnecting'], ['pending']]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toEqual(saved);
  expect(get).toHaveBeenCalledTimes(4);
  for (const [url, init] of get.mock.calls) {
    expect(url).toBe(chapterPath);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
  }
});

it.each(['{"who":', '<html>gateway</html>'])('recovers an unreadable HTTP 200 without marking the chapter failed', async body => {
  const get = vi.fn()
    .mockResolvedValueOnce(new Response(body))
    .mockResolvedValueOnce(Response.json(saved));
  vi.stubGlobal('fetch', get);
  const status = vi.fn();
  const result = loadSummary('article-id', 'ch-2', new AbortController().signal, status);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toEqual(saved);
  expect(get).toHaveBeenCalledTimes(2);
  expect(status.mock.calls).toEqual([['reconnecting']]);
});

it('shows when a deferred summary will be checked and waits the full Retry-After before its next GET', async () => {
  const get = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({status: 'pending'}, {status: 202, headers: {'Retry-After': '42000'}}))
    .mockResolvedValueOnce(Response.json(saved));
  vi.stubGlobal('fetch', get);
  const status = vi.fn();
  const nextCheckAt = Date.now() + 42_000_000;
  const result = loadSummary('article-id', 'ch-2', new AbortController().signal, status);
  await vi.advanceTimersByTimeAsync(41_999_999);
  expect(status.mock.calls).toEqual([[{nextCheckAt}]]);
  expect(get).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual(saved);
  expect(get).toHaveBeenCalledTimes(2);
  expect(get.mock.calls[1][1]?.method ?? 'GET').toBe('GET');
  expect(get.mock.calls[1][1]?.body).toBeUndefined();
});

it('reports a well-formed but incomplete saved result', async () => {
  const get = vi.fn().mockResolvedValueOnce(Response.json({who: saved.who}));
  vi.stubGlobal('fetch', get);
  await expect(loadSummary('article-id', 'ch-2', new AbortController().signal, vi.fn())).rejects.toThrow('保存的总结格式不完整');
  expect(get).toHaveBeenCalledTimes(1);
});

it.each([
  [404, {error: '文章已过期'}],
  [409, {error: '旧版文章未预计算'}],
  [502, {error: '本章的 5W1H 未能生成。', code: 'SUMMARY_FAILED'}],
] as const)('returns a terminal HTTP %s result without repeating the same request', async (code, payload) => {
  const get = vi.fn().mockResolvedValueOnce(Response.json(payload, {status: code}));
  vi.stubGlobal('fetch', get);
  const status = vi.fn();
  await expect(loadSummary('article-id', 'ch-2', new AbortController().signal, status)).rejects.toThrow(payload.error);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(get).toHaveBeenCalledTimes(1);
  expect(status).not.toHaveBeenCalled();
});

it('stops reconnecting as soon as the panel is closed or the reader is replaced', async () => {
  const get = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', get);
  const abort = new AbortController();
  const status = vi.fn();
  const result = loadSummary('article-id', 'ch-2', abort.signal, status);
  await vi.advanceTimersByTimeAsync(0);
  expect(status).toHaveBeenCalledWith('reconnecting');
  abort.abort();
  await expect(result).rejects.toMatchObject({name: 'AbortError'});
  await vi.advanceTimersByTimeAsync(30_000);
  expect(get).toHaveBeenCalledTimes(1);
});
