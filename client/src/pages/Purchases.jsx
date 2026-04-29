import { useState, useEffect } from 'react'
import Modal, { ConfirmModal } from '../components/Modal'
import api from '../api'

const today = () => new Date().toISOString().slice(0, 10)

const EMPTY = {
  date: today(),
  client_id: '',
  marking_id: '',
  supplier_id: '',
  product_id: '',
  quantity_pcs: '',
  weight_kg: '',
  boxes_count: '',
  cost_almaty: '',
  cost_dubai: '',
  notes: '',
}

const EMPTY_ITEM = {
  product_id: '',
  weight: '',
  quantity: '',
  boxes: '',
  cost_almaty: '',
  cost_dubai: '',
  note: '',
}

const fmt = (n) => n != null && n !== '' ? '$' + (+n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'

export default function Purchases() {
  const [purchases, setPurchases] = useState([])
  const [purchaseHistory, setPurchaseHistory] = useState([])
  const [clients, setClients] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [products, setProducts] = useState([])
  const [markings, setMarkings] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ client_id: '', product_id: '', from_date: '', to_date: '' })
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [items, setItems] = useState([EMPTY_ITEM])
  const [filteredMarkings, setFilteredMarkings] = useState([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [supplierForm, setSupplierForm] = useState({ name: '', phone: '', notes: '' })
  const [supplierError, setSupplierError] = useState('')
  const [creatingSupplier, setCreatingSupplier] = useState(false)
  const [showSupplierCreate, setShowSupplierCreate] = useState(false)

  const loadRef = () =>
    Promise.all([api.getClients(), api.getSuppliers(), api.getProducts(), api.getMarkings()])
      .then(([c, s, p, m]) => { setClients(c); setSuppliers(s); setProducts(p); setMarkings(m) })

  const loadPurchases = () =>
    api.getPurchases(Object.fromEntries(Object.entries(filters).filter(([, v]) => v)))
      .then(setPurchases)
      .finally(() => setLoading(false))
  const loadPurchaseHistory = () => api.getPurchases().then(setPurchaseHistory)

  useEffect(() => { loadRef(); loadPurchaseHistory() }, [])
  useEffect(() => { setLoading(true); loadPurchases() }, [filters])

  // Фильтрация маркировок по клиенту
  useEffect(() => {
    setFilteredMarkings(
      form.client_id
        ? markings.filter(m => String(m.client_id) === String(form.client_id))
        : markings
    )
  }, [form.client_id, markings])

  useEffect(() => {
    if (!form.marking_id) return
    const marking = markings.find(m => String(m.id) === String(form.marking_id))
    if (marking?.client_id && String(marking.client_id) !== String(form.client_id)) {
      setF('client_id', String(marking.client_id))
    }
  }, [form.marking_id, form.client_id, markings])

  const openCreate = () => { setForm(EMPTY); setItems([EMPTY_ITEM]); setError(''); setSupplierError(''); setShowSupplierCreate(false); setModal('create') }
  const openEdit = (p) => {
    setSelected(p)
    setForm({
      date: p.date,
      client_id: String(p.client_id || ''),
      marking_id: String(p.marking_id || ''),
      supplier_id: String(p.supplier_id || ''),
      product_id: String(p.product_id),
      quantity_pcs: p.quantity_pcs || '',
      weight_kg: p.weight_kg || '',
      boxes_count: p.boxes_count || '',
      cost_almaty: p.cost_almaty || '',
      cost_dubai: p.cost_dubai || '',
      notes: p.notes || '',
    })
    setError(''); setSupplierError(''); setShowSupplierCreate(false); setModal('edit')
  }
  const openDelete = (p) => { setSelected(p); setModal('delete') }

  const save = async () => {
    setSaving(true); setError('')
    try {
      if (modal === 'create') {
        if (items.length === 0) throw new Error('Добавьте хотя бы один товар')
        for (const item of items) {
          if (!item.product_id) throw new Error('Выберите товар в каждой строке')
          if (!(+item.quantity > 0) && !(+item.weight > 0)) throw new Error('Укажите вес или количество в каждой строке')
        }
        await api.createReceipt({
          date: form.date,
          supplier_id: form.supplier_id,
          client_id: form.client_id,
          marking_id: form.marking_id,
          items,
        })
      } else {
        await api.updatePurchase(selected.id, form)
      }
      await loadPurchases()
      await loadPurchaseHistory()
      setForm(EMPTY)
      setItems([EMPTY_ITEM])
      setModal(null)
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const del = async () => {
    try { await api.deletePurchase(selected.id); await loadPurchases(); setModal(null) }
    catch (e) { alert(e.message) }
  }

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setItemF = (index, k, v) => setItems(rows => rows.map((item, i) => i === index ? { ...item, [k]: v } : item))
  const addItem = () => setItems(rows => [...rows, EMPTY_ITEM])
  const removeItem = (index) => setItems(rows => rows.length === 1 ? rows : rows.filter((_, i) => i !== index))
  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }))
  const setSupplierF = (k, v) => setSupplierForm(f => ({ ...f, [k]: v }))

  const createSupplier = async () => {
    setCreatingSupplier(true); setSupplierError('')
    try {
      const created = await api.createSupplier(supplierForm)
      const list = await api.getSuppliers()
      setSuppliers(list)
      setF('supplier_id', String(created.id))
      setSupplierForm({ name: '', phone: '', notes: '' })
      setShowSupplierCreate(false)
    } catch (e) { setSupplierError(e.message) }
    finally { setCreatingSupplier(false) }
  }

  // Превью итоговой себестоимости (считается на фронте только для отображения; сервер пересчитает)
  const previewTotalCost = (() => {
    const a = parseFloat(form.cost_almaty)
    const d = parseFloat(form.cost_dubai)
    if (isNaN(a) && isNaN(d)) return null
    return ((isNaN(a) ? 0 : a) + (isNaN(d) ? 0 : d)).toFixed(2)
  })()

  // Итоги по таблице
  const totalWeight = purchases.reduce((s, p) => s + (+p.weight_kg || 0), 0)
  const totalCost   = purchases.reduce((s, p) => s + (+p.total_cost || 0), 0)
  const itemsTotalWeight = items.reduce((sum, i) => sum + Number(i.weight || 0), 0)
  const itemsTotalQty = items.reduce((sum, i) => sum + Number(i.quantity || 0), 0)
  const itemsTotalCost =
    items.reduce((sum, i) => sum + Number(i.cost_almaty || 0), 0) +
    items.reduce((sum, i) => sum + Number(i.cost_dubai || 0), 0)
  const pricePerKg = itemsTotalWeight ? itemsTotalCost / itemsTotalWeight : 0
  const pricePerItem = itemsTotalQty ? itemsTotalCost / itemsTotalQty : 0
  const valueTone = (value) => ({ color: value > 0 ? 'var(--text)' : 'var(--text-muted)' })
  const getCostControl = (item) => {
    const prices = purchaseHistory
      .filter(p => String(p.product_id) === String(item.product_id))
      .map(p => {
        const cost = (+p.cost_almaty || 0) + (+p.cost_dubai || 0)
        const base = (+p.weight_kg || 0) > 0 ? (+p.weight_kg || 0) : (+p.quantity_pcs || 0)
        return base ? cost / base : 0
      })
      .filter(price => price > 0)
    const avgPrice = prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : 0
    const lastPrice = prices.length ? prices[0] : 0
    const currentCost = (+item.cost_almaty || 0) + (+item.cost_dubai || 0)
    const currentBase = (+item.weight || 0) || (+item.quantity || 0) || 1
    const currentPrice = currentCost / currentBase
    const diff = currentPrice - avgPrice
    const ratio = avgPrice ? currentPrice / avgPrice : 1
    const color = !avgPrice || currentPrice <= avgPrice
      ? 'var(--success)'
      : ratio >= 1.2
        ? 'var(--danger)'
        : ratio >= 1.1
          ? 'var(--warning)'
          : 'var(--success)'
    return { avgPrice, lastPrice, currentPrice, diff, color }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Приход</div>
          <div className="page-subtitle">
            {purchases.length} записей · {totalWeight.toFixed(2)} кг · итого {fmt(totalCost)}
          </div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить приход</button>
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
        <input type="date" className="form-input filter-input" value={filters.to_date}   onChange={e => setFilter('to_date', e.target.value)}   title="До даты" />
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
                <th>Вес (кг)</th>
                <th>Шт</th>
                <th>Коробки</th>
                <th>Алматы</th>
                <th>Дубай</th>
                <th>Итого себест.</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {purchases.length === 0 && (
                <tr><td colSpan={11}>
                  <div className="empty-state"><div className="empty-icon">📥</div><p>Приходов нет</p></div>
                </td></tr>
              )}
              {purchases.map(p => (
                <tr key={p.id}>
                  <td className="td-muted">{p.date}</td>
                  <td>{p.client_name || '—'}</td>
                  <td>{p.marking ? <span className="badge badge-primary">{p.marking}</span> : '—'}</td>
                  <td>{p.product_name}</td>
                  <td className="td-mono" style={{ fontWeight: 600 }}>{(+p.weight_kg || 0).toFixed(3)}</td>
                  <td className="td-mono td-muted">{p.quantity_pcs || '—'}</td>
                  <td className="td-mono td-muted">{p.boxes_count || '—'}</td>
                  <td className="td-mono td-muted">{fmt(p.cost_almaty)}</td>
                  <td className="td-mono td-muted">{fmt(p.cost_dubai)}</td>
                  <td>
                    <span className="badge badge-warning" style={{ fontSize: 12 }}>
                      {fmt(p.total_cost)}
                    </span>
                  </td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(p)}>Изм.</button>
                      <button className="btn btn-danger btn-sm" onClick={() => openDelete(p)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit modal */}
      {(modal === 'create' || modal === 'edit') && (
        <Modal
          wide
          title={modal === 'create' ? 'Новый приход' : 'Редактировать приход'}
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
            ⚠ Укажите клиента или маркировку (обязательно хотя бы одно). Если указана только маркировка — клиент определится автоматически.
          </div>

	          <div className="form-row">
	            <div className="form-group">
	              <label className="form-label">Дата <span className="required">*</span></label>
	              <input type="date" className="form-input" value={form.date} onChange={e => setF('date', e.target.value)} />
	            </div>
	            {modal === 'edit' && (
	              <div className="form-group">
	                <label className="form-label">Товар <span className="required">*</span></label>
	                <select className="form-select" value={form.product_id} onChange={e => setF('product_id', e.target.value)}>
	                  <option value="">— Выберите товар —</option>
	                  {products.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
	                </select>
	              </div>
	            )}
	          </div>

          <div className="form-group">
            <label className="form-label">Поставщик <span className="required">*</span></label>
            <select className="form-select" value={form.supplier_id} onChange={e => setF('supplier_id', e.target.value)}>
              <option value="">— Выберите поставщика —</option>
              {suppliers.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </select>
            {suppliers.length === 0 && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowSupplierCreate(true)}>
                Создать поставщика
              </button>
            )}
            {suppliers.length > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowSupplierCreate(v => !v)}>
                {showSupplierCreate ? 'Скрыть форму' : 'Создать поставщика'}
              </button>
            )}
          </div>

          {showSupplierCreate && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
              {supplierError && <div className="alert alert-error">{supplierError}</div>}
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Имя поставщика <span className="required">*</span></label>
                  <input className="form-input" value={supplierForm.name} onChange={e => setSupplierF('name', e.target.value)} placeholder="Поставщик" />
                </div>
                <div className="form-group">
                  <label className="form-label">Телефон</label>
                  <input className="form-input" value={supplierForm.phone} onChange={e => setSupplierF('phone', e.target.value)} placeholder="+971 50 000 0000" />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Заметки</label>
                <textarea className="form-textarea" value={supplierForm.notes} onChange={e => setSupplierF('notes', e.target.value)} placeholder="Дополнительная информация..." />
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={createSupplier} disabled={creatingSupplier}>
                {creatingSupplier ? 'Создание...' : 'Создать поставщика'}
              </button>
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Клиент</label>
              <select className="form-select" value={form.client_id}
                onChange={e => { setF('client_id', e.target.value); setF('marking_id', '') }}>
                <option value="">— Выберите клиента —</option>
                {clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            </div>
	            <div className="form-group">
	              <label className="form-label">Маркировка</label>
	              <select className="form-select" value={form.marking_id} onChange={e => setF('marking_id', e.target.value)}>
	                <option value="">— Без маркировки —</option>
	                {filteredMarkings.map(m => (
	                  <option key={m.id} value={String(m.id)}>{m.marking} ({m.client_name})</option>
	                ))}
	              </select>
            </div>
          </div>

	          {modal === 'create' ? (
	            <>
		              {items.map((item, index) => {
		                const cost = (+item.cost_almaty || 0) + (+item.cost_dubai || 0)
		                const costControl = getCostControl(item)
		                return (
	                  <div key={index} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
	                    <div className="record-meta" style={{ marginBottom: 12 }}>
	                      <strong>📦 Товар {index + 1}</strong>
	                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeItem(index)} disabled={items.length === 1}>Удалить товар</button>
	                    </div>
	                    <div className="form-group">
	                      <label className="form-label">Товар <span className="required">*</span></label>
	                      <select className="form-select" value={item.product_id} onChange={e => setItemF(index, 'product_id', e.target.value)}>
	                        <option value="">— Выберите товар —</option>
	                        {products.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
	                      </select>
	                    </div>
	                    <div className="form-row-3">
	                      <div className="form-group">
	                        <label className="form-label">Вес (кг)</label>
	                        <input type="number" step="0.001" min="0" className="form-input" value={item.weight} onChange={e => setItemF(index, 'weight', e.target.value)} placeholder="0.000" />
	                      </div>
	                      <div className="form-group">
	                        <label className="form-label">Количество (шт)</label>
	                        <input type="number" step="1" min="0" className="form-input" value={item.quantity} onChange={e => setItemF(index, 'quantity', e.target.value)} placeholder="0" />
	                      </div>
	                      <div className="form-group">
	                        <label className="form-label">Коробок</label>
	                        <input type="number" step="1" min="0" className="form-input" value={item.boxes} onChange={e => setItemF(index, 'boxes', e.target.value)} placeholder="0" />
	                      </div>
	                    </div>
	                    <div className="form-row">
	                      <div className="form-group">
	                        <label className="form-label">Стоимость Алматы</label>
	                        <input type="number" step="0.01" min="0" className="form-input" value={item.cost_almaty} onChange={e => setItemF(index, 'cost_almaty', e.target.value)} placeholder="0.00" />
	                      </div>
	                      <div className="form-group">
	                        <label className="form-label">Стоимость Дубай</label>
	                        <input type="number" step="0.01" min="0" className="form-input" value={item.cost_dubai} onChange={e => setItemF(index, 'cost_dubai', e.target.value)} placeholder="0.00" />
	                      </div>
	                    </div>
		                    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
		                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Себестоимость за кг</span>
		                      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--warning)', fontFamily: 'monospace', marginLeft: 8 }}>
		                        {fmt(cost)}
		                      </span>
		                    </div>
		                    {item.product_id && (
		                      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
		                        <div style={{ fontWeight: 700, marginBottom: 10 }}>Контроль себестоимости</div>
		                        <div className="record-meta" style={{ marginBottom: 6 }}>
		                          <span>Последняя</span>
		                          <strong>{fmt(costControl.lastPrice)}</strong>
		                        </div>
		                        <div className="record-meta" style={{ marginBottom: 6 }}>
		                          <span>Средняя</span>
		                          <strong>{fmt(costControl.avgPrice)}</strong>
		                        </div>
		                        <div className="record-meta" style={{ marginBottom: 0 }}>
		                          <span>Текущая</span>
		                          <strong style={{ color: costControl.color }}>{fmt(costControl.currentPrice)}</strong>
		                        </div>
		                      </div>
		                    )}
		                    <div className="form-group">
	                      <label className="form-label">Заметка</label>
	                      <textarea className="form-textarea" value={item.note} onChange={e => setItemF(index, 'note', e.target.value)} placeholder="Примечания по товару..." />
	                    </div>
	                  </div>
	                )
	              })}
		              <button type="button" className="btn btn-secondary" onClick={addItem} style={{ marginBottom: 14 }}>+ Добавить товар</button>
		              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
		                <div style={{ fontWeight: 700, marginBottom: 10 }}>📊 Итоги прихода</div>
		                <div className="record-meta" style={{ marginBottom: 6 }}>
		                  <span>Вес</span>
		                  <strong style={valueTone(itemsTotalWeight)}>{itemsTotalWeight.toFixed(3)} кг</strong>
		                </div>
		                <div className="record-meta" style={{ marginBottom: 6 }}>
		                  <span>Количество</span>
		                  <strong style={valueTone(itemsTotalQty)}>{itemsTotalQty} шт</strong>
		                </div>
		                <div className="record-meta" style={{ marginBottom: 6 }}>
		                  <span>Стоимость</span>
		                  <strong style={valueTone(itemsTotalCost)}>{fmt(itemsTotalCost)}</strong>
		                </div>
		                <div className="record-meta" style={{ marginBottom: 6 }}>
		                  <span>$/кг</span>
		                  <strong style={valueTone(pricePerKg)}>{pricePerKg.toFixed(2)}</strong>
		                </div>
		                <div className="record-meta" style={{ marginBottom: 0 }}>
		                  <span>$/шт</span>
		                  <strong style={valueTone(pricePerItem)}>{pricePerItem.toFixed(2)}</strong>
		                </div>
		              </div>
		            </>
	          ) : (
	            <>
	              <div className="form-row-3">
	                <div className="form-group">
	                  <label className="form-label">Вес (кг)</label>
	                  <input type="number" step="0.001" min="0" className="form-input"
	                    value={form.weight_kg} onChange={e => setF('weight_kg', e.target.value)} placeholder="0.000" />
	                </div>
	                <div className="form-group">
	                  <label className="form-label">Количество (шт)</label>
	                  <input type="number" step="1" min="0" className="form-input"
	                    value={form.quantity_pcs} onChange={e => setF('quantity_pcs', e.target.value)} placeholder="0" />
	                </div>
	                <div className="form-group">
	                  <label className="form-label">Коробок</label>
	                  <input type="number" step="1" min="0" className="form-input"
	                    value={form.boxes_count} onChange={e => setF('boxes_count', e.target.value)} placeholder="0" />
	                </div>
	              </div>
	              <div className="form-row">
	                <div className="form-group">
	                  <label className="form-label">Стоимость Алматы</label>
	                  <input type="number" step="0.01" min="0" className="form-input"
	                    value={form.cost_almaty} onChange={e => setF('cost_almaty', e.target.value)} placeholder="0.00" />
	                </div>
	                <div className="form-group">
	                  <label className="form-label">Стоимость Дубай</label>
	                  <input type="number" step="0.01" min="0" className="form-input"
	                    value={form.cost_dubai} onChange={e => setF('cost_dubai', e.target.value)} placeholder="0.00" />
	                </div>
	              </div>
	              {previewTotalCost !== null && (
	                <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
	                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Итоговая себестоимость</span>
	                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--warning)', fontFamily: 'monospace', marginLeft: 8 }}>
	                    = {fmt(form.cost_almaty || 0)} + {fmt(form.cost_dubai || 0)} = <strong>${previewTotalCost}</strong>
	                  </span>
	                </div>
	              )}
	              <div className="form-group">
	                <label className="form-label">Заметки</label>
	                <textarea className="form-textarea" value={form.notes}
	                  onChange={e => setF('notes', e.target.value)} placeholder="Примечания..." />
	              </div>
	            </>
	          )}
        </Modal>
      )}

      {modal === 'delete' && (
        <ConfirmModal
          message="Удалить запись прихода?"
          onConfirm={del}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}
