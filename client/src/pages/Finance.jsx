import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Modal from '../components/Modal'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function FinanceCard({ label, value, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone || ''}`}>{fmt(value)}</div>
    </div>
  )
}

export default function Finance() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState(null)
  const [profitSummary, setProfitSummary] = useState(null)
  const [periodProfit, setPeriodProfit] = useState(null)
  const [audit, setAudit] = useState(null)
  const [periodFilters, setPeriodFilters] = useState({ date_from: '', date_to: '' })
  const [periodLoading, setPeriodLoading] = useState(false)
  const [debts, setDebts] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [accounts, setAccounts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [accountForm, setAccountForm] = useState({ name: '', currency: 'USD' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([api.getDebtsSummary(), api.getDebtsBySuppliers(), api.getAccounts(), api.getProfitSummary(), api.getDebts(), api.getTransactions(), api.getAudit()])
      .then(([summaryData, suppliersData, accountsData, profitData, debtsData, transactionsData, auditData]) => {
        console.log('Analytics data:', { summaryData, suppliersData, accountsData, profitData, debtsData, transactionsData, auditData })
        setSummary(summaryData && typeof summaryData === 'object' ? summaryData : {})
        setSuppliers(normalizeArray(suppliersData))
        setAccounts(normalizeArray(accountsData))
        setProfitSummary(profitData && typeof profitData === 'object' ? profitData : {})
        setPeriodProfit(profitData && typeof profitData === 'object' ? profitData : {})
        setDebts(normalizeArray(debtsData))
        setTransactions(normalizeArray(transactionsData))
        setAudit(auditData && typeof auditData === 'object' ? auditData : {})
      })
      .catch(() => {
        console.log('Analytics data:', null)
        setSummary({})
        setSuppliers([])
        setAccounts([])
        setProfitSummary({})
        setPeriodProfit({})
        setDebts([])
        setTransactions([])
        setAudit({})
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const createAccount = async () => {
    setSaving(true); setError('')
    try {
      await api.createAccount(accountForm)
      setAccountForm({ name: '', currency: 'USD' })
      setModal(null)
      await load()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const loadPeriodProfit = async (filters = periodFilters) => {
    setPeriodLoading(true)
    setError('')
    try {
      const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value))
      const result = await api.getProfitSummary(params)
      setPeriodProfit(result && typeof result === 'object' ? result : {})
    } catch (e) {
      setError(e.message || 'Не удалось загрузить прибыль за период')
      setPeriodProfit({})
    } finally {
      setPeriodLoading(false)
    }
  }

  const resetPeriodProfit = async () => {
    const empty = { date_from: '', date_to: '' }
    setPeriodFilters(empty)
    await loadPeriodProfit(empty)
  }

  if (loading) return <div className="loading">Загрузка...</div>

  const safeDebts = normalizeArray(debts)
  const safeSuppliers = normalizeArray(suppliers)
  const safeAccounts = normalizeArray(accounts)
  const safeTransactions = normalizeArray(transactions)
  const receivable = toNumber(summary?.receivable?.total)
  const payable = toNumber(summary?.payable?.total)
  const supplierPayable = toNumber(summary?.supplier_payable?.total ?? safeDebts
    .filter(debt => debt.type === 'payable')
    .reduce((sum, debt) => sum + toNumber(debt.debt), 0))
  const clientAdvances = toNumber(summary?.client_advances?.total)
  const balance = receivable - payable
  const profit = toNumber(profitSummary?.profit)
  const cash = safeAccounts.reduce((sum, account) => sum + toNumber(account.balance), 0)
  const ownerContribution = safeTransactions
    .filter(transaction => transaction.type === 'owner_contribution')
    .reduce((sum, transaction) => sum + toNumber(transaction.amount), 0)
  const ownerWithdrawal = safeTransactions
    .filter(transaction => transaction.type === 'owner_withdrawal')
    .reduce((sum, transaction) => sum + toNumber(transaction.amount), 0)
  const ownerCapital = ownerContribution - ownerWithdrawal
  const auditControl = audit?.proposed_control_formula || {}
  const auditBridge = audit?.profit_reconciliation?.diagnostic_bridge || {}
  const inventoryAsset = toNumber(auditControl.inventory_asset ?? auditBridge.inventory_cost_gap?.gap)
  const manualBalanceAdjustments = toNumber(auditControl.manual_balance_adjustments ?? auditBridge.manual_balance_adjustments?.net)
  const baseAssets = cash + receivable
  const assets = baseAssets + inventoryAsset
  const liabilities = payable
  const control = assets - manualBalanceAdjustments - liabilities - profit - ownerCapital
  const legacyControl = baseAssets - liabilities - profit - ownerCapital
  const isOk = Math.abs(control) < 0.01

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Баланс</div>
          <div className="page-subtitle">Баланс бизнеса</div>
        </div>
        <div className="td-actions">
          <button className="btn btn-secondary" onClick={() => navigate('/audit')}>Перейти в аудит</button>
          <button className="btn btn-primary" onClick={() => setModal('account')}>+ Добавить кассу</button>
        </div>
      </div>

      <div className="stat-grid">
        <FinanceCard label="💰 Деньги" value={cash} tone={cash >= 0 ? 'positive' : 'negative'} />
        <FinanceCard label="📥 Нам должны" value={receivable} tone="positive" />
        <FinanceCard label="📤 Мы должны" value={payable} tone="negative" />
        <FinanceCard label="Авансы клиентов" value={clientAdvances} tone={clientAdvances > 0 ? 'negative' : ''} />
        <FinanceCard label="📊 Прибыль" value={profit} tone={profit >= 0 ? 'positive' : 'negative'} />
        <FinanceCard label="Капитал владельца" value={ownerCapital} tone={ownerCapital >= 0 ? 'positive' : 'negative'} />
        <FinanceCard label="Товарный актив" value={inventoryAsset} tone={inventoryAsset >= 0 ? 'positive' : 'negative'} />
        <FinanceCard label="Ручные корректировки" value={manualBalanceAdjustments} tone={manualBalanceAdjustments >= 0 ? 'negative' : 'positive'} />
        <FinanceCard label="🧮 Контроль" value={control} tone={isOk ? 'positive' : 'negative'} />
      </div>

      <div className={`alert ${isOk ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 20 }}>
        {isOk ? 'Баланс сошелся' : `Ошибка баланса: ${fmt(control)}`}
        <div style={{ marginTop: 8 }}>
          деньги + дебиторка: {fmt(baseAssets)} · товарный актив: {fmt(inventoryAsset)} · ручные балансировочные корректировки: {fmt(manualBalanceAdjustments)} · обязательства: {fmt(liabilities)} · поставщики: {fmt(supplierPayable)} · авансы клиентов: {fmt(clientAdvances)} · прибыль: {fmt(profit)} · капитал владельца: {fmt(ownerCapital)}
        </div>
        <div style={{ marginTop: 6 }}>
          Старая формула без товарного актива: {fmt(legacyControl)}
        </div>
      </div>

      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>Прибыль за период</div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-row" style={{ marginBottom: 12 }}>
          <div className="form-group">
            <label className="form-label">Дата с</label>
            <input type="date" className="form-input" value={periodFilters.date_from} onChange={e => setPeriodFilters(f => ({ ...f, date_from: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Дата по</label>
            <input type="date" className="form-input" value={periodFilters.date_to} onChange={e => setPeriodFilters(f => ({ ...f, date_to: e.target.value }))} />
          </div>
          <div className="form-group" style={{ justifyContent: 'flex-end' }}>
            <label className="form-label">&nbsp;</label>
            <div className="td-actions">
              <button className="btn btn-primary" onClick={() => loadPeriodProfit()} disabled={periodLoading}>
                {periodLoading ? 'Загрузка...' : 'Показать'}
              </button>
              <button className="btn btn-secondary" onClick={resetPeriodProfit} disabled={periodLoading}>Сбросить</button>
            </div>
          </div>
        </div>
        <div className="stat-grid">
          <FinanceCard label="Реализация за период" value={toNumber(periodProfit?.revenue)} tone="positive" />
          <FinanceCard label="Себестоимость за период" value={toNumber(periodProfit?.cost)} tone="negative" />
          <FinanceCard label="Расходы за период" value={toNumber(periodProfit?.manual_expenses ?? periodProfit?.expenses)} tone="negative" />
          <FinanceCard label="Прибыль за период" value={toNumber(periodProfit?.profit)} tone={toNumber(periodProfit?.profit) >= 0 ? 'positive' : 'negative'} />
          <div className="stat-card">
            <div className="stat-label">Реализаций / строк</div>
            <div className="stat-value">{toNumber(periodProfit?.sales_count)} / {toNumber(periodProfit?.items_count)}</div>
          </div>
        </div>
      </div>

      <div className="table-wrapper" style={{ marginBottom: 20 }}>
        <table>
          <thead>
            <tr>
              <th>Касса</th>
              <th>Валюта</th>
              <th>Остаток</th>
            </tr>
          </thead>
          <tbody>
            {safeAccounts.length === 0 && (
              <tr><td colSpan={3}>
                <div className="empty-state"><p>Кассы не созданы</p></div>
              </td></tr>
            )}
            {safeAccounts.map(a => (
              <tr key={a.id}>
                <td style={{ fontWeight: 600 }}>{a.name}</td>
                <td className="td-muted">{a.currency}</td>
                <td>
                  <span className={`badge ${toNumber(a.balance) >= 0 ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: 13 }}>
                    {fmt(a.balance)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Поставщик</th>
              <th>Долг</th>
            </tr>
          </thead>
          <tbody>
            {safeSuppliers.length === 0 && (
              <tr><td colSpan={2}>
                <div className="empty-state"><p>Долгов поставщикам нет</p></div>
              </td></tr>
            )}
            {safeSuppliers.map(s => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600 }}>{s.name}</td>
                <td>
                  <span className="badge badge-warning" style={{ fontSize: 13 }}>{fmt(s.debt)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal === 'account' && (
        <Modal
          title="Новая касса"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Отмена</button>
              <button className="btn btn-primary" onClick={createAccount} disabled={saving}>
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </>
          }
        >
          {error && <div className="alert alert-error">{error}</div>}
          <div className="form-group">
            <label className="form-label">Название <span className="required">*</span></label>
            <input className="form-input" value={accountForm.name} onChange={e => setAccountForm(f => ({ ...f, name: e.target.value }))} placeholder="Касса USD" autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Валюта <span className="required">*</span></label>
            <input className="form-input" value={accountForm.currency} onChange={e => setAccountForm(f => ({ ...f, currency: e.target.value }))} placeholder="USD" />
          </div>
        </Modal>
      )}
    </div>
  )
}
