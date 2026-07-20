import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { handleRegisterGet, handleRegisterPost, handleRegisterPatch } from './handlers/register'
import { createRecordStore, type FakeErpMode } from './store'

export type { FakeErpMode } from './store'

export async function startFakeErpServer(opts: { port: number; mode?: FakeErpMode }) {
  const app = new Hono()
  // One store per server instance — created/updated records and the active
  // failure mode never leak across separate startFakeErpServer() calls.
  const store = createRecordStore()

  app.get('/api/:company/:register', (c) => handleRegisterGet(c, store))
  app.post('/api/:company/:register', (c) => handleRegisterPost(c, store, opts.mode))
  app.patch('/api/:company/:register/:sernr', (c) => handleRegisterPatch(c, store, opts.mode))

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
