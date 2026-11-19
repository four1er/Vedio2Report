export interface SseEvent {
  type: string
  data: unknown
}

export async function* parseSseEvents(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('服务器未返回流式响应，请稍后重试。')
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let sep: RegExpExecArray | null
      while ((sep = /\r?\n\r?\n/.exec(buffer))) {
        const lines = buffer.slice(0, sep.index).split(/\r?\n/)
        buffer = buffer.slice(sep.index + sep[0].length)
        const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
        const data = lines
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (type && data) {
          yield { type, data: JSON.parse(data) }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function readResponseError(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return new Error(payload.error.trim())
  }
  return new Error(`${fallback}（HTTP ${response.status}）`)
}
