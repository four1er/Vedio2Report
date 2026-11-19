import { connect as cfConnect } from 'cloudflare:sockets'
import { Tls13Stream, type ByteStream } from './tls13'

export interface ProxyEndpoint {
  host: string
  port: number
  username?: string
  password?: string
}

export type SocketConnector = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'off'; allowHalfOpen: false },
) => ByteStream

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const MAX_RESPONSE_BYTES = 5_000_000

/**
 * Parses proxy endpoints from Webshare format (`host:port:user:pass`) or standard URLs
 * (`http://user:pass@host:port`), separated by newlines, commas, or semicolons.
 */
export function parseProxyList(raw?: string): ProxyEndpoint[] {
  if (!raw?.trim()) return []
  const proxies: ProxyEndpoint[] = []
  const entries = raw
    .split(/[\r\n,;]+/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))

  for (const entry of entries) {
    if (entry.includes('://')) {
      try {
        const parsed = new URL(entry)
        const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
        if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) continue
        proxies.push({
          host: parsed.hostname,
          port,
          username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
          password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        })
      } catch {
        // Ignore malformed entries
      }
      continue
    }

    // Webshare export format: IP:PORT:USERNAME:PASSWORD (or IP:PORT)
    const parts = entry.split(':')
    if (parts.length === 2 || parts.length >= 4) {
      const host = parts[0].trim()
      const port = Number(parts[1])
      if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) continue
      if (parts.length >= 4) {
        proxies.push({
          host,
          port,
          username: parts[2],
          password: parts.slice(3).join(':'),
        })
      } else {
        proxies.push({ host, port })
      }
    }
  }
  return proxies
}

function defaultSocketConnector(
  address: { hostname: string; port: number },
  options: { secureTransport: 'off'; allowHalfOpen: false },
): ByteStream {
  const socket = cfConnect(address, options)
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  let closed = false

  return {
    async read(): Promise<Uint8Array | null> {
      const { value, done } = await reader.read()
      if (done || !value) return null
      return value instanceof Uint8Array ? value : new Uint8Array(value)
    },
    async write(chunk: Uint8Array): Promise<void> {
      await writer.write(chunk)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
      try {
        reader.releaseLock()
      } catch {
        // ignore
      }
      try {
        writer.releaseLock()
      } catch {
        // ignore
      }
      try {
        await socket.close()
      } catch {
        // ignore
      }
    },
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i
    }
  }
  return -1
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Request aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Request aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      val => {
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function withPrepend(base: ByteStream, initial: Uint8Array): ByteStream {
  if (!initial.length) return base
  let pending: Uint8Array | null = initial
  return {
    async read() {
      if (pending) {
        const out = pending
        pending = null
        return out
      }
      return base.read()
    },
    write: chunk => base.write(chunk),
    close: () => base.close(),
  }
}

function decodeChunked(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = []
  let pos = 0
  while (pos < raw.length) {
    let lineEnd = -1
    for (let i = pos; i <= raw.length - 2; i++) {
      if (raw[i] === 13 && raw[i + 1] === 10) {
        lineEnd = i
        break
      }
    }
    if (lineEnd < 0) break
    const sizeText = decoder.decode(raw.subarray(pos, lineEnd)).split(';')[0].trim()
    const chunkSize = parseInt(sizeText, 16)
    if (!Number.isFinite(chunkSize) || chunkSize < 0) {
      throw new Error(`Invalid HTTP chunk size: ${sizeText}`)
    }
    pos = lineEnd + 2
    if (chunkSize === 0) break
    if (pos + chunkSize > raw.length) {
      parts.push(raw.subarray(pos))
      break
    }
    parts.push(raw.subarray(pos, pos + chunkSize))
    pos += chunkSize + 2 // skip trailing CRLF
  }
  return concatBytes(parts)
}

async function decompressBody(body: Uint8Array, encoding: string | null): Promise<Uint8Array> {
  const format = encoding?.trim().toLowerCase()
  if (!format || format === 'identity') return body
  if (format !== 'gzip' && format !== 'deflate') return body
  const ds = new DecompressionStream(format)
  const writer = ds.writable.getWriter()
  const writePromise = writer.write(body as unknown as BufferSource).then(() => writer.close())
  const chunks: Uint8Array[] = []
  const reader = ds.readable.getReader()
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) throw new Error('Decompressed HTTP body exceeds size limit')
        chunks.push(value)
      }
    }
    await writePromise
    return concatBytes(chunks)
  } finally {
    reader.releaseLock()
  }
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function parseHttpResponse(raw: Uint8Array): { status: number; statusText: string; headers: Headers; body: Uint8Array } {
  const headerEnd = findHeaderEnd(raw)
  if (headerEnd < 0) throw new Error('Incomplete HTTP response headers')
  const headerBlock = decoder.decode(raw.subarray(0, headerEnd))
  const lines = headerBlock.split('\r\n')
  const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/.exec(lines[0] ?? '')
  if (!statusMatch) throw new Error(`Invalid HTTP status line: ${lines[0] ?? ''}`)

  const status = Number(statusMatch[1])
  const statusText = statusMatch[2] ?? ''
  const headers = new Headers()
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':')
    if (colon <= 0) continue
    const name = lines[i].slice(0, colon).trim()
    const value = lines[i].slice(colon + 1).trim()
    try {
      headers.append(name, value)
    } catch {
      // ignore invalid header names
    }
  }

  let body = raw.subarray(headerEnd + 4)
  const transferEncoding = headers.get('transfer-encoding')?.toLowerCase() ?? ''
  if (transferEncoding.includes('chunked')) {
    body = decodeChunked(body)
  } else {
    const contentLength = Number(headers.get('content-length'))
    if (Number.isInteger(contentLength) && contentLength >= 0 && body.length > contentLength) {
      body = body.subarray(0, contentLength)
    }
  }
  return { status, statusText, headers, body }
}

