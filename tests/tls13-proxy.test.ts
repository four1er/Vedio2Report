import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { buildSync } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseProxyList, proxyFetch, type SocketConnector } from '../src/worker/proxy-http'
import type { ByteStream } from '../src/worker/tls13'

function createSelfSignedCert(dir: string, keyArgs: string[], sanDns: string) {
  const keyPath = path.join(dir, `${sanDns}-${keyArgs[1]}.key`)
  const certPath = path.join(dir, `${sanDns}-${keyArgs[1]}.crt`)
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    ...keyArgs,
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    `/CN=${sanDns}`,
    '-addext',
    `subjectAltName=DNS:${sanDns},DNS:*.youtube.com`,
  ], { stdio: 'ignore' })
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  }
}

function nodeSocketConnector(): SocketConnector {
  return ({ hostname, port }) => {
    const sock = net.connect({ host: hostname, port })
    const queue: Array<Uint8Array | null> = []
    let waiter: ((v: Uint8Array | null) => void) | null = null
    let failed: Error | null = null

    const push = (val: Uint8Array | null) => {
      if (waiter) {
        const resolve = waiter
        waiter = null
        resolve(val)
      } else {
        queue.push(val)
      }
    }
    sock.on('data', chunk => push(new Uint8Array(chunk)))
    sock.on('end', () => push(null))
    sock.on('close', () => push(null))
    sock.on('error', err => {
      failed = err
      push(null)
    })

    const stream: ByteStream = {
      async read() {
        if (failed) throw failed
        if (queue.length > 0) return queue.shift()!
        return await new Promise<Uint8Array | null>(resolve => {
          waiter = resolve
        })
      },
      async write(chunk) {
        await new Promise<void>((resolve, reject) => {
          sock.write(chunk, err => (err ? reject(err) : resolve()))
        })
      },
      async close() {
        sock.destroy()
      },
    }
    return stream
  }
}

