/**
 * Minimal RFC 8446 TLS 1.3 client built exclusively on native WebCrypto (crypto.subtle).
 *
 * Why this exists: Cloudflare Workers' `socket.startTls({ expectedServerHostname })`
 * currently omits SNI on production edge when upgrading an IP-connected TCP socket
 * (cloudflare/workerd#6903), causing HTTPS tunnels through IP-based forward proxies
 * (such as Webshare) to fail TLS handshakes in production. Running TLS 1.3 over raw
 * `cloudflare:sockets` via WebCrypto sends proper SNI, verifies the server certificate
 * hostname and handshake signature, and stays well under the Free Tier CPU budget.
 */

export interface ByteStream {
  read(): Promise<Uint8Array | null>
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

interface CipherSpec {
  hash: 'SHA-256' | 'SHA-384'
  hashLen: number
  keyLen: number
}

interface TrafficKeys {
  key: CryptoKey
  iv: Uint8Array
  seq: bigint
}

const MAX_RECORD_PLAINTEXT = 16_384
const HRR_RANDOM_HEX = 'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff])
}

function u24(n: number): Uint8Array {
  return new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

function readU16(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1]
}

function readU24(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2]
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function digest(hash: CipherSpec['hash'], data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(hash, toBuffer(data)))
}

async function hmac(hash: CipherSpec['hash'], keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(keyBytes),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toBuffer(data)))
}

async function hkdfExpandLabel(
  hash: CipherSpec['hash'],
  secret: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const fullLabel = encoder.encode('tls13 ' + label)
  const info = concat(
    u16(length),
    new Uint8Array([fullLabel.length]),
    fullLabel,
    new Uint8Array([context.length]),
    context,
  )
  let prev: Uint8Array = new Uint8Array(0)
  const blocks: Uint8Array[] = []
  let produced = 0
  for (let counter = 1; produced < length; counter++) {
    prev = await hmac(hash, secret, concat(prev, info, new Uint8Array([counter])))
    blocks.push(prev)
    produced += prev.length
  }
  return concat(...blocks).subarray(0, length)
}

async function deriveTrafficKeys(spec: CipherSpec, secret: Uint8Array): Promise<TrafficKeys> {
  const empty = new Uint8Array(0)
  const [rawKey, iv] = await Promise.all([
    hkdfExpandLabel(spec.hash, secret, 'key', empty, spec.keyLen),
    hkdfExpandLabel(spec.hash, secret, 'iv', empty, 12),
  ])
  const key = await crypto.subtle.importKey('raw', toBuffer(rawKey), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
  return { key, iv, seq: 0n }
}

function makeNonce(iv: Uint8Array, seq: bigint): Uint8Array {
  const nonce = iv.slice()
  let value = seq
  for (let i = 11; i >= 4; i--) {
    nonce[i] ^= Number(value & 0xffn)
    value >>= 8n
  }
  return nonce
}

async function encryptRecord(keys: TrafficKeys, innerType: number, content: Uint8Array): Promise<Uint8Array> {
  const inner = concat(content, new Uint8Array([innerType]))
  const encryptedLength = inner.length + 16
  const header = new Uint8Array([0x17, 0x03, 0x03, (encryptedLength >> 8) & 0xff, encryptedLength & 0xff])
  const nonce = makeNonce(keys.iv, keys.seq++)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(header) },
      keys.key,
      toBuffer(inner),
    ),
  )
  return concat(header, ciphertext)
}

async function decryptRecord(
  keys: TrafficKeys,
  header: Uint8Array,
  ciphertext: Uint8Array,
): Promise<{ type: number; content: Uint8Array }> {
  const nonce = makeNonce(keys.iv, keys.seq++)
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(header) },
      keys.key,
      toBuffer(ciphertext),
    ),
  )
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end--
  if (end < 0) throw new Error('TLS 1.3 decrypted record missing content type')
  return { type: plain[end], content: plain.subarray(0, end) }
}

function buildExtension(type: number, body: Uint8Array): Uint8Array {
  return concat(u16(type), u16(body.length), body)
}

