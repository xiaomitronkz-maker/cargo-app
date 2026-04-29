import { useEffect, useMemo, useState } from 'react'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function StatCard({ label, value, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone || ''}`}>{fmt(value)}</div>
    </div>
  )
}

function SectionCard({ title, children }) {
  return (
    <div className="table-wrapper" style={{ marginTop: 20 }}>
      <div style={{ padding: '14px 16px 0', fontWeight: 700 }}>{title}</div>
      {children}
    </div>
  )
}

export default function Dashboard() {
  const [accounts, setAccounts] = useState([])
  const [debts, setDebts] = useState([])
  const [sales, setSales] = useState([])
  const [receipts, setReceipts] = useState([])
  const [profitSummary, setProfitSummary] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const [accountsData, debtsData, salesData, receiptsData, profitData] = await Promise.all([
          api.getAccounts(),
          api.getDebts(),
          api.getSales(),
          api.getReceipts(),
          api.getProfitSummary(),
        ])
        console.log('Analytics data:', { accountsData, debtsData, salesData, receiptsData, profitData })
        setAccounts(normalizeArray(accountsData))
        setDebts(normalizeArray(debtsData))
        setSales(normalizeArray(salesData))
        setReceipts(normalizeArray(receiptsData))
        setProfitSummary(profitData && typeof profitData === 'object' ? profitData : {})
      } catch (e) {
        console.log('Analytics data:', null)
        setAccounts([])
        setDebts([])
        setSales([])
        setReceipts([])
        setProfitSummary({})
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const safeAccounts = normalizeArray(accounts)
  const safeDebts = normalizeArray(debts)
  const safeSales = normalizeArray(sales)
  const safeReceipts = normalizeArray(receipts)

  const cash = useMemo(() => safeAccounts.reduce((sum, account) => sum + toNumber(account.balance), 0), [safeAccounts])
  const receivable = useMemo(() => safeDebts.filter((d) => d.type === 'receivable').reduce((sum, debt) => sum + toNumber(debt.debt), 0), [safeDebts])
  const payable = useMemo(() => safeDebts.filter((d) => d.type === 'payable').reduce((sum, debt) => sum + toNumber(debt.debt), 0), [safeDebts])
  const profit = toNumber(profitSummary?.profit)
  const control = cash + receivable - (payable + profit)

  const latestSales = useMemo(() => [...safeSales].slice(0, 5), [safeSales])
  const latestReceipts = useMemo(() => [...safeReceipts].slice(0, 5), [safeReceipts])
  const topReceivable = useMemo(
    () => [...safeDebts].filter((d) => d.type === 'receivable').sort((a, b) => toNumber(b.debt) - toNumber(a.debt)).slice(0, 5),
    [safeDebts]
  )
  const topPayable = useMemo(
    () => [...safeDebts].filter((d) => d.type === 'payable').sort((a, b) => toNumber(b.debt) - toNumber(a.debt)).slice(0, 5),
    [safeDebts]
  )

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">Деньги, долги и риски</div>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="Деньги" value={cash} tone={cash >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Нам должны" value={receivable} tone="positive" />
        <StatCard label="Мы должны" value={payable} tone="negative" />
        <StatCard label="Прибыль" value={profit} tone={profit >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Контроль" value={control} tone={Math.abs(control) < 0.01 ? 'positive' : 'negative'} />
      </div>

      <div className={`alert ${Math.abs(control) < 0.01 ? 'alert-success' : 'alert-error'}`} style={{ marginTop: 20 }}>
        {Math.abs(control) < 0.01 ? 'Баланс сошелся' : `Контроль: ${fmt(control)}`}
      </div>

      <div className="record-grid" style={{ marginTop: 20 }}>
        <SectionCard title="Последние продажи">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Клиент</th>
                <th>Товар</th>
                <th>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {latestSales.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Нет продаж</td></tr>
              )}
              {latestSales.map((sale) => (
                <tr key={sale.id}>
                  <td className="td-muted">{sale.date || '—'}</td>
                  <td>{sale.client_name || '—'}</td>
                  <td>{sale.product_name || '—'}</td>
                  <td className="td-mono">{fmt(sale.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Последние приходы">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Поставщик</th>
                <th>Клиент</th>
                <th>Товаров</th>
              </tr>
            </thead>
            <tbody>
              {latestReceipts.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Нет приходов</td></tr>
              )}
              {latestReceipts.map((receipt) => (
                <tr key={receipt.id}>
                  <td className="td-muted">{receipt.date || '—'}</td>
                  <td>{receipt.supplier_name || '—'}</td>
                  <td>{receipt.client_name || '—'}</td>
                  <td className="td-mono">{toNumber(receipt.items_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Топ должников">
          <table>
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Документ</th>
                <th>Долг</th>
              </tr>
            </thead>
            <tbody>
              {topReceivable.length === 0 && (
                <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Нет дебиторки</td></tr>
              )}
              {topReceivable.map((debt) => (
                <tr key={`${debt.type}-${debt.id}`}>
                  <td>{debt.client_name || '—'}</td>
                  <td>{debt.document_label || debt.product_name || '—'}</td>
                  <td><span className="badge badge-success">{fmt(debt.debt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Топ обязательств">
          <table>
            <thead>
              <tr>
                <th>Поставщик</th>
                <th>Документ</th>
                <th>Долг</th>
              </tr>
            </thead>
            <tbody>
              {topPayable.length === 0 && (
                <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Нет обязательств</td></tr>
              )}
              {topPayable.map((debt) => (
                <tr key={`${debt.type}-${debt.id}`}>
                  <td>{debt.supplier_name || '—'}</td>
                  <td>{debt.document_label || `Приход №${debt.id}`}</td>
                  <td><span className="badge badge-warning">{fmt(debt.debt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>
    </div>
  )
}
