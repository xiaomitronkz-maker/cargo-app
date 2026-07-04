import { useEffect, useMemo, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'
import { formatDate } from '../utils/data'

const emptyLedger = {
  summary: {
    receivable: 0,
    payable: 0,
    client_advances: 0,
    supplier_payable: 0,
    balance: 0,
    customersCount: 0,
    suppliersCount: 0,
    closedCount: 0,
  },
  customers: [],
  suppliers: [],
  closed: [],
  history: [],
}

const normalizeArray = (data) => Array.isArray(data) ? data : []
const toNumber = (value) => Number(value || 0)
const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtPlain = (n) => toNumber(n) ? fmt(n) : '—'
const roundMoney = (value) => Math.round(toNumber(value) * 100) / 100
const todayIso = () => {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}
const emptyPaymentForm = () => ({ account_id: '', amount: '', date: todayIso(), comment: '' })

const tabLabels = {
  customers: 'Клиенты',
  suppliers: 'Поставщики',
  history: 'История',
}

const typeLabel = (type) => type === 'supplier' ? 'Поставщик' : 'Клиент'

function statusLabel(row) {
  const balance = toNumber(row.balance)
  if (Math.abs(balance) < 0.01) return 'Закрыт'
  if (row.type === 'customer' && balance < 0) return 'Аванс'
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

function entryPaymentAmount(entry) {
  if (entry?.active_payment != null) return roundMoney(entry.active_payment)
  return entry?.cancelled_at ? 0 : roundMoney(entry?.payment)
}

function hasOpenDebt(row) {
  return toNumber(row?.balance) > 0.009
}

function hasClientAdvance(row) {
  return row?.type === 'customer' && toNumber(row.balance) < -0.009
}

function balanceLabel(row) {
  if (hasClientAdvance(row)) return `Аванс: ${fmt(Math.abs(toNumber(row.balance)))}`
  return fmt(row?.balance)
}

function runningBalanceLabel(rowType, value) {
  const balance = toNumber(value)
  if (rowType === 'customer' && balance < -0.009) return `Аванс: ${fmt(Math.abs(balance))}`
  return fmt(balance)
}

function paymentActionLabel(row) {
  return row?.type === 'supplier' ? 'Оплатить' : 'Принять оплату'
}

function paymentDistributionLabel(entry, rowType) {
  const count = toNumber(entry?.payment_count)
  if (!entry?.is_group || count <= 1) return ''
  return `Распределено по ${count} ${rowType === 'supplier' ? 'приходам' : 'реализациям'}`
}

const GROUPED_PAYMENT_EDIT_WARNING = 'Это групповое погашение распределено по нескольким документам. Частичное редактирование недоступно. Отмените погашение целиком и создайте новое.'

function isMultiPaymentGroup(payment) {
  const count = toNumber(payment?.payment_count)
  return Boolean(payment?.is_group || ((payment?.group_id || payment?.debt_payment_group_id) && count > 1))
}

function paymentTitle(row) {
  return row?.type === 'supplier' ? 'Оплата поставщику' : 'Оплата клиента'
}

function entryDocumentType(entry, rowType) {
  if (entry.document_type) return entry.document_type
  if (rowType === 'supplier') return 'receipt'
  return 'sales_document'
}

function getOpenDocuments(row) {
  const documents = []
  normalizeArray(row?.entries).forEach((entry) => {
    const charge = roundMoney(entry.charge)
    const payment = entryPaymentAmount(entry)
    if (charge > 0 && entry.document_id) {
      documents.push({
        document_id: entry.document_id,
        document_type: entryDocumentType(entry, row?.type),
        date: entry.date,
        description: entry.description || operationKind(entry.kind),
        total: charge,
        remaining: charge,
      })
    }
    if (payment > 0) {
      let rest = payment
      for (const document of documents) {
        if (rest <= 0) break
        const applied = Math.min(document.remaining, rest)
        document.remaining = roundMoney(document.remaining - applied)
        rest = roundMoney(rest - applied)
      }
    }
  })
  return documents.filter(document => document.remaining > 0.009)
}

export default function Debts() {
  const [ledger, setLedger] = useState(emptyLedger)
  const [accounts, setAccounts] = useState([])
  const [activeTab, setActiveTab] = useState('customers')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [paymentTarget, setPaymentTarget] = useState(null)
  const [paymentForm, setPaymentForm] = useState(emptyPaymentForm())
  const [paymentError, setPaymentError] = useState('')
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [editPaymentTarget, setEditPaymentTarget] = useState(null)
  const [editPaymentForm, setEditPaymentForm] = useState(emptyPaymentForm())
  const [editPaymentError, setEditPaymentError] = useState('')
  const [editPaymentSaving, setEditPaymentSaving] = useState(false)
  const [cancellingGroupId, setCancellingGroupId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const normalizeLedgerData = (data) => ({
    summary: { ...emptyLedger.summary, ...(data?.summary || {}) },
    customers: normalizeArray(data?.customers),
    suppliers: normalizeArray(data?.suppliers),
    closed: normalizeArray(data?.closed),
    history: normalizeArray(data?.history),
  })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getDebtsLedger()
      const nextLedger = normalizeLedgerData(data)
      setLedger(nextLedger)
      return nextLedger
    } catch (e) {
      setLedger(emptyLedger)
      setError(e.message || 'Не удалось загрузить взаиморасчеты')
      return emptyLedger
    } finally {
      setLoading(false)
    }
  }

  const loadAccounts = async () => {
    try {
      setAccounts(normalizeArray(await api.getAccounts()))
    } catch (e) {
      setAccounts([])
    }
  }

  useEffect(() => {
    load()
    loadAccounts()
  }, [])

  const rows = useMemo(() => {
    const source = activeTab === 'history'
      ? (ledger.history.length ? ledger.history : [...ledger.customers, ...ledger.suppliers])
      : activeTab === 'suppliers'
        ? ledger.suppliers
        : ledger.customers
    const term = search.trim().toLowerCase()
    if (!term) return source
    return source.filter(row => (row.counterparty_name || '').toLowerCase().includes(term))
  }, [activeTab, ledger, search])

  const summary = ledger.summary || emptyLedger.summary
  const paymentDocuments = useMemo(() => getOpenDocuments(paymentTarget), [paymentTarget])
  const paymentAccount = accounts.find(account => String(account.id) === String(paymentForm.account_id))
  const paymentAmount = roundMoney(paymentForm.amount)
  const paymentDebt = roundMoney(paymentTarget?.balance)
  const paymentAfter = roundMoney(paymentDebt - paymentAmount)
  const paymentDisabled = paymentSaving ||
    !paymentTarget ||
    !paymentForm.account_id ||
    !(paymentAmount > 0) ||
    (paymentTarget?.type === 'supplier' && paymentAmount > paymentDebt + 0.009) ||
    (paymentTarget?.type === 'supplier' && paymentAccount && paymentAmount > toNumber(paymentAccount.balance) + 0.009)

  const openPayment = (row) => {
    const firstAccount = accounts[0]
    setPaymentTarget(row)
    setPaymentForm({
      account_id: firstAccount?.id ? String(firstAccount.id) : '',
      amount: hasOpenDebt(row) ? String(roundMoney(row.balance)) : '',
      date: todayIso(),
      comment: '',
    })
    setPaymentError('')
  }

  const setPaymentField = (key, value) => {
    setPaymentForm(form => ({ ...form, [key]: value }))
  }

  const closePayment = () => {
    if (paymentSaving) return
    setPaymentTarget(null)
    setPaymentForm(emptyPaymentForm())
    setPaymentError('')
  }

  const refreshAfterPayment = async () => {
    const nextLedger = await load()
    await loadAccounts()
    if (selected) {
      const updated = [...nextLedger.customers, ...nextLedger.suppliers, ...nextLedger.closed, ...nextLedger.history]
        .find(row => row.type === selected.type && String(row.counterparty_id) === String(selected.counterparty_id))
      setSelected(updated || null)
    }
  }

  const submitPayment = async () => {
    if (!paymentTarget) return
    const amount = roundMoney(paymentForm.amount)
    const debt = roundMoney(paymentTarget.balance)
    if (!paymentForm.account_id) {
      setPaymentError('Выберите кассу')
      return
    }
    if (!(amount > 0)) {
      setPaymentError('Сумма должна быть больше 0')
      return
    }
    if (paymentTarget.type === 'supplier' && amount > debt + 0.009) {
      setPaymentError('Сумма оплаты превышает текущий долг')
      return
    }
    if (paymentTarget.type === 'supplier' && paymentAccount && amount > toNumber(paymentAccount.balance) + 0.009) {
      setPaymentError('Недостаточно средств в кассе')
      return
    }

    setPaymentSaving(true)
    setPaymentError('')
    try {
      await api.payDebt({
        entity_type: paymentTarget.type === 'supplier' ? 'supplier' : 'client',
        entity_id: paymentTarget.counterparty_id,
        cashbox_id: paymentForm.account_id,
        amount,
        date: paymentForm.date || todayIso(),
        comment: paymentForm.comment || null,
      })
      setPaymentTarget(null)
      setPaymentForm(emptyPaymentForm())
      setPaymentError('')
      await refreshAfterPayment()
      alert('Оплата сохранена')
    } catch (e) {
      setPaymentError(e.message || 'Не удалось сохранить оплату')
    } finally {
      setPaymentSaving(false)
    }
  }

  const openEditPayment = async (entry) => {
    if (!entry?.payment_id) return
    try {
      const payments = normalizeArray(await api.getPayments())
      const payment = payments.find(row => String(row.id) === String(entry.payment_id))
      if (!payment) throw new Error('Платеж не найден')
      setEditPaymentTarget(payment)
      setEditPaymentForm({
        account_id: payment.cashbox_id ? String(payment.cashbox_id) : '',
        amount: String(payment.amount ?? entry.payment ?? ''),
        date: payment.date ? String(payment.date).slice(0, 10) : (entry.date || todayIso()),
        comment: payment.comment || entry.comment || '',
      })
      setEditPaymentError('')
    } catch (e) {
      alert(e.message || 'Не удалось открыть платеж')
    }
  }

  const closeEditPayment = () => {
    if (editPaymentSaving) return
    setEditPaymentTarget(null)
    setEditPaymentForm(emptyPaymentForm())
    setEditPaymentError('')
  }

  const setEditPaymentField = (key, value) => {
    setEditPaymentForm(form => ({ ...form, [key]: value }))
  }

  const submitEditPayment = async () => {
    if (!editPaymentTarget) return
    if (isMultiPaymentGroup(editPaymentTarget)) {
      setEditPaymentError(GROUPED_PAYMENT_EDIT_WARNING)
      return
    }
    const amount = roundMoney(editPaymentForm.amount)
    if (!editPaymentForm.account_id) {
      setEditPaymentError('Выберите кассу')
      return
    }
    if (!(amount > 0)) {
      setEditPaymentError('Сумма должна быть больше 0')
      return
    }
    if (!editPaymentForm.date) {
      setEditPaymentError('Укажите дату')
      return
    }

    setEditPaymentSaving(true)
    setEditPaymentError('')
    try {
      await api.updatePayment(editPaymentTarget.id, {
        amount,
        cashbox_id: editPaymentForm.account_id,
        date: editPaymentForm.date,
        comment: editPaymentForm.comment || null,
      })
      setEditPaymentTarget(null)
      setEditPaymentForm(emptyPaymentForm())
      await refreshAfterPayment()
      alert('Платеж обновлен')
    } catch (e) {
      setEditPaymentError(e.message || 'Не удалось обновить платеж')
    } finally {
      setEditPaymentSaving(false)
    }
  }

  const cancelDebtPayment = async (entry) => {
    if (!canCancelDebtPayment(entry)) return
    if (!window.confirm('Отменить погашение? Касса и долг будут пересчитаны.')) return
    setCancellingGroupId(entry.debt_payment_group_id)
    try {
      await api.cancelDebtPaymentGroup(entry.debt_payment_group_id)
      await refreshAfterPayment()
      if (editPaymentTarget?.debt_payment_group_id === entry.debt_payment_group_id) {
        setEditPaymentTarget(null)
        setEditPaymentForm(emptyPaymentForm())
        setEditPaymentError('')
      }
      alert('Погашение отменено')
    } catch (e) {
      alert(e.message || 'Не удалось отменить погашение')
    } finally {
      setCancellingGroupId('')
    }
  }

  const canCancelDebtPayment = (entry) => Boolean((entry?.payment_id || entry?.id) && entry.debt_payment_group_id && !entry.cancelled_at)
  const editPaymentLocked = isMultiPaymentGroup(editPaymentTarget)

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
          <span className={`badge ${hasClientAdvance(row) ? 'badge-primary' : toNumber(row.balance) > 0 ? 'badge-warning' : 'badge-success'}`}>
            {balanceLabel(row)}
          </span>
        </td>
        {activeTab !== 'history' && <td className="td-mono">{row.documents_count || 0}</td>}
        <td className="td-muted td-date">{formatDate(row.last_operation_date)}</td>
        {activeTab !== 'history' && (
          <td>
            <span className={`badge ${statusBadge(row)}`}>{statusLabel(row)}</span>
          </td>
        )}
        <td>
          <div className="td-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setSelected(row)}>Открыть</button>
            {activeTab !== 'history' && hasOpenDebt(row) && (
              <button className="btn btn-primary btn-sm" onClick={() => openPayment(row)}>
                {paymentActionLabel(row)}
              </button>
            )}
          </div>
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
          <div className="balance-card-label">Авансы клиентов</div>
          <div className="balance-card-value" style={{ color: '#60a5fa' }}>{fmt(summary.client_advances)}</div>
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
                <th>Действия</th>
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
          footer={
            <>
              {hasOpenDebt(selected) && (
                <button className="btn btn-primary" onClick={() => openPayment(selected)}>
                  {paymentActionLabel(selected)}
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setSelected(null)}>Закрыть</button>
            </>
          }
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
              <div className="balance-card-label">{hasClientAdvance(selected) ? 'Текущий аванс' : 'Текущий остаток'}</div>
              <div className={`balance-card-value ${hasClientAdvance(selected) ? 'positive' : toNumber(selected.balance) > 0 ? 'negative' : 'positive'}`}>
                {balanceLabel(selected)}
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
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {normalizeArray(selected.entries).length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state"><p>Истории нет</p></div>
                    </td>
                  </tr>
                ) : normalizeArray(selected.entries).map((entry, index) => (
                  <tr key={`${entry.kind}-${entry.document_id || 'payment'}-${index}`} className={entry.cancelled_at ? 'row-cancelled' : ''}>
                    <td className="td-muted td-date">{formatDate(entry.date)}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{entry.description || operationKind(entry.kind)}</div>
                      <div className="td-muted">
                        {operationKind(entry.kind)}
                        {entry.debt_payment_group_id ? ' · Групповое погашение' : ''}
                      </div>
                      {paymentDistributionLabel(entry, selected.type) && (
                        <div className="td-muted">{paymentDistributionLabel(entry, selected.type)}</div>
                      )}
                      {entry.cancelled_at && <span className="badge badge-neutral">Отменён</span>}
                    </td>
                    <td className="td-mono">{fmtPlain(entry.charge)}</td>
                    <td className="td-mono">
                      {fmtPlain(entry.payment)}
                      {entry.cancelled_at && <div className="td-muted">не влияет на остаток</div>}
                    </td>
                    <td>
                      <span className={`badge ${toNumber(entry.balance_after) > 0 ? 'badge-warning' : 'badge-success'}`}>
                        {runningBalanceLabel(selected.type, entry.balance_after)}
                      </span>
                    </td>
                    <td className="td-muted">
                      {entry.comment || '—'}
                      {entry.cancelled_reason && <div>Причина отмены: {entry.cancelled_reason}</div>}
                    </td>
                    <td>
                      {entry.kind === 'payment' && entry.payment_id ? (
                        <div className="td-actions">
                          <button className="btn btn-secondary btn-sm" onClick={() => openEditPayment(entry)} disabled={Boolean(entry.cancelled_at)}>
                            Редактировать
                          </button>
                          {entry.cancelled_at ? (
                            <button className="btn btn-secondary btn-sm" disabled>
                              Отменено
                            </button>
                          ) : canCancelDebtPayment(entry) ? (
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => cancelDebtPayment(entry)}
                              disabled={cancellingGroupId === entry.debt_payment_group_id}
                            >
                              {cancellingGroupId === entry.debt_payment_group_id ? 'Отмена...' : 'Отменить'}
                            </button>
                          ) : (
                            <button
                              className="btn btn-secondary btn-sm"
                              disabled
                              title="Старое погашение без группы нельзя отменить автоматически"
                            >
                              Старое погашение
                            </button>
                          )}
                        </div>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {paymentTarget && (
        <Modal
          title={paymentTitle(paymentTarget)}
          onClose={closePayment}
          footer={
            <>
              <button className="btn btn-secondary" onClick={closePayment} disabled={paymentSaving}>Отмена</button>
              <button className="btn btn-primary" onClick={submitPayment} disabled={paymentDisabled}>
                {paymentSaving ? 'Сохранение...' : paymentActionLabel(paymentTarget)}
              </button>
            </>
          }
        >
          {paymentError && <div className="alert alert-error">{paymentError}</div>}

          <div className="record-meta" style={{ marginBottom: 14 }}>
            <span>{typeLabel(paymentTarget.type)}</span>
            <strong>{paymentTarget.counterparty_name || '—'}</strong>
          </div>

          <div className="balance-grid" style={{ marginBottom: 18 }}>
            <div className="balance-card">
              <div className="balance-card-label">Текущий долг</div>
              <div className="balance-card-value negative">{fmt(paymentTarget.balance)}</div>
            </div>
            <div className="balance-card">
              <div className="balance-card-label">После оплаты</div>
              <div className={`balance-card-value ${paymentAfter > 0.009 ? 'negative' : 'positive'}`}>
                {paymentTarget.type === 'customer' && paymentAfter < -0.009
                  ? `Аванс: ${fmt(Math.abs(paymentAfter))}`
                  : fmt(Math.max(0, paymentAfter))}
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Касса</label>
            <select className="form-select" value={paymentForm.account_id} onChange={e => setPaymentField('account_id', e.target.value)}>
              <option value="">— Выберите кассу —</option>
              {accounts.map(account => (
                <option key={account.id} value={String(account.id)}>
                  {account.name} · {account.currency || 'USD'} · {fmt(account.balance)}
                </option>
              ))}
            </select>
            {paymentTarget.type === 'supplier' && paymentAccount && (
              <div className="td-muted" style={{ fontSize: 12, marginTop: 6 }}>
                Доступно в кассе: {fmt(paymentAccount.balance)}
              </div>
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Сумма оплаты</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="form-input"
                value={paymentForm.amount}
                onChange={e => setPaymentField('amount', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Дата</label>
              <input
                type="date"
                className="form-input"
                value={paymentForm.date}
                onChange={e => setPaymentField('date', e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Комментарий</label>
            <textarea
              className="form-textarea"
              value={paymentForm.comment}
              onChange={e => setPaymentField('comment', e.target.value)}
              placeholder={paymentTarget.type === 'supplier' ? 'Оплата поставщику' : 'Оплата клиента'}
            />
          </div>

          <div className="td-muted" style={{ fontSize: 13, marginTop: 8 }}>
            {paymentTarget.type === 'supplier'
              ? 'Оплата будет автоматически распределена по открытым документам от старых к новым.'
              : 'Оплата будет автоматически распределена по открытым документам от старых к новым. Сумма сверх долга станет авансом клиента.'}
          </div>

          <div style={{ fontWeight: 700, margin: '16px 0 10px' }}>Открытые документы</div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Документ</th>
                  <th>Остаток</th>
                </tr>
              </thead>
              <tbody>
                {paymentDocuments.length === 0 ? (
                  <tr><td colSpan={3}><div className="empty-state"><p>Открытых документов нет</p></div></td></tr>
                ) : paymentDocuments.map(document => (
                  <tr key={`${document.document_type}-${document.document_id}`}>
                    <td className="td-date td-muted">{formatDate(document.date)}</td>
                    <td>{document.description}</td>
                    <td className="td-mono">{fmt(document.remaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {editPaymentTarget && (
        <Modal
          title="Редактировать платеж"
          onClose={closeEditPayment}
          footer={
            <>
              {editPaymentLocked && canCancelDebtPayment(editPaymentTarget) && (
                <button
                  className="btn btn-danger"
                  onClick={() => cancelDebtPayment(editPaymentTarget)}
                  disabled={editPaymentSaving || cancellingGroupId === editPaymentTarget.debt_payment_group_id}
                >
                  {cancellingGroupId === editPaymentTarget.debt_payment_group_id ? 'Отмена...' : 'Отменить погашение целиком'}
                </button>
              )}
              <button className="btn btn-secondary" onClick={closeEditPayment} disabled={editPaymentSaving}>
                {editPaymentLocked ? 'Закрыть' : 'Отмена'}
              </button>
              {!editPaymentLocked && (
                <button className="btn btn-primary" onClick={submitEditPayment} disabled={editPaymentSaving}>
                  {editPaymentSaving ? 'Сохранение...' : 'Сохранить'}
                </button>
              )}
            </>
          }
        >
          {editPaymentError && <div className="alert alert-error">{editPaymentError}</div>}
          {editPaymentLocked && <div className="alert alert-info">{GROUPED_PAYMENT_EDIT_WARNING}</div>}
          <div className="record-meta" style={{ marginBottom: 14 }}>
            <span>Контрагент</span>
            <strong>{selected?.counterparty_name || editPaymentTarget.client_name || editPaymentTarget.supplier_name || '—'}</strong>
          </div>
          <div className="record-meta" style={{ marginBottom: 14 }}>
            <span>Тип</span>
            <strong>{editPaymentTarget.entity_type === 'purchase' ? 'Поставщик' : 'Клиент'}</strong>
          </div>
          <div className="record-meta" style={{ marginBottom: 14 }}>
            <span>Текущая сумма</span>
            <strong>{fmt(editPaymentTarget.amount)}</strong>
          </div>

          <div className="form-group">
            <label className="form-label">Касса</label>
            <select className="form-select" value={editPaymentForm.account_id} onChange={e => setEditPaymentField('account_id', e.target.value)} disabled={editPaymentLocked}>
              <option value="">— Выберите кассу —</option>
              {accounts.map(account => (
                <option key={account.id} value={String(account.id)}>
                  {account.name} · {account.currency || 'USD'} · {fmt(account.balance)}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Новая сумма оплаты</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="form-input"
                value={editPaymentForm.amount}
                onChange={e => setEditPaymentField('amount', e.target.value)}
                disabled={editPaymentLocked}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Дата</label>
              <input
                type="date"
                className="form-input"
                value={editPaymentForm.date}
                onChange={e => setEditPaymentField('date', e.target.value)}
                disabled={editPaymentLocked}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Комментарий</label>
            <textarea
              className="form-textarea"
              value={editPaymentForm.comment}
              onChange={e => setEditPaymentField('comment', e.target.value)}
              placeholder={editPaymentTarget.entity_type === 'purchase' ? 'Оплата поставщику' : 'Оплата клиента'}
              disabled={editPaymentLocked}
            />
          </div>

          {!editPaymentLocked && (
            <div className="alert alert-info">
              Можно изменить кассу, сумму, дату и комментарий выбранного платежа.
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
