import { useState, useEffect } from 'react'
import Modal, { ConfirmModal } from '../components/Modal'
import api from '../api'

const EMPTY = { client_id: '', marking: '' }

export default function Markings() {
  const [markings, setMarkings] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterClient, setFilterClient] = useState('')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => Promise.all([
    api.getMarkings(),
    api.getClients()
  ]).then(([m, c]) => { setMarkings(m); setClients(c) }).finally(() => setLoading(false))

  useEffect(() => { load() }, [])

  const openCreate = () => { setForm(EMPTY); setError(''); setModal('create') }
  const openEdit = (m) => { setSelected(m); setForm({ client_id: String(m.client_id), marking: m.marking }); setError(''); setModal('edit') }
  const openDelete = (m) => { setSelected(m); setModal('delete') }

  const save = async () => {
    setSaving(true); setError('')
    try {
      const payload = { ...form, marking: form.marking.toUpperCase() }
      if (modal === 'create') await api.createMarking(payload)
      else await api.updateMarking(selected.id, payload)
      await load(); setModal(null)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  const del = async () => {
    try { await api.deleteMarking(selected.id); await load(); setModal(null) }
    catch (e) { alert(e.message) }
  }

  const filtered = markings.filter(m => {
    const matchClient = !filterClient || String(m.client_id) === filterClient
    const matchSearch = !search || m.marking.toLowerCase().includes(search.toLowerCase()) || m.client_name.toLowerCase().includes(search.toLowerCase())
    return matchClient && matchSearch
  })

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Маркировки</div>
          <div className="page-subtitle">{markings.length} маркировок</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить маркировку</button>
      </div>

      <div className="filters-bar">
        <input className="form-input filter-input" placeholder="Поиск..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="form-select filter-input" value={filterClient} onChange={e => setFilterClient(e.target.value)}>
          <option value="">Все клиенты</option>
          {clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
        </select>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Маркировка</th>
                <th>Клиент</th>
                <th>Добавлена</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={4}>
                  <div className="empty-state"><div className="empty-icon">🏷</div><p>Маркировок нет</p></div>
                </td></tr>
              )}
              {filtered.map(m => (
                <tr key={m.id}>
                  <td><span className="badge badge-primary td-mono" style={{ fontSize: 13 }}>{m.marking}</span></td>
                  <td style={{ fontWeight: 500 }}>{m.client_name}</td>
                  <td className="td-muted">{new Date(m.created_at).toLocaleDateString('ru-RU')}</td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(m)}>Изм.</button>
                      <button className="btn btn-danger btn-sm" onClick={() => openDelete(m)}>✕</button>
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
          title={modal === 'create' ? 'Новая маркировка' : `Редактировать: ${selected.marking}`}
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
            <label className="form-label">Клиент <span className="required">*</span></label>
            <select className="form-select" value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} autoFocus>
              <option value="">— Выберите клиента —</option>
              {clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Маркировка <span className="required">*</span></label>
            <input
              className="form-input td-mono"
              value={form.marking}
              onChange={e => setForm(f => ({ ...f, marking: e.target.value.toUpperCase() }))}
              placeholder="ZHAN01"
              style={{ textTransform: 'uppercase', letterSpacing: 1 }}
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Маркировка будет сохранена в верхнем регистре. Должна быть уникальной.</span>
          </div>
        </Modal>
      )}

      {modal === 'delete' && (
        <ConfirmModal
          message={`Удалить маркировку "${selected?.marking}"? Приходы и продажи с этой маркировкой сохранятся.`}
          onConfirm={del}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}