function buildClientHello(hostname: string, clientPublicKey: Uint8Array): Uint8Array {
  const random = crypto.getRandomValues(new Uint8Array(32))
  const sessionId = crypto.getRandomValues(new Uint8Array(32))
  const hostBytes = encoder.encode(hostname)
  const sniEntry = concat(new Uint8Array([0x00]), u16(hostBytes.length), hostBytes)
  const sniExt = buildExtension(0x0000, concat(u16(sniEntry.length), sniEntry))

  const supportedVersions = buildExtension(0x002b, new Uint8Array([0x02, 0x03, 0x04]))
  const supportedGroups = buildExtension(0x000a, new Uint8Array([0x00, 0x02, 0x00, 0x17]))
  const sigAlgs = buildExtension(
    0x000d,
    new Uint8Array([
      0x00, 0x0c,
      0x04, 0x03, // ecdsa_secp256r1_sha256
      0x05, 0x03, // ecdsa_secp384r1_sha384
      0x08, 0x04, // rsa_pss_rsae_sha256
      0x08, 0x05, // rsa_pss_rsae_sha384
      0x04, 0x01, // rsa_pkcs1_sha256
      0x05, 0x01, // rsa_pkcs1_sha384
    ]),
  )
  const keyShareEntry = concat(u16(0x0017), u16(clientPublicKey.length), clientPublicKey)
  const keyShare = buildExtension(0x0033, concat(u16(keyShareEntry.length), keyShareEntry))
  const proto = encoder.encode('http/1.1')
  const alpnList = concat(new Uint8Array([proto.length]), proto)
  const alpn = buildExtension(0x0010, concat(u16(alpnList.length), alpnList))

  const extensions = concat(sniExt, supportedVersions, supportedGroups, sigAlgs, keyShare, alpn)
  const body = concat(
    new Uint8Array([0x03, 0x03]),
    random,
    new Uint8Array([sessionId.length]),
    sessionId,
    new Uint8Array([0x00, 0x04, 0x13, 0x01, 0x13, 0x02]),
    new Uint8Array([0x01, 0x00]),
    u16(extensions.length),
    extensions,
  )
  return concat(new Uint8Array([0x01]), u24(body.length), body)
}

// --- Minimal ASN.1 DER helpers for leaf cert SPKI + SAN hostname + ECDSA DER sig ---

interface Asn1Node {
  tag: number
  start: number
  contentStart: number
  end: number
}

function readAsn1(data: Uint8Array, offset: number): Asn1Node {
  if (offset >= data.length) throw new Error('Truncated ASN.1 element')
  const tag = data[offset]
  let pos = offset + 1
  if (pos >= data.length) throw new Error('Truncated ASN.1 length')
  let len = data[pos++]
  if (len & 0x80) {
    const count = len & 0x7f
    if (count === 0 || count > 4 || pos + count > data.length) throw new Error('Invalid ASN.1 length')
    len = 0
    for (let i = 0; i < count; i++) len = (len << 8) | data[pos++]
  }
  const end = pos + len
  if (end > data.length) throw new Error('ASN.1 length out of bounds')
  return { tag, start: offset, contentStart: pos, end }
}

function readChildren(data: Uint8Array, node: Asn1Node): Asn1Node[] {
  const children: Asn1Node[] = []
  let pos = node.contentStart
  while (pos < node.end) {
    const child = readAsn1(data, pos)
    children.push(child)
    pos = child.end
  }
  return children
}

function extractCertInfo(certDer: Uint8Array): { spki: Uint8Array; dnsNames: string[] } {
  const cert = readAsn1(certDer, 0)
  const tbs = readChildren(certDer, cert)[0]
  const fields = readChildren(certDer, tbs)
  let idx = 0
  if (fields[0]?.tag === 0xa0) idx++ // optional version [0]
  // serialNumber(0), signature(1), issuer(2), validity(3), subject(4), subjectPublicKeyInfo(5)
  const spkiNode = fields[idx + 5]
  if (!spkiNode) throw new Error('Certificate missing SubjectPublicKeyInfo')
  const spki = certDer.slice(spkiNode.start, spkiNode.end)

  const dnsNames: string[] = []
  const extWrapper = fields.find(f => f.tag === 0xa3)
  if (extWrapper) {
    const extSeq = readAsn1(certDer, extWrapper.contentStart)
    for (const ext of readChildren(certDer, extSeq)) {
      const parts = readChildren(certDer, ext)
      if (parts.length < 2) continue
      const oidBytes = certDer.subarray(parts[0].contentStart, parts[0].end)
      // OID 2.5.29.17 (subjectAltName) => 55 1d 11
      if (oidBytes.length === 3 && oidBytes[0] === 0x55 && oidBytes[1] === 0x1d && oidBytes[2] === 0x11) {
        const octet = parts[parts.length - 1]
        const sanSeq = readAsn1(certDer, octet.contentStart)
        for (const name of readChildren(certDer, sanSeq)) {
          if (name.tag === 0x82) {
            dnsNames.push(decoder.decode(certDer.subarray(name.contentStart, name.end)).toLowerCase())
          }
        }
      }
    }
  }
  return { spki, dnsNames }
}

