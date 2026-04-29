import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Clients from './pages/Clients'
import Suppliers from './pages/Suppliers'
import Markings from './pages/Markings'
import Products from './pages/Products'
import Purchases from './pages/Purchases'
import Receipts from './pages/Receipts'
import Sales from './pages/Sales'
import MoneyAssets from './pages/MoneyAssets'
import Liabilities from './pages/Liabilities'
import Debts from './pages/Debts'
import Payments from './pages/Payments'
import Finance from './pages/Finance'
import Profit from './pages/Profit'
import Accounts from './pages/Accounts'
import Transactions from './pages/Transactions'
import Ledger from './pages/Ledger'
import Audit from './pages/Audit'
import Analytics from './pages/Analytics'
import AICommands from './pages/AICommands'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="clients" element={<Clients />} />
          <Route path="suppliers" element={<Suppliers />} />
          <Route path="markings" element={<Markings />} />
          <Route path="products" element={<Products />} />
          <Route path="purchases" element={<Purchases />} />
          <Route path="receipts" element={<Receipts />} />
          <Route path="sales" element={<Sales />} />
          <Route path="money-assets" element={<MoneyAssets />} />
          <Route path="liabilities" element={<Liabilities />} />
          <Route path="debts" element={<Debts />} />
          <Route path="payments" element={<Payments />} />
          <Route path="finance" element={<Finance />} />
          <Route path="profit" element={<Profit />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="audit" element={<Audit />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="ai" element={<AICommands />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
