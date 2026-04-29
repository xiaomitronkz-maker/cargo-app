import { useEffect, useState } from 'react'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ok = (n) => Math.abs(toNumber(n)) < 0.01

function Status({ difference }) {
  return ok(difference)
    ? <span className="badge badge-success">OK</span>
    : <span className="badge badge-danger">Ошибка: {fmt(difference)}</span>
}

function StatusText({ isOk }) {
  return isOk
    ? <span className="badge badge-success">OK</span>
    : <span className="badge badge-danger">Ошибка</span>
}

export default function Audit() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    api.getAudit()
      .then((result) => {
        console.log('Analytics data:', result)
        setData(result && typeof result === 'object' ? result : {})
      })
      .catch(() => {
        console.log('Analytics data:', null)
        setData({})
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  if (loading) return <div className="loading">Загрузка...</div>

  const payments = data?.payments_vs_transactions || {}
  const accounts = normalizeArray(data?.accounts || data?.accounts_balance_check)
  const orphanTransactions = normalizeArray(data?.orphan_transactions)
  const debts = data?.debts_check || {}
  const global = data?.global_check || {}
  const accountsDifference = accounts.reduce((sum, account) => sum + Math.abs(toNumber(account.difference)), 0)
  const debtsDifference = debts.diff ?? debts.difference
  const globalDifference = toNumber(global.diff)
  const globalOk = global.ok ?? ok(globalDifference)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Аудит</div>
          <div className="page-subtitle">Жесткий контроль финансовой консистентности</div>
        </div>
        <button className="btn btn-secondary" onClick={load}>🔄 Перепроверить</button>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">💰 Кассы</div>
          <div className={`stat-value ${ok(accountsDifference) ? 'positive' : 'negative'}`}>
            {fmt(accountsDifference)}
          </div>
          <div className="stat-sub">{accounts.length} касс проверено</div>
          <Status difference={accountsDifference} />
        </div>

        <div className="stat-card">
          <div className="stat-label">⚠️ Висящие транзакции</div>
          <div className={`stat-value ${orphanTransactions.length === 0 ? 'positive' : 'negative'}`}>
            {orphanTransactions.length}
          </div>
          <div className="stat-sub">income без sale_id · expense без receipt_id</div>
          <StatusText isOk={orphanTransactions.length === 0} />
        </div>

        <div className="stat-card">
          <div className="stat-label">📊 Долги</div>
          <div className={`stat-value ${ok(debtsDifference) ? 'positive' : 'negative'}`}>
            {fmt(debtsDifference)}
          </div>
          <div className="stat-sub">клиенты и поставщики сверены с payments</div>
          <Status difference={debtsDifference} />
        </div>

        <div className="stat-card">
          <div className="stat-label">🧮 Общий баланс</div>
          <div className={`stat-value ${globalOk ? 'positive' : 'negative'}`}>
            {globalOk ? 'OK' : fmt(globalDifference)}
          </div>
          <div className="stat-sub">кассы: {fmt(global.accounts_total)} · transactions: {fmt(global.transactions_total)}</div>
          <StatusText isOk={globalOk} />
        </div>

        <div className="stat-card">
          <div className="stat-label">Payments vs Transactions</div>
          <div className={`stat-value ${ok(payments.difference) ? 'positive' : 'negative'}`}>
            {fmt(payments.difference)}
          </div>
          <div className="stat-sub">payments: {fmt(payments.payments_total)} · transactions: {fmt(payments.transactions_total)}</div>
          <Status difference={payments.difference} />
        </div>

        <div className="stat-card">
          <div className="stat-label">Долги legacy</div>
          <div className={`stat-value ${ok(debts.difference) ? 'positive' : 'negative'}`}>
            {fmt(debts.difference)}
          </div>
          <div className="stat-sub">дебиторка: {fmt(debts.receivable_total)} · ledger: {fmt(debts.ledger_total)}</div>
          <Status difference={debts.difference} />
        </div>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Касса</th>
              <th>Факт</th>
              <th>Пересчитано</th>
              <th>Разница</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr><td colSpan={5}>
                <div className="empty-state"><p>Кассы не созданы</p></div>
              </td></tr>
            )}
            {accounts.map(account => (
              <tr key={account.account_id || account.id}>
                <td style={{ fontWeight: 600 }}>{account.account_name || account.name}</td>
                <td>{fmt(toNumber(account.balance_actual ?? account.balance))}</td>
                <td>{fmt(toNumber(account.balance_calculated ?? account.recalculated_balance))}</td>
                <td style={{ fontWeight: 700, color: ok(toNumber(account.diff ?? account.difference)) ? 'var(--success)' : 'var(--danger)' }}>
                  {fmt(account.diff ?? account.difference)}
                </td>
                <td><Status difference={account.diff ?? account.difference} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrapper" style={{ marginTop: 20 }}>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Тип</th>
              <th>Сумма</th>
              <th>Комментарий</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {orphanTransactions.length === 0 && (
              <tr><td colSpan={5}>
                <div className="empty-state"><p>Висящих транзакций нет</p></div>
              </td></tr>
            )}
            {orphanTransactions.map(tx => (
              <tr key={tx.id}>
                <td className="td-mono">#{tx.id}</td>
                <td><span className="badge badge-danger">{tx.type}</span></td>
                <td className="td-mono">{fmt(tx.amount)}</td>
                <td className="td-muted">{tx.comment || '—'}</td>
                <td><span className="badge badge-danger">Нет связи</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="stat-grid" style={{ marginTop: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Клиенты</div>
          <div className={`stat-value ${ok((debts.receivable_system || 0) - (debts.receivable_ledger || 0)) ? 'positive' : 'negative'}`}>
            {fmt((debts.receivable_system || 0) - (debts.receivable_ledger || 0))}
          </div>
          <div className="stat-sub">system: {fmt(debts.receivable_system)} · payments: {fmt(debts.receivable_ledger)}</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Поставщики</div>
          <div className={`stat-value ${ok((debts.payable_system || 0) - (debts.payable_ledger || 0)) ? 'positive' : 'negative'}`}>
            {fmt((debts.payable_system || 0) - (debts.payable_ledger || 0))}
          </div>
          <div className="stat-sub">system: {fmt(debts.payable_system)} · payments: {fmt(debts.payable_ledger)}</div>
        </div>
      </div>
    </div>
  )
}
