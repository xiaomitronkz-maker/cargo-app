import { useEffect, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'
import { formatType, normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => {
  const value = toNumber(n)
  const normalized = Math.abs(value) < 0.005 ? 0 : value
  return '$' + normalized.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const ok = (n) => Math.abs(toNumber(n)) < 0.01
const COST_METHOD_LABELS = {
  manual_override: 'Ручная себестоимость',
  actual_receipt_cost: 'Точная связь с приходом',
  legacy_fallback: 'Legacy fallback',
  product_average: 'Средняя по товару',
  unknown: 'Неизвестно',
}

const fmtDate = (value) => {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('ru-RU')
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

function ProfitStatus({ status, isOk }) {
  if (isOk) return <span className="badge badge-success">OK</span>
  if (status === 'inventory_required') return <span className="badge badge-warning">Требует товарного учета</span>
  return <span className="badge badge-danger">Ошибка</span>
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
  const [costModal, setCostModal] = useState(null)
  const [costForm, setCostForm] = useState({ cost: '', reason: '' })
  const [costSaving, setCostSaving] = useState(false)
  const [costError, setCostError] = useState('')
  const [costNotice, setCostNotice] = useState('')

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

  const openCostModal = (row) => {
    setCostModal(row)
    setCostForm({ cost: String(toNumber(row.cost)), reason: '' })
    setCostError('')
    setCostNotice('')
  }

  const closeCostModal = () => {
    setCostModal(null)
    setCostForm({ cost: '', reason: '' })
    setCostError('')
  }

  const saveManualCost = async () => {
    if (!costModal?.sale_id) return
    const reason = costForm.reason.trim()
    if (!reason) {
      setCostError('Укажите причину ручной себестоимости.')
      return
    }
    setCostSaving(true)
    setCostError('')
    setCostNotice('')
    try {
      const result = await api.put(`/sales/${costModal.sale_id}/manual-cost`, {
        cost: costForm.cost,
        reason,
      })
      if (result?.warning) setCostNotice(result.warning)
      closeCostModal()
      await load()
    } catch (e) {
      setCostError(e.message || 'Не удалось сохранить себестоимость')
    } finally {
      setCostSaving(false)
    }
  }

  if (loading) return <div className="loading">Загрузка...</div>

  const payments = data?.payments_vs_transactions || {}
  const accounts = normalizeArray(data?.accounts || data?.accounts_balance_check)
  const orphanTransactions = normalizeArray(data?.orphan_transactions)
  const operationLogFailures = data?.operation_log_failures || {}
  const operationLogFailureRows = normalizeArray(operationLogFailures.recent)
  const operationLogFailureCount = toNumber(operationLogFailures.unresolved_count ?? operationLogFailures.count)
  const operationLogFailuresOk = operationLogFailures.status === 'ok' || operationLogFailureCount === 0
  const manualBalanceTables = data?.legacy_manual_balance_tables || data?.money_assets_liabilities_status || {}
  const manualAssetsCount = toNumber(manualBalanceTables.money_assets_count)
  const manualAssetsTotal = toNumber(manualBalanceTables.money_assets_total)
  const manualLiabilitiesCount = toNumber(manualBalanceTables.liabilities_count)
  const manualLiabilitiesTotal = toNumber(manualBalanceTables.liabilities_total)
  const manualBalanceTablesOk = manualBalanceTables.status === 'ok' || (
    manualAssetsCount === 0 &&
    manualLiabilitiesCount === 0 &&
    ok(manualAssetsTotal) &&
    ok(manualLiabilitiesTotal)
  )
  const debts = data?.debts_check || {}
  const global = data?.global_check || {}
  const profitReconciliation = data?.profit_reconciliation || {}
  const legacyProfitReconciliation = data?.legacy_profit_reconciliation || {}
  const costMethodSummary = normalizeArray(data?.cost_method_summary)
  const costMethodDetails = normalizeArray(data?.cost_method_details)
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
  const clientAdvancesTotal = toNumber(data?.client_advances_total ?? global.client_advances_total ?? debts.client_advances_total)
  const profitDifference = toNumber(profitReconciliation.profit_difference)
  const profitBridge = profitReconciliation.diagnostic_bridge || {}
  const inventoryCostGap = profitBridge.inventory_cost_gap || {}
  const manualBalanceAdjustments = profitBridge.manual_balance_adjustments || {}
  const bridgedDifference = toNumber(profitBridge.bridged_difference)
  const proposedControl = data?.proposed_control_formula || {}
  const proposedControlDifference = toNumber(proposedControl.proposed_difference)
  const proposedControlOk = proposedControl.status === 'ok' || ok(proposedControlDifference)
  const profitReconciliationOk = profitReconciliation.status === 'ok' || ok(profitDifference)
  const legacyProfitDifference = toNumber(legacyProfitReconciliation.profit_difference)
  const inventoryAsset = toNumber(proposedControl.inventory_asset ?? inventoryCostGap.gap)
  const manualBalanceAdjustmentNet = toNumber(proposedControl.manual_balance_adjustments ?? manualBalanceAdjustments.net)
  const ownerControlInventoryAware = ownerControl + inventoryAsset - manualBalanceAdjustmentNet
  const ownerControlInventoryAwareOk = ok(ownerControlInventoryAware)
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

      {costNotice && (
        <div className="alert alert-info" style={{ marginTop: 0, marginBottom: 20 }}>
          {costNotice}
        </div>
      )}

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
          <div className="stat-label">Журнал операций</div>
          <div className={`stat-value ${operationLogFailuresOk ? 'positive' : 'negative'}`}>
            {operationLogFailureCount}
          </div>
          <div className="stat-sub">незакрытые ошибки записи operation_logs</div>
          <StatusText isOk={operationLogFailuresOk} />
        </div>

        <div className="stat-card">
          <div className="stat-label">Ручные активы/обязательства</div>
          <div className={`stat-value ${manualBalanceTablesOk ? 'positive' : 'negative'}`}>
            {manualAssetsCount + manualLiabilitiesCount}
          </div>
          <AuditBreakdown rows={[
            { label: 'Ручные активы', value: `${manualAssetsCount} · ${fmt(manualAssetsTotal)}` },
            { label: 'Ручные обязательства', value: `${manualLiabilitiesCount} · ${fmt(manualLiabilitiesTotal)}` },
            { label: 'В формуле контроля', value: manualBalanceTables.included_in_control_formula ? 'участвуют' : 'не участвуют' },
          ]} />
          <StatusText isOk={manualBalanceTablesOk} />
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
            { label: 'Контроль', value: fmt(ownerControlInventoryAware), tone: ownerControlInventoryAwareOk ? 'positive' : 'negative' },
            { label: 'Старая формула', value: fmt(ownerControl) },
            { label: 'Авансы клиентов', value: fmt(clientAdvancesTotal) },
            { label: 'Вложения', value: fmt(ownerContributionTotal) },
            { label: 'Снятия', value: fmt(ownerWithdrawalTotal) },
          ]} />
          <StatusText isOk={ownerControlInventoryAwareOk} />
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
            { label: 'Формула', value: profitReconciliation.formula || 'cash + receivable + inventory_asset - payable - ownerCapital - manual_balance_adjustments' },
            { label: 'Товарный актив', value: fmt(inventoryAsset) },
            { label: 'Ручные балансировочные корректировки', value: fmt(manualBalanceAdjustmentNet) },
            { label: 'Bridge diff', value: fmt(bridgedDifference), tone: ok(bridgedDifference) ? 'positive' : 'negative' },
          ]} />
          <ProfitStatus status={profitReconciliation.status} isOk={profitReconciliationOk} />
        </div>

        <div className="stat-card">
          <div className="stat-label">Старая формула без товарного актива</div>
          <div className={`stat-value ${ok(legacyProfitDifference) ? 'positive' : 'negative'}`}>
            Разница: {fmt(legacyProfitDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Прибыль по отчету', value: fmt(legacyProfitReconciliation.profit_report) },
            { label: 'Прибыль по старой формуле', value: fmt(legacyProfitReconciliation.implied_profit) },
            { label: 'Формула', value: legacyProfitReconciliation.formula || 'cash + receivable - payable - ownerCapital' },
          ]} />
          <StatusText isOk={ok(legacyProfitDifference)} />
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

      <div className="stat-grid" style={{ marginTop: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Диагностика с учетом товарного актива</div>
          <div className={`stat-value ${proposedControlOk ? 'positive' : 'negative'}`}>
            Разница: {fmt(proposedControlDifference)}
          </div>
          <AuditBreakdown rows={[
            { label: 'Товарный актив', value: fmt(inventoryAsset) },
            { label: 'Ручные балансировочные корректировки', value: fmt(manualBalanceAdjustmentNet) },
            { label: 'Прибыль по диагностической формуле', value: fmt(proposedControl.proposed_implied_profit) },
            { label: 'Разница по диагностической формуле', value: fmt(proposedControlDifference), tone: proposedControlOk ? 'positive' : 'negative' },
          ]} />
          <StatusText isOk={proposedControlOk} />
        </div>
      </div>

      <div className="alert alert-info" style={{ marginTop: 20 }}>
        Старая формула не учитывала товар/остатки как актив, поэтому давала расхождение {fmt(legacyProfitDifference)}.
      </div>

      {!profitReconciliationOk && (
        <div className="alert alert-info" style={{ marginTop: 20 }}>
          {profitReconciliation.note || 'Прибыль по P&L отличается от балансной прибыли даже с учетом товарного актива и ручных балансировочных корректировок.'}
        </div>
      )}

      {!operationLogFailuresOk && (
        <div className="alert alert-error" style={{ marginTop: 20 }}>
          {operationLogFailures.note || 'Есть незакрытые ошибки записи operation_logs. Проверьте журнал аудита.'}
        </div>
      )}

      <div className={`alert ${manualBalanceTablesOk ? 'alert-info' : 'alert-error'}`} style={{ marginTop: 20 }}>
        {manualBalanceTables.note || 'Таблицы money_assets/liabilities используются только как справочные/диагностические и не включаются в формулу прибыли/контроля, чтобы избежать двойного учета.'}
      </div>

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
              const statusText = row.status === 'manual' ? 'Вручную' : (isWarning ? 'Проверить' : 'OK')
              return (
                <tr key={row.method}>
                  <td style={{ fontWeight: 600 }}>{COST_METHOD_LABELS[row.method] || row.method || 'Неизвестно'}</td>
                  <td className="td-mono">{toNumber(row.count).toLocaleString('ru-RU')}</td>
                  <td className="td-mono">{fmt(row.revenue)}</td>
                  <td className="td-mono">{fmt(row.cost)}</td>
                  <td className="td-mono">{fmt(row.profit)}</td>
                  <td>
                    <span className={`badge ${isWarning ? 'badge-warning' : 'badge-success'}`}>
                      {statusText}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {costMethodDetails.length > 0 && (
        <details open style={{ marginTop: 20 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, marginBottom: 10 }}>Строки для проверки</summary>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Метод</th>
                  <th>Дата</th>
                  <th>Клиент</th>
                  <th>Товар</th>
                  <th>Маркировка</th>
                  <th>Кол-во/кг</th>
                  <th>Выручка</th>
                  <th>Себестоимость</th>
                  <th>Прибыль</th>
                  <th>Причина</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {costMethodDetails.map(row => {
                  const amount = row.sale_unit === 'pcs'
                    ? `${toNumber(row.quantity).toLocaleString('ru-RU')} шт`
                    : `${toNumber(row.weight_kg).toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кг`
                  return (
                    <tr key={`${row.method}-${row.sale_id}`}>
                      <td><span className="badge badge-warning">{COST_METHOD_LABELS[row.method] || row.method || 'Неизвестно'}</span></td>
                      <td className="td-date">{fmtDate(row.sale_date || row.document_date)}</td>
                      <td>{row.client_name || '—'}</td>
                      <td>{row.product_name || '—'}</td>
                      <td>{row.marking_name || '—'}</td>
                      <td className="td-mono">{amount}</td>
                      <td className="td-mono">{fmt(row.revenue)}</td>
                      <td className="td-mono">{fmt(row.cost)}</td>
                      <td className="td-mono">{fmt(row.profit)}</td>
                      <td>
                        <div>{row.reason || '—'}</div>
                        <div className="td-muted" style={{ fontSize: 11, marginTop: 4 }}>
                          Продажа #{row.sale_id || '—'}
                          {row.sales_document_id ? ` · Документ #${row.sales_document_id}` : ''}
                          {row.source_row ? ` · source row ${row.source_row}` : ''}
                        </div>
                      </td>
                      <td>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => openCostModal(row)}>
                          Исправить себестоимость
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {operationLogFailureRows.length > 0 && (
        <details open style={{ marginTop: 20 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, marginBottom: 10 }}>Ошибки журнала операций</summary>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Операция</th>
                  <th>Сущность</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {operationLogFailureRows.map(row => (
                  <tr key={row.id}>
                    <td className="td-date">{fmtDate(row.created_at)}</td>
                    <td><span className="badge badge-warning">{row.operation_type || 'Неизвестно'}</span></td>
                    <td className="td-mono">
                      {row.entity_type || '—'}{row.entity_id ? ` #${row.entity_id}` : ''}
                    </td>
                    <td>{row.error_message || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

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

      {costModal && (
        <Modal
          title="Исправить себестоимость"
          onClose={closeCostModal}
          footer={
            <>
              <button className="btn btn-secondary" onClick={closeCostModal} disabled={costSaving}>Отмена</button>
              <button className="btn btn-primary" onClick={saveManualCost} disabled={costSaving}>
                {costSaving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </>
          }
        >
          {costError && <div className="alert alert-error">{costError}</div>}
          <div className="stat-sub audit-breakdown" style={{ marginBottom: 14 }}>
            <div>Дата: <strong>{fmtDate(costModal.sale_date || costModal.document_date)}</strong></div>
            <div>Клиент: <strong>{costModal.client_name || '—'}</strong></div>
            <div>Товар: <strong>{costModal.product_name || '—'}</strong></div>
            <div>Маркировка: <strong>{costModal.marking_name || '—'}</strong></div>
            <div>Выручка: <strong>{fmt(costModal.revenue)}</strong></div>
            <div>Текущая себестоимость: <strong>{fmt(costModal.cost)}</strong></div>
          </div>
          <div className="form-group">
            <label className="form-label">Новая себестоимость</label>
            <input
              type="number"
              min="0"
              step="0.01"
              className="form-input"
              value={costForm.cost}
              onChange={e => setCostForm(form => ({ ...form, cost: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Причина / комментарий *</label>
            <textarea
              className="form-textarea"
              required
              value={costForm.reason}
              onChange={e => setCostForm(form => ({ ...form, reason: e.target.value }))}
              placeholder="Например: сверено вручную по исходному приходу"
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