function hostnameMatches(hostname: string, dnsNames: string[]): boolean {
  const target = hostname.toLowerCase()
  for (const pattern of dnsNames) {
    if (pattern === target) return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // ".example.com"
      if (target.endsWith(suffix) && !target.slice(0, target.length - suffix.length).includes('.')) {
        return true
      }
    }
  }
  return false
}

function derEcdsaToRaw(derSig: Uint8Array, coordLen: number): Uint8Array {
  const seq = readAsn1(derSig, 0)
  const [rNode, sNode] = readChildren(derSig, seq)
  if (!rNode || !sNode) throw new Error('Invalid DER ECDSA signature')
  const raw = new Uint8Array(coordLen * 2)
  const copyInt = (node: Asn1Node, destOffset: number) => {
    let bytes = derSig.subarray(node.contentStart, node.end)
    while (bytes.length > coordLen && bytes[0] === 0) bytes = bytes.subarray(1)
    if (bytes.length > coordLen) throw new Error('ECDSA integer wider than curve coordinate')
    raw.set(bytes, destOffset + (coordLen - bytes.length))
  }
  copyInt(rNode, 0)
  copyInt(sNode, coordLen)
  return raw
}

async function verifyCertificateSignature(
  spki: Uint8Array,
  scheme: number,
  signature: Uint8Array,
  transcriptHash: Uint8Array,
): Promise<void> {
  const contextLabel = encoder.encode('TLS 1.3, server CertificateVerify\x00')
  const signedData = concat(new Uint8Array(64).fill(0x20), contextLabel, transcriptHash)

  let importAlgo: SubtleCryptoImportKeyAlgorithm
  let verifyAlgo: Parameters<SubtleCrypto['verify']>[0]
  let sigBytes = signature

  switch (scheme) {
    case 0x0403: // ecdsa_secp256r1_sha256
      importAlgo = { name: 'ECDSA', namedCurve: 'P-256' }
      verifyAlgo = { name: 'ECDSA', hash: 'SHA-256' }
      sigBytes = derEcdsaToRaw(signature, 32)
      break
    case 0x0503: // ecdsa_secp384r1_sha384
      importAlgo = { name: 'ECDSA', namedCurve: 'P-384' }
      verifyAlgo = { name: 'ECDSA', hash: 'SHA-384' }
      sigBytes = derEcdsaToRaw(signature, 48)
      break
    case 0x0804: // rsa_pss_rsae_sha256
      importAlgo = { name: 'RSA-PSS', hash: 'SHA-256' }
      verifyAlgo = { name: 'RSA-PSS', saltLength: 32 }
      break
    case 0x0805: // rsa_pss_rsae_sha384
      importAlgo = { name: 'RSA-PSS', hash: 'SHA-384' }
      verifyAlgo = { name: 'RSA-PSS', saltLength: 48 }
      break
    case 0x0401: // rsa_pkcs1_sha256
      importAlgo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      verifyAlgo = { name: 'RSASSA-PKCS1-v1_5' }
      break
    case 0x0501: // rsa_pkcs1_sha384
      importAlgo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }
      verifyAlgo = { name: 'RSASSA-PKCS1-v1_5' }
      break
    default:
      throw new Error(`Unsupported TLS CertificateVerify scheme: 0x${scheme.toString(16)}`)
  }

  const key = await crypto.subtle.importKey('spki', toBuffer(spki), importAlgo, false, ['verify'])
  const valid = await crypto.subtle.verify(verifyAlgo, key, toBuffer(sigBytes), toBuffer(signedData))
  if (!valid) throw new Error('TLS server CertificateVerify signature check failed')
}

