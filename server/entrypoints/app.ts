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
import { getSyncCacheStatus } from '../domain/sync/cache-status.js'

const p1FilterSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  grain: z.enum(['day', 'week', 'month']).default('day'),
  agent_name: z.string().default(''),
  tz_offset_minutes: z.coerce.number().int().optional(),
})

const p1BacklogMailSchema = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  grain: z.enum(['day', 'week', 'month']).optional(),
  agent_name: z.string().optional(),
  tz_offset_minutes: z.coerce.number().int().min(-840).max(840),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
  needs_reply: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === true || value === 'true')),
})

const p1NeedsReplyBodySchema = z.object({
  needs_reply: z.boolean(),
  reason: z.string().optional(),
  operator: z.string().optional(),
})

const filterSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  grain: z.enum(['day', 'week', 'month']).default('week'),
  date_basis: z.enum(['record_date', 'order_date', 'refund_date']).default('record_date'),
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
  const app = Fastify({ logger: true })
  const p1Service =
    overrides?.p1Service ??
    createP1Service({
      baseUrl: env.p1ApiBaseUrl,
      apiKey: env.p1ApiKey,
    })
  const service = overrides?.service ?? createP3Service(env.repoRoot, env.syncConfigPath, {
    info: (message) => app.log.info(message),
    warn: (message) => app.log.warn(message),
    error: (message) => app.log.error(message),
  })
  const p2Service = createP2Service()

  app.addHook('onClose', async () => {
    p2Service.close()
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/api/bi/cache-status', async () => getSyncCacheStatus(env.syncConfigPath))

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
        request.log.warn({ err: error }, 'P1 dashboard service is not configured.')
        return reply.status(503).send({ detail: error.message })
      }
      if (error instanceof P1UpstreamError) {
        request.log.warn(
          { err: error, upstream_status: error.statusCode },
          'P1 dashboard upstream request failed.',
        )
        return reply.status(502).send({ detail: error.message })
      }
      throw error
    }
  })

  app.get('/api/bi/p1/backlog-mails', async (request, reply) => {
    const parsed = p1BacklogMailSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ detail: parsed.error.flatten() })
    }
    if (!p1Service.getBacklogMails) {
      return reply.status(501).send({ detail: 'P1 backlog mail list is not configured.' })
    }

    try {
      return await p1Service.getBacklogMails(parsed.data)
    } catch (error) {
      if (error instanceof P1ConfigError) {
        request.log.warn({ err: error }, 'P1 backlog mail list service is not configured.')
        return reply.status(503).send({ detail: error.message })
      }
      if (error instanceof P1UpstreamError) {
        request.log.warn(
          { err: error, upstream_status: error.statusCode },
          'P1 backlog mail list upstream request failed.',
        )
        return reply.status(error.statusCode).send({ detail: error.message })
      }
      throw error
    }
  })

  app.post('/api/bi/p1/backlog-mails/:mail_id/needs-reply', async (request, reply) => {
    const parsed = p1NeedsReplyBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ detail: parsed.error.flatten() })
    }
    const params = request.params as { mail_id: string }
    const mailId = Number(params.mail_id)
    if (!Number.isInteger(mailId)) {
      return reply.status(400).send({ detail: 'mail_id must be an integer.' })
    }
    if (!p1Service.markBacklogMailNeedsReply) {
      return reply.status(501).send({ detail: 'P1 backlog mail marking is not configured.' })
    }

    try {
      return await p1Service.markBacklogMailNeedsReply(
        mailId,
        parsed.data.needs_reply,
        { reason: parsed.data.reason, operator: parsed.data.operator },
      )
    } catch (error) {
      if (error instanceof P1ConfigError) {
        request.log.warn({ err: error }, 'P1 backlog mail marking service is not configured.')
        return reply.status(503).send({ detail: error.message })
      }
      if (error instanceof P1UpstreamError) {
        request.log.warn(
          { err: error, upstream_status: error.statusCode, mail_id: mailId },
          'P1 backlog mail marking upstream request failed.',
        )
        return reply.status(error.statusCode).send({ detail: error.message })
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
