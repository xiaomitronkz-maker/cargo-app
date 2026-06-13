import { useEffect, useState } from 'react'
import api from '../api'
import { formatDate, formatType, normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const today = () => new Date().toISOString().slice(0, 10)

const accountName = (tx) => {
  if (tx.type === 'income' || tx.type === 'owner_contribution' || tx.type === 'cash_adjustment_in') return tx.account_to_name || '—'
  if (tx.type === 'expense' || tx.type === 'withdraw' || tx.type === 'owner_withdrawal' || tx.type === 'cash_adjustment_out') return tx.account_from_name || '—'
  return `${tx.account_from_name || '—'} → ${tx.account_to_name || '—'}`
}

const OPERATION_TYPES = [
  { value: 'expense', label: 'Расход бизнеса', hint: 'Уменьшает кассу и прибыль' },
  { value: 'owner_contribution', label: 'Пополнение владельцем', hint: 'Увеличивает кассу и капитал владельца' },
  { value: 'owner_withdrawal', label: 'Снятие владельцем', hint: 'Уменьшает кассу и капитал владельца' },
  { value: 'cash_adjustment_in', label: 'Пополнение кассы', hint: 'Корректировка кассы. Увеличивает деньги, не влияет на прибыль и капитал владельца' },
  { value: 'cash_adjustment_out', label: 'Снятие с кассы', hint: 'Корректировка кассы. Уменьшает деньги, не влияет на прибыль и капитал владельца' },
  { value: 'transfer', label: 'Перевод между кассами', hint: 'Перемещает деньги между кассами, не влияет на прибыль' },
]

const EMPTY_FORM = {
  type: 'expense',
  account_from_id: '',
  account_to_id: '',
  cash_account_id: '',
  amount: '',
  date: today(),
  comment: '',
}

export default function Transactions() {
  const [transactions, setTransactions] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([api.getTransactions(), api.getAccounts()])
      .then(([transactionsData, accountsData]) => {
        setTransactions(normalizeArray(transactionsData))
        setAccounts(normalizeArray(accountsData))
      })
      .catch((e) => {
        setTransactions([])
        setAccounts([])
        setError(e.message || 'Не удалось загрузить движения')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const setF = (key, value) => setForm(f => ({ ...f, [key]: value }))
  const isTransfer = form.type === 'transfer'
  const isOutflow = form.type === 'owner_withdrawal' || form.type === 'cash_adjustment_out' || form.type === 'expense'
  const isInflow = form.type === 'owner_contribution' || form.type === 'cash_adjustment_in'
  const selectedOperationType = OPERATION_TYPES.find(type => type.value === form.type)
  const commentPlaceholder = form.type === 'expense'
    ? 'Например: аренда, упаковка, сервис'
    : form.type === 'owner_contribution'
      ? 'Например: пополнение владельцем'
      : form.type === 'owner_withdrawal'
        ? 'Например: снятие владельцем'
        : form.type === 'cash_adjustment_in'
          ? 'Например: корректировка остатка кассы'
          : form.type === 'cash_adjustment_out'
            ? 'Например: убрать лишний остаток кассы'
            : 'Например: перевод между кассами'
  const selectedAccount = accounts.find(account => String(account.id) === String(form.cash_account_id))
  const remaining = selectedAccount ? toNumber(selectedAccount.balance) - toNumber(form.amount) : 0

  const submit = async () => {
    setSaving(true)
    setError('')
    if (!(+form.amount > 0)) {
      setError('Сумма должна быть больше 0')
      setSaving(false)
      return
    }
    if (!form.date) {
      setError('Выберите дату')
      setSaving(false)
      return
    }
    if (isTransfer && (!form.account_from_id || !form.account_to_id)) {
      setError('Выберите кассы')
      setSaving(false)
      return
    }
    if (isTransfer && form.account_from_id === form.account_to_id) {
      setError('Кассы должны отличаться')
      setSaving(false)
      return
    }
    if (!isTransfer && !form.cash_account_id) {
      setError('Выберите кассу')
      setSaving(false)
      return
    }
    if (isOutflow && selectedAccount && remaining < 0) {
      setError('Недостаточно средств в кассе')
      setSaving(false)
      return
    }
    try {
      if (isTransfer) {
        await api.createTransaction({
          type: 'transfer',
          amount: form.amount,
          account_from_id: form.account_from_id,
          account_to_id: form.account_to_id,
          date: form.date,
          comment: form.comment,
        })
      } else {
        await api.createManualTransaction({
          type: form.type,
          cash_account_id: form.cash_account_id,
          amount: form.amount,
          date: form.date,
          comment: form.comment,
        })
      }
      setForm({ ...EMPTY_FORM, type: form.type, date: today() })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Движение денег</div>
          <div className="page-subtitle">{transactions.length} операций</div>
        </div>
        <button className="btn btn-secondary" onClick={load}>Обновить</button>
      </div>

      <div className="table-wrapper" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16 }}>
          <div className="form-group">
            <label className="form-label">Тип операции</label>
            <select className="form-input" value={form.type} onChange={e => setForm({ ...EMPTY_FORM, type: e.target.value, date: form.date || today() })}>
              {OPERATION_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
            {selectedOperationType?.hint && (
              <div className="td-muted" style={{ fontSize: 12, marginTop: 6 }}>{selectedOperationType.hint}</div>
            )}
          </div>

          <div className="form-grid">
            {isTransfer ? (
              <>
                <div className="form-group">
                  <label className="form-label">Откуда</label>
                  <select className="form-input" value={form.account_from_id} onChange={e => setF('account_from_id', e.target.value)}>
                    <option value="">Выберите кассу</option>
                    {accounts.map(account => <option key={account.id} value={account.id}>{account.name} — {fmt(account.balance)}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Куда</label>
                  <select className="form-input" value={form.account_to_id} onChange={e => setF('account_to_id', e.target.value)}>
                    <option value="">Выберите кассу</option>
                    {accounts.map(account => <option key={account.id} value={account.id}>{account.name} — {fmt(account.balance)}</option>)}
                  </select>
                </div>
              </>
            ) : (
              <div className="form-group">
                <label className="form-label">{isInflow ? 'Куда: касса' : 'Откуда: касса'}</label>
                <select className="form-input" value={form.cash_account_id} onChange={e => setF('cash_account_id', e.target.value)}>
                  <option value="">Выберите кассу</option>
                  {accounts.map(account => <option key={account.id} value={account.id}>{account.name} — {fmt(account.balance)}</option>)}
                </select>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Сумма</label>
              <input type="number" min="0" step="0.01" className="form-input" value={form.amount} onChange={e => setF('amount', e.target.value)} placeholder="0.00" />
            </div>
            <div className="form-group">
              <label className="form-label">Дата</label>
              <input type="date" className="form-input" value={form.date} onChange={e => setF('date', e.target.value)} />
            </div>
          </div>
          <div className="record-meta" style={{ marginBottom: 10 }}>
            {isTransfer && <span>Списывается: {fmt(form.amount)}</span>}
            {isTransfer && <span>Поступает: {fmt(form.amount)}</span>}
            {isInflow && <span>Поступает: {fmt(form.amount)}</span>}
            {isOutflow && <span>Списывается: {fmt(form.amount)}</span>}
            {isOutflow && selectedAccount && (
              <span style={{ color: remaining >= 0 ? 'var(--success)' : 'var(--danger)' }}>Останется: {fmt(remaining)}</span>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">Комментарий</label>
            <input className="form-input" value={form.comment} onChange={e => setF('comment', e.target.value)} placeholder={commentPlaceholder} />
          </div>
          {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Сохранение...' : 'Добавить движение'}
          </button>
        </div>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Тип</th>
                <th>Сумма</th>
                <th>Счет</th>
                <th>Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="empty-state"><p>Движений нет</p></div>
                </td></tr>
              )}
              {transactions.map(tx => (
                <tr key={tx.id}>
                  <td className="td-muted td-date">{formatDate(tx.date)}</td>
                  <td><span className="badge badge-neutral">{formatType(tx.type)}</span></td>
                  <td className="td-mono">{fmt(tx.amount)}</td>
                  <td>{accountName(tx)}</td>
                  <td className="td-muted">{tx.comment || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
