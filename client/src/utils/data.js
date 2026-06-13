export function normalizeArray(data) {
  return Array.isArray(data) ? data : []
}

export function toNumber(x) {
  return Number(x || 0)
}

export function formatDate(value) {
  if (!value) return '—'
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (match) return `${match[3]}.${match[2]}.${match[1]}`
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('ru-RU')
}

export const TYPE_LABELS = {
  expense: 'Расход бизнеса',
  income: 'Доход (legacy)',
  transfer: 'Перевод',
  withdraw: 'Вывод',
  owner_contribution: 'Пополнение владельцем',
  owner_withdrawal: 'Снятие владельцем',
  cash_adjustment_in: 'Пополнение кассы',
  cash_adjustment_out: 'Снятие с кассы',
  dubai: 'Дубай',
  almaty: 'Алматы',
  receivable: 'Нам должны',
  payable: 'Мы должны',
  sale: 'Реализация',
  purchase: 'Приход',
  receipt: 'Приход',
  payment: 'Оплата',
  customer: 'Клиент',
  supplier: 'Поставщик',
  kg: 'кг',
  pcs: 'шт',
  both: 'кг / шт',
}

export function formatType(value) {
  return TYPE_LABELS[value] || value || '—'
}
