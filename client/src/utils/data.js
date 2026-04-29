export function normalizeArray(data) {
  return Array.isArray(data) ? data : []
}

export function toNumber(x) {
  return Number(x || 0)
}
