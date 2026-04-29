import { useState, useEffect } from 'react'
import Modal, { ConfirmModal } from '../components/Modal'
import api from '../api'

const EMPTY = { name: '', phone: '', notes: '' }

export default function Clients() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null) // null | 'create' | 'edit' | 'markings' | 'delete'
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [clientDetail, setClientDetail] = useState(null)

  const load = () => api.getClients().then(setClients).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const openCreate = () => { setForm(EMPTY); setError(''); setModal('create') }
  const openEdit = (c) => { setSelected(c); setForm({ name: c.name, phone: c.phone || '', notes: c.notes || '' }); setError(''); setModal('edit') }
  const openDelete = (c) => { setSelected(c); setModal('delete') }
  const openMarkings = (c) => {
    setSelected(c)
    api.getClient(c.id).then(setClientDetail)
    setModal('markings')
  }

  const save = async () => {
    setSaving(true); setError('')
    try {
      if (modal === 'create') await api.createClient(form)
      else await api.updateClient(selected.id, form)
      await load()
      setModal(null)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const del = async () => {
    try { await api.deleteClient(selected.id); await load(); setModal(null) }
    catch (e) { setError(e.message) }
  }

  const filtered = clients.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || (c.phone || '').includes(search))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Клиенты</div>
          <div className="page-subtitle">{clients.length} клиентов в базе</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить клиента</button>
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
                  <div className="empty-state"><div className="empty-icon">👤</div><p>Клиентов нет</p></div>
                </td></tr>
              )}
              {filtered.map(c => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td className="td-muted">{c.phone || '—'}</td>
                  <td className="td-muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.notes || '—'}</td>
                  <td className="td-muted">{new Date(c.created_at).toLocaleDateString('ru-RU')}</td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => openMarkings(c)} title="Маркировки">🏷</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(c)}>Изм.</button>
                      <button className="btn btn-danger btn-sm" onClick={() => openDelete(c)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      {(modal === 'create' || modal === 'edit') && (
        <Modal
          title={modal === 'create' ? 'Новый клиент' : `Редактировать: ${selected.name}`}
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
            <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Жанибек Алиев" autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Телефон</label>
            <input className="form-input" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+7 777 000 0000" />
          </div>
          <div className="form-group">
            <label className="form-label">Заметки</label>
            <textarea className="form-textarea" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Дополнительная информация..." />
          </div>
        </Modal>
      )}

      {/* Delete confirmation */}
      {modal === 'delete' && (
        <ConfirmModal
          message={`Удалить клиента "${selected?.name}"? Все маркировки будут удалены. Приходы и продажи сохранятся.`}
          onConfirm={del}
          onCancel={() => setModal(null)}
        />
      )}

      {/* Markings view */}
      {modal === 'markings' && clientDetail && (
        <Modal title={`Маркировки: ${selected.name}`} onClose={() => { setModal(null); setClientDetail(null) }}
          footer={<button className="btn btn-secondary" onClick={() => setModal(null)}>Закрыть</button>}>
          {clientDetail.markings.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">🏷</div><p>Маркировок нет</p></div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {clientDetail.markings.map(m => (
                <span key={m.id} className="badge badge-primary" style={{ fontSize: 13, padding: '5px 12px' }}>{m.marking}</span>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
