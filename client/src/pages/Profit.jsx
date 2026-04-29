import { useEffect, useState } from 'react'
import api from '../api'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function ProfitCard({ label, value, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone || ''}`}>{fmt(value)}</div>
    </div>
  )
}

export default function Profit() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getProfitSummary().then(setData).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Прибыль</div>
          <div className="page-subtitle">Выручка минус себестоимость</div>
        </div>
      </div>

      <div className="stat-grid">
        <ProfitCard label="Выручка" value={data?.revenue || 0} tone="positive" />
        <ProfitCard label="Себестоимость" value={data?.cost || 0} tone="negative" />
        <ProfitCard label="Прибыль" value={data?.profit || 0} tone={(data?.profit || 0) >= 0 ? 'positive' : 'negative'} />
      </div>
    </div>
  )
}
