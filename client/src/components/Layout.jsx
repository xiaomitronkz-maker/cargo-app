import { Outlet, NavLink, useNavigate } from 'react-router-dom'

const NAV = [
  { section: 'Обзор', items: [
    { path: '/dashboard', icon: '◈', label: 'Обзор' },
    { path: '/analytics', icon: '◉', label: 'Аналитика' },
    { path: '/ai', icon: '⌬', label: 'AI Команды' },
  ]},
  { section: 'Справочники', items: [
    { path: '/clients', icon: '◎', label: 'Клиенты' },
    { path: '/suppliers', icon: '◌', label: 'Поставщики' },
    { path: '/markings', icon: '◈', label: 'Маркировки' },
    { path: '/products', icon: '▣', label: 'Товары' },
    { path: '/tariffs', icon: '≋', label: 'Тарифы' },
  ]},
  { section: 'Учёт', items: [
    { path: '/receipts', icon: '📄', label: 'Приходы' },
    { path: '/sales', icon: '↑', label: 'Реализация' },
  ]},
  { section: 'Финансы', items: [
    { path: '/finance', icon: '▦', label: 'Финансы' },
    { path: '/accounts', icon: '💰', label: 'Кассы' },
    { path: '/transactions', icon: '⇄', label: 'Движение' },
    { path: '/expenses', icon: '−', label: 'Расходы' },
    { path: '/money-assets', icon: '◇', label: 'Активы' },
    { path: '/liabilities', icon: '◆', label: 'Обязательства' },
    { path: '/debts', icon: '◌', label: 'Долги' },
    { path: '/payments', icon: '◍', label: 'Платежи' },
    { path: '/ledger', icon: '≡', label: 'Акт сверки' },
    { path: '/operation-logs', icon: '≣', label: 'Журнал операций' },
    { path: '/audit', icon: '✓', label: 'Аудит' },
  ]},
]

export default function Layout({ user, onLogout }) {
  const navigate = useNavigate()

  const logout = async () => {
    await onLogout?.()
    navigate('/dashboard', { replace: true })
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <h1>📦 Cargo Manager</h1>
          <span>Дубай → Казахстан</span>
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

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <span>Пользователь</span>
            <strong>{user?.username || 'admin'}</strong>
          </div>
          <button className="btn btn-secondary btn-sm sidebar-logout" type="button" onClick={logout}>
            Выйти
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
