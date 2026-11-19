import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:sockets': path.resolve(__dirname, 'tests/sockets-stub.ts'),
    },
  },
})
