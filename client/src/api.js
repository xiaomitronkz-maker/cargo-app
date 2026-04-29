// All requests use relative /api path — proxied in dev, served by Express in prod

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(`/api${path}`, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

const api = {
  get: (path, options) => {
    const q = options?.params ? new URLSearchParams(options.params).toString() : ''
    return request('GET', `${path}${q ? '?' + q : ''}`)
  },
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),

  // Clients
  getClients: () => api.get('/clients'),
  getClient: (id) => api.get(`/clients/${id}`),
  createClient: (data) => api.post('/clients', data),
  updateClient: (id, data) => api.put(`/clients/${id}`, data),
  deleteClient: (id) => api.del(`/clients/${id}`),

  // Suppliers
  getSuppliers: () => api.get('/suppliers'),
  createSupplier: (data) => api.post('/suppliers', data),
  updateSupplier: (id, data) => api.put(`/suppliers/${id}`, data),
  deleteSupplier: (id) => api.del(`/suppliers/${id}`),

  // Markings
  getMarkings: (clientId) => api.get(`/markings${clientId ? `?client_id=${clientId}` : ''}`),
  createMarking: (data) => api.post('/markings', data),
  updateMarking: (id, data) => api.put(`/markings/${id}`, data),
  deleteMarking: (id) => api.del(`/markings/${id}`),

  // Products
  getProducts: () => api.get('/products'),
  createProduct: (data) => api.post('/products', data),
  updateProduct: (id, data) => api.put(`/products/${id}`, data),
  deleteProduct: (id) => api.del(`/products/${id}`),

  // Purchases
  getPurchases: (filters = {}) => {
    const q = new URLSearchParams(filters).toString()
    return api.get(`/purchases${q ? '?' + q : ''}`)
  },
  createPurchase: (data) => api.post('/purchases', data),
  getReceipts: () => api.get('/receipts'),
  getReceipt: (id) => api.get(`/receipts/${id}`),
  createReceipt: (data) => api.post('/receipts', data),
  updateReceipt: (id, data) => api.put(`/receipts/${id}`, data),
  deleteReceipt: (id) => api.del(`/receipts/${id}`),
  updatePurchase: (id, data) => api.put(`/purchases/${id}`, data),
  deletePurchase: (id) => api.del(`/purchases/${id}`),

  // Sales
  getSales: (filters = {}) => {
    const q = new URLSearchParams(filters).toString()
    return api.get(`/sales${q ? '?' + q : ''}`)
  },
  createSale: (data) => api.post('/sales', data),
  createSalesDocument: (data) => api.post('/sales-documents', data),
  updateSale: (id, data) => api.put(`/sales/${id}`, data),
  deleteSale: (id) => api.del(`/sales/${id}`),
  paySale: (id, data) => api.put(`/sales/${id}/pay`, data),

  // Debts
  getDebts: () => api.get('/debts'),
  getDebtsSummary: () => api.get('/debts/summary'),
  getDebtsBySuppliers: () => api.get('/debts/by-suppliers'),
  payReceipt: (id, data) => api.put(`/receipts/${id}/pay`, data),
  payPurchase: (id, data) => api.put(`/purchases/${id}/pay`, data),
  getPayments: () => api.get('/payments'),
  getLedger: (params) => api.get('/ledger', { params }),

  // Accounts
  getAccounts: () => api.get('/accounts'),
  createAccount: (data) => api.post('/accounts', data),
  getTransactions: () => api.get('/transactions'),
  createTransaction: (data) => api.post('/transactions', data),
  getAudit: () => api.get('/audit'),

  // Money Assets
  getMoneyAssets: () => api.get('/money-assets'),
  createMoneyAsset: (data) => api.post('/money-assets', data),
  updateMoneyAsset: (id, data) => api.put(`/money-assets/${id}`, data),
  deleteMoneyAsset: (id) => api.del(`/money-assets/${id}`),

  // Liabilities
  getLiabilities: () => api.get('/liabilities'),
  createLiability: (data) => api.post('/liabilities', data),
  updateLiability: (id, data) => api.put(`/liabilities/${id}`, data),
  deleteLiability: (id) => api.del(`/liabilities/${id}`),

  // Analytics
  getDashboard: () => api.get('/analytics/dashboard'),
  getProfit: (period) => api.get(`/analytics/profit${period ? `?period=${period}` : ''}`),
  getProfitSummary: () => api.get('/profit/summary'),

  // AI
  sendCommand: (command) => api.post('/ai/command', { command }),
}

export default api
