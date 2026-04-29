import { useEffect, useState } from 'react'
import api from '../api'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const typeMeta = {
  sale: { label: 'sale', badge: 'badge-success' },
  purchase: { label: 'purchase', badge: 'badge-warning' },
}

export default function Payments() {
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    api.getPayments().then(setPayments).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

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
            <div className="record-card" key={payment.id}>
              <div className="record-card-main">
                <div>
                  <div className="record-title">{payment.client_name || 'Без клиента'}</div>
                  <div className="record-subtitle">{payment.product_name || 'Без товара'}</div>
                </div>
                <span className={`badge ${typeMeta[payment.entity_type]?.badge || 'badge-neutral'}`}>
                  {typeMeta[payment.entity_type]?.label || payment.entity_type}
                </span>
              </div>
              <div className="record-meta">
                <span>{payment.date}</span>
                <strong>{fmt(payment.amount)}</strong>
              </div>
              {payment.comment && <div className="record-note">{payment.comment}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
