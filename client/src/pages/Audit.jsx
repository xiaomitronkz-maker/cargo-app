import { useEffect, useState } from 'react'
import api from '../api'
import { formatType, normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ok = (n) => Math.abs(toNumber(n)) < 0.01
const COST_METHOD_LABELS = {
  actual_receipt_cost: 'Точная связь с приходом',
  legacy_fallback: 'Legacy fallback',
  product_average: 'Средняя по товару',
  unknown: 'Неизвестно',
}

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

function AuditBreakdown({ rows }) {
  return (
    <div className="stat-sub audit-breakdown">
      {rows.map(({ label, value, tone }) => (
        <div key={label}>
          {label}: <strong className={tone || ''}>{value}</strong>
        </div>
      ))}
    </div>
  )
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
  const profitReconciliation = data?.profit_reconciliation || {}
  const costMethodSummary = normalizeArray(data?.cost_method_summary)
  const supplierReconciliation = data?.supplier_reconciliation || {}
  const accountFactTotal = accounts.reduce((sum, account) => sum + toNumber(account.balance_actual ?? account.balance), 0)
  const accountCalculatedTotal = accounts.reduce((sum, account) => sum + toNumber(account.balance_calculated ?? account.recalculated_balance), 0)
  const accountDifference = accountFactTotal - accountCalculatedTotal
  const accountsDifference = accounts.reduce((sum, account) => {
    const actual = toNumber(account.balance_actual ?? account.balance)
    const calculated = toNumber(account.balance_calculated ?? account.recalculated_balance)
    return sum + Math.abs(toNumber(account.diff ?? account.difference ?? (actual - calculated)))
  }, 0)
  const accountsOk = ok(accountsDifference)
  const paymentsDifference = toNumber(payments.difference)
  const debtsDifference = toNumber(debts.diff ?? debts.difference)
  const legacyDebtsDifference = toNumber(debts.difference)
  const globalAccountsTotal = toNumber(global.accounts_total)
  const globalTransactionsTotal = toNumber(global.transactions_total)
  const globalDifference = toNumber(global.diff ?? (globalAccountsTotal - globalTransactionsTotal))
  const globalOk = global.ok ?? ok(globalDifference)
  const ownerContributionTotal = toNumber(data?.owner_contribution_total ?? global.owner_contribution_total)
  const ownerWithdrawalTotal = toNumber(data?.owner_withdrawal_total ?? global.owner_withdrawal_total)
  const ownerCapitalTotal = toNumber(data?.owner_capital_total ?? global.owner_capital_total ?? (ownerContributionTotal - ownerWithdrawalTotal))
  const ownerControl = toNumber(data?.control_with_owner_ops ?? global.control_with_owner_ops)
  const ownerControlOk = global.control_with_owner_ok ?? ok(ownerControl)
  const clientAdvancesTotal = toNumber(data?.client_advances_total ?? global.client_advances_total ?? debts.client_advances_total)
  const profitDifference = toNumber(profitReconciliation.profit_difference)
  const profitReconciliationOk = profitReconciliation.status === 'ok' || ok(profitDifference)
  const supplierDifference = toNumber(supplierReconciliation.ledger_difference ?? ((debts.supplier_payable_total || 0) - (debts.supplier_payable_ledger_total || 0)))
  const supplierBySuppliersDifference = toNumber(supplierReconciliation.by_suppliers_difference)
  const supplierOk = supplierReconciliation.status === 'ok' || (ok(supplierDifference) && ok(supplierBySuppliersDifference))

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
          <div className={`stat-value ${accountsOk ? 'positive' : 'negative'}`}>
            Расхождение: {fmt(accountDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Факт', value: fmt(accountFactTotal) },
            { label: 'Пересчитано', value: fmt(accountCalculatedTotal) },
            ...(!ok(accountsDifference - Math.abs(accountDifference)) ? [{ label: 'По кассам', value: fmt(accountsDifference) }] : []),
            { label: 'Касс проверено', value: accounts.length },
          ]} />
          <Status difference={accountsDifference} />
        </div>

        <div className="stat-card">
          <div className="stat-label">⚠️ Висящие транзакции</div>
          <div className={`stat-value ${orphanTransactions.length === 0 ? 'positive' : 'negative'}`}>
            {orphanTransactions.length}
          </div>
          <div className="stat-sub">подозрительные операции без допустимой связи</div>
          <StatusText isOk={orphanTransactions.length === 0} />
        </div>

        <div className="stat-card">
          <div className="stat-label">📊 Долги</div>
          <div className={`stat-value ${ok(debtsDifference) ? 'positive' : 'negative'}`}>
            Расхождение: {fmt(debtsDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Дебиторка', value: fmt(debts.receivable_system) },
            { label: 'Журнал', value: fmt(debts.receivable_ledger) },
          ]} />
          <Status difference={debtsDifference} />
        </div>

        <div className="stat-card">
          <div className="stat-label">🧮 Общий баланс</div>
          <div className={`stat-value ${globalOk ? 'positive' : 'negative'}`}>
            Расхождение: {fmt(globalDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Кассы', value: fmt(globalAccountsTotal) },
            { label: 'Движения', value: fmt(globalTransactionsTotal) },
          ]} />
          <StatusText isOk={globalOk} />
        </div>

        <div className="stat-card">
          <div className="stat-label">Оплаты и движения</div>
          <div className={`stat-value ${ok(paymentsDifference) ? 'positive' : 'negative'}`}>
            Расхождение: {fmt(paymentsDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Оплаты', value: fmt(payments.payments_total) },
            { label: 'Движения', value: fmt(payments.transactions_total) },
          ]} />
          <Status difference={paymentsDifference} />
        </div>

        <div className="stat-card">
          <div className="stat-label">Капитал владельца</div>
          <div className={`stat-value ${ownerCapitalTotal >= 0 ? 'positive' : 'negative'}`}>
            {fmt(ownerCapitalTotal)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Контроль', value: fmt(ownerControl), tone: ownerControlOk ? 'positive' : 'negative' },
            { label: 'Авансы клиентов', value: fmt(clientAdvancesTotal) },
            { label: 'Вложения', value: fmt(ownerContributionTotal) },
            { label: 'Снятия', value: fmt(ownerWithdrawalTotal) },
          ]} />
          <StatusText isOk={ownerControlOk} />
        </div>

        <div className="stat-card">
          <div className="stat-label">Долги по журналу</div>
          <div className={`stat-value ${ok(legacyDebtsDifference) ? 'positive' : 'negative'}`}>
            Расхождение: {fmt(legacyDebtsDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Дебиторка', value: fmt(debts.receivable_total) },
            { label: 'Журнал', value: fmt(debts.ledger_total) },
          ]} />
          <Status difference={legacyDebtsDifference} />
        </div>
      </div>

      <div className="stat-grid" style={{ marginTop: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Сверка прибыли</div>
          <div className={`stat-value ${profitReconciliationOk ? 'positive' : 'negative'}`}>
            Разница: {fmt(profitDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Прибыль по отчету', value: fmt(profitReconciliation.reported_profit) },
            { label: 'Прибыль по балансу', value: fmt(profitReconciliation.implied_profit) },
            { label: 'Формула', value: profitReconciliation.formula || 'cash + receivable - payable - owner_capital' },
          ]} />
          <StatusText isOk={profitReconciliationOk} />
        </div>

        <div className="stat-card">
          <div className="stat-label">Поставщики</div>
          <div className={`stat-value ${supplierOk ? 'positive' : 'negative'}`}>
            Расхождение: {fmt(supplierDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Debts summary', value: fmt(supplierReconciliation.summary_total ?? debts.supplier_payable_total) },
            { label: 'Ledger', value: fmt(supplierReconciliation.ledger_total ?? debts.supplier_payable_ledger_total) },
            { label: 'By suppliers', value: fmt(supplierReconciliation.by_suppliers_total) },
            ...(!ok(supplierBySuppliersDifference) ? [{ label: 'By suppliers diff', value: fmt(supplierBySuppliersDifference), tone: 'negative' }] : []),
          ]} />
          <StatusText isOk={supplierOk} />
        </div>
      </div>

      {!profitReconciliationOk && (
        <div className="alert alert-info" style={{ marginTop: 20 }}>
          {profitReconciliation.note || 'Прибыль по P&L отличается от балансной прибыли. Частая причина — продажи со средней/legacy себестоимостью без точной связи с приходом.'}
        </div>
      )}

      <div className="table-wrapper" style={{ marginTop: 20 }}>
        <table>
          <thead>
            <tr>
              <th>Метод</th>
              <th>Строк</th>
              <th>Выручка</th>
              <th>Себестоимость</th>
              <th>Прибыль</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {costMethodSummary.length === 0 && (
              <tr><td colSpan={6}>
                <div className="empty-state"><p>Данных по методам себестоимости нет</p></div>
              </td></tr>
            )}
            {costMethodSummary.map(row => {
              const isWarning = row.status === 'warning'
              return (
                <tr key={row.method}>
                  <td style={{ fontWeight: 600 }}>{COST_METHOD_LABELS[row.method] || row.method || 'Неизвестно'}</td>
                  <td className="td-mono">{toNumber(row.count).toLocaleString('ru-RU')}</td>
                  <td className="td-mono">{fmt(row.revenue)}</td>
                  <td className="td-mono">{fmt(row.cost)}</td>
                  <td className="td-mono">{fmt(row.profit)}</td>
                  <td>
                    <span className={`badge ${isWarning ? 'badge-warning' : 'badge-success'}`}>
                      {isWarning ? 'Проверить' : 'OK'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Касса</th>
              <th>Факт</th>
              <th>Пересчитано</th>
              <th>Расхождение</th>
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
                <td><span className="badge badge-danger">{formatType(tx.type)}</span></td>
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
          <div className="stat-sub">система: {fmt(debts.receivable_system)} · оплаты: {fmt(debts.receivable_ledger)}</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Поставщики</div>
          <div className={`stat-value ${supplierOk ? 'positive' : 'negative'}`}>
            {fmt(supplierDifference)}
          </div>
          <div className="stat-sub">summary: {fmt(supplierReconciliation.summary_total ?? debts.supplier_payable_total)} · ledger: {fmt(supplierReconciliation.ledger_total ?? debts.supplier_payable_ledger_total)}</div>
          <div className="stat-sub">авансы клиентов: {fmt(clientAdvancesTotal)}</div>
        </div>
      </div>
    </div>
  )
}
