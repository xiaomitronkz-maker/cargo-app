import { Fragment, useEffect, useMemo, useState } from 'react'
import api from '../api'
import { formatDate, normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const liabilityDateKey = (value) => {
  if (!value) return 'no-date'
  const raw = String(value).trim()
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? 'no-date' : parsed.toISOString().slice(0, 10)
}
const compareDateKeysDesc = (a, b) => {
  if (a === b) return 0
  if (a === 'no-date') return 1
  if (b === 'no-date') return -1
  return b.localeCompare(a)
}
const dateLabel = (key) => key === 'no-date' ? 'Без даты' : formatDate(key)
const supplierKey = (debt) => debt.supplier_id ? `id:${debt.supplier_id}` : `name:${String(debt.supplier_name || '').trim().toLowerCase()}`
const liabilityAmount = (debt) => {
  const fields = [debt.debt, debt.debt_amount, debt.total_amount, debt.amount, debt.balance, debt.payable]
  const value = fields.find(field => field !== undefined && field !== null && field !== '')
  return toNumber(value)
}

export default function Liabilities() {
  const [payables, setPayables] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState('dates')
  const [expandedDate, setExpandedDate] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const debts = await api.getDebts()
      console.log('Analytics data:', debts)
      const safeDebts = normalizeArray(debts)
      setPayables(safeDebts.filter(debt => debt.type === 'payable'))
    } catch (e) {
      console.log('Analytics data:', null)
      setPayables([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const safePayables = normalizeArray(payables)
  const sortedPayables = useMemo(() => safePayables
    .slice()
    .sort((a, b) => compareDateKeysDesc(liabilityDateKey(a.date), liabilityDateKey(b.date)) || toNumber(b.id) - toNumber(a.id)), [safePayables])
  const dateGroups = useMemo(() => {
    const groups = new Map()
    sortedPayables.forEach((debt) => {
      const key = liabilityDateKey(debt.date)
      if (!groups.has(key)) {
        groups.set(key, {
          date_key: key,
          documents_count: 0,
          suppliers: new Set(),
          total_amount: 0,
          rows: [],
        })
      }
      const group = groups.get(key)
      group.documents_count += 1
      if (supplierKey(debt) !== 'name:') group.suppliers.add(supplierKey(debt))
      group.total_amount += liabilityAmount(debt)
      group.rows.push(debt)
    })
    return Array.from(groups.values())
      .map(group => ({ ...group, suppliers_count: group.suppliers.size }))
      .sort((a, b) => compareDateKeysDesc(a.date_key, b.date_key))
  }, [sortedPayables])
  const total = dateGroups.reduce((sum, group) => sum + group.total_amount, 0)
  const suppliersTotal = useMemo(() => {
    const keys = new Set()
    sortedPayables.forEach((debt) => {
      const key = supplierKey(debt)
      if (key !== 'name:') keys.add(key)
    })
    return keys.size
  }, [sortedPayables])

  const renderLiabilitiesTable = (rows, { showDate = true } = {}) => (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            {showDate && <th>Дата</th>}
            <th>Поставщик</th>
            <th>Документ</th>
            <th>Сумма долга</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={3 + (showDate ? 1 : 0)}>
              <div className="empty-state"><p>Обязательств нет</p></div>
            </td></tr>
          )}
          {rows.map(debt => (
            <tr key={debt.id}>
              {showDate && <td className="td-muted td-date">{formatDate(debt.date)}</td>}
              <td style={{ fontWeight: 600 }}>{debt.supplier_name || 'Без поставщика'}</td>
              <td>{debt.document_label || `Приход №${debt.id}`}</td>
              <td><span className="badge badge-danger" style={{ fontSize: 13 }}>{fmt(liabilityAmount(debt))}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Обязательства</div>
          <div className="page-subtitle">
            {sortedPayables.length} документов · {dateGroups.length} дней · {suppliersTotal} поставщиков · {fmt(total)}
          </div>
        </div>
        <button className="btn btn-secondary" onClick={load}>Обновить</button>
      </div>

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">💳 Всего обязательств</div>
          <div className="stat-value negative">{fmt(total)}</div>
          <div className="stat-sub">{safePayables.length} открытых документов</div>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab${viewMode === 'dates' ? ' active' : ''}`} onClick={() => setViewMode('dates')}>По датам</button>
        <button className={`tab${viewMode === 'list' ? ' active' : ''}`} onClick={() => setViewMode('list')}>Списком</button>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        viewMode === 'list' ? renderLiabilitiesTable(sortedPayables) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Документов</th>
                  <th>Поставщиков</th>
                  <th>Общая сумма долга</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {dateGroups.length === 0 && (
                  <tr><td colSpan={5}>
                    <div className="empty-state"><p>Обязательств нет</p></div>
                  </td></tr>
                )}
                {dateGroups.map(group => (
                  <Fragment key={group.date_key}>
                    <tr>
                      <td className="td-date">{dateLabel(group.date_key)}</td>
                      <td className="td-mono">{group.documents_count}</td>
                      <td className="td-mono">{group.suppliers_count}</td>
                      <td><span className="badge badge-danger" style={{ fontSize: 13 }}>{fmt(group.total_amount)}</span></td>
                      <td>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => setExpandedDate(expandedDate === group.date_key ? null : group.date_key)}
                        >
                          {expandedDate === group.date_key ? 'Скрыть' : 'Открыть'}
                        </button>
                      </td>
                    </tr>
                    {expandedDate === group.date_key && (
                      <tr>
                        <td colSpan={5}>
                          <div style={{ fontWeight: 700, marginBottom: 10 }}>Обязательства за {dateLabel(group.date_key)}</div>
                          {renderLiabilitiesTable(group.rows, { showDate: true })}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