// --- Buffered TCP reader for exact TLS record framing ---

class BufferedReader {
  private buf: Uint8Array = new Uint8Array(0)
  private eof = false

  constructor(private readonly transport: ByteStream) {}

  async readExact(count: number): Promise<Uint8Array | null> {
    while (this.buf.length < count) {
      if (this.eof) return null
      const chunk = await this.transport.read()
      if (!chunk || chunk.length === 0) {
        this.eof = true
        if (this.buf.length === 0) return null
        throw new Error('Unexpected EOF mid-TLS record')
      }
      this.buf = concat(this.buf, chunk)
    }
    const out = this.buf.slice(0, count)
    this.buf = this.buf.slice(count)
    return out
  }

  async readRecord(): Promise<{ type: number; header: Uint8Array; payload: Uint8Array } | null> {
    const header = await this.readExact(5)
    if (!header) return null
    const length = readU16(header, 3)
    if (length > 18_432) throw new Error(`TLS record too large: ${length}`)
    const payload = await this.readExact(length)
    if (!payload) throw new Error('Unexpected EOF reading TLS record payload')
    return { type: header[0], header, payload }
  }
}

export class Tls13Stream implements ByteStream {
  private closed = false

  private constructor(
    private readonly transport: ByteStream,
    private readonly reader: BufferedReader,
    private readonly clientApp: TrafficKeys,
    private readonly serverApp: TrafficKeys,
  ) {}

