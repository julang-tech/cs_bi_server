import { useState } from 'react'
import P1Dashboard from './features/p1/P1Dashboard'
import P2Dashboard from './features/p2/P2Dashboard'
import P3Dashboard from './features/p3/P3Dashboard'

interface PageOption {
  value: 'p1' | 'p2' | 'p3'
  title: string
  description: string
}

const PAGE_OPTIONS: PageOption[] = [
  {
    value: 'p1',
    title: '聊天数据看板',
    description: '查看客服接待规模与响应效率',
  },
  {
    value: 'p2',
    title: '退款情况看板',
    description: '查看退款规模、占比与商品分布',
  },
  {
    value: 'p3',
    title: '客诉总览看板',
    description: '查看销量、客诉量、客诉率和整体问题规模',
  },
]

function PlaceholderPage({ title }: { title: string }) {
  return (
    <main className="placeholder-shell">
      <section className="placeholder-shell__body" aria-label={`${title} 页面占位`} />
    </main>
  )
}

function App() {
  const [activePage, setActivePage] = useState<'p1' | 'p2' | 'p3'>('p1')
  const activePageMeta = PAGE_OPTIONS.find((item) => item.value === activePage) ?? PAGE_OPTIONS[0]

  return (
    <div className="app-shell">
      <aside className="side-nav">
        <div className="side-nav__brand">
          <div className="side-nav__brand-copy">
            <span className="eyebrow">Julang BI</span>
            <strong>客服看板</strong>
          </div>
        </div>
        <nav className="side-nav__menu" aria-label="看板导航">
          {PAGE_OPTIONS.map((page) => (
            <button
              key={page.value}
              type="button"
              className={`side-nav__item ${activePage === page.value ? 'side-nav__item--active' : ''}`}
              onClick={() => setActivePage(page.value)}
            >
              <span className="side-nav__text">
                <strong>{page.title}</strong>
                <small>{page.description}</small>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="app-content">
        {activePage === 'p1' ? (
          <P1Dashboard />
        ) : activePage === 'p3' ? (
          <P3Dashboard />
        ) : activePage === 'p2' ? (
          <P2Dashboard />
        ) : (
          <PlaceholderPage title={activePageMeta.title} />
        )}
      </section>
    </div>
  )
}

export default App
