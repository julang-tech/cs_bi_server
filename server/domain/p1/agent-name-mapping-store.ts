import fs from 'node:fs'
import path from 'node:path'

export type P1AgentMailNameMapping = {
  agent_name: string
  mail_names: string[]
}

export type P1AgentMailNameMappingsPayload = {
  mappings: P1AgentMailNameMapping[]
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function normalizeMapping(mapping: P1AgentMailNameMapping): P1AgentMailNameMapping | null {
  const agentName = mapping.agent_name.trim()
  if (!agentName) return null
  const mailNames = [...new Set(
    mapping.mail_names
      .map((name) => name.trim())
      .filter(Boolean),
  )]
  if (!mailNames.length) return null
  return { agent_name: agentName, mail_names: mailNames }
}

export function normalizeMappingsPayload(
  payload: P1AgentMailNameMappingsPayload,
): P1AgentMailNameMappingsPayload {
  const mappings = payload.mappings
    .map(normalizeMapping)
    .filter((mapping): mapping is P1AgentMailNameMapping => Boolean(mapping))
  return { mappings }
}

export class P1AgentMailNameMappingStore {
  constructor(private readonly filePath: string) {}

  read(): P1AgentMailNameMappingsPayload {
    if (!fs.existsSync(this.filePath)) {
      return { mappings: [] }
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { mappings?: unknown }).mappings)) {
      return { mappings: [] }
    }
    return normalizeMappingsPayload(raw as P1AgentMailNameMappingsPayload)
  }

  write(payload: P1AgentMailNameMappingsPayload): P1AgentMailNameMappingsPayload {
    const normalized = normalizeMappingsPayload(payload)
    ensureParentDir(this.filePath)
    fs.writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`)
    return normalized
  }
}

export function createP1AgentMailNameMappingStore(repoRoot: string) {
  return new P1AgentMailNameMappingStore(
    path.join(repoRoot, 'config', 'data', 'p1-agent-mail-name-mapping.json'),
  )
}
