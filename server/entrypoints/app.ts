import path from 'node:path'
import fs from 'node:fs'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import { loadEnv } from '../config/env.js'
import {
  createP1Service,
  P1ConfigError,
  P1UpstreamError,
  type P1DashboardService,
} from '../domain/p1/service.js'
import { createP3Service } from '../domain/p3/service.js'
import { createP2Service } from '../domain/p2/service.js'

const p1FilterSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  grain: z.enum(['day', 'week', 'month']).default('day'),
  agent_name: z.string().default(''),
})

const filterSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  grain: z.enum(['day', 'week', 'month']).default('week'),
  date_basis: z.enum(['order_date', 'refund_date']).default('order_date'),
  sku: z.string().optional(),
  skc: z.string().optional(),
  spu: z.string().optional(),
})

const previewSchema = filterSchema.extend({
  major_issue_type: z.enum(['product', 'warehouse', 'logistics']),
})

const p2FilterSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  grain: z.enum(['day', 'week', 'month']).default('month'),
  category: z.string().optional(),
  spu: z.string().optional(),
  skc: z.string().optional(),
  channel: z.string().optional(),
  listing_date_from: z.string().optional(),
  listing_date_to: z.string().optional(),
  spu_list: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (Array.isArray(v) ? v : v ? [v] : [])),
  skc_list: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (Array.isArray(v) ? v : v ? [v] : [])),
})

const p2SpuTableSchema = p2FilterSchema.extend({
  top_n: z.coerce.number().int().min(1).max(500).default(20),
})

export async function buildApp(overrides?: {
  service?: ReturnType<typeof createP3Service>
  p1Service?: P1DashboardService
}) {
  const env = loadEnv()
  const p1Service =
    overrides?.p1Service ??
    createP1Service({
      baseUrl: env.p1ApiBaseUrl,
      apiKey: env.p1ApiKey,
    })
  const service = overrides?.service ?? createP3Service(env.repoRoot, env.syncConfigPath)
  const p2Service = createP2Service()
  const app = Fastify({ logger: true })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/api/bi/p1/dashboard', async (request, reply) => {
    const parsed = p1FilterSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(422).send({ detail: parsed.error.flatten() })
    }
    if (parsed.data.date_from > parsed.data.date_to) {
      return reply.status(422).send({ detail: 'date_from cannot be later than date_to.' })
    }

    try {
      return await p1Service.getDashboard(parsed.data)
    } catch (error) {
      if (error instanceof P1ConfigError) {
        return reply.status(503).send({ detail: error.message })
      }
      if (error instanceof P1UpstreamError) {
        return reply.status(502).send({ detail: error.message })
      }
      throw error
    }
  })

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

  app.get('/api/bi/p3/product-ranking', async (request, reply) => {
    const parsed = filterSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(422).send({ detail: parsed.error.flatten() })
    }
    if (parsed.data.date_from > parsed.data.date_to) {
      return reply.status(422).send({ detail: 'date_from cannot be later than date_to.' })
    }
    return service.getProductRanking(parsed.data)
  })

  app.get('/api/bi/p2/refund-dashboard/overview', async (request, reply) => {
    const parsed = p2FilterSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(422).send({ detail: parsed.error.flatten() })
    }
    if (parsed.data.date_from > parsed.data.date_to) {
      return reply.status(422).send({ detail: 'date_from cannot be later than date_to.' })
    }
    if (
      parsed.data.listing_date_from &&
      parsed.data.listing_date_to &&
      parsed.data.listing_date_from > parsed.data.listing_date_to
    ) {
      return reply.status(422).send({
        detail: 'listing_date_from cannot be later than listing_date_to.',
      })
    }
    return p2Service.getOverview(parsed.data)
  })

  app.get('/api/bi/p2/refund-dashboard/spu-table', async (request, reply) => {
    const parsed = p2SpuTableSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(422).send({ detail: parsed.error.flatten() })
    }
    if (parsed.data.date_from > parsed.data.date_to) {
      return reply.status(422).send({ detail: 'date_from cannot be later than date_to.' })
    }
    if (
      parsed.data.listing_date_from &&
      parsed.data.listing_date_to &&
      parsed.data.listing_date_from > parsed.data.listing_date_to
    ) {
      return reply.status(422).send({
        detail: 'listing_date_from cannot be later than listing_date_to.',
      })
    }
    return p2Service.getSpuTable(parsed.data, parsed.data.top_n)
  })

  app.get('/api/bi/p2/refund-dashboard/spu-skc-options', async (request, reply) => {
    const parsed = p2FilterSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(422).send({ detail: parsed.error.flatten() })
    }
    if (parsed.data.date_from > parsed.data.date_to) {
      return reply.status(422).send({ detail: 'date_from cannot be later than date_to.' })
    }
    if (
      parsed.data.listing_date_from &&
      parsed.data.listing_date_to &&
      parsed.data.listing_date_from > parsed.data.listing_date_to
    ) {
      return reply.status(422).send({
        detail: 'listing_date_from cannot be later than listing_date_to.',
      })
    }
    return p2Service.getSpuSkcOptions(parsed.data)
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
