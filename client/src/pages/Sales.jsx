import { useEffect, useMemo, useState } from 'react'
import Modal, { ConfirmModal } from '../components/Modal'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const today = () => new Date().toISOString().slice(0, 10)
const EMPTY_FORM = { date: today(), client_id: '', marking_id: '' }
const EMPTY_ITEM = { product_id: '', sale_unit: '', quantity: '', price_per_unit: '', notes: '' }
const UNIT_LABELS = { kg: 'кг', pcs: 'шт' }
const fmt = (n) => n != null ? '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'

export default function Sales() {
  const [sales, setSales] = useState([])
  const [clients, setClients] = useState([])
  const [products, setProducts] = useState([])
  const [markings, setMarkings] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ client_id: '', product_id: '', from_date: '', to_date: '' })
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [items, setItems] = useState([EMPTY_ITEM])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const loadRef = () => Promise.all([api.getClients(), api.getProducts(), api.getMarkings()])
    .then(([c, p, m]) => {
      setClients(normalizeArray(c))
      setProducts(normalizeArray(p))
      setMarkings(normalizeArray(m))
    })

  const loadSales = () => api.getSales(
    Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
  ).then((rows) => setSales(normalizeArray(rows))).finally(() => setLoading(false))

  useEffect(() => { loadRef() }, [])
  useEffect(() => { setLoading(true); loadSales() }, [filters])

  const filteredMarkings = useMemo(() => (
    form.client_id
      ? normalizeArray(markings).filter(m => String(m.client_id) === String(form.client_id))
      : normalizeArray(markings)
  ), [form.client_id, markings])

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }))
  const setItemF = (index, key, value) => setItems((rows) => rows.map((item, i) => i === index ? { ...item, [key]: value } : item))
  const addItem = () => setItems((rows) => [...rows, { ...EMPTY_ITEM }])
  const removeItem = (index) => setItems((rows) => rows.length === 1 ? rows : rows.filter((_, i) => i !== index))

  const getProduct = (productId) => normalizeArray(products).find((p) => String(p.id) === String(productId))
  const unitOptions = (productId) => {
    const product = getProduct(productId)
    if (!product?.sale_type || product.sale_type === 'both') return ['kg', 'pcs']
    return [product.sale_type]
  }

  const previewTotal = items.reduce((sum, item) => sum + (toNumber(item.quantity) * toNumber(item.price_per_unit)), 0)
  const totalAmount = normalizeArray(sales).reduce((sum, row) => sum + toNumber(row.total_amount), 0)
  const saleItems = (sale) => normalizeArray(sale.items)
  const itemCount = (sale) => toNumber(sale.items_count) || saleItems(sale).length
  const itemQty = (item) => `${toNumber(item.quantity).toLocaleString('ru-RU', { maximumFractionDigits: 3 })} ${UNIT_LABELS[item.sale_unit] || item.sale_unit || ''}`.trim()

  const openCreate = () => {
    setSelected(null)
    setForm(EMPTY_FORM)
    setItems([{ ...EMPTY_ITEM }])
    setError('')
    setModal('create')
  }

  const openEdit = (sale) => {
    const rows = saleItems(sale)
    setSelected(sale)
    setForm({
      date: sale.date || today(),
      client_id: String(sale.client_id || ''),
      marking_id: String(sale.marking_id || ''),
    })
    setItems((rows.length ? rows : [sale]).map((item) => ({
      product_id: String(item.product_id || ''),
      sale_unit: item.sale_unit || '',
      quantity: item.quantity ?? '',
      price_per_unit: item.price_per_unit ?? '',
      notes: item.notes || '',
    })))
    setError('')
    setModal('edit')
  }

  const openDelete = (sale) => {
    setSelected(sale)
    setModal('delete')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      if (modal === 'create') {
        await api.createSalesDocument({ ...form, items })
      } else if (selected.sales_document_id) {
        await api.updateSale(selected.id, { ...form, items })
      } else {
        const item = items[0] || EMPTY_ITEM
        await api.updateSale(selected.id, {
          ...form,
          product_id: item.product_id,
          sale_unit: item.sale_unit,
          quantity: item.quantity,
          price_per_unit: item.price_per_unit,
          notes: item.notes,
        })
      }
      await loadSales()
      setModal(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const del = async () => {
    try {
      await api.deleteSale(selected.id)
      await loadSales()
      setModal(null)
    } catch (e) {
      alert(e.message)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Реализация</div>
          <div className="page-subtitle">{normalizeArray(sales).length} реализаций · итого {fmt(totalAmount)}</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить продажу</button>
      </div>

      <div className="filters-bar">
        <select className="form-select filter-input" value={filters.client_id} onChange={(e) => setFilter('client_id', e.target.value)}>
          <option value="">Все клиенты</option>
          {normalizeArray(clients).map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
        </select>
        <select className="form-select filter-input" value={filters.product_id} onChange={(e) => setFilter('product_id', e.target.value)}>
          <option value="">Все товары</option>
          {normalizeArray(products).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </select>
        <input type="date" className="form-input filter-input" value={filters.from_date} onChange={(e) => setFilter('from_date', e.target.value)} title="От даты" />
        <input type="date" className="form-input filter-input" value={filters.to_date} onChange={(e) => setFilter('to_date', e.target.value)} title="До даты" />
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
                <th>Товары</th>
                <th>Итого</th>
                <th>Оплачено</th>
                <th>Долг</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {normalizeArray(sales).length === 0 && (
                <tr><td colSpan={8}>
                  <div className="empty-state"><div className="empty-icon">📤</div><p>Продаж нет</p></div>
                </td></tr>
              )}
              {normalizeArray(sales).map((sale) => {
                const rows = saleItems(sale)
                return (
                  <tr key={sale.sales_document_id ? `doc-${sale.sales_document_id}` : `sale-${sale.id}`}>
                    <td className="td-muted">{sale.date}</td>
                    <td>{sale.client_name || '—'}</td>
                    <td>{sale.marking ? <span className="badge badge-primary">{sale.marking}</span> : '—'}</td>
                    <td>
                      <div style={{ display: 'grid', gap: 6 }}>
                        <span className="badge badge-primary" style={{ width: 'fit-content' }}>{itemCount(sale)} тов.</span>
                        <div style={{ display: 'grid', gap: 4 }}>
                          {rows.map((item) => (
                            <div key={item.id} className="td-muted" style={{ fontSize: 12 }}>
                              <strong style={{ color: 'var(--text-primary)' }}>{item.product_name || 'Товар'}</strong>
                              {' — '}{itemQty(item)} × {fmt(item.price_per_unit)} = {fmt(item.total_amount)}
                              {item.notes ? <span> · {item.notes}</span> : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    </td>
                    <td><span className="badge badge-success">{fmt(sale.total_amount)}</span></td>
                    <td className="td-mono td-muted">{fmt(sale.paid_amount)}</td>
                    <td><span className={`badge ${toNumber(sale.debt) > 0 ? 'badge-warning' : 'badge-success'}`}>{fmt(sale.debt)}</span></td>
                    <td>
                      <div className="td-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEdit(sale)}
                        >
                          Изм.
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => openDelete(sale)}>✕</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {(modal === 'create' || modal === 'edit') && (
        <Modal
          wide
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
            ⚠ Сумма рассчитывается сервером. В режиме создания можно добавить несколько товаров в один документ.
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Дата <span className="required">*</span></label>
              <input type="date" className="form-input" value={form.date} onChange={(e) => setF('date', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Клиент</label>
              <select className="form-select" value={form.client_id} onChange={(e) => { setF('client_id', e.target.value); setF('marking_id', '') }}>
                <option value="">— Выберите клиента —</option>
                {normalizeArray(clients).map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Маркировка</label>
            <select className="form-select" value={form.marking_id} onChange={(e) => setF('marking_id', e.target.value)}>
              <option value="">— Без маркировки —</option>
              {filteredMarkings.map((m) => <option key={m.id} value={String(m.id)}>{m.marking} ({m.client_name})</option>)}
            </select>
          </div>

          {items.map((item, index) => {
            const product = getProduct(item.product_id)
            const options = unitOptions(item.product_id)
            return (
              <div key={index} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                  <strong>Товар {index + 1}</strong>
                  <div className="td-actions">
                    {(modal === 'create' || selected?.sales_document_id) && <button type="button" className="btn btn-secondary btn-sm" onClick={addItem}>Добавить товар</button>}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => removeItem(index)}
                      disabled={items.length === 1 || (modal === 'edit' && !selected?.sales_document_id)}
                    >
                      Удалить товар
                    </button>
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Товар <span className="required">*</span></label>
                    <select
                      className="form-select"
                      value={item.product_id}
                      onChange={(e) => {
                        const nextProductId = e.target.value
                        const nextProduct = getProduct(nextProductId)
                        setItems((rows) => rows.map((row, i) => i !== index ? row : {
                          ...row,
                          product_id: nextProductId,
                          sale_unit: !nextProductId ? '' : nextProduct?.sale_type && nextProduct.sale_type !== 'both' ? nextProduct.sale_type : row.sale_unit,
                        }))
                      }}
                    >
                      <option value="">— Выберите товар —</option>
                      {normalizeArray(products).map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name} {p.sale_type ? `[${p.sale_type}]` : '[нет правила]'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Единица продажи <span className="required">*</span></label>
                    <select
                      className="form-select"
                      value={item.sale_unit}
                      onChange={(e) => setItemF(index, 'sale_unit', e.target.value)}
                      disabled={product?.sale_type && product.sale_type !== 'both'}
                    >
                      <option value="">— Выберите —</option>
                      {options.map((u) => <option key={u} value={u}>{u === 'kg' ? 'кг (kg)' : 'шт (pcs)'}</option>)}
                    </select>
                  </div>
                </div>

                {product && (
                  <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 10, padding: '6px 12px' }}>
                    Правило: <strong>{product.sale_type || 'не задано'}</strong>
                    {product.sale_type === 'pcs' && ' — только по штукам'}
                    {product.sale_type === 'kg' && ' — только по килограммам'}
                    {product.sale_type === 'both' && ' — любая единица'}
                    {!product.sale_type && ' ⚠ Продажа заблокирована до настройки правила'}
                  </div>
                )}

                <div className="form-row-3">
                  <div className="form-group">
                    <label className="form-label">Количество <span className="required">*</span></label>
                    <input type="number" step="0.001" min="0.001" className="form-input" value={item.quantity} onChange={(e) => setItemF(index, 'quantity', e.target.value)} placeholder="0.000" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Цена за единицу <span className="required">*</span></label>
                    <input type="number" step="0.01" min="0.01" className="form-input" value={item.price_per_unit} onChange={(e) => setItemF(index, 'price_per_unit', e.target.value)} placeholder="0.00" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Итого</label>
                    <input className="form-input" value={fmt(toNumber(item.quantity) * toNumber(item.price_per_unit))} readOnly />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Заметки</label>
                  <textarea className="form-textarea" value={item.notes} onChange={(e) => setItemF(index, 'notes', e.target.value)} placeholder="Примечания..." />
                </div>
              </div>
            )
          })}

          {previewTotal > 0 && (
            <div style={{ background: 'var(--success-dim)', border: '1px solid rgba(22,163,74,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 }}>
              <strong style={{ color: 'var(--success)' }}>Итого: {fmt(previewTotal)}</strong>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>— будет пересчитано сервером</span>
            </div>
          )}
        </Modal>
      )}

      {modal === 'delete' && (
        <ConfirmModal
          message="Удалить реализацию?"
          onConfirm={del}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}
