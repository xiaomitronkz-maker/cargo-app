import { useState, useEffect } from 'react'
import Modal, { ConfirmModal } from '../components/Modal'
import api from '../api'
import { formatDate, normalizeArray } from '../utils/data'

const EMPTY = { name: '', phone: '', notes: '' }
const IMPORT_STATUS_LABELS = {
  new: 'Новый',
  already_exists_client: 'Уже есть клиент',
  already_exists_supplier: 'Уже есть поставщик',
}
const IMPORT_TYPE_LABELS = {
  client: 'Клиент',
  supplier: 'Поставщик',
  skip: 'Пропустить',
}

export default function Clients() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null) // null | 'create' | 'edit' | 'markings' | 'delete' | 'import'
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [clientDetail, setClientDetail] = useState(null)
  const [importFile, setImportFile] = useState(null)
  const [importItems, setImportItems] = useState([])
  const [importSummary, setImportSummary] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')

  const load = () => api.getClients().then(setClients).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const openCreate = () => { setForm(EMPTY); setError(''); setModal('create') }
  const openEdit = (c) => { setSelected(c); setForm({ name: c.name, phone: c.phone || '', notes: c.notes || '' }); setError(''); setModal('edit') }
  const openDelete = (c) => { setSelected(c); setModal('delete') }
  const openImport = () => {
    setImportFile(null)
    setImportItems([])
    setImportSummary(null)
    setImportResult(null)
    setImportError('')
    setModal('import')
  }
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

  const previewImport = async () => {
    if (!importFile) {
      setImportError('Выберите файл .mxl')
      return
    }
    setImportLoading(true)
    setImportError('')
    setImportResult(null)
    try {
      const data = await api.previewCounterpartiesImport(importFile)
      setImportSummary(data.summary || null)
      setImportItems(normalizeArray(data.items).map(item => ({
        ...item,
        type: item.exists_as_client || item.exists_as_supplier ? 'skip' : item.suggested_type || 'client',
      })))
    } catch (e) {
      setImportError(e.message || 'Не удалось прочитать файл')
      setImportItems([])
      setImportSummary(null)
    } finally {
      setImportLoading(false)
    }
  }

  const commitImport = async () => {
    setImportLoading(true)
    setImportError('')
    try {
      const result = await api.commitCounterpartiesImport({
        items: importItems.map(item => ({ name: item.name, type: item.type })),
      })
      setImportResult(result)
      await load()
    } catch (e) {
      setImportError(e.message || 'Не удалось импортировать контрагентов')
    } finally {
      setImportLoading(false)
    }
  }

  const setImportType = (index, type) => {
    setImportItems(items => items.map((item, i) => i === index ? { ...item, type } : item))
  }

  const filtered = clients.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || (c.phone || '').includes(search))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Клиенты</div>
          <div className="page-subtitle">{clients.length} клиентов в базе</div>
        </div>
        <div className="td-actions">
          <button className="btn btn-secondary" onClick={openImport}>Импорт контрагентов</button>
          <button className="btn btn-primary" onClick={openCreate}>+ Добавить клиента</button>
        </div>
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
                  <td className="td-muted td-date">{formatDate(c.created_at)}</td>
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
          message={`Удалить клиента "${selected?.name}"? Это действие нельзя отменить. Все маркировки будут удалены. Приходы и продажи сохранятся.`}
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

      {modal === 'import' && (
        <Modal
          wide
          title="Импорт контрагентов из 1C MXL"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Закрыть</button>
              <button className="btn btn-primary" onClick={commitImport} disabled={importLoading || importItems.length === 0}>
                {importLoading ? 'Импорт...' : 'Импортировать'}
              </button>
            </>
          }
        >
          {importError && <div className="alert alert-error">{importError}</div>}
          {importResult && (
            <div className="alert alert-success">
              Создано клиентов: {importResult.created_clients || 0}, поставщиков: {importResult.created_suppliers || 0}, пропущено: {importResult.skipped || 0}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Файл 1C MXL</label>
            <input
              type="file"
              className="form-input"
              accept=".mxl,.MXL"
              onChange={e => {
                setImportFile(e.target.files?.[0] || null)
                setImportItems([])
                setImportSummary(null)
                setImportResult(null)
                setImportError('')
              }}
            />
          </div>
          <button className="btn btn-secondary" onClick={previewImport} disabled={importLoading}>
            {importLoading ? 'Проверка...' : 'Загрузить и проверить'}
          </button>

          {importSummary && (
            <div className="stat-grid" style={{ marginTop: 16 }}>
              <div className="stat-card">
                <div className="stat-label">Найдено</div>
                <div className="stat-value">{importSummary.total || 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Новые</div>
                <div className="stat-value positive">{importSummary.new || 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Дубли</div>
                <div className="stat-value">{importSummary.duplicates || 0}</div>
              </div>
            </div>
          )}

          {importItems.length > 0 && (
            <div className="table-wrapper" style={{ marginTop: 16 }}>
              <table>
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Есть в клиентах</th>
                    <th>Есть в поставщиках</th>
                    <th>Тип импорта</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {importItems.map((item, index) => (
                    <tr key={`${item.name}-${index}`}>
                      <td style={{ fontWeight: 600 }}>{item.name}</td>
                      <td>{item.exists_as_client ? <span className="badge badge-success">Да</span> : <span className="badge badge-neutral">Нет</span>}</td>
                      <td>{item.exists_as_supplier ? <span className="badge badge-success">Да</span> : <span className="badge badge-neutral">Нет</span>}</td>
                      <td>
                        <select className="form-select" value={item.type} onChange={e => setImportType(index, e.target.value)}>
                          <option value="client">{IMPORT_TYPE_LABELS.client}</option>
                          <option value="supplier">{IMPORT_TYPE_LABELS.supplier}</option>
                          <option value="skip">{IMPORT_TYPE_LABELS.skip}</option>
                        </select>
                      </td>
                      <td>
                        <span className={`badge ${item.status === 'new' ? 'badge-primary' : 'badge-neutral'}`}>
                          {IMPORT_STATUS_LABELS[item.status] || item.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
