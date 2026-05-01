import { useState } from 'react'
import './App.css'
import P1Dashboard from './features/p1/legacy/P1Dashboard'
import P2Dashboard from './features/p2/legacy/P2Dashboard'
import P3Dashboard from './features/p3/P3Dashboard'

interface PageOption {
  value: 'p1' | 'p2' | 'p3'
  shortTitle: string
  title: string
  description: string
}

const PAGE_OPTIONS: PageOption[] = [
  {
    value: 'p1',
    shortTitle: 'P1',
    title: '聊天数据看板',
    description: '查看客服接待规模与响应效率',
  },
  {
    value: 'p2',
    shortTitle: 'P2',
    title: '退款情况看板',
    description: '查看退款规模、占比与商品分布',
  },
  {
    value: 'p3',
    shortTitle: 'P3',
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(true)
  const activePageMeta = PAGE_OPTIONS.find((item) => item.value === activePage) ?? PAGE_OPTIONS[0]

  return (
    <div className={`app-shell ${isSidebarCollapsed ? 'app-shell--sidebar-collapsed' : ''}`}>
      <aside className={`side-nav ${isSidebarCollapsed ? 'side-nav--collapsed' : ''}`}>
        <div className="side-nav__brand">
          <div className="side-nav__brand-copy">
            {!isSidebarCollapsed ? (
              <>
                <span className="eyebrow">Julang BI</span>
                <strong>客服看板</strong>
              </>
            ) : null}
          </div>
          <button
            type="button"
            className="side-nav__toggle"
            onClick={() => setIsSidebarCollapsed((current) => !current)}
            aria-label={isSidebarCollapsed ? '展开导航栏' : '收起导航栏'}
            title={isSidebarCollapsed ? '展开导航栏' : '收起导航栏'}
          >
            {isSidebarCollapsed ? '›' : '‹'}
          </button>
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
                <strong>{isSidebarCollapsed ? page.shortTitle : page.title}</strong>
                {!isSidebarCollapsed ? <small>{page.description}</small> : null}
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
