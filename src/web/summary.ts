import { retryDelayMs, waitForRetry } from './stream';

export const summaryKeys = ['who', 'what', 'when', 'where', 'why', 'how'] as const;
export type Summary = Record<typeof summaryKeys[number], string>;
export type SummaryProgress = 'pending' | 'reconnecting' | {nextCheckAt: number};

export async function loadSummary(articleId: string, chapterId: string, signal: AbortSignal, onStatus: (state: SummaryProgress) => void): Promise<Summary> {
  const url = '/api/articles/' + encodeURIComponent(articleId) + '/chapters/' + encodeURIComponent(chapterId) + '/summary';
  let backoff = 1000;
  for (;;) {
    signal.throwIfAborted();
    let response: Response | undefined;
    let data;
    try {
      response = await fetch(url, {cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])});
      // An error response may be an HTML gateway page. Truncated or non-JSON
      // success responses must be read again before judging the saved fields.
      const isHttpError = !response.ok;
      data = await response.json().catch(error => {
        if (isHttpError && error instanceof SyntaxError) return null;
        throw error;
      });
    } catch {
      signal.throwIfAborted();
      response = undefined;
    }

    const pending = response?.status === 202;
    if (response?.ok && !pending) {
      if (!data || summaryKeys.some(key => typeof data[key] !== 'string' || !data[key].trim()))
        throw new Error('本章保存的总结格式不完整。');
      return data;
    }
    if (response && !pending && (data?.code === 'SUMMARY_FAILED' ||
        (response.status < 500 && ![408, 425, 429].includes(response.status)))) {
      throw new Error(typeof data?.error === 'string' ? data.error : '无法读取本章总结（HTTP ' + response.status + '）。');
    }

    // GET is read-only. While the panel is open we can safely resume a failed read
    // without resubmitting the background job. Closing it cancels the wait.
    const delay = retryDelayMs(response?.headers.get('Retry-After') ?? null, pending ? 2000 : backoff);
    if (delay >= 60_000) onStatus({nextCheckAt: Date.now() + delay});
    else onStatus(pending ? 'pending' : 'reconnecting');
    await waitForRetry(delay, signal);
    backoff = pending ? 1000 : Math.min(backoff * 2, 30_000);
  }
}
