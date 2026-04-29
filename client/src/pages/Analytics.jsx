import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line } from 'recharts'
import api from '../api'

const fmt = (n) => '$' + (n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtShort = (n) => { if (Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(1) + 'k'; return '$' + n.toFixed(0) }

const PIE_COLORS = { cash: '#5e6ad2', in_transit: '#d97706', debtors: '#dc2626', transfer: '#16a34a' }
const PIE_LABELS = { cash: 'Наличные', in_transit: 'В дороге', debtors: 'Должники', transfer: 'Перевод' }

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</p>
      {payload.map(p => (
        <p key={p.name} style={{ fontSize: 13, color: p.color || 'var(--text)', marginBottom: 2 }}>
          {p.name}: {fmtShort(p.value)}
        </p>
      ))}
    </div>
  )
}

const PERIODS = [
  { key: '', label: 'Всё время' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
  { key: 'year', label: 'Год' },
]
const TABS = ['Клиенты', 'Товары', 'Продажи по датам', 'Баланс']

export default function Analytics() {
  const [data, setData] = useState(null)
  const [period, setPeriod] = useState('')
  const [tab, setTab] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getProfit(period).then(setData).finally(() => setLoading(false))
  }, [period])

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Аналитика</div>
          <div className="page-subtitle">Прибыль, продажи, баланс</div>
        </div>
        <div className="period-btns">
          {PERIODS.map(p => (
            <button key={p.key} className={`period-btn${period === p.key ? ' active' : ''}`} onClick={() => setPeriod(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t, i) => (
          <button key={t} className={`tab${tab === i ? ' active' : ''}`} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : !data ? (
        <div className="alert alert-error">Ошибка загрузки</div>
      ) : tab === 0 ? (
        <ClientsTab data={data} />
      ) : tab === 1 ? (
        <ProductsTab data={data} />
      ) : tab === 2 ? (
        <TimelineTab data={data} />
      ) : (
        <BalanceTab data={data} />
      )}
    </div>
  )
}

function ClientsTab({ data }) {
  const { byClient } = data
  return (
    <div>
      {byClient.length > 0 && (
        <div className="chart-card">
          <div className="chart-title">Продажи по клиентам</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={byClient.slice(0, 10)} layout="vertical" margin={{ left: 0, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis type="number" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={fmtShort} />
              <YAxis dataKey="name" type="category" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} tickLine={false} axisLine={false} width={90} />
              <Tooltip content={<CustomTooltip />} />
              <Bar name="Продажи" dataKey="total_sales" fill="#5e6ad2" radius={[0,4,4,0]} />
              <Bar name="Прибыль" dataKey="profit" fill="#16a34a" radius={[0,4,4,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="table-wrapper">
        <table>
          <thead><tr><th>Клиент</th><th>Продажи</th><th>Затраты</th><th>Прибыль</th></tr></thead>
          <tbody>
            {byClient.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Нет данных</td></tr>
            )}
            {byClient.map((c, i) => (
              <tr key={i}>
                <td>{c.name}</td>
                <td className="td-mono">{fmt(c.total_sales)}</td>
                <td className="td-mono td-muted">{fmt(c.total_costs)}</td>
                <td><span className={`badge ${c.profit >= 0 ? 'badge-success' : 'badge-danger'}`}>{fmt(c.profit)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ProductsTab({ data }) {
  const { byProduct } = data
  return (
    <div>
      {byProduct.length > 0 && (
        <div className="chart-card">
          <div className="chart-title">Продажи по товарам</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={byProduct.slice(0, 10)} layout="vertical" margin={{ left: 0, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis type="number" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={fmtShort} />
              <YAxis dataKey="name" type="category" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} tickLine={false} axisLine={false} width={110} />
              <Tooltip content={<CustomTooltip />} />
              <Bar name="Продажи" dataKey="total_sales" fill="#d97706" radius={[0,4,4,0]} />
              <Bar name="Прибыль" dataKey="profit" fill="#16a34a" radius={[0,4,4,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="table-wrapper">
        <table>
          <thead><tr><th>Товар</th><th>Продажи</th><th>Затраты</th><th>Прибыль</th></tr></thead>
          <tbody>
            {byProduct.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Нет данных</td></tr>
            )}
            {byProduct.map((p, i) => (
              <tr key={i}>
                <td>{p.name}</td>
                <td className="td-mono">{fmt(p.total_sales)}</td>
                <td className="td-mono td-muted">{fmt(p.total_costs)}</td>
                <td><span className={`badge ${p.profit >= 0 ? 'badge-success' : 'badge-danger'}`}>{fmt(p.profit)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TimelineTab({ data }) {
  const { salesByPeriod, purchasesByPeriod } = data
  const dates = [...new Set([...salesByPeriod.map(r => r.date), ...purchasesByPeriod.map(r => r.date)])].sort()
  const combined = dates.map(d => ({
    date: d.slice(5),
    sales: salesByPeriod.find(r => r.date === d)?.total || 0,
    costs: purchasesByPeriod.find(r => r.date === d)?.total || 0,
  }))
  return (
    <div>
      <div className="chart-card">
        <div className="chart-title">Продажи и затраты по датам</div>
        {combined.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>Нет данных за период</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={combined} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={fmtShort} width={56} />
              <Tooltip content={<CustomTooltip />} />
              <Line name="Продажи" type="monotone" dataKey="sales" stroke="#5e6ad2" strokeWidth={2} dot={false} />
              <Line name="Затраты" type="monotone" dataKey="costs" stroke="#dc2626" strokeWidth={2} dot={false} strokeDasharray="4 4" />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

function BalanceTab({ data }) {
  const { assetsByType, totalLiab } = data
  const totalAssets = assetsByType.reduce((s, r) => s + r.total, 0)
  const pieData = assetsByType.map(r => ({ name: PIE_LABELS[r.asset_type] || r.asset_type, value: r.total, type: r.asset_type }))

  return (
    <div>
      <div className="balance-grid">
        {assetsByType.map(r => (
          <div className="balance-card" key={r.asset_type}>
            <div className="balance-card-label">{PIE_LABELS[r.asset_type] || r.asset_type}</div>
            <div className="balance-card-value" style={{ color: PIE_COLORS[r.asset_type] || 'var(--text)' }}>{fmt(r.total)}</div>
          </div>
        ))}
        <div className="balance-card">
          <div className="balance-card-label">Обязательства</div>
          <div className="balance-card-value" style={{ color: 'var(--danger)' }}>{fmt(totalLiab)}</div>
        </div>
        <div className="balance-card" style={{ borderColor: 'var(--primary)' }}>
          <div className="balance-card-label">Чистый баланс</div>
          <div className="balance-card-value" style={{ color: totalAssets - totalLiab >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {fmt(totalAssets - totalLiab)}
          </div>
        </div>
      </div>

      {pieData.length > 0 && (
        <div className="chart-card">
          <div className="chart-title">Структура активов</div>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`}>
                {pieData.map((entry, i) => <Cell key={i} fill={PIE_COLORS[entry.type] || '#888'} />)}
              </Pie>
              <Tooltip formatter={(v) => fmt(v)} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