  static async connect(transport: ByteStream, hostname: string): Promise<Tls13Stream> {
    const reader = new BufferedReader(transport)

    // 1. Generate ephemeral P-256 ECDH keypair and send ClientHello
    const clientKeys = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )) as CryptoKeyPair
    const clientPubRaw = new Uint8Array(
      (await crypto.subtle.exportKey('raw', clientKeys.publicKey)) as ArrayBuffer,
    )
    const clientHello = buildClientHello(hostname, clientPubRaw)
    const chRecord = concat(new Uint8Array([0x16, 0x03, 0x01]), u16(clientHello.length), clientHello)
    await transport.write(chRecord)

    const transcriptParts: Uint8Array[] = [clientHello]

    // 2. Read ServerHello
    let serverHelloMsg: Uint8Array | null = null
    let hsBuffer: Uint8Array = new Uint8Array(0)
    while (!serverHelloMsg) {
      const rec = await reader.readRecord()
      if (!rec) throw new Error('Connection closed before ServerHello')
      if (rec.type === 0x15) {
        throw new Error(`TLS alert during handshake: level=${rec.payload[0]} desc=${rec.payload[1]}`)
      }
      if (rec.type !== 0x16) continue
      hsBuffer = concat(hsBuffer, rec.payload)
      if (hsBuffer.length >= 4) {
        const hsLen = readU24(hsBuffer, 1)
        if (hsBuffer.length >= 4 + hsLen) {
          serverHelloMsg = hsBuffer.slice(0, 4 + hsLen)
          hsBuffer = hsBuffer.slice(4 + hsLen)
        }
      }
    }
    if (serverHelloMsg[0] !== 0x02) {
      throw new Error(`Expected ServerHello (0x02), got 0x${serverHelloMsg[0].toString(16)}`)
    }
    transcriptParts.push(serverHelloMsg)

    const shBody = serverHelloMsg.subarray(4)
    const serverRandom = shBody.subarray(2, 34)
    if (toHex(serverRandom) === HRR_RANDOM_HEX) {
      throw new Error('Server requested TLS HelloRetryRequest for P-256')
    }
    let pos = 34
    const sidLen = shBody[pos++]
    pos += sidLen
    const cipherSuite = readU16(shBody, pos)
    pos += 2
    pos += 1 // compression method
    const spec: CipherSpec =
      cipherSuite === 0x1301
        ? { hash: 'SHA-256', hashLen: 32, keyLen: 16 }
        : cipherSuite === 0x1302
          ? { hash: 'SHA-384', hashLen: 48, keyLen: 32 }
          : (() => {
              throw new Error(`Unsupported TLS 1.3 cipher suite: 0x${cipherSuite.toString(16)}`)
            })()

    const extEnd = pos + 2 + readU16(shBody, pos)
    pos += 2
    let tls13Confirmed = false
    let serverPubBytes: Uint8Array | null = null
    while (pos + 4 <= extEnd) {
      const extType = readU16(shBody, pos)
      const extLen = readU16(shBody, pos + 2)
      const extData = shBody.subarray(pos + 4, pos + 4 + extLen)
      pos += 4 + extLen
      if (extType === 0x002b && extLen === 2 && readU16(extData, 0) === 0x0304) {
        tls13Confirmed = true
      } else if (extType === 0x0033 && extLen >= 4) {
        const group = readU16(extData, 0)
        const keyLen = readU16(extData, 2)
        if (group === 0x0017 && keyLen === 65) {
          serverPubBytes = extData.subarray(4, 4 + keyLen)
        }
      }
    }
    if (!tls13Confirmed || !serverPubBytes) {
      throw new Error('ServerHello did not negotiate TLS 1.3 with P-256 key_share')
    }

    // 3. Derive handshake traffic keys
    const serverPubKey = await crypto.subtle.importKey(
      'raw',
      toBuffer(serverPubBytes),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: serverPubKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
        clientKeys.privateKey,
        256,
      ),
    )

    const zeros = new Uint8Array(spec.hashLen)
    const empty = new Uint8Array(0)
    const emptyHash = await digest(spec.hash, empty)
    const earlySecret = await hmac(spec.hash, zeros, zeros)
    const derived1 = await hkdfExpandLabel(spec.hash, earlySecret, 'derived', emptyHash, spec.hashLen)
    const handshakeSecret = await hmac(spec.hash, derived1, sharedSecret)

    const chShHash = await digest(spec.hash, concat(...transcriptParts))
    const clientHsSecret = await hkdfExpandLabel(spec.hash, handshakeSecret, 'c hs traffic', chShHash, spec.hashLen)
    const serverHsSecret = await hkdfExpandLabel(spec.hash, handshakeSecret, 's hs traffic', chShHash, spec.hashLen)

    const [clientHsKeys, serverHsKeys] = await Promise.all([
      deriveTrafficKeys(spec, clientHsSecret),
      deriveTrafficKeys(spec, serverHsSecret),
    ])

    // 4. Read encrypted server flight: EncryptedExtensions, Certificate, CertificateVerify, Finished
    let leafSpki: Uint8Array | null = null
    let certVerified = false
    let serverFinished = false
    let encHsBuf: Uint8Array = new Uint8Array(0)

    while (!serverFinished) {
      const rec = await reader.readRecord()
      if (!rec) throw new Error('Connection closed during encrypted TLS handshake')
      if (rec.type === 0x14) continue // middlebox ChangeCipherSpec
      if (rec.type === 0x15) {
        throw new Error(`TLS plaintext alert: level=${rec.payload[0]} desc=${rec.payload[1]}`)
      }
      if (rec.type !== 0x17) continue
      const inner = await decryptRecord(serverHsKeys, rec.header, rec.payload)
      if (inner.type === 0x15) {
        throw new Error(`TLS alert: level=${inner.content[0]} desc=${inner.content[1]}`)
      }
      if (inner.type !== 0x16) continue
      encHsBuf = concat(encHsBuf, inner.content)

      while (encHsBuf.length >= 4) {
        const hsType = encHsBuf[0]
        const hsLen = readU24(encHsBuf, 1)
        if (encHsBuf.length < 4 + hsLen) break
        const rawMsg = encHsBuf.slice(0, 4 + hsLen)
        const msgBody = rawMsg.subarray(4)
        encHsBuf = encHsBuf.slice(4 + hsLen)

        if (hsType === 0x0b) {
          // Certificate message: context_len(1) + context + cert_list_len(3) + [cert_len(3) + der + ext_len(2) + ext]...
          let cPos = 1 + msgBody[0]
          cPos += 3 // cert_list_len
          const leafLen = readU24(msgBody, cPos)
          const leafDer = msgBody.subarray(cPos + 3, cPos + 3 + leafLen)
          const { spki, dnsNames } = extractCertInfo(leafDer)
          if (dnsNames.length > 0 && !hostnameMatches(hostname, dnsNames)) {
            throw new Error(`TLS certificate hostname mismatch for ${hostname}`)
          }
          leafSpki = spki
          transcriptParts.push(rawMsg)
        } else if (hsType === 0x0f) {
          // CertificateVerify: verify against transcript BEFORE this message
          if (!leafSpki) throw new Error('Received CertificateVerify before Certificate')
          const scheme = readU16(msgBody, 0)
          const sigLen = readU16(msgBody, 2)
          const sig = msgBody.subarray(4, 4 + sigLen)
          const preVerifyHash = await digest(spec.hash, concat(...transcriptParts))
          await verifyCertificateSignature(leafSpki, scheme, sig, preVerifyHash)
          certVerified = true
          transcriptParts.push(rawMsg)
        } else if (hsType === 0x14) {
          // Server Finished
          if (!certVerified) throw new Error('TLS server did not complete CertificateVerify')
          const preFinHash = await digest(spec.hash, concat(...transcriptParts))
          const finishedKey = await hkdfExpandLabel(spec.hash, serverHsSecret, 'finished', empty, spec.hashLen)
          const expected = await hmac(spec.hash, finishedKey, preFinHash)
          if (!equalBytes(msgBody, expected)) {
            throw new Error('TLS server Finished MAC verification failed')
          }
          transcriptParts.push(rawMsg)
          serverFinished = true
          break
        } else {
          transcriptParts.push(rawMsg)
        }
      }
    }

    // 5. Derive application traffic keys & send Client Finished
    const serverFinHash = await digest(spec.hash, concat(...transcriptParts))
    const derived2 = await hkdfExpandLabel(spec.hash, handshakeSecret, 'derived', emptyHash, spec.hashLen)
    const masterSecret = await hmac(spec.hash, derived2, zeros)
    const clientAppSecret = await hkdfExpandLabel(spec.hash, masterSecret, 'c ap traffic', serverFinHash, spec.hashLen)
    const serverAppSecret = await hkdfExpandLabel(spec.hash, masterSecret, 's ap traffic', serverFinHash, spec.hashLen)

    const [clientApp, serverApp, clientFinishedKey] = await Promise.all([
      deriveTrafficKeys(spec, clientAppSecret),
      deriveTrafficKeys(spec, serverAppSecret),
      hkdfExpandLabel(spec.hash, clientHsSecret, 'finished', empty, spec.hashLen),
    ])

    const clientVerifyData = await hmac(spec.hash, clientFinishedKey, serverFinHash)
    const clientFinishedMsg = concat(new Uint8Array([0x14]), u24(clientVerifyData.length), clientVerifyData)
    const clientFinishedRec = await encryptRecord(clientHsKeys, 0x16, clientFinishedMsg)
    await transport.write(clientFinishedRec)

    return new Tls13Stream(transport, reader, clientApp, serverApp)
  }

  async write(data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.length; offset += MAX_RECORD_PLAINTEXT) {
      const slice = data.subarray(offset, Math.min(offset + MAX_RECORD_PLAINTEXT, data.length))
      const record = await encryptRecord(this.clientApp, 0x17, slice)
      await this.transport.write(record)
    }
  }

  async read(): Promise<Uint8Array | null> {
    if (this.closed) return null
    for (;;) {
      const rec = await this.reader.readRecord()
      if (!rec) return null
      if (rec.type === 0x14) continue
      if (rec.type === 0x15) {
        this.closed = true
        return null
      }
      if (rec.type !== 0x17) continue
      const inner = await decryptRecord(this.serverApp, rec.header, rec.payload)
      if (inner.type === 0x17) return inner.content
      if (inner.type === 0x16) continue // post-handshake NewSessionTicket, etc.
      if (inner.type === 0x15) {
        this.closed = true
        if (inner.content[1] === 0) return null // close_notify
        throw new Error(`TLS alert: level=${inner.content[0]} desc=${inner.content[1]}`)
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      const closeNotify = await encryptRecord(this.clientApp, 0x15, new Uint8Array([0x01, 0x00]))
      await this.transport.write(closeNotify)
    } catch {
      // Ignore write failures when tearing down an already-closed socket.
    }
    await this.transport.close()
  }
}
