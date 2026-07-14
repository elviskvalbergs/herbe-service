import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { handleRegisterGet } from './handlers/register'

export async function startFakeErpServer(opts: { port: number }) {
  const app = new Hono()
  app.get('/api/:company/:register', handleRegisterGet)

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
