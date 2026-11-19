export function connect(): never {
  throw new Error('cloudflare:sockets connect() is only available inside Cloudflare Workers / workerd.')
}
