import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtShort = (n) => {
  const value = toNumber(n)
  if (Math.abs(value) >= 1000) return '$' + (value / 1000).toFixed(1) + 'k'
  return '$' + value.toFixed(0)
}

function StatCard({ label, value, sub, positive }) {
  const isNum = typeof value === 'number'
  const cls = isNum && value > 0 ? 'positive' : isNum && value < 0 ? 'negative' : ''
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${positive !== undefined ? (positive ? 'positive' : 'negative') : cls}`}>
        {isNum ? fmt(value) : value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

const CustomTooltip = ({ active, payload, label }) => {
  const safePayload = normalizeArray(payload)
  if (!active || safePayload.length === 0) return null
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</p>
      {safePayload.map(p => (
        <p key={p.name} style={{ fontSize: 13, color: p.color, marginBottom: 2 }}>
          {p.name}: {fmtShort(p.value)}
        </p>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const result = await api.getDashboard()
        console.log('Analytics data:', result)
        setData(result && typeof result === 'object' ? result : {})
      } catch (e) {
        console.log('Analytics data:', null)
        setData({})
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) return <div className="loading">Загрузка...</div>
  if (!data) return <div className="page"><div className="alert alert-error">Ошибка загрузки</div></div>

  const safeData = data && typeof data === 'object' ? data : {}
  const totalProfit = toNumber(safeData.totalProfit)
  const todayProfit = toNumber(safeData.todayProfit)
  const weekProfit = toNumber(safeData.weekProfit)
  const monthProfit = toNumber(safeData.monthProfit)
  const clientCount = toNumber(safeData.clientCount)
  const saleCount = toNumber(safeData.saleCount)
  const purchaseCount = toNumber(safeData.purchaseCount)
  const totalBalance = toNumber(safeData.totalBalance)
  const totalAssets = toNumber(safeData.totalAssets)
  const profitByDate = normalizeArray(safeData.profitByDate).map(row => ({
    ...row,
    sales: toNumber(row?.sales),
    profit: toNumber(row?.profit),
    costs: toNumber(row?.costs),
  }))
  const topClients = normalizeArray(safeData.topClients).map(row => ({
    ...row,
    total_sales: toNumber(row?.total_sales),
    total_costs: toNumber(row?.total_costs),
    profit: toNumber(row?.profit),
  }))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">Общий обзор бизнеса</div>
        </div>
      </div>

      {/* Profit stats */}
      <div className="stat-grid">
        <StatCard label="Общая прибыль" value={totalProfit} sub={`Продажи: ${fmt(toNumber(safeData.totalSales))}`} />
        <StatCard label="Сегодня" value={todayProfit} />
        <StatCard label="Неделя" value={weekProfit} />
        <StatCard label="Месяц" value={monthProfit} />
        <StatCard label="Баланс" value={totalBalance} sub={`Активы: ${fmt(totalAssets)}`} />
        <StatCard label="Клиентов" value={clientCount} positive />
        <StatCard label="Продаж" value={saleCount} positive />
        <StatCard label="Приходов" value={purchaseCount} positive />
      </div>

      {/* Profit chart */}
      <div className="chart-card">
        <div className="chart-title">Прибыль за 30 дней</div>
        {profitByDate.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '32px 0', fontSize: 13 }}>
            Нет данных. Добавьте приходы и продажи.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={profitByDate} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false}
                tickFormatter={v => String(v || '').slice(5)} />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false}
                tickFormatter={fmtShort} width={56} />
              <Tooltip content={<CustomTooltip />} />
              <Line name="Продажи" type="monotone" dataKey="sales" stroke="#5e6ad2" strokeWidth={2} dot={false} />
              <Line name="Прибыль" type="monotone" dataKey="profit" stroke="#16a34a" strokeWidth={2} dot={false} />
              <Line name="Затраты" type="monotone" dataKey="costs" stroke="#dc2626" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Top clients */}
      <div className="chart-card">
        <div className="chart-title">Топ клиентов по продажам</div>
        {topClients.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0', fontSize: 13 }}>
            Нет данных по клиентам
          </div>
        ) : (
          <div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={topClients} layout="vertical" margin={{ left: 0, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={fmtShort} />
                <YAxis dataKey="name" type="category" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} tickLine={false} axisLine={false} width={80} />
                <Tooltip content={<CustomTooltip />} />
                <Bar name="Продажи" dataKey="total_sales" fill="#5e6ad2" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>

            <div className="table-wrapper" style={{ marginTop: 16 }}>
              <table>
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>Продажи</th>
                    <th>Затраты</th>
                    <th>Прибыль</th>
                  </tr>
                </thead>
                <tbody>
                  {topClients.map(c => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="td-mono">{fmt(c.total_sales)}</td>
                      <td className="td-mono td-muted">{fmt(c.total_costs)}</td>
                      <td>
                        <span className={`badge ${c.profit >= 0 ? 'badge-success' : 'badge-danger'}`}>
                          {fmt(c.profit)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