function isChunkedComplete(body: Uint8Array): boolean {
  let pos = 0
  while (pos < body.length) {
    let lineEnd = -1
    for (let i = pos; i <= body.length - 2; i++) {
      if (body[i] === 13 && body[i + 1] === 10) {
        lineEnd = i
        break
      }
    }
    if (lineEnd < 0) return false
    const sizeText = decoder.decode(body.subarray(pos, lineEnd)).split(';')[0].trim()
    const chunkSize = parseInt(sizeText, 16)
    if (!Number.isFinite(chunkSize) || chunkSize < 0) return false
    pos = lineEnd + 2
    if (chunkSize === 0) {
      if (pos + 2 <= body.length && body[pos] === 13 && body[pos + 1] === 10) return true
      return findHeaderEnd(body.subarray(Math.max(0, pos - 2))) >= 0
    }
    if (pos + chunkSize + 2 > body.length) return false
    pos += chunkSize + 2
  }
  return false
}

function inspectFraming(headerBytes: Uint8Array): { status: number; chunked: boolean; contentLength: number } {
  const lines = decoder.decode(headerBytes).split('\r\n')
  const status = Number(/^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0)
  let chunked = false
  let contentLength = -1
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':')
    if (colon <= 0) continue
    const key = lines[i].slice(0, colon).trim().toLowerCase()
    const val = lines[i].slice(colon + 1).trim().toLowerCase()
    if (key === 'transfer-encoding' && val.includes('chunked')) chunked = true
    else if (key === 'content-length') contentLength = Number(val)
  }
  return { status, chunked, contentLength }
}

/**
 * Performs a single HTTP/1.1 request to an HTTPS (or HTTP) target through an HTTP CONNECT proxy
 * using Cloudflare Workers TCP Sockets (`cloudflare:sockets`) and native WebCrypto TLS 1.3.
 */