function startMockConnectProxy(targetPort: number, expectedAuth: string) {
  const sockets = new Set<net.Socket>()
  const server = net.createServer(client => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    let head = ''
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      client.off('data', onData)
      const lines = head.slice(0, end).split('\r\n')
      const authHeader = lines.find(l => l.toLowerCase().startsWith('proxy-authorization:'))
      const provided = authHeader?.slice(authHeader.indexOf(':') + 1).trim()
      if (provided !== `Basic ${Buffer.from(expectedAuth).toString('base64')}`) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
        sockets.add(upstream)
        upstream.on('close', () => sockets.delete(upstream))
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const extra = Buffer.from(head.slice(end + 4), 'latin1')
        if (extra.length) upstream.write(extra)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    }
    client.on('data', onData)
  })
  return new Promise<{ server: net.Server; port: number; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>(done => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

describe('Webshare proxy parser', () => {
  it('parses Webshare IP:PORT:USER:PASS and URL formats cleanly', () => {
    const raw = `
      # Webshare 10 proxies export
      31.59.20.176:6754:userone:pass:with:colon
      http://alice:secret@10.0.0.2:8080, 192.168.1.5:3128
      not-a-proxy
    `
    expect(parseProxyList(raw)).toEqual([
      { host: '31.59.20.176', port: 6754, username: 'userone', password: 'pass:with:colon' },
      { host: '10.0.0.2', port: 8080, username: 'alice', password: 'secret' },
      { host: '192.168.1.5', port: 3128 },
    ])
  })
})

describe('HTTP CONNECT + pure WebCrypto TLS 1.3 client', () => {
  let certDir = ''
  let ecServer!: https.Server
  let ecPort = 0
  let rsaServer!: https.Server
  let rsaPort = 0
  let ecProxy!: { server: net.Server; port: number; close: () => Promise<void> }
  let rsaProxy!: { server: net.Server; port: number; close: () => Promise<void> }
  let lastSni = ''

  beforeAll(async () => {
    certDir = mkdtempSync(path.join(tmpdir(), 'vedio2report-tls-'))
    const ecCert = createSelfSignedCert(certDir, ['ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'], 'www.youtube.com')
    const rsaCert = createSelfSignedCert(certDir, ['rsa:2048'], 'www.youtube.com')

    ecServer = https.createServer(
      {
        key: ecCert.key,
        cert: ecCert.cert,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ciphers: 'TLS_AES_128_GCM_SHA256',
        SNICallback(servername, cb) {
          lastSni = servername
          cb(null, null as never)
        },
      },
      (req, res) => {
        const bigPayload = JSON.stringify({ ok: true, sni: lastSni, path: req.url, pad: 'A'.repeat(40_000) })
        const gz = gzipSync(Buffer.from(bigPayload))
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Transfer-Encoding': 'chunked',
        })
        res.write(gz.subarray(0, 500))
        res.end(gz.subarray(500))
      },
    )
    await new Promise<void>(resolve => ecServer.listen(0, '127.0.0.1', resolve))
    ecPort = (ecServer.address() as net.AddressInfo).port

    rsaServer = https.createServer(
      {
        key: rsaCert.key,
        cert: rsaCert.cert,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ciphers: 'TLS_AES_256_GCM_SHA384',
      },
      (req, res) => {
        let body = ''
        req.on('data', d => {
          body += d.toString()
        })
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ method: req.method, received: JSON.parse(body) }))
        })
      },
    )
    await new Promise<void>(resolve => rsaServer.listen(0, '127.0.0.1', resolve))
    rsaPort = (rsaServer.address() as net.AddressInfo).port

    ecProxy = await startMockConnectProxy(ecPort, 'wsuser:wspass')
    rsaProxy = await startMockConnectProxy(rsaPort, 'wsuser:wspass')
  })

  afterAll(async () => {
    ecServer.closeAllConnections()
    rsaServer.closeAllConnections()
    await Promise.all([
      ecProxy.close(),
      rsaProxy.close(),
      new Promise(r => ecServer.close(r)),
      new Promise(r => rsaServer.close(r)),
    ])
    rmSync(certDir, { recursive: true, force: true })
  })

  it('tunnels HTTPS GET over HTTP CONNECT with ECDSA P-256 TLS 1.3, proper SNI, gzip & chunked decoding', async () => {
    const res = await proxyFetch(
      { host: '127.0.0.1', port: ecProxy.port, username: 'wsuser', password: 'wspass' },
      'https://www.youtube.com/watch?v=xRh2sVcNXQ8',
      {},
      nodeSocketConnector(),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { ok: boolean; sni: string; path: string; pad: string }
    expect(data.ok).toBe(true)
    expect(data.sni).toBe('www.youtube.com')
    expect(data.path).toBe('/watch?v=xRh2sVcNXQ8')
    expect(data.pad.length).toBe(40_000)
  })

  it('tunnels HTTPS POST over HTTP CONNECT with RSA-2048 TLS_AES_256_GCM_SHA384', async () => {
    const res = await proxyFetch(
      { host: '127.0.0.1', port: rsaProxy.port, username: 'wsuser', password: 'wspass' },
      'https://www.youtube.com/youtubei/v1/player',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: 'xRh2sVcNXQ8' }),
      },
      nodeSocketConnector(),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: 'POST', received: { videoId: 'xRh2sVcNXQ8' } })
  })

  it('rejects certificate SAN hostname mismatch', async () => {
    await expect(
      proxyFetch(
        { host: '127.0.0.1', port: ecProxy.port, username: 'wsuser', password: 'wspass' },
        'https://wrong.example.com/',
        {},
        nodeSocketConnector(),
      ),
    ).rejects.toThrow(/hostname mismatch/i)
  })

  it('rejects invalid proxy credentials (407)', async () => {
    await expect(
      proxyFetch(
        { host: '127.0.0.1', port: ecProxy.port, username: 'wsuser', password: 'wrong' },
        'https://www.youtube.com/',
        {},
        nodeSocketConnector(),
      ),
    ).rejects.toThrow(/407/)
  })

  it('runs real cloudflare:sockets connect() + TLS 1.3 inside workerd (Miniflare)', async () => {
    const entry = `
      import { proxyFetch } from './src/worker/proxy-http.ts';
      export default {
        async fetch(request) {
          const url = new URL(request.url);
          const port = Number(url.searchParams.get('port'));
          const res = await proxyFetch(
            { host: '127.0.0.1', port, username: 'wsuser', password: 'wspass' },
            'https://www.youtube.com/watch?v=test1234567'
          );
          return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
        }
      };
    `
    const built = buildSync({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2022',
      external: ['cloudflare:sockets'],
    })

    const mf = new Miniflare(
      convertV4MiniflareOptions({
        host: '127.0.0.1',
        cf: false,
        compatibilityDate: '2026-06-01',
        modules: true,
        script: built.outputFiles[0].text,
      }),
    )
    try {
      const response = await mf.dispatchFetch(`https://local.test/?port=${ecProxy.port}`)
      expect(response.status).toBe(200)
      const data = (await response.json()) as { ok: boolean; sni: string; path: string }
      expect(data.ok).toBe(true)
      expect(data.sni).toBe('www.youtube.com')
      expect(data.path).toBe('/watch?v=test1234567')
    } finally {
      await mf.dispose()
    }
  })
})
