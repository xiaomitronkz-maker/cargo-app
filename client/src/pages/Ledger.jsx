import { useEffect, useMemo, useState } from 'react'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const formatLocalDate = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const today = () => formatLocalDate(new Date())
const monthStart = () => {
  const date = new Date()
  return formatLocalDate(new Date(date.getFullYear(), date.getMonth(), 1))
}
const emptyAct = null
const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtPlain = (n) => toNumber(n) ? fmt(n) : '—'

function csvCell(value) {
  const text = value == null ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function buildCsv(act) {
  const rows = [
    ['Акт сверки'],
    ['Контрагент', act.counterparty_name],
    ['Период', `${act.date_from} — ${act.date_to}`],
    ['Остаток на начало', act.opening_balance],
    ['Начислено', act.total_charged],
    ['Оплачено', act.total_paid],
    ['Остаток на конец', act.closing_balance],
    [],
    ['Дата', 'Операция', 'Документ', 'Начислено', 'Оплачено', 'Остаток', 'Комментарий'],
    ...normalizeArray(act.entries).map(entry => [
      entry.date || '',
      entry.operation || '',
      entry.document_id ? `№${entry.document_id}` : '',
      entry.charge || 0,
      entry.payment || 0,
      entry.balance_after || 0,
      entry.comment || '',
    ]),
    [],
    ['Итого начислено', act.total_charged],
    ['Итого оплачено', act.total_paid],
    ['Остаток на конец', act.closing_balance],
  ]
  return '\ufeff' + rows.map(row => row.map(csvCell).join(';')).join('\n')
}

function downloadCsv(act) {
  const slug = (act.counterparty_name || 'counterparty')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'counterparty'
  const blob = new Blob([buildCsv(act)], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `act-sverki-${slug}-${act.date_from}-${act.date_to}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(link.href)
}

export default function Ledger() {
  const [entityType, setEntityType] = useState('customer')
  const [clients, setClients] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())
  const [act, setAct] = useState(emptyAct)
  const [loading, setLoading] = useState(false)
  const [loadingRefs, setLoadingRefs] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoadingRefs(true)
    Promise.all([api.getClients(), api.getSuppliers()])
      .then(([clientsData, suppliersData]) => {
        setClients(normalizeArray(clientsData))
        setSuppliers(normalizeArray(suppliersData))
      })
      .catch(() => {
        setClients([])
        setSuppliers([])
        setError('Не удалось загрузить контрагентов')
      })
      .finally(() => setLoadingRefs(false))
  }, [])

  useEffect(() => {
    setSelectedId('')
    setAct(emptyAct)
    setError('')
  }, [entityType])

  const entities = entityType === 'customer' ? normalizeArray(clients) : normalizeArray(suppliers)
  const selectedName = useMemo(
    () => entities.find(item => String(item.id) === String(selectedId))?.name || '',
    [entities, selectedId]
  )

  const formAct = async () => {
    setError('')
    if (!selectedId) {
      setError('Выберите контрагента')
      return
    }
    if (!dateFrom || !dateTo) {
      setError('Выберите период')
      return
    }
    setLoading(true)
    try {
      const data = await api.getReconciliationAct({
        type: entityType,
        id: selectedId,
        date_from: dateFrom,
        date_to: dateTo,
      })
      setAct(data && typeof data === 'object' ? data : emptyAct)
    } catch (e) {
      setAct(emptyAct)
      setError(e.message || 'Не удалось сформировать акт сверки')
    } finally {
      setLoading(false)
    }
  }

  const entries = normalizeArray(act?.entries)

  return (
    <div className="page">
      <div className="page-header no-print">
        <div>
          <div className="page-title">Акт сверки</div>
          <div className="page-subtitle">Официальный отчёт по взаиморасчётам за период</div>
        </div>
      </div>

      <div className="filters-bar no-print">
        <select className="form-select filter-input" value={entityType} onChange={e => setEntityType(e.target.value)}>
          <option value="customer">Клиент</option>
          <option value="supplier">Поставщик</option>
        </select>
        <select className="form-select filter-input" value={selectedId} onChange={e => { setSelectedId(e.target.value); setAct(emptyAct) }} disabled={loadingRefs}>
          <option value="">Выберите {entityType === 'customer' ? 'клиента' : 'поставщика'}</option>
          {entities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <input type="date" className="form-input filter-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <input type="date" className="form-input filter-input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        <button className="btn btn-primary" onClick={formAct} disabled={loading}>
          {loading ? 'Формирование...' : 'Сформировать'}
        </button>
      </div>

      {error && <div className="alert alert-error no-print">{error}</div>}

      {!act ? (
        <div className="empty-state no-print">
          <p>{selectedName ? 'Нажмите “Сформировать”, чтобы получить акт сверки' : 'Выберите контрагента и период'}</p>
        </div>
      ) : (
        <>
          <div className="td-actions no-print" style={{ marginBottom: 16, justifyContent: 'flex-start' }}>
            <button className="btn btn-secondary" onClick={() => window.print()}>Скачать PDF</button>
            <button className="btn btn-secondary" onClick={() => downloadCsv(act)}>Скачать Excel/CSV</button>
          </div>

          <div className="reconciliation-print-area">
            <div className="chart-card">
              <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>Акт сверки</div>
              <div className="page-subtitle">Контрагент: {act.counterparty_name || selectedName || '—'}</div>
              <div className="page-subtitle">Период: {act.date_from} — {act.date_to}</div>
            </div>

            <div className="balance-grid">
              <div className="balance-card">
                <div className="balance-card-label">Остаток на начало</div>
                <div className={`balance-card-value ${toNumber(act.opening_balance) > 0 ? 'negative' : 'positive'}`}>
                  {fmt(act.opening_balance)}
                </div>
              </div>
              <div className="balance-card">
                <div className="balance-card-label">Начислено</div>
                <div className="balance-card-value">{fmt(act.total_charged)}</div>
              </div>
              <div className="balance-card">
                <div className="balance-card-label">Оплачено</div>
                <div className="balance-card-value" style={{ color: 'var(--success)' }}>{fmt(act.total_paid)}</div>
              </div>
              <div className="balance-card">
                <div className="balance-card-label">Остаток на конец</div>
                <div className={`balance-card-value ${toNumber(act.closing_balance) > 0 ? 'negative' : 'positive'}`}>
                  {fmt(act.closing_balance)}
                </div>
              </div>
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Операция</th>
                    <th>Документ</th>
                    <th>Начислено</th>
                    <th>Оплачено</th>
                    <th>Остаток</th>
                    <th>Комментарий</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 && (
                    <tr><td colSpan={7}>
                      <div className="empty-state"><p>Операций за период нет</p></div>
                    </td></tr>
                  )}
                  {entries.map((entry, index) => (
                    <tr key={`${entry.operation}-${entry.document_id || 'payment'}-${index}`}>
                      <td className="td-muted">{entry.date || '—'}</td>
                      <td>{entry.operation || '—'}</td>
                      <td className="td-muted">{entry.document_id ? `№${entry.document_id}` : '—'}</td>
                      <td className="td-mono">{fmtPlain(entry.charge)}</td>
                      <td className="td-mono">{fmtPlain(entry.payment)}</td>
                      <td>
                        <span className={`badge ${toNumber(entry.balance_after) > 0 ? 'badge-warning' : 'badge-success'}`}>
                          {fmt(entry.balance_after)}
                        </span>
                      </td>
                      <td className="td-muted">{entry.comment || '—'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ fontWeight: 700 }}>Итого</td>
                    <td className="td-mono" style={{ fontWeight: 700 }}>{fmt(act.total_charged)}</td>
                    <td className="td-mono" style={{ fontWeight: 700 }}>{fmt(act.total_paid)}</td>
                    <td>
                      <span className={`badge ${toNumber(act.closing_balance) > 0 ? 'badge-warning' : 'badge-success'}`}>
                        {fmt(act.closing_balance)}
                      </span>
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