export async function proxyFetch(
  proxy: ProxyEndpoint,
  input: string | URL,
  init: RequestInit = {},
  socketConnector: SocketConnector = defaultSocketConnector,
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input)
  const isHttps = url.protocol === 'https:'
  const targetPort = Number(url.port || (isHttps ? 443 : 80))
  const signal = init.signal ?? undefined

  const tcp = socketConnector({ hostname: proxy.host, port: proxy.port }, { secureTransport: 'off', allowHalfOpen: false })
  let stream: ByteStream = tcp

  const abortHandler = () => {
    void stream.close()
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

  try {
    // 1. Establish HTTP CONNECT tunnel with the forward proxy
    const targetAuthority = `${url.hostname}:${targetPort}`
    const connectLines = [
      `CONNECT ${targetAuthority} HTTP/1.1`,
      `Host: ${targetAuthority}`,
      'Proxy-Connection: Keep-Alive',
    ]
    if (proxy.username !== undefined) {
      const credentials = btoa(`${proxy.username}:${proxy.password ?? ''}`)
      connectLines.push(`Proxy-Authorization: Basic ${credentials}`)
    }
    await withAbort(tcp.write(encoder.encode(connectLines.join('\r\n') + '\r\n\r\n')), signal)

    // 2. Read proxy CONNECT response headers
    let handshakeBuf: Uint8Array = new Uint8Array(0)
    let headerEnd = -1
    while (headerEnd < 0) {
      const chunk = await withAbort(tcp.read(), signal)
      if (!chunk) throw new Error('Proxy closed connection during CONNECT handshake')
      handshakeBuf = concatBytes([handshakeBuf, chunk])
      if (handshakeBuf.length > 16_384) throw new Error('Proxy CONNECT header too large')
      headerEnd = findHeaderEnd(handshakeBuf)
    }
    const statusLine = decoder.decode(handshakeBuf.subarray(0, headerEnd)).split('\r\n')[0] ?? ''
    if (!/^HTTP\/\d\.\d\s+200\b/.test(statusLine)) {
      throw new Error(`Proxy CONNECT rejected (${statusLine})`)
    }
    const leftover = handshakeBuf.subarray(headerEnd + 4)
    const tunnelStream = withPrepend(tcp, leftover)

    // 3. Upgrade tunnel to TLS 1.3 with proper SNI for HTTPS targets
    stream = isHttps ? await withAbort(Tls13Stream.connect(tunnelStream, url.hostname), signal) : tunnelStream

    // 4. Send HTTP/1.1 request over the tunnel
    const method = (init.method ?? 'GET').toUpperCase()
    const path = `${url.pathname || '/'}${url.search}`
    const reqHeaders = new Headers(init.headers)
    reqHeaders.set('Host', url.port ? `${url.hostname}:${url.port}` : url.hostname)
    reqHeaders.set('Connection', 'close')
    if (!reqHeaders.has('Accept-Encoding')) reqHeaders.set('Accept-Encoding', 'gzip')
    if (!reqHeaders.has('Accept')) reqHeaders.set('Accept', '*/*')

    let bodyBytes: Uint8Array | undefined
    if (typeof init.body === 'string') {
      bodyBytes = encoder.encode(init.body)
    } else if (init.body instanceof Uint8Array) {
      bodyBytes = init.body
    } else if (init.body instanceof ArrayBuffer) {
      bodyBytes = new Uint8Array(init.body)
    }
    if (bodyBytes) {
      reqHeaders.set('Content-Length', String(bodyBytes.byteLength))
    }

    const requestLines = [`${method} ${path} HTTP/1.1`]
    reqHeaders.forEach((value, key) => {
      requestLines.push(`${key}: ${sanitizeHeaderValue(value)}`)
    })
    const headBytes = encoder.encode(requestLines.join('\r\n') + '\r\n\r\n')
    await withAbort(stream.write(bodyBytes ? concatBytes([headBytes, bodyBytes]) : headBytes), signal)

    // 5. Read HTTP/1.1 response until complete or EOF
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    let bodyStart = -1
    let framing: { status: number; chunked: boolean; contentLength: number } | null = null

    for (;;) {
      const chunk = await withAbort(stream.read(), signal)
      if (!chunk) break
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        throw new Error('Proxied HTTP response exceeds 5 MB limit')
      }
      chunks.push(chunk)

      if (!framing) {
        const snapshot = concatBytes(chunks)
        const end = findHeaderEnd(snapshot)
        if (end >= 0) {
          bodyStart = end + 4
          framing = inspectFraming(snapshot.subarray(0, end))
          if ([204, 205, 304].includes(framing.status)) break
          if (!framing.chunked && framing.contentLength >= 0 && totalBytes - bodyStart >= framing.contentLength) break
          if (framing.chunked && isChunkedComplete(snapshot.subarray(bodyStart))) break
        }
      } else if (!framing.chunked && framing.contentLength >= 0) {
        if (totalBytes - bodyStart >= framing.contentLength) break
      } else if (framing.chunked) {
        // Chunked terminator always ends with "0\r\n\r\n" (or trailer CRLF CRLF)
        const tail = chunk
        if (tail.length >= 2 && tail[tail.length - 2] === 13 && tail[tail.length - 1] === 10) {
          if (isChunkedComplete(concatBytes(chunks).subarray(bodyStart))) break
        }
      }
    }

    const parsed = parseHttpResponse(concatBytes(chunks))
    const decodedBody = await decompressBody(parsed.body, parsed.headers.get('content-encoding'))
    parsed.headers.delete('content-encoding')
    parsed.headers.delete('transfer-encoding')
    parsed.headers.delete('content-length')

    const responseBody = [204, 205, 304].includes(parsed.status)
      ? null
      : (decodedBody.buffer.slice(
          decodedBody.byteOffset,
          decodedBody.byteOffset + decodedBody.byteLength,
        ) as ArrayBuffer)
    return new Response(responseBody, {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
    })
  } finally {
    signal?.removeEventListener('abort', abortHandler)
    await stream.close()
  }
}

export function createProxyFetcher(
  proxy: ProxyEndpoint,
  socketConnector?: SocketConnector,
): FetchLike {
  return (url, init) => proxyFetch(proxy, url, init, socketConnector)
}
