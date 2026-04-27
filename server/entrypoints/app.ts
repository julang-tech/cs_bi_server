import path from 'node:path'
import fs from 'node:fs'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import { loadEnv } from '../config/env.js'
import { createP3Service } from '../domain/p3/service.js'

const filterSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  grain: z.enum(['day', 'week', 'month']).default('week'),
  sku: z.string().optional(),
  skc: z.string().optional(),
  spu: z.string().optional(),
})

const previewSchema = filterSchema.extend({
  major_issue_type: z.enum(['product', 'warehouse', 'logistics']),
})

export async function buildApp(overrides?: {
  service?: ReturnType<typeof createP3Service>
}) {
  const env = loadEnv()
  const service = overrides?.service ?? createP3Service(env.repoRoot, env.syncConfigPath)
  const app = Fastify({ logger: true })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/api/bi/p3/dashboard', async (request, reply) => {
    const parsed = filterSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(422).send({ detail: parsed.error.flatten() })
    }
    if (parsed.data.date_from > parsed.data.date_to) {
      return reply.status(422).send({ detail: 'date_from cannot be later than date_to.' })
    }
    return service.getDashboard(parsed.data)
  })

  app.get('/api/bi/p3/drilldown-options', async (request, reply) => {
    const parsed = filterSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(422).send({ detail: parsed.error.flatten() })
    }
    if (parsed.data.date_from > parsed.data.date_to) {
      return reply.status(422).send({ detail: 'date_from cannot be later than date_to.' })
    }
    return service.getDrilldownOptions(parsed.data)
  })

  app.get('/api/bi/p3/drilldown-preview', async (request, reply) => {
    const parsed = previewSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(422).send({ detail: parsed.error.flatten() })
    }
    if (parsed.data.date_from > parsed.data.date_to) {
      return reply.status(422).send({ detail: 'date_from cannot be later than date_to.' })
    }
    return service.getDrilldownPreview(parsed.data)
  })

  const distPath = path.join(env.repoRoot, 'dist')
  if (fs.existsSync(distPath)) {
    await app.register(fastifyStatic, {
      root: distPath,
      wildcard: false,
    })

    app.get('/*', async (request, reply) => {
      if (String(request.url).startsWith('/api')) {
        return reply.status(404).send({ message: 'Not Found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return { app, env }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { app, env } = await buildApp()

  await app.listen({
    host: env.host,
    port: env.port,
  })
}
