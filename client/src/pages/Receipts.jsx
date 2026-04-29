import { useEffect, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'

const fmtNum = (n, digits = 2) => (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const emptyItem = () => ({ product_id: '', weight: '', quantity: '', cost_almaty: '', cost_dubai: '', note: '' })

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

  const load = () => {
    setLoading(true)
    api.getReceipts().then(setReceipts).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    Promise.all([api.getSuppliers(), api.getClients(), api.getProducts(), api.getMarkings()])
      .then(([suppliersData, clientsData, productsData, markingsData]) => {
        setSuppliers(suppliersData)
        setClients(clientsData)
        setProducts(productsData)
        setMarkings(markingsData)
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
    if (!confirm('Удалить приход?')) return
    await api.deleteReceipt(receipt.id)
    setSelected(null)
    setEditing(null)
    await load()
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Приходы</div>
          <div className="page-subtitle">{receipts.length} документов</div>
        </div>
        <div className="td-actions">
          <button className="btn btn-primary" onClick={openCreate}>+ Добавить приход</button>
          <button className="btn btn-secondary" onClick={load}>Обновить</button>
        </div>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Поставщик</th>
                <th>Клиент</th>
                <th>Товаров</th>
                <th>Вес</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {receipts.length === 0 && (
                <tr><td colSpan={6}>
                  <div className="empty-state"><p>Документов прихода нет</p></div>
                </td></tr>
              )}
              {receipts.map(receipt => (
                <tr key={receipt.id}>
                  <td className="td-muted">{receipt.date || '—'}</td>
                  <td>{receipt.supplier_name || '—'}</td>
                  <td>{receipt.client_name || '—'}</td>
                  <td className="td-mono">{receipt.items_count || 0}</td>
                  <td className="td-mono">{fmtNum(receipt.total_weight, 3)} кг</td>
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
              <strong>{selected.date || '—'}</strong>
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
                  <th>Заметка</th>
                </tr>
              </thead>
              <tbody>
                {(selected.items || []).map(item => (
                  <tr key={item.id}>
                    <td>{item.product_name || '—'}</td>
                    <td className="td-mono">{fmtNum(item.quantity, 0)} шт</td>
                    <td className="td-mono">{fmtNum(item.weight, 3)} кг</td>
                    <td className="td-muted">{item.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                  <label className="form-label">Количество</label>
                  <input type="number" min="0" step="1" className="form-input" value={item.quantity} onChange={e => setItemF(index, 'quantity', e.target.value)} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Стоимость Алматы</label>
                  <input type="number" min="0" step="0.01" className="form-input" value={item.cost_almaty} onChange={e => setItemF(index, 'cost_almaty', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Стоимость Дубай</label>
                  <input type="number" min="0" step="0.01" className="form-input" value={item.cost_dubai} onChange={e => setItemF(index, 'cost_dubai', e.target.value)} />
                </div>
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
    </div>
  )
}
