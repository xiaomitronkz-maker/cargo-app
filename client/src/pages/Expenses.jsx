import { useEffect, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'
import { formatDate, normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const emptyFilters = {
  date_from: '',
  date_to: '',
  cashbox_id: '',
  search: '',
}

function SummaryCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  )
}

export default function Expenses() {
  const [filters, setFilters] = useState(emptyFilters)
  const [accounts, setAccounts] = useState([])
  const [items, setItems] = useState([])
  const [summary, setSummary] = useState({ total_amount: 0, count: 0 })
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async (nextFilters = filters) => {
    setLoading(true)
    setError('')
    try {
      const params = Object.fromEntries(
        Object.entries({ ...nextFilters, limit: 200, offset: 0 }).filter(([, value]) => value !== '')
      )
      const [expensesData, accountsData] = await Promise.all([
        api.getExpenses(params),
        api.getAccounts(),
      ])
      setItems(normalizeArray(expensesData?.items))
      setSummary(expensesData?.summary || { total_amount: 0, count: 0 })
      setAccounts(normalizeArray(accountsData))
    } catch (e) {
      setItems([])
      setSummary({ total_amount: 0, count: 0 })
      setError(e.message || 'Не удалось загрузить расходы')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(emptyFilters) }, [])

  const setFilter = (key, value) => {
    setFilters(current => ({ ...current, [key]: value }))
  }

  const resetFilters = async () => {
    setFilters(emptyFilters)
    await load(emptyFilters)
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Расходы</div>
          <div className="page-subtitle">Ручные расходы бизнеса, которые уменьшают прибыль</div>
        </div>
        <button className="btn btn-secondary" onClick={() => load()}>Обновить</button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <SummaryCard label="Всего расходов за период" value={fmt(summary.total_amount)} />
        <SummaryCard label="Количество операций" value={toNumber(summary.count)} />
      </div>

      <div className="filters-bar" style={{ marginBottom: 20 }}>
        <input
          type="date"
          className="form-input filter-input"
          value={filters.date_from}
          onChange={e => setFilter('date_from', e.target.value)}
          title="Дата с"
        />
        <input
          type="date"
          className="form-input filter-input"
          value={filters.date_to}
          onChange={e => setFilter('date_to', e.target.value)}
          title="Дата по"
        />
        <select
          className="form-select filter-input"
          value={filters.cashbox_id}
          onChange={e => setFilter('cashbox_id', e.target.value)}
        >
          <option value="">Все кассы</option>
          {accounts.map(account => (
            <option key={account.id} value={String(account.id)}>{account.name}</option>
          ))}
        </select>
        <input
          className="form-input filter-input"
          value={filters.search}
          onChange={e => setFilter('search', e.target.value)}
          placeholder="Поиск по комментарию или кассе"
        />
        <button className="btn btn-primary" onClick={() => load()}>Показать</button>
        <button className="btn btn-secondary" onClick={resetFilters}>Сбросить</button>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Касса</th>
                <th>Сумма</th>
                <th>Комментарий</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state"><p>Расходов пока нет</p></div>
                  </td>
                </tr>
              )}
              {items.map(item => (
                <tr key={item.id}>
                  <td className="td-muted td-date">{formatDate(item.date)}</td>
                  <td>{item.cashbox_name || '—'}</td>
                  <td className="td-mono">{fmt(item.amount)}</td>
                  <td className="td-muted">{item.comment || '—'}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => setSelected(item)}>
                      Просмотр
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <Modal
          title="Расход"
          onClose={() => setSelected(null)}
          footer={<button className="btn btn-secondary" onClick={() => setSelected(null)}>Закрыть</button>}
        >
          <div className="record-meta" style={{ marginBottom: 12 }}>
            <span>Дата</span>
            <strong>{formatDate(selected.date)}</strong>
          </div>
          <div className="record-meta" style={{ marginBottom: 12 }}>
            <span>Касса</span>
            <strong>{selected.cashbox_name || '—'}</strong>
          </div>
          <div className="record-meta" style={{ marginBottom: 12 }}>
            <span>Сумма</span>
            <strong>{fmt(selected.amount)}</strong>
          </div>
          <div className="record-meta" style={{ marginBottom: 12 }}>
            <span>Комментарий</span>
            <strong>{selected.comment || '—'}</strong>
          </div>
        </Modal>
      )}
    </div>
  )
}
