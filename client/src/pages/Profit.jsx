import { useEffect, useState } from 'react'
import api from '../api'
import { toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
    const load = async () => {
      setLoading(true)
      try {
        const result = await api.getProfitSummary()
        console.log('Analytics data:', result)
        setData(result && typeof result === 'object' ? result : {})
      } catch (e) {
        console.log('Analytics data:', null)
        setData({})
      } finally {
        setLoading(false)
      }
    }
    load()
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
        <ProfitCard label="Выручка" value={toNumber(data?.revenue)} tone="positive" />
        <ProfitCard label="Себестоимость" value={toNumber(data?.cost)} tone="negative" />
        <ProfitCard label="Прибыль" value={toNumber(data?.profit)} tone={toNumber(data?.profit) >= 0 ? 'positive' : 'negative'} />
      </div>
    </div>
  )
}
