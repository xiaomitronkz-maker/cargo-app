import { Fragment, useEffect, useMemo, useState } from 'react'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const ACTION_LABELS = {
  receipt_created: 'Создан приход',
  receipt_updated: 'Изменён приход',
  receipt_deleted: 'Удалён приход',
  sale_created: 'Создана реализация',
  sale_updated: 'Изменена реализация',
  sale_deleted: 'Удалена реализация',
  payment_created: 'Создан платёж',
  client_payment: 'Оплата клиента',
  supplier_payment: 'Оплата поставщику',
  cashbox_transfer: 'Перевод между кассами',
  owner_contribution: 'Пополнение владельцем',
  owner_withdrawal: 'Снятие владельцем',
  income: 'Доход (legacy)',
  expense: 'Расход',
  google_sheets_import: 'Импорт Google Sheets',
  counterparty_import: 'Импорт контрагентов',
  tariff_created: 'Создан тариф',
  tariff_updated: 'Изменён тариф',
  tariff_deleted: 'Удалён тариф',
  marking_created: 'Создана маркировка',
  marking_updated: 'Изменена маркировка',
  marking_deleted: 'Удалена маркировка',
  product_created: 'Создан товар',
  product_updated: 'Изменён товар',
  product_deleted: 'Удалён товар',
  client_created: 'Создан клиент',
  client_updated: 'Изменён клиент',
  client_deleted: 'Удалён клиент',
  supplier_created: 'Создан поставщик',
  supplier_updated: 'Изменён поставщик',
  supplier_deleted: 'Удалён поставщик',
  cashbox_created: 'Создана касса',
  cashbox_updated: 'Изменена касса',
}

const ENTITY_LABELS = {
  receipt: 'Приход',
  sale: 'Реализация',
  sales_document: 'Реализация',
  payment: 'Платёж',
  transaction: 'Движение денег',
  tariff: 'Тариф',
  marking: 'Маркировка',
  product: 'Товар',
  client: 'Клиент',
  supplier: 'Поставщик',
  account: 'Касса',
  google_sheets_import: 'Импорт Google Sheets',
  counterparty_import: 'Импорт контрагентов',
}

const ACTION_OPTIONS = Object.entries(ACTION_LABELS)
const ENTITY_OPTIONS = Object.entries(ENTITY_LABELS)
const DEFAULT_FILTERS = { date_from: '', date_to: '', action: '', entity_type: '', search: '' }
const PAGE_LIMIT = 100

const fmtMoney = (amount, currency = 'USD') => {
  if (amount == null || amount === '') return '—'
  const value = toNumber(amount).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency === 'USD' ? `$${value}` : `${value} ${currency || ''}`.trim()
}

const formatDateTime = (value) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const cleanParams = (filters, offset = 0) => {
  const params = { limit: PAGE_LIMIT, offset }
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params[key] = value
  })
  return params
}

export default function OperationLogs() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState(null)

  const page = Math.floor(offset / PAGE_LIMIT) + 1
  const hasNext = offset + PAGE_LIMIT < total
  const hasPrev = offset > 0

  const load = async (nextOffset = offset, nextFilters = filters) => {
    setLoading(true)
    setError('')
    try {
      const result = await api.getOperationLogs(cleanParams(nextFilters, nextOffset))
      setLogs(normalizeArray(result?.items))
      setTotal(toNumber(result?.total))
      setOffset(toNumber(result?.offset))
    } catch (e) {
      setLogs([])
      setTotal(0)
      setError(e.message || 'Не удалось загрузить журнал операций')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(0, DEFAULT_FILTERS) }, [])

  const visibleLogs = normalizeArray(logs)
  const subtitle = useMemo(() => {
    const shown = visibleLogs.length
    return `${total} операций · показано ${shown}`
  }, [total, visibleLogs.length])

  const applyFilters = () => load(0, filters)
  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS)
    setExpandedId(null)
    load(0, DEFAULT_FILTERS)
  }

  const updateFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Журнал операций</div>
          <div className="page-subtitle">Все действия в системе · {subtitle}</div>
        </div>
        <button className="btn btn-secondary" onClick={() => load()}>Обновить</button>
      </div>

      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        Журнал фиксирует операции с момента добавления этой функции.
      </div>

      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 18 }}>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Дата с</label>
            <input type="date" className="form-input" value={filters.date_from} onChange={e => updateFilter('date_from', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Дата по</label>
            <input type="date" className="form-input" value={filters.date_to} onChange={e => updateFilter('date_to', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Тип действия</label>
            <select className="form-input" value={filters.action} onChange={e => updateFilter('action', e.target.value)}>
              <option value="">Все действия</option>
              {ACTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Объект</label>
            <select className="form-input" value={filters.entity_type} onChange={e => updateFilter('entity_type', e.target.value)}>
              <option value="">Все объекты</option>
              {ENTITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Поиск</label>
            <input
              className="form-input"
              placeholder="Действие, документ, описание или сумма"
              value={filters.search}
              onChange={e => updateFilter('search', e.target.value)}
            />
          </div>
          <div className="form-group" style={{ justifyContent: 'flex-end' }}>
            <label className="form-label">&nbsp;</label>
            <div className="td-actions">
              <button className="btn btn-primary" onClick={applyFilters} disabled={loading}>Показать</button>
              <button className="btn btn-secondary" onClick={resetFilters} disabled={loading}>Сбросить</button>
            </div>
          </div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Дата/время</th>
                <th>Действие</th>
                <th>Объект</th>
                <th>Описание</th>
                <th>Сумма</th>
                <th>Пользователь</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleLogs.length === 0 && (
                <tr><td colSpan={7}>
                  <div className="empty-state"><p>Операций пока нет</p></div>
                </td></tr>
              )}
              {visibleLogs.map(log => (
                <Fragment key={log.id}>
                  <tr>
                    <td className="td-muted td-date">{formatDateTime(log.created_at)}</td>
                    <td><span className="badge badge-primary">{ACTION_LABELS[log.action] || log.action}</span></td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{log.entity_label || ENTITY_LABELS[log.entity_type] || '—'}</div>
                      {log.entity_type && <div className="td-muted" style={{ fontSize: 12 }}>{ENTITY_LABELS[log.entity_type] || log.entity_type}</div>}
                    </td>
                    <td>{log.description || '—'}</td>
                    <td className="td-mono">{fmtMoney(log.amount, log.currency)}</td>
                    <td>{log.actor || 'system'}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}>
                        Подробнее
                      </button>
                    </td>
                  </tr>
                  {expandedId === log.id && (
                    <tr>
                      <td colSpan={7}>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>
                          {JSON.stringify(log.meta || {}, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="td-actions" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary" disabled={!hasPrev || loading} onClick={() => load(Math.max(offset - PAGE_LIMIT, 0))}>Назад</button>
        <span className="td-muted" style={{ alignSelf: 'center' }}>Страница {page}</span>
        <button className="btn btn-secondary" disabled={!hasNext || loading} onClick={() => load(offset + PAGE_LIMIT)}>Вперёд</button>
      </div>
    </div>
  )
}
