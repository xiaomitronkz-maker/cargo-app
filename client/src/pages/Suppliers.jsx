import { useState, useEffect } from 'react'
import Modal from '../components/Modal'
import api from '../api'

const EMPTY = { name: '', phone: '', notes: '' }

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => api.getSuppliers().then(setSuppliers).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const openCreate = () => { setForm(EMPTY); setError(''); setModal('create') }
  const openEdit = (s) => { setSelected(s); setForm({ name: s.name, phone: s.phone || '', notes: s.notes || '' }); setError(''); setModal('edit') }
  const openDelete = (s) => { setSelected(s); setError(''); setModal('delete') }

  const save = async () => {
    setSaving(true); setError('')
    try {
      if (modal === 'create') await api.createSupplier(form)
      else await api.updateSupplier(selected.id, form)
      await load()
      setModal(null)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const del = async () => {
    setSaving(true); setError('')
    try {
      await api.deleteSupplier(selected.id)
      await load()
      setModal(null)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const filtered = suppliers.filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || (s.phone || '').includes(search))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Поставщики</div>
          <div className="page-subtitle">{suppliers.length} поставщиков в базе</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить поставщика</button>
      </div>

      <div className="filters-bar">
        <input className="form-input filter-input" placeholder="Поиск по имени или телефону..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Имя</th>
                <th>Телефон</th>
                <th>Заметки</th>
                <th>Добавлен</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="empty-state"><div className="empty-icon">◇</div><p>Поставщиков нет</p></div>
                </td></tr>
              )}
              {filtered.map(s => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td className="td-muted">{s.phone || '—'}</td>
                  <td className="td-muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.notes || '—'}</td>
                  <td className="td-muted">{new Date(s.created_at).toLocaleDateString('ru-RU')}</td>
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
        <Modal
          title={modal === 'create' ? 'Новый поставщик' : `Редактировать: ${selected.name}`}
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
            <label className="form-label">Имя <span className="required">*</span></label>
            <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Поставщик" autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Телефон</label>
            <input className="form-input" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+971 50 000 0000" />
          </div>
          <div className="form-group">
            <label className="form-label">Заметки</label>
            <textarea className="form-textarea" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Дополнительная информация..." />
          </div>
        </Modal>
      )}

      {modal === 'delete' && (
        <Modal
          title="Удалить поставщика"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Отмена</button>
              <button className="btn btn-danger" onClick={del} disabled={saving}>
                {saving ? 'Удаление...' : 'Удалить'}
              </button>
            </>
          }
        >
          {error && <div className="alert alert-error">{error}</div>}
          <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
            Удалить поставщика "{selected?.name}"?
          </p>
        </Modal>
      )}
    </div>
  )
}
