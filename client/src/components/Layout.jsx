import { Outlet, NavLink, useNavigate } from 'react-router-dom'

const NAV = [
  { section: 'Обзор', items: [
    { path: '/dashboard', icon: '◈', label: 'Dashboard' },
    { path: '/analytics', icon: '◉', label: 'Аналитика' },
    { path: '/ai', icon: '⌬', label: 'AI Команды' },
  ]},
  { section: 'Справочники', items: [
    { path: '/clients', icon: '◎', label: 'Клиенты' },
    { path: '/suppliers', icon: '◌', label: 'Поставщики' },
    { path: '/markings', icon: '◈', label: 'Маркировки' },
    { path: '/products', icon: '▣', label: 'Товары' },
  ]},
  { section: 'Учёт', items: [
    { path: '/receipts', icon: '📄', label: 'Приходы' },
    { path: '/sales', icon: '↑', label: 'Реализация' },
  ]},
  { section: 'Финансы', items: [
    { path: '/finance', icon: '▦', label: 'Финансы' },
    { path: '/profit', icon: '◉', label: 'Прибыль' },
    { path: '/accounts', icon: '💰', label: 'Кассы' },
    { path: '/transactions', icon: '⇄', label: 'Движение' },
    { path: '/money-assets', icon: '◇', label: 'Активы' },
    { path: '/liabilities', icon: '◆', label: 'Обязательства' },
    { path: '/debts', icon: '◌', label: 'Долги' },
    { path: '/payments', icon: '◍', label: 'Платежи' },
    { path: '/ledger', icon: '≡', label: 'История' },
    { path: '/audit', icon: '✓', label: 'Аудит' },
  ]},
]

export default function Layout() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <h1>📦 Cargo Manager</h1>
          <span>Dubai → Kazakhstan</span>
        </div>

        <nav className="sidebar-nav">
          {NAV.map(({ section, items }) => (
            <div className="sidebar-section" key={section}>
              <div className="sidebar-section-label">{section}</div>
              {items.map(({ path, icon, label }) => (
                <NavLink
                  key={path}
                  to={path}
                  className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                >
                  <span className="icon">{icon}</span>
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
