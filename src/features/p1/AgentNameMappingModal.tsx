import { useEffect, useState } from 'react'
import type { P1AgentMailNameMapping } from '../../api/types'

type DraftMapping = {
  id: string
  agent_name: string
  mail_names_text: string
}

interface AgentNameMappingModalProps {
  mappings: P1AgentMailNameMapping[]
  saving: boolean
  error: string | null
  onClose: () => void
  onSave: (mappings: P1AgentMailNameMapping[]) => void
}

function toDraft(mapping: P1AgentMailNameMapping, index: number): DraftMapping {
  return {
    id: `${mapping.agent_name}-${index}`,
    agent_name: mapping.agent_name,
    mail_names_text: mapping.mail_names.join(', '),
  }
}

function normalizeDrafts(drafts: DraftMapping[]): P1AgentMailNameMapping[] {
  return drafts
    .map((draft) => ({
      agent_name: draft.agent_name.trim(),
      mail_names: [...new Set(
        draft.mail_names_text
          .split(/[,，\n]/)
          .map((name) => name.trim())
          .filter(Boolean),
      )],
    }))
    .filter((mapping) => mapping.agent_name && mapping.mail_names.length)
}

export function AgentNameMappingModal({
  mappings, saving, error, onClose, onSave,
}: AgentNameMappingModalProps) {
  const [drafts, setDrafts] = useState<DraftMapping[]>(() => mappings.map(toDraft))

  useEffect(() => {
    setDrafts(mappings.map(toDraft))
  }, [mappings])

  function updateDraft(id: string, patch: Partial<DraftMapping>) {
    setDrafts((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function addDraft() {
    setDrafts((items) => [
      ...items,
      { id: `new-${Date.now()}-${items.length}`, agent_name: '', mail_names_text: '' },
    ])
  }

  function removeDraft(id: string) {
    setDrafts((items) => items.filter((item) => item.id !== id))
  }

  return (
    <div className="p1-mapping-modal" role="dialog" aria-modal="true" aria-label="客服邮件留名映射配置">
      <div className="p1-mapping-modal__backdrop" onClick={onClose} />
      <section className="p1-mapping-modal__panel">
        <header className="p1-mapping-modal__header">
          <div>
            <h2>映射配置</h2>
            <p>把多个邮件留名合并到一个客服姓名行；未配置的留名会保留原行。</p>
          </div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>

        {error ? <div className="status-banner status-banner--error">{error}</div> : null}

        <div className="p1-mapping-modal__body">
          <div className="p1-mapping-grid p1-mapping-grid--head" aria-hidden="true">
            <span>客服姓名</span>
            <span>邮件留名（多个用逗号分隔）</span>
            <span />
          </div>
          {drafts.length ? drafts.map((draft) => (
            <div className="p1-mapping-grid" key={draft.id}>
              <input
                className="input-control"
                value={draft.agent_name}
                placeholder="例如 Mira"
                onChange={(event) => updateDraft(draft.id, { agent_name: event.target.value })}
              />
              <input
                className="input-control"
                value={draft.mail_names_text}
                placeholder="例如 Mira, Mia"
                onChange={(event) => updateDraft(draft.id, { mail_names_text: event.target.value })}
              />
              <button type="button" className="p1-mapping-modal__ghost" onClick={() => removeDraft(draft.id)}>
                删除
              </button>
            </div>
          )) : (
            <div className="p1-mapping-modal__empty">暂无映射，未配置的邮件留名会按原行展示。</div>
          )}
        </div>

        <footer className="p1-mapping-modal__footer">
          <button type="button" className="p1-mapping-modal__ghost" onClick={addDraft}>新增映射</button>
          <button
            type="button"
            className="p1-mapping-modal__primary"
            disabled={saving}
            onClick={() => onSave(normalizeDrafts(drafts))}
          >
            {saving ? '保存中...' : '保存并刷新'}
          </button>
        </footer>
      </section>
    </div>
  )
}
