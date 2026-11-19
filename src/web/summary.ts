import { waitForRetry } from './stream';

export const summaryKeys = ['who', 'what', 'when', 'where', 'why', 'how'] as const;
export type Summary = Record<typeof summaryKeys[number], string>;
export type SummaryProgress = 'pending' | 'reconnecting';

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

    if (response?.status === 202) {
      onStatus('pending');
      backoff = 1000;
      await waitForRetry(response.headers.get('Retry-After'), signal);
      continue;
    }
    if (response?.ok) {
      if (!data || summaryKeys.some(key => typeof data[key] !== 'string' || !data[key].trim()))
        throw new Error('本章保存的总结格式不完整。');
      return data;
    }
    if (response && (data?.code === 'SUMMARY_FAILED' ||
        (response.status < 500 && ![408, 425, 429].includes(response.status)))) {
      throw new Error(typeof data?.error === 'string' ? data.error : '无法读取本章总结（HTTP ' + response.status + '）。');
    }

    // GET is read-only. While the panel is open we can safely resume a failed read
    // without resubmitting the background job. Closing it cancels the wait.
    onStatus('reconnecting');
    await waitForRetry(response?.headers.get('Retry-After') ?? null, signal, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
