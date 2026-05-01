import { METRIC_DEFINITION_GROUPS } from '../../shared/metricDefinitions'

export default function MetricDefinitionsPage() {
  return (
    <main className="metric-doc-shell">
      <header className="metric-doc-hero">
        <span className="eyebrow">Definitions</span>
        <h1>指标口径</h1>
        <p>
          汇总客服 BI 看板的时间、币种、筛选、指标公式和业务归因规则。页面内 KPI 问号提示为简版口径，
          这里作为完整说明。
        </p>
      </header>

      <div className="metric-doc-layout">
        <nav className="metric-doc-toc" aria-label="指标口径目录">
          {METRIC_DEFINITION_GROUPS.map((group) => (
            <a key={group.id} href={`#${group.id}`}>{group.title}</a>
          ))}
        </nav>

        <div className="metric-doc-content">
          {METRIC_DEFINITION_GROUPS.map((group) => (
            <section key={group.id} id={group.id} className="metric-doc-group">
              <header className="metric-doc-group__header">
                <h2>{group.title}</h2>
                <p>{group.description}</p>
              </header>

              {group.sections.map((section) => (
                <section key={section.title} className="metric-doc-section">
                  <h3>{section.title}</h3>
                  <div className="metric-definition-list">
                    {section.items.map((item) => (
                      <article key={item.id} className="metric-definition-item">
                        <div className="metric-definition-item__main">
                          <h4>{item.name}</h4>
                          <p>{item.detail}</p>
                        </div>
                        <div className="metric-definition-item__meta">
                          <span>{item.short}</span>
                          {item.formula ? <code>{item.formula}</code> : null}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </section>
          ))}
        </div>
      </div>
    </main>
  )
}
