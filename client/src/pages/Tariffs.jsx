import { useEffect, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const EMPTY = {
  name: '',
  product_pattern: '',
  class_code: '',
  dxb_rate: '5.5',
  ala_rate: '3',
  ala_unit: 'kg',
  is_default: false,
  is_active: true,
}

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Tariffs() {
  const [tariffs, setTariffs] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    api.getTariffs()
      .then((data) => setTariffs(normalizeArray(data)))
      .catch((e) => setError(e.message || 'Не удалось загрузить тарифы'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const openCreate = () => {
    setSelected(null)
    setForm(EMPTY)
    setError('')
    setModal('form')
  }

  const openEdit = (tariff) => {
    setSelected(tariff)
    setForm({
      name: tariff.name || '',
      product_pattern: tariff.product_pattern || '',
      class_code: tariff.class_code || '',
      dxb_rate: tariff.dxb_rate ?? '5.5',
      ala_rate: tariff.ala_rate ?? '0',
      ala_unit: tariff.ala_unit || 'kg',
      is_default: Boolean(tariff.is_default),
      is_active: tariff.is_active !== false,
    })
    setError('')
    setModal('form')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      if (selected) await api.updateTariff(selected.id, form)
      else await api.createTariff(form)
      setModal(null)
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const disable = async (tariff) => {
    if (!confirm('Отключить тариф?')) return
    try {
      await api.deleteTariff(tariff.id)
      await load()
    } catch (e) {
      alert(e.message || 'Не удалось отключить тариф')
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Тарифы</div>
          <div className="page-subtitle">DXB по кг, ALA по кг или по шт</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить тариф</button>
      </div>

      <div className="alert" style={{ marginBottom: 16 }}>
        Для телефонов ALA обычно считается по шт, для остальных по кг.
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Товар / ключевые слова</th>
                <th>Класс</th>
                <th>DXB $/кг</th>
                <th>ALA тариф</th>
                <th>ALA ед.</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tariffs.length === 0 && (
                <tr><td colSpan={8}>
                  <div className="empty-state"><p>Тарифов нет</p></div>
                </td></tr>
              )}
              {tariffs.map((tariff) => (
                <tr key={tariff.id}>
                  <td style={{ fontWeight: 700 }}>{tariff.name}</td>
                  <td className="td-muted">{tariff.product_pattern || '—'}</td>
                  <td>{tariff.class_code || '—'}</td>
                  <td className="td-mono">{fmt(tariff.dxb_rate)}</td>
                  <td className="td-mono">{fmt(tariff.ala_rate)}</td>
                  <td><span className="badge badge-neutral">{tariff.ala_unit === 'pcs' ? 'шт' : 'кг'}</span></td>
                  <td>
                    <span className={`badge ${tariff.is_active ? 'badge-success' : 'badge-neutral'}`}>
                      {tariff.is_active ? (tariff.is_default ? 'По умолчанию' : 'Активен') : 'Отключен'}
                    </span>
                  </td>
                  <td>
                    <div className="td-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(tariff)}>Изм.</button>
                      <button className="btn btn-danger btn-sm" onClick={() => disable(tariff)}>Откл.</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === 'form' && (
        <Modal
          title={selected ? `Редактировать: ${selected.name}` : 'Новый тариф'}
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
            <label className="form-label">Название</label>
            <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Ключевые слова товара</label>
            <input className="form-input" value={form.product_pattern} onChange={e => setForm(f => ({ ...f, product_pattern: e.target.value }))} placeholder="iphone, phone, айфон" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Класс</label>
              <input className="form-input" value={form.class_code} onChange={e => setForm(f => ({ ...f, class_code: e.target.value }))} placeholder="B" />
            </div>
            <div className="form-group">
              <label className="form-label">DXB $/кг</label>
              <input type="number" min="0" step="0.01" className="form-input" value={form.dxb_rate} onChange={e => setForm(f => ({ ...f, dxb_rate: e.target.value }))} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">ALA тариф</label>
              <input type="number" min="0" step="0.01" className="form-input" value={form.ala_rate} onChange={e => setForm(f => ({ ...f, ala_rate: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">ALA считается</label>
              <select className="form-select" value={form.ala_unit} onChange={e => setForm(f => ({ ...f, ala_unit: e.target.value }))}>
                <option value="kg">По кг</option>
                <option value="pcs">По шт</option>
              </select>
            </div>
          </div>
          <div className="form-row">
            <label className="checkbox-label">
              <input type="checkbox" checked={form.is_default} onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))} />
              Тариф по умолчанию
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
              Активен
            </label>
          </div>
        </Modal>
      )}
    </div>
  )
}
