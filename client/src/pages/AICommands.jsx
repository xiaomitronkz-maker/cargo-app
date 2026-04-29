import { useState, useRef, useEffect } from 'react'
import api from '../api'

const EXAMPLES = [
  'продай Жанибек 2 iphone по 650',
  'прибыль за неделю',
  'прибыль за месяц',
  'прибыль за сегодня',
  'должники',
  'баланс',
  'клиенты',
]

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function ResultCard({ result, onConfirmSale }) {
  const { type, message, data, suggestions } = result
  const isError = type === 'error' || type === 'help'
  const isSuccess = type === 'sale_preview' || type === 'analytics' || type === 'balance' || type === 'debtors' || type === 'clients'

  return (
    <div className={`ai-result ${isError ? 'type-error' : isSuccess ? 'type-success' : ''}`}>
      <div className="ai-result-msg">{message}</div>

      {type === 'sale_preview' && data && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
            <div>Клиент: <strong style={{ color: 'var(--text)' }}>{data.client_name}</strong></div>
            <div>Товар: <strong style={{ color: 'var(--text)' }}>{data.product_name}</strong></div>
            <div>Кол-во: <strong style={{ color: 'var(--text)' }}>{data.quantity} {data.sale_unit}</strong></div>
            <div>Цена/ед: <strong style={{ color: 'var(--text)' }}>{fmt(data.price_per_unit)}</strong></div>
            <div>Правило: <strong style={{ color: 'var(--text)' }}>{data.sale_type || 'не задано'}</strong></div>
            <div>Итого: <strong style={{ color: '#22c55e', fontSize: 15 }}>{fmt(data.total_amount)}</strong></div>
          </div>
          <button className="btn btn-primary" onClick={() => onConfirmSale(data)}>
            ✓ Подтвердить и сохранить продажу
          </button>
        </div>
      )}

      {type === 'analytics' && data && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 13 }}>
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>ПРОДАЖИ</div>
            <div style={{ fontWeight: 700, color: 'var(--primary-hover)' }}>{fmt(data.sales)}</div>
          </div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>ЗАТРАТЫ</div>
            <div style={{ fontWeight: 700, color: 'var(--danger)' }}>{fmt(data.costs)}</div>
          </div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>ПРИБЫЛЬ</div>
            <div style={{ fontWeight: 700, color: data.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmt(data.profit)}</div>
          </div>
        </div>
      )}

      {type === 'balance' && data && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 13 }}>
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>АКТИВЫ</div>
            <div style={{ fontWeight: 700, color: 'var(--success)' }}>{fmt(data.assets)}</div>
          </div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>ОБЯЗАТЕЛЬСТВА</div>
            <div style={{ fontWeight: 700, color: 'var(--danger)' }}>{fmt(data.liabilities)}</div>
          </div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>БАЛАНС</div>
            <div style={{ fontWeight: 700, color: data.balance >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmt(data.balance)}</div>
          </div>
        </div>
      )}

      {type === 'debtors' && data && data.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11 }}>Дата</th>
              <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11 }}>Сумма</th>
              <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11 }}>Комментарий</th>
            </tr>
          </thead>
          <tbody>
            {data.map(d => (
              <tr key={d.id}>
                <td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>{d.date}</td>
                <td style={{ padding: '4px 8px', fontWeight: 700, color: 'var(--danger)' }}>{fmt(d.amount)}</td>
                <td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>{d.comment || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {type === 'clients' && data && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {data.map(c => (
            <span key={c.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 13 }}>
              {c.name} {c.phone ? `· ${c.phone}` : ''}
            </span>
          ))}
        </div>
      )}

      {type === 'help' && suggestions && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Доступные команды:</div>
          {suggestions.map((s, i) => (
            <div key={i} style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)', padding: '2px 0' }}>→ {s}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AICommands() {
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [confirmSale, setConfirmSale] = useState(null)
  const [saleStatus, setSaleStatus] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const send = async (cmd = command) => {
    const c = cmd.trim()
    if (!c) return
    setLoading(true)
    try {
      const result = await api.sendCommand(c)
      setHistory(h => [{ command: c, result, ts: new Date().toLocaleTimeString('ru-RU') }, ...h])
      setCommand('')
    } catch (e) {
      setHistory(h => [{ command: c, result: { type: 'error', message: e.message }, ts: new Date().toLocaleTimeString('ru-RU') }, ...h])
    } finally { setLoading(false) }
  }

  const handleKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

  const handleConfirmSale = async (data) => {
    setSaleStatus(null)
    try {
      const today = new Date().toISOString().slice(0, 10)
      await api.createSale({
        date: today,
        client_id: data.client_id,
        product_id: data.product_id,
        sale_unit: data.sale_unit,
        quantity: data.quantity,
        price_per_unit: data.price_per_unit,
      })
      setSaleStatus({ ok: true, msg: `✓ Продажа сохранена: ${data.client_name} — ${data.product_name} — $${data.total_amount}` })
      setConfirmSale(null)
    } catch (e) {
      setSaleStatus({ ok: false, msg: `Ошибка: ${e.message}` })
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">AI Команды</div>
          <div className="page-subtitle">Управление через свободный ввод текста</div>
        </div>
      </div>

      {/* Input */}
      <div className="ai-input-wrap">
        <input
          ref={inputRef}
          className="ai-input"
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={handleKey}
          placeholder='Введите команду: "продай Жанибек 2 iphone по 650" или "прибыль за неделю"'
          disabled={loading}
        />
        <button className="btn btn-primary" onClick={() => send()} disabled={loading || !command.trim()}>
          {loading ? '...' : '→ Выполнить'}
        </button>
      </div>

      {/* Sale confirm status */}
      {saleStatus && (
        <div className={`alert ${saleStatus.ok ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 16 }}>
          {saleStatus.msg}
          <button className="btn btn-ghost btn-sm" onClick={() => setSaleStatus(null)} style={{ marginLeft: 8 }}>✕</button>
        </div>
      )}

      {/* Examples */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Примеры команд
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {EXAMPLES.map(ex => (
            <button key={ex} className="btn btn-secondary btn-sm" onClick={() => send(ex)}>
              {ex}
            </button>
          ))}
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            История команд
          </div>
          <div className="ai-history">
            {history.map((h, i) => (
              <div key={i}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                  <span style={{ fontFamily: 'monospace', color: 'var(--primary-hover)' }}>→ {h.command}</span>
                  <span style={{ marginLeft: 8 }}>{h.ts}</span>
                </div>
                <ResultCard result={h.result} onConfirmSale={handleConfirmSale} />
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length === 0 && (
        <div className="empty-state" style={{ marginTop: 40 }}>
          <div className="empty-icon">⌬</div>
          <p>Введите команду выше или нажмите на пример</p>
        </div>
      )}
    </div>
  )
}
