import { useEffect, useMemo, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'

const emptyLedger = {
  summary: {
    receivable: 0,
    payable: 0,
    balance: 0,
    customersCount: 0,
    suppliersCount: 0,
    closedCount: 0,
  },
  customers: [],
  suppliers: [],
  closed: [],
}

const normalizeArray = (data) => Array.isArray(data) ? data : []
const toNumber = (value) => Number(value || 0)
const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtPlain = (n) => toNumber(n) ? fmt(n) : '—'

const tabLabels = {
  customers: 'Клиенты',
  suppliers: 'Поставщики',
  history: 'История',
}

const typeLabel = (type) => type === 'supplier' ? 'Поставщик' : 'Клиент'

function statusLabel(row) {
  const balance = toNumber(row.balance)
  if (Math.abs(balance) < 0.01) return 'Закрыт'
  if (balance < 0) return 'Переплата'
  return row.type === 'supplier' ? 'Мы должны' : 'Должен'
}

function statusBadge(row) {
  const balance = toNumber(row.balance)
  if (Math.abs(balance) < 0.01) return 'badge-success'
  if (balance < 0) return 'badge-primary'
  return row.type === 'supplier' ? 'badge-warning' : 'badge-danger'
}

function operationKind(kind) {
  if (kind === 'payment') return 'Оплата'
  if (kind === 'receipt') return 'Приход'
  return 'Реализация'
}

export default function Debts() {
  const [ledger, setLedger] = useState(emptyLedger)
  const [activeTab, setActiveTab] = useState('customers')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getDebtsLedger()
      setLedger({
        summary: { ...emptyLedger.summary, ...(data?.summary || {}) },
        customers: normalizeArray(data?.customers),
        suppliers: normalizeArray(data?.suppliers),
        closed: normalizeArray(data?.closed),
      })
    } catch (e) {
      setLedger(emptyLedger)
      setError(e.message || 'Не удалось загрузить взаиморасчеты')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const rows = useMemo(() => {
    const source = activeTab === 'history'
      ? ledger.closed
      : activeTab === 'suppliers'
        ? ledger.suppliers
        : ledger.customers
    const term = search.trim().toLowerCase()
    if (!term) return source
    return source.filter(row => (row.counterparty_name || '').toLowerCase().includes(term))
  }, [activeTab, ledger, search])

  const summary = ledger.summary || emptyLedger.summary

  const renderRows = () => {
    if (rows.length === 0) {
      return (
        <tr>
          <td colSpan={activeTab === 'history' ? 7 : 8}>
            <div className="empty-state">
              <p>{search ? 'Ничего не найдено' : 'Истории пока нет'}</p>
            </div>
          </td>
        </tr>
      )
    }

    return rows.map(row => (
      <tr key={`${row.type}-${row.counterparty_id}`}>
        {activeTab === 'history' && <td>{typeLabel(row.type)}</td>}
        <td>{row.counterparty_name || '—'}</td>
        <td className="td-mono">{fmt(row.total_charged)}</td>
        <td className="td-mono">{fmt(row.total_paid)}</td>
        <td>
          <span className={`badge ${toNumber(row.balance) > 0 ? 'badge-warning' : 'badge-success'}`}>
            {fmt(row.balance)}
          </span>
        </td>
        {activeTab !== 'history' && <td className="td-mono">{row.documents_count || 0}</td>}
        <td className="td-muted">{row.last_operation_date || '—'}</td>
        {activeTab !== 'history' && (
          <td>
            <span className={`badge ${statusBadge(row)}`}>{statusLabel(row)}</span>
          </td>
        )}
        <td>
          <button className="btn btn-secondary btn-sm" onClick={() => setSelected(row)}>Открыть</button>
        </td>
      </tr>
    ))
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Взаиморасчёты</div>
          <div className="page-subtitle">
            История по клиентам и поставщикам не исчезает после закрытия долга
          </div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="balance-grid">
        <div className="balance-card">
          <div className="balance-card-label">Нам должны</div>
          <div className="balance-card-value" style={{ color: 'var(--success)' }}>{fmt(summary.receivable)}</div>
        </div>
        <div className="balance-card">
          <div className="balance-card-label">Мы должны</div>
          <div className="balance-card-value" style={{ color: '#fbbf24' }}>{fmt(summary.payable)}</div>
        </div>
        <div className="balance-card">
          <div className="balance-card-label">Баланс</div>
          <div className={`balance-card-value ${toNumber(summary.balance) >= 0 ? 'positive' : 'negative'}`}>
            {fmt(summary.balance)}
          </div>
        </div>
        <div className="balance-card">
          <div className="balance-card-label">Клиентов с историей</div>
          <div className="balance-card-value">{summary.customersCount || 0}</div>
        </div>
        <div className="balance-card">
          <div className="balance-card-label">Поставщиков с историей</div>
          <div className="balance-card-value">{summary.suppliersCount || 0}</div>
        </div>
      </div>

      <div className="filters-bar">
        <input
          className="form-input filter-input"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск по клиенту или поставщику"
        />
      </div>

      <div className="tabs">
        {Object.entries(tabLabels).map(([key, label]) => (
          <button
            key={key}
            className={`tab${activeTab === key ? ' active' : ''}`}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                {activeTab === 'history' && <th>Тип</th>}
                <th>{activeTab === 'suppliers' ? 'Поставщик' : activeTab === 'history' ? 'Контрагент' : 'Клиент'}</th>
                <th>Начислено</th>
                <th>Оплачено</th>
                <th>Остаток</th>
                {activeTab !== 'history' && <th>Документов</th>}
                <th>Последняя операция</th>
                {activeTab !== 'history' && <th>Статус</th>}
                <th>Открыть</th>
              </tr>
            </thead>
            <tbody>{renderRows()}</tbody>
          </table>
        </div>
      )}

      {selected && (
        <Modal
          wide
          title={selected.counterparty_name || 'Контрагент'}
          onClose={() => setSelected(null)}
          footer={<button className="btn btn-secondary" onClick={() => setSelected(null)}>Закрыть</button>}
        >
          <div className="record-meta" style={{ marginBottom: 14 }}>
            <span>Тип</span>
            <strong>{typeLabel(selected.type)}</strong>
          </div>

          <div className="balance-grid" style={{ marginBottom: 20 }}>
            <div className="balance-card">
              <div className="balance-card-label">Всего начислено</div>
              <div className="balance-card-value">{fmt(selected.total_charged)}</div>
            </div>
            <div className="balance-card">
              <div className="balance-card-label">Всего оплачено</div>
              <div className="balance-card-value" style={{ color: 'var(--success)' }}>{fmt(selected.total_paid)}</div>
            </div>
            <div className="balance-card">
              <div className="balance-card-label">Текущий остаток</div>
              <div className={`balance-card-value ${toNumber(selected.balance) > 0 ? 'negative' : 'positive'}`}>
                {fmt(selected.balance)}
              </div>
            </div>
            <div className="balance-card">
              <div className="balance-card-label">Статус</div>
              <div className="balance-card-value" style={{ fontSize: 18 }}>
                <span className={`badge ${statusBadge(selected)}`}>{statusLabel(selected)}</span>
              </div>
            </div>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Операция</th>
                  <th>Начисление</th>
                  <th>Оплата</th>
                  <th>Остаток после операции</th>
                  <th>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {normalizeArray(selected.entries).length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state"><p>Истории нет</p></div>
                    </td>
                  </tr>
                ) : normalizeArray(selected.entries).map((entry, index) => (
                  <tr key={`${entry.kind}-${entry.document_id || 'payment'}-${index}`}>
                    <td className="td-muted">{entry.date || '—'}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{entry.description || operationKind(entry.kind)}</div>
                      <div className="td-muted">{operationKind(entry.kind)}</div>
                    </td>
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
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  )
}
