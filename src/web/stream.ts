export async function* events(response: Response) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('服务器未返回生成流，请重试。');
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const lines = buffer.slice(0, separator.index).split(/\r?\n/);
        buffer = buffer.slice(separator.index + separator[0].length);
        const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (type && data) yield { type, data: JSON.parse(data) };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function responseError(response: Response, fallback: string) {
  const json = await response.json().catch(() => null);
  return new Error(typeof json?.error === 'string' ? json.error : fallback + '（HTTP ' + response.status + '）');
}

export function waitForRetry(retryAfter: string | null, signal: AbortSignal, defaultDelay = 2000) {
  const retryMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter || '') - Date.now();
  const delay = Number.isFinite(retryMs) ? Math.min(2147483647, Math.max(1000, retryMs)) : defaultDelay;
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, delay);
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, {once: true});
  });
}
