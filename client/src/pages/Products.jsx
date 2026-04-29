import { useState, useEffect } from 'react'
import Modal, { ConfirmModal } from '../components/Modal'
import api from '../api'

const EMPTY = { name: '', category: '', is_active: true, sale_type: '' }
const SALE_TYPE_LABELS = { kg: 'по кг', pcs: 'по шт', both: 'кг / шт', '': '—' }
const SALE_TYPE_BADGE = { kg: 'badge-warning', pcs: 'badge-primary', both: 'badge-success', '': 'badge-neutral' }

export default function Products() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterActive, setFilterActive] = useState('')
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => api.getProducts().then(setProducts).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const openCreate = () => { setForm(EMPTY); setError(''); setModal('create') }
  const openEdit = (p) => {
    setSelected(p)
    setForm({ name: p.name, category: p.category || '', is_active: Boolean(p.is_active), sale_type: p.sale_type || '' })
    setError(''); setModal('edit')
  }
  const openDelete = (p) => { setSelected(p); setModal('delete') }

  const save = async () => {
    setSaving(true); setError('')
    try {
      if (modal === 'create') await api.createProduct(form)
      else await api.updateProduct(selected.id, form)
      await load(); setModal(null)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const del = async () => {
    try { await api.deleteProduct(selected.id); await load(); setModal(null) }
    catch (e) { alert(e.message) }
  }

  const filtered = products.filter(p => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.category || '').toLowerCase().includes(search.toLowerCase())
    const matchActive = !filterActive || (filterActive === '1' ? p.is_active : !p.is_active)
    return matchSearch && matchActive
  })

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Товары</div>
          <div className="page-subtitle">{products.length} товаров в базе</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить товар</button>
      </div>

      <div className="filters-bar">
        <input className="form-input filter-input" placeholder="Поиск по названию или категории..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="form-select filter-input" value={filterActive} onChange={e => setFilterActive(e.target.value)}>
          <option value="">Все статусы</option>
          <option value="1">Активные</option>
          <option value="0">Неактивные</option>
        </select>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Категория</th>
                <th>Правило продажи</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="empty-state"><div className="empty-icon">📦</div><p>Товаров нет</p></div>
                </td></tr>
              )}
              {filtered.map(p => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td className="td-muted">{p.category || '—'}</td>
                  <td>
                    <span className={`badge ${SALE_TYPE_BADGE[p.sale_type || '']}`}>
                      {SALE_TYPE_LABELS[p.sale_type || '']}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${p.is_active ? 'badge-success' : 'badge-neutral'}`}>
                      {p.is_active ? 'Активен' : 'Неактивен'}
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

      {(modal === 'create' || modal === 'edit') && (
        <Modal
          title={modal === 'create' ? 'Новый товар' : `Редактировать: ${selected.name}`}
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
          <div className="form-group">
            <label className="form-label">Название <span className="required">*</span></label>
            <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="iPhone 15 Pro" autoFocus />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Категория</label>
              <input className="form-input" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="Электроника" />
            </div>
            <div className="form-group">
              <label className="form-label">Статус</label>
              <select className="form-select" value={form.is_active ? '1' : '0'} onChange={e => setForm(f => ({ ...f, is_active: e.target.value === '1' }))}>
                <option value="1">Активен</option>
                <option value="0">Неактивен</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Правило продажи</label>
            <select className="form-select" value={form.sale_type} onChange={e => setForm(f => ({ ...f, sale_type: e.target.value }))}>
              <option value="">— Не задано —</option>
              <option value="pcs">По штукам (pcs) — например iPhone</option>
              <option value="kg">По килограммам (kg) — карго товар</option>
              <option value="both">Оба варианта (both) — гибкий товар</option>
            </select>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Без правила продажа этого товара будет заблокирована
            </span>
          </div>
        </Modal>
      )}

      {modal === 'delete' && (
        <ConfirmModal
          message={`Удалить товар "${selected?.name}"? Связанное правило продажи тоже будет удалено.`}
          onConfirm={del}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}
