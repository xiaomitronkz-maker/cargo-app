import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import { formatDate, formatType, normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const typeMeta = {
  sale: { label: 'Реализация', badge: 'badge-success' },
  purchase: { label: 'Приход', badge: 'badge-warning' },
  client_advance: { label: 'Аванс клиента', badge: 'badge-primary' },
}

export default function Payments() {
  const [payments, setPayments] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [editForm, setEditForm] = useState({ amount: '', cashbox_id: '', date: '', comment: '' })
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [cancellingGroupId, setCancellingGroupId] = useState('')

  const load = () => {
    setLoading(true)
    Promise.all([api.getPayments(), api.getAccounts()])
      .then(([paymentRows, accountRows]) => {
        setPayments(normalizeArray(paymentRows))
        setAccounts(normalizeArray(accountRows))
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const openEdit = (payment) => {
    setEditing(payment)
    setEditForm({
      amount: String(payment.amount ?? ''),
      cashbox_id: payment.cashbox_id ? String(payment.cashbox_id) : '',
      date: payment.date ? String(payment.date).slice(0, 10) : '',
      comment: payment.comment || '',
    })
    setEditError('')
  }

  const closeEdit = () => {
    if (saving) return
    setEditing(null)
    setEditForm({ amount: '', cashbox_id: '', date: '', comment: '' })
    setEditError('')
  }

  const setEditField = (key, value) => setEditForm(form => ({ ...form, [key]: value }))

  const paymentCounterparty = (payment) => payment?.client_name || payment?.supplier_name || '—'
  const paymentTypeLabel = (payment) => payment?.entity_type === 'purchase' ? 'Поставщик' : 'Клиент'
  const selectedAccount = accounts.find(account => String(account.id) === String(editForm.cashbox_id))
  const isSupplierPayment = editing?.entity_type === 'purchase'
  const isDebtPayment = (payment) => ['sale', 'purchase', 'client_advance'].includes(payment?.entity_type)
  const canCancelPayment = (payment) => isDebtPayment(payment) && Boolean(payment?.debt_payment_group_id) && !payment?.cancelled_at

  const cancelPayment = async (payment) => {
    if (!canCancelPayment(payment)) return
    if (!window.confirm('Отменить погашение? Касса и долг будут пересчитаны.')) return
    setCancellingGroupId(payment.debt_payment_group_id)
    try {
      await api.cancelDebtPaymentGroup(payment.debt_payment_group_id)
      await load()
      alert('Погашение отменено')
    } catch (e) {
      alert(e.message || 'Не удалось отменить погашение')
    } finally {
      setCancellingGroupId('')
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    const amount = toNumber(editForm.amount)
    if (!(amount > 0)) {
      setEditError('Сумма должна быть больше 0')
      return
    }
    if (!editForm.cashbox_id) {
      setEditError('Выберите кассу')
      return
    }
    if (!editForm.date) {
      setEditError('Укажите дату')
      return
    }

    setSaving(true)
    setEditError('')
    try {
      await api.updatePayment(editing.id, {
        amount,
        cashbox_id: editForm.cashbox_id,
        date: editForm.date,
        comment: editForm.comment || null,
      })
      setEditing(null)
      setEditForm({ amount: '', cashbox_id: '', date: '', comment: '' })
      setEditError('')
      await load()
      alert('Платеж обновлен')
    } catch (e) {
      setEditError(e.message || 'Не удалось обновить платеж')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Платежи</div>
          <div className="page-subtitle">{payments.length} записей</div>
        </div>
        <button className="btn btn-secondary" onClick={load}>Обновить</button>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="record-grid">
          {payments.length === 0 && (
            <div className="empty-state record-empty"><p>Платежей нет</p></div>
          )}
          {payments.map(payment => (
            <div className="record-card" key={payment.id} style={payment.cancelled_at ? { opacity: 0.62 } : undefined}>
              <div className="record-card-main">
                <div>
                  <div className="record-title">{payment.client_name || 'Без клиента'}</div>
                  <div className="record-subtitle">{payment.product_name || 'Без товара'}</div>
                </div>
                <div className="td-actions">
                  <span className={`badge ${typeMeta[payment.entity_type]?.badge || 'badge-neutral'}`}>
                    {typeMeta[payment.entity_type]?.label || formatType(payment.entity_type)}
                  </span>
                  {payment.cancelled_at && <span className="badge badge-neutral">Отменён</span>}
                </div>
              </div>
              <div className="record-meta">
                <span>{formatDate(payment.date)}</span>
                <strong>{fmt(payment.amount)}</strong>
              </div>
              <div className="record-meta">
                <span>Касса</span>
                <strong>{payment.account_name || '—'}</strong>
              </div>
              {payment.comment && <div className="record-note">{payment.comment}</div>}
              {payment.cancelled_reason && <div className="record-note">Причина отмены: {payment.cancelled_reason}</div>}
              <div className="td-actions" style={{ marginTop: 12 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => openEdit(payment)} disabled={payment.cancelled_at || payment.debt_payment_group_id}>
                  Редактировать
                </button>
                {payment.cancelled_at ? (
                  <button className="btn btn-secondary btn-sm" disabled>
                    Отменено
                  </button>
                ) : canCancelPayment(payment) ? (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => cancelPayment(payment)}
                    disabled={cancellingGroupId === payment.debt_payment_group_id}
                  >
                    {cancellingGroupId === payment.debt_payment_group_id ? 'Отмена...' : 'Отменить'}
                  </button>
                ) : isDebtPayment(payment) && (
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled
                    title="Старое погашение без группы нельзя отменить автоматически"
                  >
                    Старое погашение
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal
          title="Редактировать платеж"
          onClose={closeEdit}
          footer={
            <>
              <button className="btn btn-secondary" onClick={closeEdit} disabled={saving}>Отмена</button>
              <button className="btn btn-primary" onClick={saveEdit} disabled={saving}>
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </>
          }
        >
          {editError && <div className="alert alert-error">{editError}</div>}
          <div className="record-meta" style={{ marginBottom: 14 }}>
            <span>Контрагент</span>
            <strong>{paymentCounterparty(editing)}</strong>
          </div>
          <div className="record-meta" style={{ marginBottom: 14 }}>
            <span>Тип</span>
            <strong>{paymentTypeLabel(editing)}</strong>
          </div>
          <div className="record-meta" style={{ marginBottom: 14 }}>
            <span>Текущая сумма</span>
            <strong>{fmt(editing.amount)}</strong>
          </div>

          <div className="form-group">
            <label className="form-label">Касса <span className="required">*</span></label>
            <select className="form-select" value={editForm.cashbox_id} onChange={e => setEditField('cashbox_id', e.target.value)}>
              <option value="">— Выберите кассу —</option>
              {accounts.map(account => (
                <option key={account.id} value={String(account.id)}>
                  {account.name} · {account.currency || 'USD'} · {fmt(account.balance)}
                </option>
              ))}
            </select>
            {selectedAccount && (
              <div className="td-muted" style={{ fontSize: 12, marginTop: 6 }}>
                Текущий остаток кассы: {fmt(selectedAccount.balance)}
              </div>
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Новая сумма оплаты <span className="required">*</span></label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="form-input"
                value={editForm.amount}
                onChange={e => setEditField('amount', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Дата <span className="required">*</span></label>
              <input
                type="date"
                className="form-input"
                value={editForm.date}
                onChange={e => setEditField('date', e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Комментарий</label>
            <textarea
              className="form-textarea"
              value={editForm.comment}
              onChange={e => setEditField('comment', e.target.value)}
              placeholder={isSupplierPayment ? 'Оплата поставщику' : 'Оплата клиента'}
            />
          </div>

          <div className="alert alert-info">
            Если платеж был распределен по нескольким документам, сейчас редактируется только выбранная строка платежа.
          </div>
        </Modal>
      )}
    </div>
  )
}
