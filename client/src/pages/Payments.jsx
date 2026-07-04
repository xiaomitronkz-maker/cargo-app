import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import { formatDate, formatType, normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const typeMeta = {
  sale: { label: 'Реализация', badge: 'badge-success' },
  purchase: { label: 'Приход', badge: 'badge-warning' },
  client_advance: { label: 'Аванс клиента', badge: 'badge-primary' },
  client: { label: 'Клиент', badge: 'badge-success' },
  supplier: { label: 'Поставщик', badge: 'badge-warning' },
}
const GROUPED_PAYMENT_EDIT_WARNING = 'Это групповое погашение распределено по нескольким документам. Частичное редактирование недоступно. Отмените погашение целиком и создайте новое.'

const isMultiPaymentGroup = (payment) => {
  const count = toNumber(payment?.payment_count)
  return Boolean((payment?.group_id || payment?.debt_payment_group_id) && count > 1)
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

  const paymentCounterparty = (payment) => payment?.entity_name || (payment?.entity_type === 'purchase'
    ? (payment?.supplier_name || payment?.client_name || '—')
    : (payment?.client_name || payment?.supplier_name || '—'))
  const paymentTypeLabel = (payment) => ['purchase', 'supplier'].includes(payment?.entity_type) ? 'Поставщик' : 'Клиент'
  const paymentDocument = (payment) => {
    if (payment?.is_group) return `Распределён по ${payment.allocation_count || payment.payment_count || 0} документам`
    if (payment?.entity_type === 'client_advance') return 'Аванс клиента'
    return payment?.product_name || `Платеж №${payment?.id}`
  }
  const paymentStatus = (payment) => {
    if (payment?.cancelled_at) return 'Отменён'
    if (payment?.debt_payment_group_id) return 'Групповое погашение'
    if (isDebtPayment(payment)) return 'Старое погашение'
    return 'Активен'
  }
  const selectedAccount = accounts.find(account => String(account.id) === String(editForm.cashbox_id))
  const isSupplierPayment = ['purchase', 'supplier'].includes(editing?.entity_type)
  const isDebtPayment = (payment) => ['sale', 'purchase', 'client_advance', 'client', 'supplier'].includes(payment?.entity_type)
  const canCancelPayment = (payment) => isDebtPayment(payment) && Boolean(payment?.debt_payment_group_id) && !payment?.cancelled_at
  const canEditPayment = (payment) => !payment?.cancelled_at
  const editLocked = isMultiPaymentGroup(editing)

  const cancelPayment = async (payment) => {
    if (!canCancelPayment(payment)) return
    if (!window.confirm('Отменить погашение? Касса и долг будут пересчитаны.')) return
    setCancellingGroupId(payment.debt_payment_group_id)
    try {
      await api.cancelDebtPaymentGroup(payment.debt_payment_group_id)
      await load()
      if (editing?.debt_payment_group_id === payment.debt_payment_group_id) {
        setEditing(null)
        setEditForm({ amount: '', cashbox_id: '', date: '', comment: '' })
        setEditError('')
      }
      alert('Погашение отменено')
    } catch (e) {
      alert(e.message || 'Не удалось отменить погашение')
    } finally {
      setCancellingGroupId('')
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    if (isMultiPaymentGroup(editing)) {
      setEditError(GROUPED_PAYMENT_EDIT_WARNING)
      return
    }
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
        <div className="table-wrapper payments-table">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Контрагент</th>
                <th>Тип</th>
                <th>Документ/товар</th>
                <th>Сумма</th>
                <th>Касса</th>
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state"><p>Платежей нет</p></div>
                  </td>
                </tr>
              ) : payments.map(payment => (
                <tr key={payment.id} className={payment.cancelled_at ? 'row-cancelled' : ''}>
                  <td className="td-muted td-date">{formatDate(payment.date)}</td>
                  <td>{paymentCounterparty(payment)}</td>
                  <td>
                    <span className={`badge ${typeMeta[payment.entity_type]?.badge || 'badge-neutral'}`}>
                      {typeMeta[payment.entity_type]?.label || formatType(payment.entity_type)}
                    </span>
                    {payment.is_group && (
                      <span className="badge badge-primary" style={{ marginLeft: 6 }}>
                        Групповой
                      </span>
                    )}
                  </td>
                  <td>
                    <div>{paymentDocument(payment)}</div>
                    {payment.comment && <div className="td-muted">{payment.comment}</div>}
                    {payment.cancelled_reason && (
                      <div className="td-muted">Причина отмены: {payment.cancelled_reason}</div>
                    )}
                  </td>
                  <td className="td-mono">{fmt(payment.amount)}</td>
                  <td>{payment.account_name || '—'}</td>
                  <td>
                    <span className={`badge ${payment.cancelled_at ? 'badge-neutral' : payment.debt_payment_group_id ? 'badge-primary' : 'badge-warning'}`}>
                      {paymentStatus(payment)}
                    </span>
                  </td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(payment)} disabled={!canEditPayment(payment)}>
                        Редактировать
                      </button>
                      {payment.cancelled_at ? (
                        <button className="btn btn-secondary btn-sm" disabled>
                          Отменён
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal
          title="Редактировать платеж"
          onClose={closeEdit}
          footer={
            <>
              {editLocked && canCancelPayment(editing) && (
                <button
                  className="btn btn-danger"
                  onClick={() => cancelPayment(editing)}
                  disabled={saving || cancellingGroupId === editing.debt_payment_group_id}
                >
                  {cancellingGroupId === editing.debt_payment_group_id ? 'Отмена...' : 'Отменить погашение целиком'}
                </button>
              )}
              <button className="btn btn-secondary" onClick={closeEdit} disabled={saving}>
                {editLocked ? 'Закрыть' : 'Отмена'}
              </button>
              {!editLocked && (
                <button className="btn btn-primary" onClick={saveEdit} disabled={saving}>
                  {saving ? 'Сохранение...' : 'Сохранить'}
                </button>
              )}
            </>
          }
        >
          {editError && <div className="alert alert-error">{editError}</div>}
          {editLocked && <div className="alert alert-info">{GROUPED_PAYMENT_EDIT_WARNING}</div>}
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
            <select className="form-select" value={editForm.cashbox_id} onChange={e => setEditField('cashbox_id', e.target.value)} disabled={editLocked}>
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
                disabled={editLocked}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Дата <span className="required">*</span></label>
              <input
                type="date"
                className="form-input"
                value={editForm.date}
                onChange={e => setEditField('date', e.target.value)}
                disabled={editLocked}
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
              disabled={editLocked}
            />
          </div>

          {!editLocked && (
            <div className="alert alert-info">
              Можно изменить кассу, сумму, дату и комментарий выбранного платежа.
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
