import { useEffect, useMemo, useState } from 'react'
import Modal from '../components/Modal'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const emptyForm = (type = 'purchase') => ({
  name: '',
  tariff_type: type,
  product_pattern: '',
  class_code: '',
  dxb_rate: type === 'purchase' ? '5.5' : '0',
  ala_rate: type === 'purchase' ? '3' : '0',
  ala_unit: 'kg',
  sale_rate: '0',
  sale_unit: 'kg',
  is_default: false,
  is_active: true,
})

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const unitLabel = (unit) => unit === 'pcs' ? 'шт' : 'кг'

export default function Tariffs() {
  const [tariffs, setTariffs] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [activeTab, setActiveTab] = useState('purchase')
  const [form, setForm] = useState(emptyForm('purchase'))
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

  const visibleTariffs = useMemo(
    () => tariffs.filter((tariff) => (tariff.tariff_type || 'purchase') === activeTab),
    [tariffs, activeTab],
  )

  const openCreate = () => {
    setSelected(null)
    setForm(emptyForm(activeTab))
    setError('')
    setModal('form')
  }

  const openEdit = (tariff) => {
    const type = tariff.tariff_type || 'purchase'
    setSelected(tariff)
    setForm({
      name: tariff.name || '',
      tariff_type: type,
      product_pattern: tariff.product_pattern || '',
      class_code: tariff.class_code || '',
      dxb_rate: tariff.dxb_rate ?? (type === 'purchase' ? '5.5' : '0'),
      ala_rate: tariff.ala_rate ?? (type === 'purchase' ? '3' : '0'),
      ala_unit: tariff.ala_unit || 'kg',
      sale_rate: tariff.sale_rate ?? '0',
      sale_unit: tariff.sale_unit || 'kg',
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
      setActiveTab(form.tariff_type || 'purchase')
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

  const setTariffType = (type) => {
    setForm((current) => ({
      ...emptyForm(type),
      ...current,
      tariff_type: type,
      dxb_rate: type === 'sale' ? '0' : (current.tariff_type === 'sale' ? '5.5' : current.dxb_rate),
      ala_rate: type === 'sale' ? '0' : (current.tariff_type === 'sale' ? '3' : current.ala_rate),
    }))
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Тарифы</div>
          <div className="page-subtitle">Себестоимость прихода и цена реализации</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Добавить тариф</button>
      </div>

      <div className="tabs">
        <button className={`tab${activeTab === 'purchase' ? ' active' : ''}`} onClick={() => setActiveTab('purchase')}>Тарифы прихода</button>
        <button className={`tab${activeTab === 'sale' ? ' active' : ''}`} onClick={() => setActiveTab('sale')}>Тарифы реализации</button>
      </div>

      <div className="alert" style={{ marginBottom: 16 }}>
        {activeTab === 'purchase'
          ? 'DXB считается по кг. ALA для телефонов обычно по шт, для остальных по кг.'
          : 'Тариф реализации подставляется в импорт Google Sheets как цена продажи клиенту. Цену можно изменить перед созданием реализации.'}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              {activeTab === 'purchase' ? (
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
              ) : (
                <tr>
                  <th>Название</th>
                  <th>Товар / ключевые слова</th>
                  <th>Класс</th>
                  <th>Цена реализации</th>
                  <th>Ед. реализации</th>
                  <th>Статус</th>
                  <th></th>
                </tr>
              )}
            </thead>
            <tbody>
              {visibleTariffs.length === 0 && (
                <tr><td colSpan={activeTab === 'purchase' ? 8 : 7}>
                  <div className="empty-state"><p>Тарифов нет</p></div>
                </td></tr>
              )}
              {visibleTariffs.map((tariff) => (
                <tr key={tariff.id}>
                  <td style={{ fontWeight: 700 }}>{tariff.name}</td>
                  <td className="td-muted">{tariff.product_pattern || '—'}</td>
                  <td>{tariff.class_code || '—'}</td>
                  {activeTab === 'purchase' ? (
                    <>
                      <td className="td-mono">{fmt(tariff.dxb_rate)}</td>
                      <td className="td-mono">{fmt(tariff.ala_rate)}</td>
                      <td><span className="badge badge-neutral">{unitLabel(tariff.ala_unit)}</span></td>
                    </>
                  ) : (
                    <>
                      <td className="td-mono">{fmt(tariff.sale_rate)}</td>
                      <td><span className="badge badge-neutral">{unitLabel(tariff.sale_unit)}</span></td>
                    </>
                  )}
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
            <label className="form-label">Тип тарифа</label>
            <select className="form-select" value={form.tariff_type} onChange={e => setTariffType(e.target.value)}>
              <option value="purchase">Приход</option>
              <option value="sale">Реализация</option>
            </select>
          </div>
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
              <input className="form-input" value={form.class_code} onChange={e => setForm(f => ({ ...f, class_code: e.target.value }))} placeholder="A, B, C, D, E" />
            </div>
            {form.tariff_type === 'purchase' ? (
              <div className="form-group">
                <label className="form-label">DXB $/кг</label>
                <input type="number" min="0" step="0.01" className="form-input" value={form.dxb_rate} onChange={e => setForm(f => ({ ...f, dxb_rate: e.target.value }))} />
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label">Цена реализации</label>
                <input type="number" min="0" step="0.01" className="form-input" value={form.sale_rate} onChange={e => setForm(f => ({ ...f, sale_rate: e.target.value }))} />
              </div>
            )}
          </div>

          {form.tariff_type === 'purchase' ? (
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
          ) : (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Реализация считается</label>
                <select className="form-select" value={form.sale_unit} onChange={e => setForm(f => ({ ...f, sale_unit: e.target.value }))}>
                  <option value="kg">По кг</option>
                  <option value="pcs">По шт</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Подсказка</label>
                <div className="alert" style={{ margin: 0 }}>Это цена продажи клиенту, не себестоимость.</div>
              </div>
            </div>
          )}

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
