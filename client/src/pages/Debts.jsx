import { useEffect, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'

const today = () => new Date().toISOString().slice(0, 10)
const emptyPayment = () => ({ amount: '', date: today(), comment: '' })
const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const typeMeta = {
  receivable: { label: 'receivable', badge: 'badge-success', title: 'Нам должны' },
  payable: { label: 'payable', badge: 'badge-warning', title: 'Мы должны' },
}

export default function Debts() {
  const [debts, setDebts] = useState([])
  const [summary, setSummary] = useState({ receivable: { total: 0, count: 0 }, payable: { total: 0, count: 0 }, balance: 0 })
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [isMultiPayment, setIsMultiPayment] = useState(false)
  const [multiPayments, setMultiPayments] = useState([{ account_id: '', amount: '' }])
  const [form, setForm] = useState(emptyPayment())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [debtsData, summaryData, accountsData] = await Promise.all([
        api.getDebts(),
        api.getDebtsSummary(),
        api.getAccounts(),
      ])
      setDebts(debtsData)
      setSummary(summaryData)
      setAccounts(accountsData)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const openPay = async (debt) => {
    setSelected(debt)
    setForm({ ...emptyPayment(), amount: debt.debt })
    setSelectedAccountId('')
    setIsMultiPayment(false)
    setMultiPayments([{ account_id: '', amount: debt.debt }])
    setError('')
    setModal('pay')
    try {
      setAccounts(await api.getAccounts())
    } catch (e) {
      setError(e.message)
    }
  }

  const setF = (key, value) => setForm(f => ({ ...f, [key]: value }))
  const setMultiF = (index, key, value) => setMultiPayments(rows => rows.map((row, i) => i === index ? { ...row, [key]: value } : row))
  const addMultiPayment = () => setMultiPayments(rows => [...rows, { account_id: '', amount: '' }])
  const removeMultiPayment = (index) => setMultiPayments(rows => rows.length === 1 ? rows : rows.filter((_, i) => i !== index))

  const pay = async () => {
    setSaving(true)
    setError('')
    if (paymentError) {
      setError(paymentError)
      setSaving(false)
      return
    }
    try {
      if (isMultiPayment) {
        for (const payment of multiPayments) {
          const payload = { amount: payment.amount, date: form.date, comment: form.comment }
          if (selected.type === 'receivable') payload.account_to_id = payment.account_id
          else payload.account_from_id = payment.account_id
          if (selected.type === 'receivable') await api.paySale(selected.id, payload)
          else await api.payReceipt(selected.id, payload)
        }
      } else {
        const payload = { amount: form.amount, date: form.date, comment: form.comment }
        if (selected.type === 'receivable') payload.account_to_id = selectedAccountId
        else payload.account_from_id = selectedAccountId
        if (selected.type === 'receivable') await api.paySale(selected.id, payload)
        else await api.payReceipt(selected.id, payload)
      }
      setModal(null)
      setForm(emptyPayment())
      setSelectedAccountId('')
      setIsMultiPayment(false)
      setMultiPayments([{ account_id: '', amount: '' }])
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const debtName = (debt) => debt.type === 'payable'
    ? `${debt.document_label || `Приход №${debt.id}`} — ${debt.supplier_name || 'Без поставщика'}`
    : debt.client_name || 'Без клиента'
  const debtSubtitle = (debt) => debt.type === 'payable'
    ? debt.date || 'Без даты'
    : debt.product_name || 'Без товара'
  const amount = +form.amount || 0
  const selectedAccount = accounts.find(a => String(a.id) === selectedAccountId)
  const accountBalance = selectedAccount ? +selectedAccount.balance || 0 : 0
  const accountRemaining = selected?.type === 'payable' ? accountBalance - amount : accountBalance + amount
  const multiTotal = multiPayments.reduce((sum, payment) => sum + (+payment.amount || 0), 0)
  const displayedRemainingDebt = selected ? Math.max((+selected.debt || 0) - (isMultiPayment ? multiTotal : amount), 0) : 0
  const multiAccountIds = multiPayments.map(payment => payment.account_id).filter(Boolean)
  const hasDuplicateAccount = new Set(multiAccountIds).size !== multiAccountIds.length
  const multiBalanceError = selected?.type === 'payable' && multiPayments.some(payment => {
    const account = accounts.find(a => String(a.id) === payment.account_id)
    return account && (+account.balance || 0) < (+payment.amount || 0)
  })
  const multiPaymentError = modal === 'pay' && selected && isMultiPayment
    ? multiPayments.some(payment => !payment.account_id)
      ? 'Выберите кассу'
      : multiPayments.some(payment => !(+payment.amount > 0))
        ? 'Введите сумму'
        : hasDuplicateAccount
          ? 'Касса повторяется'
          : multiTotal > selected.debt
            ? 'Сумма больше долга'
            : multiBalanceError
              ? 'Недостаточно средств'
              : ''
    : ''
  const ordinaryPaymentError = selected
    ? !selectedAccountId
      ? 'Выберите кассу'
      : amount <= 0
        ? 'Введите сумму'
        : amount > selected.debt
          ? 'Сумма больше долга'
          : selected.type === 'payable' && accountRemaining < 0
            ? 'Недостаточно средств'
            : ''
    : ''
  const paymentError = modal === 'pay' && selected
    ? isMultiPayment ? multiPaymentError : ordinaryPaymentError
    : ''

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Долги</div>
          <div className="page-subtitle">{debts.length} открытых записей</div>
        </div>
      </div>

      <div className="balance-grid">
        <div className="balance-card">
          <div className="balance-card-label">Нам должны</div>
          <div className="balance-card-value" style={{ color: 'var(--success)' }}>{fmt(summary.receivable?.total)}</div>
        </div>
        <div className="balance-card">
          <div className="balance-card-label">Мы должны</div>
          <div className="balance-card-value" style={{ color: '#fbbf24' }}>{fmt(summary.payable?.total)}</div>
        </div>
        <div className="balance-card">
          <div className="balance-card-label">Баланс</div>
          <div className={`balance-card-value ${summary.balance >= 0 ? 'positive' : 'negative'}`}>{fmt(summary.balance)}</div>
        </div>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="record-grid">
          {debts.length === 0 && (
            <div className="empty-state record-empty"><p>Долгов нет</p></div>
          )}
          {debts.map(debt => (
            <div className="record-card" key={`${debt.type}-${debt.id}`}>
              <div className="record-card-main">
                <div>
                  <div className="record-title">{debtName(debt)}</div>
                  <div className="record-subtitle">{debtSubtitle(debt)}</div>
                </div>
                <span className={`badge ${typeMeta[debt.type]?.badge || 'badge-neutral'}`}>
                  {typeMeta[debt.type]?.label || debt.type}
                </span>
              </div>
              <div className="record-meta">
                <span className={`debt-type ${debt.type}`}>{typeMeta[debt.type]?.title}</span>
                <strong>{fmt(debt.debt)}</strong>
              </div>
              <button className="btn btn-primary record-action" onClick={() => openPay(debt)}>Оплатить</button>
            </div>
          ))}
        </div>
      )}

      {modal === 'pay' && (
        <Modal
          title="Оплатить долг"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Отмена</button>
              <button className="btn btn-primary" onClick={pay} disabled={saving || !!paymentError}>
                {saving ? 'Сохранение...' : 'Оплатить'}
              </button>
            </>
          }
        >
          {(error || paymentError) && <div className="alert alert-error">{error || paymentError}</div>}
          <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Название</div>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>{debtName(selected)}</div>
            {selected.type === 'payable' && (
              <div className="record-meta" style={{ marginBottom: 6 }}>
                <span>Дата</span>
                <strong>{selected.date || '—'}</strong>
              </div>
            )}
            <div className="record-meta" style={{ marginBottom: 6 }}>
              <span>Сумма долга</span>
              <strong>{fmt(selected.debt)}</strong>
            </div>
            <div className="record-meta" style={{ marginBottom: 0 }}>
              <span>После оплаты останется</span>
              <strong>{fmt(displayedRemainingDebt)}</strong>
            </div>
          </div>
          <div className="form-label" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="radio" checked={!isMultiPayment} onChange={() => setIsMultiPayment(false)} />
              Обычная оплата
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="radio" checked={isMultiPayment} onChange={() => setIsMultiPayment(true)} />
              Разбить по кассам
            </label>
          </div>
          {isMultiPayment ? (
            <>
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
                <div className="record-meta" style={{ marginBottom: 6 }}>
                  <span>Долг</span>
                  <strong>{fmt(selected.debt)}</strong>
                </div>
                <div className="record-meta" style={{ marginBottom: 6 }}>
                  <span>Введено</span>
                  <strong>{fmt(multiTotal)}</strong>
                </div>
                <div className="record-meta" style={{ marginBottom: 0 }}>
                  <span>Осталось</span>
                  <strong style={{ color: selected.debt - multiTotal >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmt(selected.debt - multiTotal)}</strong>
                </div>
              </div>
              {multiPayments.map((payment, index) => {
                const rowAccount = accounts.find(a => String(a.id) === payment.account_id)
                const rowRemaining = rowAccount ? (+rowAccount.balance || 0) - (+payment.amount || 0) : 0
                return (
                  <div className="form-grid" key={index} style={{ alignItems: 'end', marginBottom: 10 }}>
                    <div className="form-group">
                      <label className="form-label">Касса</label>
                      <select className="form-input" value={payment.account_id} onChange={e => setMultiF(index, 'account_id', e.target.value)}>
                        <option value="">— Выберите кассу —</option>
                        {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name} — {fmt(a.balance)}</option>)}
                      </select>
                      {rowAccount && selected.type === 'payable' && (
                        <div className="stat-sub" style={{ color: rowRemaining >= 0 ? 'var(--text-muted)' : 'var(--danger)' }}>
                          Останется: {fmt(rowRemaining)}
                        </div>
                      )}
                    </div>
                    <div className="form-group">
                      <label className="form-label">Сумма</label>
                      <input type="number" min="0" max={selected.debt} step="0.01" className="form-input" value={payment.amount} onChange={e => setMultiF(index, 'amount', e.target.value)} />
                    </div>
                    <button className="btn btn-secondary" onClick={() => removeMultiPayment(index)} disabled={multiPayments.length === 1}>Удалить</button>
                  </div>
                )
              })}
              <button className="btn btn-secondary" onClick={addMultiPayment} style={{ marginBottom: 14 }}>Добавить кассу</button>
            </>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">Сумма <span className="required">*</span></label>
                <input type="number" min="0" max={selected.debt} step="0.01" className="form-input" value={form.amount} onChange={e => setF('amount', e.target.value)} autoFocus />
              </div>
              <div className="form-group">
                <label className="form-label">
                  Касса <span className="required">*</span>
                </label>
                <select className="form-input" value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)}>
                  <option value="">— Выберите кассу —</option>
                  {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name} — {fmt(a.balance)}</option>)}
                </select>
              </div>
              {selectedAccount && (
                <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
                  <div className="record-meta" style={{ marginBottom: 6 }}>
                    <span>Доступно</span>
                    <strong>{fmt(accountBalance)}</strong>
                  </div>
                  <div className="record-meta" style={{ marginBottom: 6 }}>
                    <span>{selected.type === 'payable' ? 'Списывается' : 'Зачисляется'}</span>
                    <strong>{fmt(amount)}</strong>
                  </div>
                  <div className="record-meta" style={{ marginBottom: 0 }}>
                    <span>Останется</span>
                    <strong style={{ color: accountRemaining >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmt(accountRemaining)}</strong>
                  </div>
                </div>
              )}
            </>
          )}
          <div className="form-group">
            <label className="form-label">Дата</label>
            <input type="date" className="form-input" value={form.date} onChange={e => setF('date', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Комментарий</label>
            <textarea className="form-textarea" value={form.comment} onChange={e => setF('comment', e.target.value)} placeholder="Детали платежа" />
          </div>
        </Modal>
      )}
    </div>
  )
}
