import { useState, useEffect } from 'react'
import Modal, { ConfirmModal } from '../components/Modal'
import api from '../api'

const today = () => new Date().toISOString().slice(0, 10)
const EMPTY = { date: today(), client_id: '', marking_id: '', product_id: '', sale_unit: '', quantity: '', price_per_unit: '', notes: '' }
const fmt = (n) => n != null ? '$' + (+n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'

const UNIT_LABELS = { kg: 'кг', pcs: 'шт' }

export default function Sales() {
  const [sales, setSales] = useState([])
  const [clients, setClients] = useState([])
  const [products, setProducts] = useState([])
  const [markings, setMarkings] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ client_id: '', product_id: '', from_date: '', to_date: '' })
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [filteredMarkings, setFilteredMarkings] = useState([])
  const [currentProduct, setCurrentProduct] = useState(null)
  const [previewTotal, setPreviewTotal] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const loadRef = () => Promise.all([api.getClients(), api.getProducts(), api.getMarkings()])
    .then(([c, p, m]) => { setClients(c); setProducts(p); setMarkings(m) })

  const loadSales = () => api.getSales(
    Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
  ).then(setSales).finally(() => setLoading(false))

  useEffect(() => { loadRef() }, [])
  useEffect(() => { setLoading(true); loadSales() }, [filters])

  // Filter markings by selected client
  useEffect(() => {
    if (form.client_id) {
      setFilteredMarkings(markings.filter(m => String(m.client_id) === String(form.client_id)))
    } else {
      setFilteredMarkings(markings)
    }
  }, [form.client_id, markings])

  // Update current product on product change (for rule hint)
  useEffect(() => {
    if (form.product_id) {
      const p = products.find(p => String(p.id) === String(form.product_id))
      setCurrentProduct(p || null)
      // Auto-set sale_unit if rule is strict
      if (p?.sale_type === 'kg') setForm(f => ({ ...f, sale_unit: 'kg' }))
      else if (p?.sale_type === 'pcs') setForm(f => ({ ...f, sale_unit: 'pcs' }))
    } else {
      setCurrentProduct(null)
    }
  }, [form.product_id, products])

  // Preview total_amount
  useEffect(() => {
    const q = parseFloat(form.quantity)
    const p = parseFloat(form.price_per_unit)
    setPreviewTotal(!isNaN(q) && !isNaN(p) && q > 0 && p > 0 ? (q * p).toFixed(2) : null)
  }, [form.quantity, form.price_per_unit])

  const openCreate = () => { setForm(EMPTY); setError(''); setCurrentProduct(null); setModal('create') }
  const openEdit = (s) => {
    setSelected(s)
    setForm({
      date: s.date, client_id: String(s.client_id || ''), marking_id: String(s.marking_id || ''),
      product_id: String(s.product_id), sale_unit: s.sale_unit,
      quantity: s.quantity, price_per_unit: s.price_per_unit, notes: s.notes || ''
    })
    setError(''); setModal('edit')
  }
  const openDelete = (s) => { setSelected(s); setModal('delete') }

  const save = async () => {
    setSaving(true); setError('')
    try {
      // total_amount intentionally NOT sent — server computes it
      const payload = { ...form }
      delete payload.total_amount
      if (modal === 'create') await api.createSale(payload)
      else await api.updateSale(selected.id, payload)
      await loadSales(); setModal(null)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const del = async () => {
    try { await api.deleteSale(selected.id); await loadSales(); setModal(null) }
    catch (e) { alert(e.message) }
  }

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }))

  const totalAmount = sales.reduce((s, r) => s + (r.total_amount || 0), 0)

  // Sale unit options based on product rule
  const unitOptions = () => {
    if (!currentProduct?.sale_type) return ['kg', 'pcs']
    if (currentProduct.sale_type === 'both') return ['kg', 'pcs']
    return [currentProduct.sale_type]
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Реализация</div>
          <div className="page-subtitle">{sales.length} продаж · итого {fmt(totalAmount)}</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить продажу</button>
      </div>

      {/* Filters */}
      <div className="filters-bar">
        <select className="form-select filter-input" value={filters.client_id} onChange={e => setFilter('client_id', e.target.value)}>
          <option value="">Все клиенты</option>
          {clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
        </select>
        <select className="form-select filter-input" value={filters.product_id} onChange={e => setFilter('product_id', e.target.value)}>
          <option value="">Все товары</option>
          {products.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </select>
        <input type="date" className="form-input filter-input" value={filters.from_date} onChange={e => setFilter('from_date', e.target.value)} title="От даты" />
        <input type="date" className="form-input filter-input" value={filters.to_date} onChange={e => setFilter('to_date', e.target.value)} title="До даты" />
        {(filters.client_id || filters.product_id || filters.from_date || filters.to_date) && (
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters({ client_id: '', product_id: '', from_date: '', to_date: '' })}>
            ✕ Сбросить
          </button>
        )}
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Клиент</th>
                <th>Маркировка</th>
                <th>Товар</th>
                <th>Ед.</th>
                <th>Кол-во</th>
                <th>Цена/ед</th>
                <th>Итого</th>
                <th>Заметки</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sales.length === 0 && (
                <tr><td colSpan={10}>
                  <div className="empty-state"><div className="empty-icon">📤</div><p>Продаж нет</p></div>
                </td></tr>
              )}
              {sales.map(s => (
                <tr key={s.id}>
                  <td className="td-muted">{s.date}</td>
                  <td>{s.client_name || '—'}</td>
                  <td>{s.marking ? <span className="badge badge-primary">{s.marking}</span> : '—'}</td>
                  <td>{s.product_name}</td>
                  <td><span className={`badge ${s.sale_unit === 'kg' ? 'badge-warning' : 'badge-primary'}`}>{UNIT_LABELS[s.sale_unit]}</span></td>
                  <td className="td-mono">{(+s.quantity).toFixed(3)}</td>
                  <td className="td-mono td-muted">{fmt(s.price_per_unit)}</td>
                  <td><span className="badge badge-success">{fmt(s.total_amount)}</span></td>
                  <td className="td-muted" style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.notes || '—'}</td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(s)}>Изм.</button>
                      <button className="btn btn-danger btn-sm" onClick={() => openDelete(s)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(modal === 'create' || modal === 'edit') && (
        <Modal wide
          title={modal === 'create' ? 'Новая продажа' : 'Редактировать продажу'}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Отмена</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </>
          }
        >
          {error && <div className="alert alert-error">{error}</div>}

          <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 14 }}>
            ⚠ Укажите клиента или маркировку. Сумма (total) рассчитывается сервером — данные фронта игнорируются.
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Дата <span className="required">*</span></label>
              <input type="date" className="form-input" value={form.date} onChange={e => setF('date', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Товар <span className="required">*</span></label>
              <select className="form-select" value={form.product_id} onChange={e => { setF('product_id', e.target.value); setF('sale_unit', '') }}>
                <option value="">— Выберите товар —</option>
                {products.map(p => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name} {p.sale_type ? `[${p.sale_type}]` : '[нет правила]'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Product rule hint */}
          {currentProduct && (
            <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 10, padding: '6px 12px' }}>
              Правило: <strong>{currentProduct.sale_type || 'не задано'}</strong>
              {currentProduct.sale_type === 'pcs' && ' — только по штукам'}
              {currentProduct.sale_type === 'kg' && ' — только по килограммам'}
              {currentProduct.sale_type === 'both' && ' — любая единица'}
              {!currentProduct.sale_type && ' ⚠ Продажа заблокирована до настройки правила'}
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Клиент</label>
              <select className="form-select" value={form.client_id} onChange={e => { setF('client_id', e.target.value); setF('marking_id', '') }}>
                <option value="">— Выберите клиента —</option>
                {clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Маркировка</label>
              <select className="form-select" value={form.marking_id} onChange={e => setF('marking_id', e.target.value)}>
                <option value="">— Без маркировки —</option>
                {filteredMarkings.map(m => <option key={m.id} value={String(m.id)}>{m.marking} ({m.client_name})</option>)}
              </select>
            </div>
          </div>

          <div className="form-row-3">
            <div className="form-group">
              <label className="form-label">Единица продажи <span className="required">*</span></label>
              <select className="form-select" value={form.sale_unit} onChange={e => setF('sale_unit', e.target.value)}
                disabled={currentProduct?.sale_type && currentProduct.sale_type !== 'both'}>
                <option value="">— Выберите —</option>
                {unitOptions().map(u => <option key={u} value={u}>{u === 'kg' ? 'кг (kg)' : 'шт (pcs)'}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Количество <span className="required">*</span></label>
              <input type="number" step="0.001" min="0.001" className="form-input" value={form.quantity} onChange={e => setF('quantity', e.target.value)} placeholder="0.000" />
            </div>
            <div className="form-group">
              <label className="form-label">Цена за единицу <span className="required">*</span></label>
              <input type="number" step="0.01" min="0.01" className="form-input" value={form.price_per_unit} onChange={e => setF('price_per_unit', e.target.value)} placeholder="0.00" />
            </div>
          </div>

          {/* Live total preview */}
          {previewTotal && (
            <div style={{ background: 'var(--success-dim)', border: '1px solid rgba(22,163,74,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 }}>
              <strong style={{ color: 'var(--success)' }}>Итого (предпросмотр): ${previewTotal}</strong>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>— будет пересчитано сервером</span>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Заметки</label>
            <textarea className="form-textarea" value={form.notes} onChange={e => setF('notes', e.target.value)} placeholder="Примечания..." />
          </div>
        </Modal>
      )}

      {modal === 'delete' && (
        <ConfirmModal
          message="Удалить запись о продаже?"
          onConfirm={del}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}
