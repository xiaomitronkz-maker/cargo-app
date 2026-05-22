import { Fragment, useEffect, useMemo, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'
import { formatDate, normalizeArray, toNumber } from '../utils/data'

const fmtNum = (n, digits = 2) => (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const fmtMoney = (n) => '$' + fmtNum(n, 2)
const emptyItem = () => ({ product_id: '', weight: '', quantity: '', cost_almaty: '', cost_dubai: '', note: '' })
const itemTotalCost = (item) => item.total_cost != null && +item.total_cost > 0
  ? +item.total_cost
  : ((+item.weight || 0) * (+item.cost_dubai || 0)) + ((+item.quantity || 0) * (+item.cost_almaty || 0))
const receiptTotalCost = (receipt) => {
  const apiTotal = toNumber(receipt?.total_cost ?? receipt?.total_amount ?? receipt?.total_sum)
  if (apiTotal) return apiTotal
  return normalizeArray(receipt?.items).reduce((sum, item) => sum + itemTotalCost(item), 0)
}
const receiptDateKey = (value) => {
  if (!value) return 'no-date'
  const raw = String(value).trim()
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? 'no-date' : parsed.toISOString().slice(0, 10)
}
const compareReceiptDateKeysDesc = (a, b) => {
  if (a === b) return 0
  if (a === 'no-date') return 1
  if (b === 'no-date') return -1
  return b.localeCompare(a)
}
const receiptDateLabel = (key) => key === 'no-date' ? 'Без даты' : formatDate(key)
const receiptClientKey = (receipt) => receipt.client_id ? `id:${receipt.client_id}` : `name:${String(receipt.client_name || '').trim().toLowerCase()}`
const IMPORT_EMPTY = { url: '', date_from: '', date_to: '', supplier_id: '', mode: 'receipt_only' }
const STATUS_LABELS = {
  ready: 'Готово',
  marking_not_found: 'Маркировка не найдена',
  already_imported: 'Уже импортировано',
  partial: 'Частично',
}
const statusBadge = (status) => {
  if (status === 'ready') return 'badge-success'
  if (status === 'already_imported') return 'badge-neutral'
  if (status === 'partial') return 'badge-warning'
  return 'badge-danger'
}

export default function Receipts() {
  const [receipts, setReceipts] = useState([])
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ date: '', supplier_id: '', client_id: '', marking_id: '' })
  const [items, setItems] = useState([emptyItem()])
  const [suppliers, setSuppliers] = useState([])
  const [clients, setClients] = useState([])
  const [products, setProducts] = useState([])
  const [markings, setMarkings] = useState([])
  const [loading, setLoading] = useState(true)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importForm, setImportForm] = useState(IMPORT_EMPTY)
  const [importPreview, setImportPreview] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [importError, setImportError] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const [importCommitting, setImportCommitting] = useState(false)
  const [viewMode, setViewMode] = useState('dates')
  const [expandedDate, setExpandedDate] = useState(null)

  const load = () => {
    setLoading(true)
    api.getReceipts().then(setReceipts).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    Promise.all([api.getSuppliers(), api.getClients(), api.getProducts(), api.getMarkings()])
      .then(([suppliersData, clientsData, productsData, markingsData]) => {
        setSuppliers(normalizeArray(suppliersData))
        setClients(normalizeArray(clientsData))
        setProducts(normalizeArray(productsData))
        setMarkings(normalizeArray(markingsData))
      })
  }, [])

  const openReceipt = async (receipt) => {
    setDetailsLoading(true)
    try {
      setSelected(await api.getReceipt(receipt.id))
    } finally {
      setDetailsLoading(false)
    }
  }

  const resetForm = () => {
    setForm({ date: '', supplier_id: '', client_id: '', marking_id: '' })
    setItems([emptyItem()])
    setError('')
  }

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    resetForm()
  }

  const openCreate = () => {
    setSelected(null)
    setEditing(null)
    resetForm()
    setCreating(true)
  }

  const openEdit = async (receipt) => {
    setDetailsLoading(true)
    setError('')
    try {
      const data = await api.getReceipt(receipt.id)
      setEditing(data)
      setSelected(null)
      setForm({
        date: data.date || '',
        supplier_id: String(data.supplier_id || ''),
        client_id: String(data.client_id || ''),
        marking_id: String(data.marking_id || ''),
      })
      setItems((data.items || []).map(item => ({
        product_id: String(item.product_id || ''),
        weight: item.weight || '',
        quantity: item.quantity || '',
        cost_almaty: item.cost_almaty || '',
        cost_dubai: item.cost_dubai || '',
        ala_unit: item.ala_unit || '',
        class_code: item.class_code || '',
        note: item.note || '',
      })))
    } finally {
      setDetailsLoading(false)
    }
  }

  const setF = (key, value) => setForm(f => ({ ...f, [key]: value }))
  const setItemF = (index, key, value) => setItems(rows => rows.map((item, i) => i === index ? { ...item, [key]: value } : item))
  const addItem = () => setItems(rows => [...rows, emptyItem()])
  const removeItem = (index) => setItems(rows => rows.length === 1 ? rows : rows.filter((_, i) => i !== index))

  const saveReceipt = async () => {
    setSaving(true)
    setError('')
    try {
      if (items.length === 0) throw new Error('Добавьте хотя бы один товар')
      for (const item of items) {
        if (!item.product_id) throw new Error('Выберите товар в каждой строке')
      }
      if (editing) {
        await api.updateReceipt(editing.id, { ...form, items })
      } else {
        await api.createReceipt({ ...form, items })
      }
      closeForm()
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const deleteReceipt = async (receipt) => {
    if (!confirm('Удалить приход? Это действие нельзя отменить.')) return
    try {
      await api.deleteReceipt(receipt.id)
      setSelected(null)
      setEditing(null)
      await load()
    } catch (e) {
      console.error('Delete receipt failed:', e)
      alert(e?.message || 'Не удалось удалить приход')
    }
  }

  const openImport = () => {
    setImportForm(f => ({ ...IMPORT_EMPTY, supplier_id: f.supplier_id || '' }))
    setImportPreview(null)
    setImportResult(null)
    setImportError('')
    setImportOpen(true)
  }

  const loadImportPreview = async () => {
    setImportLoading(true)
    setImportError('')
    setImportResult(null)
    try {
      const data = await api.previewGoogleSheetsImport({
        url: importForm.url,
        date_from: importForm.date_from,
        date_to: importForm.date_to,
      })
      setImportPreview(data)
    } catch (e) {
      setImportPreview(null)
      setImportError(e.message || 'Не удалось загрузить данные')
    } finally {
      setImportLoading(false)
    }
  }

  const commitImport = async () => {
    const rows = normalizeArray(importPreview?.rows)
    if (!importForm.supplier_id) {
      setImportError('Выберите поставщика')
      return
    }
    if (rows.some(row => row.status === 'marking_not_found')) {
      setImportError('Есть строки без найденной маркировки')
      return
    }
    setImportCommitting(true)
    setImportError('')
    try {
      const result = await api.commitGoogleSheetsImport({
        supplier_id: importForm.supplier_id,
        mode: importForm.mode,
        rows,
      })
      setImportResult(result)
      await load()
    } catch (e) {
      setImportError(e.message || 'Не удалось создать приходы')
    } finally {
      setImportCommitting(false)
    }
  }

  const previewRows = normalizeArray(importPreview?.rows)
  const previewGroups = normalizeArray(importPreview?.groups)
  const debugSummary = importPreview?.debug_summary || null
  const hasMarkingProblems = previewRows.some(row => row.status === 'marking_not_found')
  const hasReadyRows = previewRows.some(row => row.status === 'ready')
  const sortedReceipts = useMemo(() => normalizeArray(receipts)
    .slice()
    .sort((a, b) => compareReceiptDateKeysDesc(receiptDateKey(a.date), receiptDateKey(b.date)) || toNumber(b.id) - toNumber(a.id)), [receipts])
  const dateGroups = useMemo(() => {
    const groups = new Map()
    sortedReceipts.forEach(receipt => {
      const key = receiptDateKey(receipt.date)
      if (!groups.has(key)) {
        groups.set(key, {
          date_key: key,
          documents_count: 0,
          clients: new Set(),
          items_count: 0,
          total_weight: 0,
          total_quantity: 0,
          total_cost: 0,
          receipts: [],
        })
      }
      const group = groups.get(key)
      group.documents_count += 1
      if (receiptClientKey(receipt) !== 'name:') group.clients.add(receiptClientKey(receipt))
      group.items_count += toNumber(receipt.items_count)
      group.total_weight += toNumber(receipt.total_weight)
      group.total_quantity += toNumber(receipt.total_quantity)
      group.total_cost += receiptTotalCost(receipt)
      group.receipts.push(receipt)
    })
    return Array.from(groups.values())
      .map(group => ({ ...group, clients_count: group.clients.size }))
      .sort((a, b) => compareReceiptDateKeysDesc(a.date_key, b.date_key))
  }, [sortedReceipts])
  const pageSummary = useMemo(() => ({
    documents: sortedReceipts.length,
    days: dateGroups.length,
    total_weight: dateGroups.reduce((sum, group) => sum + group.total_weight, 0),
    total_cost: dateGroups.reduce((sum, group) => sum + group.total_cost, 0),
  }), [sortedReceipts.length, dateGroups])
  const formItemTotalCost = (item) => {
    const product = products.find(p => String(p.id) === String(item.product_id))
    const productName = String(product?.name || '').toLowerCase()
    const isPhone = productName.includes('iphone') ||
      productName.includes('айфон') ||
      productName.includes('smartphone') ||
      productName.includes('телефон') ||
      /(^|[^a-z0-9])phone([^a-z0-9]|$)/i.test(productName)
    const weight = toNumber(item.weight)
    const quantity = toNumber(item.quantity)
    const alaBase = isPhone ? quantity : weight
    return (weight * toNumber(item.cost_dubai)) + (alaBase * toNumber(item.cost_almaty))
  }

  const renderReceiptsTable = (rows, { showDate = true, showQuantity = false } = {}) => (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            {showDate && <th>Дата</th>}
            <th>Поставщик</th>
            <th>Клиент</th>
            <th>Товаров</th>
            <th>Вес</th>
            {showQuantity && <th>Количество</th>}
            <th>Сумма</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={6 + (showDate ? 1 : 0) + (showQuantity ? 1 : 0)}>
              <div className="empty-state"><p>Документов прихода нет</p></div>
            </td></tr>
          )}
          {rows.map(receipt => (
            <tr key={receipt.id}>
              {showDate && <td className="td-muted td-date">{formatDate(receipt.date)}</td>}
              <td>{receipt.supplier_name || '—'}</td>
              <td>{receipt.client_name || '—'}</td>
              <td className="td-mono">{receipt.items_count || 0}</td>
              <td className="td-mono">{fmtNum(receipt.total_weight, 3)} кг</td>
              {showQuantity && <td className="td-mono">{fmtNum(receipt.total_quantity, 0)} шт</td>}
              <td><span className="badge badge-warning">{fmtMoney(receiptTotalCost(receipt))}</span></td>
              <td>
                <div className="td-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => openReceipt(receipt)} disabled={detailsLoading}>
                    Открыть
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => openEdit(receipt)} disabled={detailsLoading}>
                    ✏️ Редактировать
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => deleteReceipt(receipt)}>
                    🗑 Удалить
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Приходы</div>
          <div className="page-subtitle">
            {pageSummary.documents} документов · {pageSummary.days} дней · {fmtNum(pageSummary.total_weight, 3)} кг · {fmtMoney(pageSummary.total_cost)}
          </div>
        </div>
        <div className="td-actions">
          <button className="btn btn-secondary" onClick={openImport}>Импорт из Google Sheets</button>
          <button className="btn btn-primary" onClick={openCreate}>+ Добавить приход</button>
          <button className="btn btn-secondary" onClick={load}>Обновить</button>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab${viewMode === 'dates' ? ' active' : ''}`} onClick={() => setViewMode('dates')}>По датам</button>
        <button className={`tab${viewMode === 'list' ? ' active' : ''}`} onClick={() => setViewMode('list')}>Списком</button>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        viewMode === 'list' ? renderReceiptsTable(sortedReceipts) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Документов</th>
                  <th>Клиентов</th>
                  <th>Товаров</th>
                  <th>Общий вес</th>
                  <th>Общее количество</th>
                  <th>Общая сумма</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {dateGroups.length === 0 && (
                  <tr><td colSpan={8}>
                    <div className="empty-state"><p>Документов прихода нет</p></div>
                  </td></tr>
                )}
                {dateGroups.map(group => (
                  <Fragment key={group.date_key}>
                    <tr key={group.date_key}>
                      <td className="td-date">{receiptDateLabel(group.date_key)}</td>
                      <td className="td-mono">{group.documents_count}</td>
                      <td className="td-mono">{group.clients_count}</td>
                      <td className="td-mono">{group.items_count}</td>
                      <td className="td-mono">{fmtNum(group.total_weight, 3)} кг</td>
                      <td className="td-mono">{fmtNum(group.total_quantity, 0)} шт</td>
                      <td><span className="badge badge-warning">{fmtMoney(group.total_cost)}</span></td>
                      <td>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => setExpandedDate(expandedDate === group.date_key ? null : group.date_key)}
                        >
                          {expandedDate === group.date_key ? 'Скрыть' : 'Открыть'}
                        </button>
                      </td>
                    </tr>
                    {expandedDate === group.date_key && (
                      <tr key={`${group.date_key}-details`}>
                        <td colSpan={8}>
                          <div style={{ fontWeight: 700, marginBottom: 10 }}>Приходы за {receiptDateLabel(group.date_key)}</div>
                          {renderReceiptsTable(group.receipts, { showDate: false, showQuantity: true })}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {selected && (
        <Modal
          wide
          title={`Приход №${selected.id}`}
          onClose={() => setSelected(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setSelected(null)}>Закрыть</button>
              <button className="btn btn-danger" onClick={() => deleteReceipt(selected)}>Удалить</button>
            </>
          }
        >
          <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>📄 Приход №{selected.id}</div>
            <div className="record-meta" style={{ marginBottom: 6 }}>
              <span>Дата</span>
              <strong>{formatDate(selected.date)}</strong>
            </div>
            <div className="record-meta" style={{ marginBottom: 6 }}>
              <span>Поставщик</span>
              <strong>{selected.supplier_name || '—'}</strong>
            </div>
            <div className="record-meta" style={{ marginBottom: 0 }}>
              <span>Клиент</span>
              <strong>{selected.client_name || '—'}</strong>
            </div>
          </div>

          <div style={{ fontWeight: 700, marginBottom: 10 }}>📦 Товары</div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Количество</th>
                  <th>Вес</th>
                  <th>Дубай $/кг</th>
                  <th>ALA тариф</th>
                  <th>ALA ед.</th>
                  <th>Итого себест.</th>
                  <th>Заметка</th>
                </tr>
              </thead>
              <tbody>
                {(selected.items || []).map(item => (
                  <tr key={item.id}>
                    <td>{item.product_name || '—'}</td>
                    <td className="td-mono">{fmtNum(item.quantity, 0)} шт</td>
                    <td className="td-mono">{fmtNum(item.weight, 3)} кг</td>
                    <td className="td-mono">{fmtMoney(item.cost_dubai)}</td>
                    <td className="td-mono">{fmtMoney(item.cost_almaty)}</td>
                    <td><span className="badge badge-neutral">{item.ala_unit === 'pcs' ? 'шт' : 'кг'}</span></td>
                    <td><span className="badge badge-warning">{fmtMoney(itemTotalCost(item))}</span></td>
                    <td className="td-muted">{item.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', marginTop: 14 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Итого приход</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--warning)', fontFamily: 'monospace', marginLeft: 8 }}>
              {fmtMoney(receiptTotalCost(selected))}
            </span>
          </div>
        </Modal>
      )}

      {(editing || creating) && (
        <Modal
          wide
          title={editing ? `Редактировать приход №${editing.id}` : 'Добавить приход'}
          onClose={closeForm}
          footer={
            <>
              <button className="btn btn-secondary" onClick={closeForm}>Отмена</button>
              <button className="btn btn-primary" onClick={saveReceipt} disabled={saving}>
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </>
          }
        >
          {error && <div className="alert alert-error">{error}</div>}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Дата</label>
              <input type="date" className="form-input" value={form.date} onChange={e => setF('date', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Поставщик</label>
              <select className="form-select" value={form.supplier_id} onChange={e => setF('supplier_id', e.target.value)}>
                <option value="">— Выберите поставщика —</option>
                {suppliers.map(supplier => <option key={supplier.id} value={String(supplier.id)}>{supplier.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Клиент</label>
              <select className="form-select" value={form.client_id} onChange={e => { setF('client_id', e.target.value); setF('marking_id', '') }}>
                <option value="">— Выберите клиента —</option>
                {clients.map(client => <option key={client.id} value={String(client.id)}>{client.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Маркировка</label>
              <select className="form-select" value={form.marking_id} onChange={e => setF('marking_id', e.target.value)}>
                <option value="">— Без маркировки —</option>
                {markings
                  .filter(marking => !form.client_id || String(marking.client_id) === String(form.client_id))
                  .map(marking => <option key={marking.id} value={String(marking.id)}>{marking.marking} ({marking.client_name})</option>)}
              </select>
            </div>
          </div>

          {items.map((item, index) => (
            <div key={index} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
              <div className="record-meta" style={{ marginBottom: 12 }}>
                <strong>📦 Товар {index + 1}</strong>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeItem(index)} disabled={items.length === 1}>Удалить товар</button>
              </div>
              <div className="form-group">
                <label className="form-label">Товар</label>
                <select className="form-select" value={item.product_id} onChange={e => setItemF(index, 'product_id', e.target.value)}>
                  <option value="">— Выберите товар —</option>
                  {products.map(product => <option key={product.id} value={String(product.id)}>{product.name}</option>)}
                </select>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Вес (кг)</label>
                  <input type="number" min="0" step="0.001" className="form-input" value={item.weight} onChange={e => setItemF(index, 'weight', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Кол-во (шт)</label>
                  <input type="number" min="0" step="1" className="form-input" value={item.quantity} onChange={e => setItemF(index, 'quantity', e.target.value)} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">ALA тариф</label>
                  <input type="number" min="0" step="0.01" className="form-input" value={item.cost_almaty} onChange={e => setItemF(index, 'cost_almaty', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">DXB $/кг</label>
                  <input type="number" min="0" step="0.01" className="form-input" value={item.cost_dubai} onChange={e => setItemF(index, 'cost_dubai', e.target.value)} />
                </div>
              </div>
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Итого себестоимость</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--warning)', fontFamily: 'monospace', marginLeft: 8 }}>
                  {fmtMoney(formItemTotalCost(item))}
                </span>
              </div>
              <div className="form-group">
                <label className="form-label">Заметка</label>
                <textarea className="form-textarea" value={item.note} onChange={e => setItemF(index, 'note', e.target.value)} />
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-secondary" onClick={addItem}>+ Добавить товар</button>
        </Modal>
      )}

      {importOpen && (
        <Modal
          wide
          title="Импорт из Google Sheets"
          onClose={() => setImportOpen(false)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setImportOpen(false)}>Закрыть</button>
              <button
                className="btn btn-primary"
                onClick={commitImport}
                disabled={importCommitting || hasMarkingProblems || !hasReadyRows}
              >
                {importCommitting ? 'Создание...' : 'Создать приходы'}
              </button>
            </>
          }
        >
          {importError && <div className="alert alert-error">{importError}</div>}
          {importResult && (
            <div className="alert alert-success">
              Создано приходов: {importResult.created_receipts || 0} · импортировано строк: {importResult.imported_rows || 0} · пропущено дублей: {importResult.skipped_rows || 0}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Ссылка на Google Sheet</label>
            <input className="form-input" value={importForm.url} onChange={e => setImportForm(f => ({ ...f, url: e.target.value }))} placeholder="https://docs.google.com/spreadsheets/d/..." />
            <div className="td-muted" style={{ fontSize: 12, marginTop: 8 }}>
              Можно вставить ссылку на выделенный диапазон Google Sheets. Если даты не указаны, будут загружены все строки из выбранного диапазона.
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Дата с</label>
              <input type="date" className="form-input" value={importForm.date_from} onChange={e => setImportForm(f => ({ ...f, date_from: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Дата по</label>
              <input type="date" className="form-input" value={importForm.date_to} onChange={e => setImportForm(f => ({ ...f, date_to: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Поставщик</label>
              <select className="form-select" value={importForm.supplier_id} onChange={e => setImportForm(f => ({ ...f, supplier_id: e.target.value }))}>
                <option value="">— Выберите поставщика —</option>
                {suppliers.map(supplier => <option key={supplier.id} value={String(supplier.id)}>{supplier.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Режим</label>
              <select className="form-select" value={importForm.mode} onChange={e => setImportForm(f => ({ ...f, mode: e.target.value }))}>
                <option value="receipt_only">Только приход</option>
                <option value="receipt_and_sale" disabled>Приход + реализация — следующий этап</option>
              </select>
            </div>
          </div>
          <button className="btn btn-secondary" onClick={loadImportPreview} disabled={importLoading}>
            {importLoading ? 'Загрузка...' : 'Загрузить данные'}
          </button>

          {importPreview && (
            <>
              {debugSummary && (
                <div className="alert alert-info" style={{ marginTop: 16 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Диагностика импорта</div>
                  <div>Режим чтения: {debugSummary.read_mode || '—'}</div>
                  <div>Диапазон: {debugSummary.range || 'A:L'}</div>
                  <div>Строк прочитано: {debugSummary.rows_read || 0}</div>
                  <div>Найденные даты: {normalizeArray(debugSummary.dates_found).join(', ') || '—'}</div>
                  <div>Строк после фильтра: {debugSummary.rows_after_date_filter || 0}</div>
                  {normalizeArray(debugSummary.warnings).map(warning => (
                    <div key={warning} style={{ marginTop: 4 }}>{warning}</div>
                  ))}
                </div>
              )}

              {previewRows.length === 0 && (
                <div className="alert alert-info" style={{ marginTop: 16 }}>
                  Строк для импорта не найдено. Диапазон: {debugSummary?.range || '—'}, прочитано строк: {debugSummary?.rows_read || 0}, найденные даты: {normalizeArray(debugSummary?.dates_found).join(', ') || '—'}.
                  Проверьте дату или оставьте даты пустыми, если хотите импортировать весь выделенный диапазон.
                </div>
              )}

              <div className="stat-grid" style={{ marginTop: 16 }}>
                <div className="stat-card">
                  <div className="stat-label">Строк</div>
                  <div className="stat-value">{importPreview.summary?.rows_count || 0}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Готово</div>
                  <div className="stat-value positive">{importPreview.summary?.ready_count || 0}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Уже импортировано</div>
                  <div className="stat-value">{importPreview.summary?.already_imported_count || 0}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Проблемы</div>
                  <div className={`stat-value ${hasMarkingProblems ? 'negative' : 'positive'}`}>{importPreview.summary?.marking_not_found_count || 0}</div>
                </div>
              </div>

              <div style={{ fontWeight: 700, margin: '18px 0 10px' }}>Сводка будущих приходов</div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Маркировка</th>
                      <th>Клиент</th>
                      <th>Строк</th>
                      <th>Вес</th>
                      <th>Кол-во</th>
                      <th>Себестоимость app</th>
                      <th>Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewGroups.map(group => (
                      <tr key={`${group.date}-${group.marking}`}>
                        <td className="td-date">{formatDate(group.date)}</td>
                        <td>{group.marking}</td>
                        <td>{group.client_name || '—'}</td>
                        <td className="td-mono">{group.items_count}</td>
                        <td className="td-mono">{fmtNum(group.total_weight, 3)} кг</td>
                        <td className="td-mono">{fmtNum(group.total_quantity, 0)} шт</td>
                        <td><span className="badge badge-warning">{fmtMoney(group.app_total)}</span></td>
                        <td><span className={`badge ${statusBadge(group.status)}`}>{STATUS_LABELS[group.status] || group.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ fontWeight: 700, margin: '18px 0 10px' }}>Строки из Google Sheets</div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Маркировка</th>
                      <th>Клиент</th>
                      <th>Товар</th>
                      <th>PCS</th>
                      <th>KG</th>
                      <th>CLASS</th>
                      <th>Тариф</th>
                      <th>DXB $/кг</th>
                      <th>ALA</th>
                      <th>ALA ед.</th>
                      <th>Себест. app</th>
                      <th>TOTAL sheet</th>
                      <th>Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map(row => (
                      <tr key={`${row.spreadsheet_id}-${row.gid}-${row.source_row}`}>
                        <td className="td-date">{formatDate(row.date)}</td>
                        <td>{row.marking}</td>
                        <td>{row.client_name || '—'}</td>
                        <td>{row.product_name}</td>
                        <td className="td-mono">{fmtNum(row.quantity_pcs, 0)}</td>
                        <td className="td-mono">{fmtNum(row.weight_kg, 3)}</td>
                        <td>{row.class || '—'}</td>
                        <td>{row.tariff_name}</td>
                        <td className="td-mono">
                          <div>{fmtMoney(row.app_dxb_rate)}</div>
                          <div className="td-muted" style={{ fontSize: 11 }}>sheet: {fmtMoney(row.sheet_dxb_rate)}</div>
                        </td>
                        <td className="td-mono">
                          <div>{fmtMoney(row.app_ala_rate)}</div>
                          <div className="td-muted" style={{ fontSize: 11 }}>sheet: {fmtMoney(row.sheet_ala_rate)}</div>
                        </td>
                        <td><span className="badge badge-neutral">{row.app_ala_unit === 'pcs' ? 'шт' : 'кг'}</span></td>
                        <td><span className="badge badge-warning">{fmtMoney(row.app_total)}</span></td>
                        <td className="td-mono">{fmtMoney(row.sheet_total)}</td>
                        <td>
                          <span className={`badge ${statusBadge(row.status)}`}>{STATUS_LABELS[row.status] || row.status}</span>
                          {normalizeArray(row.warnings).map(warning => (
                            <div key={warning} className="td-muted" style={{ fontSize: 11, marginTop: 4 }}>{warning}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
