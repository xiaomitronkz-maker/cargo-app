require('dotenv').config();
/**
 * Cargo Manager — PostgreSQL Backend
 *
 * Требуется:
 *   DATABASE_URL=postgres://... node server.js
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
let databaseReady = false;

if (!hasDatabaseUrl) {
  console.warn('⚠️ DATABASE_URL is not set. API will return 503, frontend will work.');
}

const pool = hasDatabaseUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isProduction
        ? { rejectUnauthorized: false }
        : false,
    })
  : null;

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/api', (req, res, next) => {
  if (!pool || !databaseReady) {
    return res.status(503).json({ error: 'Database is not available' });
  }
  next();
});

function validationError(res, message, context = {}) {
  console.warn('VALIDATION ERROR:', context);
  return res.status(400).json({ error: message });
}

async function query(text, params = [], client = pool) {
  return client.query(text, params);
}

async function all(text, params = [], client = pool) {
  const { rows } = await query(text, params, client);
  return rows;
}

async function get(text, params = [], client = pool) {
  const { rows } = await query(text, params, client);
  return rows[0] || null;
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function initDb() {
  if (!pool) return;

  await query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS markings (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      marking TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_rules (
      id SERIAL PRIMARY KEY,
      product_id INTEGER UNIQUE REFERENCES products(id) ON DELETE CASCADE,
      sale_type TEXT NOT NULL CHECK(sale_type IN ('kg','pcs','both'))
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id SERIAL PRIMARY KEY,
      date DATE,
      supplier_id INTEGER REFERENCES suppliers(id),
      client_id INTEGER REFERENCES clients(id),
      marking_id INTEGER REFERENCES markings(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS receipt_items (
      id SERIAL PRIMARY KEY,
      receipt_id INTEGER REFERENCES receipts(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      weight NUMERIC DEFAULT 0,
      quantity NUMERIC DEFAULT 0,
      cost_almaty NUMERIC DEFAULT 0,
      cost_dubai NUMERIC DEFAULT 0,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      client_id INTEGER REFERENCES clients(id),
      marking_id INTEGER REFERENCES markings(id),
      supplier_id INTEGER REFERENCES suppliers(id),
      receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
      product_id INTEGER REFERENCES products(id),
      quantity_pcs NUMERIC DEFAULT 0,
      weight_kg NUMERIC DEFAULT 0,
      boxes_count NUMERIC DEFAULT 0,
      cost_almaty NUMERIC DEFAULT 0,
      cost_dubai NUMERIC DEFAULT 0,
      cost_per_kg NUMERIC DEFAULT 0,
      total_cost NUMERIC DEFAULT 0,
      paid_amount NUMERIC DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      client_id INTEGER REFERENCES clients(id),
      marking_id INTEGER REFERENCES markings(id),
      sales_document_id INTEGER,
      product_id INTEGER REFERENCES products(id),
      sale_unit TEXT CHECK(sale_unit IN ('kg','pcs')),
      quantity NUMERIC DEFAULT 0,
      price_per_unit NUMERIC DEFAULT 0,
      total_amount NUMERIC DEFAULT 0,
      paid_amount NUMERIC DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales_documents (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      client_id INTEGER REFERENCES clients(id),
      marking_id INTEGER REFERENCES markings(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales_items (
      id SERIAL PRIMARY KEY,
      sales_document_id INTEGER REFERENCES sales_documents(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      sale_unit TEXT CHECK(sale_unit IN ('kg','pcs')),
      quantity NUMERIC DEFAULT 0,
      price_per_unit NUMERIC DEFAULT 0,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('sale','purchase')),
      entity_id INTEGER NOT NULL,
      amount NUMERIC NOT NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      comment TEXT,
      transaction_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('income','expense','transfer','withdraw')),
      amount NUMERIC NOT NULL,
      account_from_id INTEGER REFERENCES accounts(id),
      account_to_id INTEGER REFERENCES accounts(id),
      receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
      sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      comment TEXT,
      related_type TEXT,
      related_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      amount NUMERIC NOT NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS money_assets (
      id SERIAL PRIMARY KEY,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('cash','in_transit','debtors','transfer')),
      amount NUMERIC NOT NULL,
      comment TEXT,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS liabilities (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      comment TEXT,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cost_almaty NUMERIC DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cost_dubai NUMERIC DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cost_per_kg NUMERIC DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS total_cost NUMERIC DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS sales_document_id INTEGER REFERENCES sales_documents(id) ON DELETE SET NULL;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS comment TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_id INTEGER;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL;
  `);

  await query(`
    UPDATE purchases
    SET cost_per_kg = COALESCE(cost_almaty,0) + COALESCE(cost_dubai,0)
    WHERE COALESCE(cost_per_kg,0) = 0
      AND (COALESCE(cost_almaty,0) > 0 OR COALESCE(cost_dubai,0) > 0);
  `);

  await query(`
    UPDATE purchases
    SET total_cost = COALESCE(cost_per_kg,0) * COALESCE(weight_kg,0)
    WHERE COALESCE(total_cost,0) = 0
      AND COALESCE(cost_per_kg,0) > 0
      AND COALESCE(weight_kg,0) > 0;
  `);

  await query(`
    UPDATE payments p
    SET transaction_id = t.id
    FROM transactions t
    WHERE p.transaction_id IS NULL
      AND t.related_type = 'payment'
      AND t.related_id = p.id;
  `);
}

async function resolveClientMarking(clientId, markingId, client = pool) {
  const cid = clientId ? +clientId : null;
  const mid = markingId ? +markingId : null;
  if (!cid && !mid) throw new Error('Укажите клиента или маркировку (обязательно хотя бы одно)');
  if (mid && !cid) {
    const marking = await get('SELECT * FROM markings WHERE id=$1', [mid], client);
    if (!marking) throw new Error(`Маркировка с id=${mid} не найдена`);
    return { cid: +marking.client_id, mid };
  }
  if (mid && cid) {
    const marking = await get('SELECT id FROM markings WHERE id=$1 AND client_id=$2', [mid, cid], client);
    if (!marking) throw new Error('Маркировка не принадлежит выбранному клиенту');
  }
  return { cid, mid };
}

function validatePurchaseNums({ weight_kg = 0, quantity_pcs = 0, cost_almaty = 0, cost_dubai = 0 }) {
  if (+weight_kg < 0) throw new Error('Вес (weight_kg) не может быть отрицательным');
  if (+quantity_pcs < 0) throw new Error('Количество (quantity_pcs) не может быть отрицательным');
  if (+cost_almaty < 0) throw new Error('Стоимость Алматы не может быть отрицательной');
  if (+cost_dubai < 0) throw new Error('Стоимость Дубай не может быть отрицательной');
}

async function getAccountBalance(accountId, client = pool) {
  const row = await get(`
    SELECT
      COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='income' AND account_to_id=$1),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='expense' AND account_from_id=$1),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='withdraw' AND account_from_id=$1),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_to_id=$1),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_from_id=$1),0)
      AS balance
  `, [accountId], client);
  return +(row?.balance || 0);
}

async function getReceiptPaidAmount(receiptId, client = pool) {
  const row = await get(`
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM (
      SELECT DISTINCT p.id, p.amount::numeric AS amount
      FROM payments p
      LEFT JOIN transactions t ON t.id = p.transaction_id
      LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id = p.entity_id
      WHERE COALESCE(t.receipt_id, pu.receipt_id) = $1
    ) x
  `, [receiptId], client);
  return +(row?.total || 0);
}

async function rebalanceReceiptPurchasePaidAmounts(receiptId, client = pool) {
  const purchases = await all(`
    SELECT id,total_cost
    FROM purchases
    WHERE receipt_id=$1
    ORDER BY id
  `, [receiptId], client);
  let remainingPaid = await getReceiptPaidAmount(receiptId, client);
  for (const purchase of purchases) {
    const applied = Math.min(+(purchase.total_cost || 0), remainingPaid);
    await query('UPDATE purchases SET paid_amount=$1 WHERE id=$2', [applied, purchase.id], client);
    remainingPaid -= applied;
  }
}

async function getSalesDocumentPaidAmount(salesDocumentId, client = pool) {
  const row = await get(`
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM (
      SELECT DISTINCT p.id, p.amount::numeric AS amount
      FROM payments p
      LEFT JOIN transactions t ON t.id = p.transaction_id
      LEFT JOIN sales s ON p.entity_type='sale' AND s.id = p.entity_id
      WHERE COALESCE(
        (SELECT s2.sales_document_id FROM sales s2 WHERE s2.id = t.sale_id),
        s.sales_document_id
      ) = $1
    ) x
  `, [salesDocumentId], client);
  return +(row?.total || 0);
}

async function rebalanceSalesDocumentPaidAmounts(salesDocumentId, client = pool) {
  const salesRows = await all(`
    SELECT id,total_amount
    FROM sales
    WHERE sales_document_id=$1
    ORDER BY id
  `, [salesDocumentId], client);
  let remainingPaid = await getSalesDocumentPaidAmount(salesDocumentId, client);
  for (const sale of salesRows) {
    const applied = Math.min(+(sale.total_amount || 0), remainingPaid);
    await query('UPDATE sales SET paid_amount=$1 WHERE id=$2', [applied, sale.id], client);
    remainingPaid -= applied;
  }
}

async function createLegacySalesForDocument({ date, clientId, markingId, items, salesDocumentId }, client = pool) {
  const saleIds = [];
  for (const item of items) {
    if (!item.product_id) throw new Error('Выберите товар в каждой строке');
    if (!item.sale_unit) throw new Error('Укажите единицу продажи в каждой строке');
    if (item.quantity == null || !(+item.quantity > 0)) throw new Error('Количество в каждой строке должно быть больше 0');
    if (item.price_per_unit == null || !(+item.price_per_unit > 0)) throw new Error('Цена в каждой строке должна быть больше 0');

    await validateSale(item.product_id, item.sale_unit, item.quantity, item.price_per_unit, client);
    const totalAmount = Math.round(+item.quantity * +item.price_per_unit * 100) / 100;
    const sale = await get(`
      INSERT INTO sales(date,client_id,marking_id,sales_document_id,product_id,sale_unit,quantity,price_per_unit,total_amount,paid_amount,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id
    `, [date, clientId, markingId, salesDocumentId, +item.product_id, item.sale_unit, +item.quantity, +item.price_per_unit, totalAmount, 0, item.note || item.notes || null], client);
    saleIds.push(sale.id);
  }
  return saleIds;
}

async function paySalesDocumentByAnchorSale(anchorSaleId, { amount, accountToId, date, comment }, client = pool) {
  const anchorSale = await get('SELECT * FROM sales WHERE id=$1', [anchorSaleId], client);
  if (!anchorSale) throw new Error('Продажа не найдена');
  if (!anchorSale.sales_document_id) throw new Error('Продажа не привязана к документу');

  const totalRow = await get('SELECT COALESCE(SUM(total_amount::numeric),0) AS total FROM sales WHERE sales_document_id=$1', [+anchorSale.sales_document_id], client);
  const totalAmount = +(totalRow?.total || 0);
  const paid = await getSalesDocumentPaidAmount(+anchorSale.sales_document_id, client);
  const remaining = totalAmount - paid;
  if (amount > remaining) throw new Error('Сумма оплаты превышает остаток долга');

  const payment = await get('INSERT INTO payments(entity_type,entity_id,amount,date,comment) VALUES($1,$2,$3,$4,$5) RETURNING id', ['sale', anchorSaleId, amount, date, comment], client);
  const transaction = await get(`
    INSERT INTO transactions(type,amount,account_to_id,sale_id,date,comment,related_type,related_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, ['income', amount, accountToId, anchorSaleId, date, comment, 'payment', payment.id], client);
  await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);
  await rebalanceSalesDocumentPaidAmounts(+anchorSale.sales_document_id, client);

  const newPaid = await getSalesDocumentPaidAmount(+anchorSale.sales_document_id, client);
  return {
    sales_document_id: +anchorSale.sales_document_id,
    paid_amount: newPaid,
    debt: totalAmount - newPaid,
  };
}

async function validateSale(productId, saleUnit, quantity, pricePerUnit, client = pool) {
  if (+quantity <= 0) throw new Error('Количество должно быть больше 0');
  if (+pricePerUnit <= 0) throw new Error('Цена за единицу должна быть больше 0');
  const rule = await get('SELECT * FROM product_rules WHERE product_id=$1', [+productId], client);
  if (!rule) throw new Error('Правило продажи для товара не задано. Настройте правило в разделе Товары.');
  if (rule.sale_type === 'pcs' && saleUnit === 'kg') throw new Error('Для этого товара разрешена продажа только по штукам (pcs)');
  if (rule.sale_type === 'kg' && saleUnit === 'pcs') throw new Error('Для этого товара разрешена продажа только по килограммам (kg)');
}

async function debtSummaryData(client = pool) {
  const receivable = await get(`
    WITH receivable_totals AS (
      SELECT
        COALESCE(sd.id, -s.id) AS receivable_group_id,
        COALESCE(SUM(s.total_amount::numeric),0) AS total
      FROM sales s
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      GROUP BY COALESCE(sd.id, -s.id)
    ),
    receivable_payments AS (
      SELECT x.receivable_group_id, COALESCE(SUM(x.amount::numeric),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(s.sales_document_id, s2.sales_document_id, -COALESCE(s.id, s2.id)) AS receivable_group_id, p.amount::numeric AS amount
        FROM payments p
        LEFT JOIN sales s ON p.entity_type='sale' AND s.id = p.entity_id
        LEFT JOIN transactions t ON t.id = p.transaction_id
        LEFT JOIN sales s2 ON s2.id = t.sale_id
        WHERE COALESCE(s.id, s2.id) IS NOT NULL
      ) x
      GROUP BY x.receivable_group_id
    )
    SELECT COUNT(*)::int AS count, COALESCE(SUM(total::numeric - COALESCE(paid::numeric,0)),0) AS total
    FROM (
      SELECT rt.receivable_group_id, rt.total, COALESCE(rp.paid,0) AS paid
      FROM receivable_totals rt
      LEFT JOIN receivable_payments rp ON rp.receivable_group_id = rt.receivable_group_id
      WHERE rt.total::numeric - COALESCE(rp.paid::numeric,0) > 0
    ) q
  `, [], client);

  const payable = await get(`
    WITH receipt_totals AS (
      SELECT r.id, COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      GROUP BY r.id
    ),
    receipt_payments AS (
      SELECT x.receipt_id, COALESCE(SUM(x.amount::numeric),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(t.receipt_id, pu.receipt_id) AS receipt_id, p.amount::numeric AS amount
        FROM payments p
        LEFT JOIN transactions t ON t.id = p.transaction_id
        LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id=p.entity_id
        WHERE COALESCE(t.receipt_id, pu.receipt_id) IS NOT NULL
      ) x
      GROUP BY x.receipt_id
    )
    SELECT COUNT(*)::int AS count, COALESCE(SUM(total::numeric - COALESCE(paid::numeric,0)),0) AS total
    FROM (
      SELECT rt.id, rt.total, COALESCE(rp.paid,0) AS paid
      FROM receipt_totals rt
      LEFT JOIN receipt_payments rp ON rp.receipt_id = rt.id
      WHERE rt.total::numeric - COALESCE(rp.paid::numeric,0) > 0
    ) q
  `, [], client);

  const totalWithdrawals = await get('SELECT COALESCE(SUM(amount::numeric),0) AS v FROM withdrawals', [], client);

  return {
    receivable: { count: +(receivable?.count || 0), total: +(receivable?.total || 0) },
    payable: { count: +(payable?.count || 0), total: +(payable?.total || 0) },
    total_withdrawals: +(totalWithdrawals?.v || 0),
    balance: +(receivable?.total || 0) - +(payable?.total || 0),
  };
}

async function profitSummaryData(client = pool) {
  const row = await get(`
    WITH purchase_costs AS (
      SELECT
        product_id,
        COALESCE(SUM(total_cost::numeric),0) AS total_cost,
        COALESCE(SUM(weight_kg::numeric),0) AS total_weight,
        COALESCE(SUM(quantity_pcs::numeric),0) AS total_quantity
      FROM purchases
      GROUP BY product_id
    ),
    sales_base AS (
      SELECT DISTINCT
        id,
        product_id,
        sale_unit,
        quantity::numeric AS quantity,
        COALESCE(total_amount::numeric, quantity::numeric * price_per_unit::numeric) AS revenue
      FROM sales
    )
    SELECT
      COALESCE(SUM(sb.revenue),0) AS revenue,
      COALESCE(SUM(CASE
        WHEN sb.sale_unit='kg' AND COALESCE(pc.total_weight,0) > 0
          THEN sb.quantity * pc.total_cost / pc.total_weight
        WHEN sb.sale_unit='pcs' AND COALESCE(pc.total_quantity,0) > 0
          THEN sb.quantity * pc.total_cost / pc.total_quantity
        ELSE 0
      END),0) AS cost
    FROM sales_base sb
    LEFT JOIN purchase_costs pc ON pc.product_id = sb.product_id
  `, [], client);

  const revenue = +(row?.revenue || 0);
  const cost = +(row?.cost || 0);
  return { revenue, cost, profit: revenue - cost };
}

// Clients
app.get('/api/clients', async (req, res) => {
  res.json(await all('SELECT * FROM clients ORDER BY name'));
});

app.get('/api/clients/:id', async (req, res) => {
  const client = await get('SELECT * FROM clients WHERE id=$1', [+req.params.id]);
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });
  const markings = await all('SELECT * FROM markings WHERE client_id=$1 ORDER BY marking', [+req.params.id]);
  res.json({ ...client, markings });
});

app.post('/api/clients', async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя клиента обязательно' });
  const row = await get('INSERT INTO clients(name,phone,notes) VALUES($1,$2,$3) RETURNING id', [name.trim(), phone || null, notes || null]);
  res.json({ id: row.id });
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя клиента обязательно' });
  await query('UPDATE clients SET name=$1,phone=$2,notes=$3 WHERE id=$4', [name.trim(), phone || null, notes || null, +req.params.id]);
  res.json({ success: true });
});

app.delete('/api/clients/:id', async (req, res) => {
  await query('DELETE FROM clients WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

// Suppliers
app.get('/api/suppliers', async (req, res) => {
  res.json(await all('SELECT * FROM suppliers ORDER BY name'));
});

app.post('/api/suppliers', async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя поставщика обязательно' });
  const row = await get('INSERT INTO suppliers(name,phone,notes) VALUES($1,$2,$3) RETURNING id', [name.trim(), phone || null, notes || null]);
  res.json({ id: row.id });
});

app.put('/api/suppliers/:id', async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя поставщика обязательно' });
  await query('UPDATE suppliers SET name=$1,phone=$2,notes=$3 WHERE id=$4', [name.trim(), phone || null, notes || null, +req.params.id]);
  res.json({ success: true });
});

app.delete('/api/suppliers/:id', async (req, res) => {
  const used = await get('SELECT id FROM purchases WHERE supplier_id=$1 LIMIT 1', [+req.params.id]);
  if (used) return res.status(400).json({ error: 'Поставщик используется в приходах' });
  await query('DELETE FROM suppliers WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

// Markings
app.get('/api/markings', async (req, res) => {
  const { client_id } = req.query;
  const sql = `
    SELECT m.*, c.name AS client_name
    FROM markings m
    JOIN clients c ON c.id = m.client_id
    ${client_id ? 'WHERE m.client_id=$1' : ''}
    ORDER BY m.marking
  `;
  res.json(await all(sql, client_id ? [+client_id] : []));
});

app.post('/api/markings', async (req, res) => {
  const { client_id, marking } = req.body;
  if (!client_id || !marking?.trim()) return res.status(400).json({ error: 'client_id и маркировка обязательны' });
  try {
    const row = await get('INSERT INTO markings(client_id,marking) VALUES($1,$2) RETURNING id', [+client_id, marking.trim().toUpperCase()]);
    res.json({ id: row.id });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Такая маркировка уже существует' : e.message });
  }
});

app.put('/api/markings/:id', async (req, res) => {
  const { client_id, marking } = req.body;
  if (!client_id || !marking?.trim()) return res.status(400).json({ error: 'client_id и маркировка обязательны' });
  try {
    await query('UPDATE markings SET client_id=$1,marking=$2 WHERE id=$3', [+client_id, marking.trim().toUpperCase(), +req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Такая маркировка уже существует' : e.message });
  }
});

app.delete('/api/markings/:id', async (req, res) => {
  await query('DELETE FROM markings WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

// Products
app.get('/api/products', async (req, res) => {
  res.json(await all(`
    SELECT p.*, pr.sale_type
    FROM products p
    LEFT JOIN product_rules pr ON pr.product_id = p.id
    ORDER BY p.name
  `));
});

app.post('/api/products', async (req, res) => {
  const { name, category, is_active, sale_type } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Название товара обязательно' });
  const product = await get('INSERT INTO products(name,category,is_active) VALUES($1,$2,$3) RETURNING id', [name.trim(), category || null, is_active !== false]);
  if (sale_type) await query('INSERT INTO product_rules(product_id,sale_type) VALUES($1,$2)', [product.id, sale_type]);
  res.json({ id: product.id });
});

app.put('/api/products/:id', async (req, res) => {
  const { name, category, is_active, sale_type } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Название товара обязательно' });
  await query('UPDATE products SET name=$1,category=$2,is_active=$3 WHERE id=$4', [name.trim(), category || null, !!is_active, +req.params.id]);
  if (sale_type) {
    const existing = await get('SELECT id FROM product_rules WHERE product_id=$1', [+req.params.id]);
    if (existing) await query('UPDATE product_rules SET sale_type=$1 WHERE product_id=$2', [sale_type, +req.params.id]);
    else await query('INSERT INTO product_rules(product_id,sale_type) VALUES($1,$2)', [+req.params.id, sale_type]);
  }
  res.json({ success: true });
});

app.delete('/api/products/:id', async (req, res) => {
  await query('DELETE FROM products WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

// Receipts
app.get('/api/receipts', async (req, res) => {
  res.json(await all(`
    SELECT
      r.id,
      r.date,
      s.name AS supplier_name,
      c.name AS client_name,
      COUNT(ri.id)::int AS items_count,
      COALESCE(SUM(ri.weight::numeric),0) AS total_weight,
      COALESCE(SUM(ri.quantity::numeric),0) AS total_quantity
    FROM receipts r
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
    GROUP BY r.id, r.date, s.name, c.name, r.created_at
    ORDER BY r.date DESC, r.created_at DESC
  `));
});

app.get('/api/receipts/:id', async (req, res) => {
  const id = +req.params.id;
  const receipt = await get(`
    SELECT r.*, s.name AS supplier_name, c.name AS client_name, m.marking
    FROM receipts r
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN markings m ON m.id = r.marking_id
    WHERE r.id=$1
  `, [id]);
  if (!receipt) return res.status(404).json({ error: 'Приход не найден' });
  const items = await all(`
    SELECT ri.*, p.name AS product_name
    FROM receipt_items ri
    LEFT JOIN products p ON p.id = ri.product_id
    WHERE ri.receipt_id=$1
    ORDER BY ri.id
  `, [id]);
  res.json({ ...receipt, items });
});

app.post('/api/receipts', async (req, res) => {
  const body = req.body;
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы один товар' });
  if (!body.date) return res.status(400).json({ error: 'Дата обязательна' });
  if (!body.supplier_id) return res.status(400).json({ error: 'Поставщик обязателен' });

  try {
    const result = await withTx(async (client) => {
      const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id, client);
      const receipt = await get(
        'INSERT INTO receipts(date,supplier_id,client_id,marking_id) VALUES($1,$2,$3,$4) RETURNING id',
        [body.date, +body.supplier_id, cid, mid],
        client
      );

      const purchaseIds = [];
      for (const item of items) {
        if (!item.product_id) throw new Error('Выберите товар в каждой строке');
        const weight = +(item.weight ?? item.weight_kg) || 0;
        const quantity = +(item.quantity ?? item.quantity_pcs) || 0;
        if (!(weight > 0) && !(quantity > 0)) throw new Error('Укажите вес или количество в каждой строке');
        validatePurchaseNums({ weight_kg: weight, quantity_pcs: quantity, cost_almaty: item.cost_almaty, cost_dubai: item.cost_dubai });

        const costAlmaty = +item.cost_almaty || 0;
        const costDubai = +item.cost_dubai || 0;
        const costPerKg = costAlmaty + costDubai;
        const totalCost = costPerKg * weight;
        const note = item.note || item.notes || null;

        await query(
          'INSERT INTO receipt_items(receipt_id,product_id,weight,quantity,cost_almaty,cost_dubai,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [receipt.id, +item.product_id, weight, quantity, costAlmaty, costDubai, note],
          client
        );

        const purchase = await get(`
          INSERT INTO purchases(date,client_id,marking_id,supplier_id,receipt_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,total_cost,paid_amount,notes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING id
        `, [body.date, cid, mid, +body.supplier_id, receipt.id, +item.product_id, quantity, weight, +(item.boxes_count || item.boxes || 0), costAlmaty, costDubai, costPerKg, totalCost, 0, note], client);
        purchaseIds.push(purchase.id);
      }

      return { receipt_id: receipt.id, purchase_ids: purchaseIds };
    });

    res.json({ id: result.receipt_id, items_count: items.length, purchase_ids: result.purchase_ids });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/receipts/:id', async (req, res) => {
  const id = +req.params.id;
  const body = req.body;
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы один товар' });
  if (!body.date) return res.status(400).json({ error: 'Дата обязательна' });
  if (!body.supplier_id) return res.status(400).json({ error: 'Поставщик обязателен' });

  try {
    const existing = await get('SELECT * FROM receipts WHERE id=$1', [id]);
    if (!existing) return res.status(404).json({ error: 'Приход не найден' });

    const purchaseIds = await withTx(async (client) => {
      const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id, client);
      await query('UPDATE receipts SET date=$1,supplier_id=$2,client_id=$3,marking_id=$4 WHERE id=$5', [body.date, +body.supplier_id, cid, mid, id], client);
      await query('DELETE FROM transactions WHERE receipt_id=$1', [id], client);
      await query(`
        DELETE FROM payments
        WHERE entity_type='purchase'
          AND entity_id IN (SELECT id FROM purchases WHERE receipt_id=$1)
      `, [id], client);
      await query('DELETE FROM purchases WHERE receipt_id=$1', [id], client);
      await query('DELETE FROM receipt_items WHERE receipt_id=$1', [id], client);

      const ids = [];
      for (const item of items) {
        if (!item.product_id) throw new Error('Выберите товар в каждой строке');
        const weight = +(item.weight ?? item.weight_kg) || 0;
        const quantity = +(item.quantity ?? item.quantity_pcs) || 0;
        if (!(weight > 0) && !(quantity > 0)) throw new Error('Укажите вес или количество в каждой строке');
        validatePurchaseNums({ weight_kg: weight, quantity_pcs: quantity, cost_almaty: item.cost_almaty, cost_dubai: item.cost_dubai });

        const costAlmaty = +item.cost_almaty || 0;
        const costDubai = +item.cost_dubai || 0;
        const costPerKg = costAlmaty + costDubai;
        const totalCost = costPerKg * weight;
        const note = item.note || item.notes || null;

        await query('INSERT INTO receipt_items(receipt_id,product_id,weight,quantity,cost_almaty,cost_dubai,note) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, +item.product_id, weight, quantity, costAlmaty, costDubai, note], client);
        const purchase = await get(`
          INSERT INTO purchases(date,client_id,marking_id,supplier_id,receipt_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,total_cost,paid_amount,notes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING id
        `, [body.date, cid, mid, +body.supplier_id, id, +item.product_id, quantity, weight, +(item.boxes_count || item.boxes || 0), costAlmaty, costDubai, costPerKg, totalCost, 0, note], client);
        ids.push(purchase.id);
      }
      return ids;
    });

    res.json({ success: true, id, items_count: items.length, purchase_ids: purchaseIds });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/receipts/:id', async (req, res) => {
  const id = +req.params.id;
  try {
    const receipt = await get('SELECT * FROM receipts WHERE id=$1', [id]);
    if (!receipt) return res.status(404).json({ error: 'Приход не найден' });
    await withTx(async (client) => {
      const purchaseIds = await all('SELECT id FROM purchases WHERE receipt_id=$1', [id], client);
      await query('DELETE FROM transactions WHERE receipt_id=$1', [id], client);
      for (const purchase of purchaseIds) {
        await query("DELETE FROM payments WHERE entity_type='purchase' AND entity_id=$1", [purchase.id], client);
      }
      await query('DELETE FROM purchases WHERE receipt_id=$1', [id], client);
      await query('DELETE FROM receipt_items WHERE receipt_id=$1', [id], client);
      await query('DELETE FROM receipts WHERE id=$1', [id], client);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/receipts/:id/pay', async (req, res) => {
  const id = +req.params.id;
  const amount = +req.body.amount;
  const accountFromId = +req.body.account_from_id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const comment = req.body.comment || null;

  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { type: 'expense', amount, account_id: accountFromId, receipt_id: id, sale_id: null });
  if (!accountFromId) return validationError(res, 'Счет списания обязателен', { type: 'expense', amount, account_id: accountFromId, receipt_id: id, sale_id: null });
  if (await getAccountBalance(accountFromId) < amount) return validationError(res, 'Недостаточно средств в кассе', { type: 'expense', amount, account_id: accountFromId, receipt_id: id, sale_id: null });

  try {
    const receipt = await get(`
      SELECT r.*, COALESCE(SUM(p.total_cost::numeric),0) AS total_cost, MIN(p.id) AS anchor_purchase_id
      FROM receipts r
      LEFT JOIN purchases p ON p.receipt_id = r.id
      WHERE r.id=$1
      GROUP BY r.id
    `, [id]);
    if (!receipt) return res.status(404).json({ error: 'Приход не найден' });
    if (!receipt.anchor_purchase_id) return res.status(400).json({ error: 'В документе нет товаров для оплаты' });

    const paid = await getReceiptPaidAmount(id);
    const remaining = +(receipt.total_cost || 0) - paid;
    if (amount > remaining) return validationError(res, 'Сумма оплаты превышает остаток долга', { type: 'expense', amount, account_id: accountFromId, receipt_id: id, sale_id: null });

    await withTx(async (client) => {
      const payment = await get('INSERT INTO payments(entity_type,entity_id,amount,date,comment) VALUES($1,$2,$3,$4,$5) RETURNING id', ['purchase', +receipt.anchor_purchase_id, amount, date, comment], client);
      const transaction = await get(`
        INSERT INTO transactions(type,amount,account_from_id,receipt_id,date,comment,related_type,related_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id
      `, ['expense', amount, accountFromId, id, date, comment, 'payment', payment.id], client);
      await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);
      await rebalanceReceiptPurchasePaidAmounts(id, client);
    });

    const newPaid = await getReceiptPaidAmount(id);
    res.json({ success: true, receipt_id: id, paid_amount: newPaid, payable: +(receipt.total_cost || 0) - newPaid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Purchases
app.get('/api/purchases', async (req, res) => {
  const { client_id, product_id, from_date, to_date } = req.query;
  const params = [];
  const where = ['1=1'];
  if (client_id) { params.push(+client_id); where.push(`p.client_id=$${params.length}`); }
  if (product_id) { params.push(+product_id); where.push(`p.product_id=$${params.length}`); }
  if (from_date) { params.push(from_date); where.push(`p.date >= $${params.length}`); }
  if (to_date) { params.push(to_date); where.push(`p.date <= $${params.length}`); }

  res.json(await all(`
    SELECT p.*, c.name AS client_name, m.marking, pr.name AS product_name
    FROM purchases p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN markings m ON m.id = p.marking_id
    LEFT JOIN products pr ON pr.id = p.product_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.date DESC, p.created_at DESC
  `, params));
});

app.post('/api/purchases', async (req, res) => {
  const body = req.body;
  if (!body.date || !body.product_id) return res.status(400).json({ error: 'Дата и товар обязательны' });
  if (!body.supplier_id) return res.status(400).json({ error: 'Поставщик обязателен' });

  try {
    validatePurchaseNums(body);
    const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id);
    const weight = +body.weight_kg || 0;
    const costPerKg = (+body.cost_almaty || 0) + (+body.cost_dubai || 0);
    const totalCost = costPerKg * weight;
    const paidAmount = +body.paid_amount || 0;
    const row = await get(`
      INSERT INTO purchases(date,client_id,marking_id,supplier_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,total_cost,paid_amount,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id
    `, [body.date, cid, mid, +body.supplier_id, +body.product_id, +body.quantity_pcs || 0, weight, +body.boxes_count || 0, +body.cost_almaty || 0, +body.cost_dubai || 0, costPerKg, totalCost, paidAmount, body.notes || null]);
    res.json({ id: row.id, cost_per_kg: costPerKg, total_cost: totalCost, paid_amount: paidAmount, payable: totalCost - paidAmount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/purchases/:id', async (req, res) => {
  const body = req.body;
  if (!body.date || !body.product_id) return res.status(400).json({ error: 'Дата и товар обязательны' });
  try {
    validatePurchaseNums(body);
    const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id);
    const weight = +body.weight_kg || 0;
    const costPerKg = (+body.cost_almaty || 0) + (+body.cost_dubai || 0);
    const totalCost = costPerKg * weight;
    await query(`
      UPDATE purchases
      SET date=$1,client_id=$2,marking_id=$3,product_id=$4,quantity_pcs=$5,weight_kg=$6,boxes_count=$7,cost_almaty=$8,cost_dubai=$9,cost_per_kg=$10,total_cost=$11,notes=$12
      WHERE id=$13
    `, [body.date, cid, mid, +body.product_id, +body.quantity_pcs || 0, weight, +body.boxes_count || 0, +body.cost_almaty || 0, +body.cost_dubai || 0, costPerKg, totalCost, body.notes || null, +req.params.id]);
    res.json({ success: true, cost_per_kg: costPerKg, total_cost: totalCost });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/purchases/:id/pay', async (req, res) => {
  const id = +req.params.id;
  const amount = +req.body.amount;
  const accountFromId = +req.body.account_from_id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const comment = req.body.comment || null;

  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { type: 'expense', amount, account_id: accountFromId, receipt_id: null, sale_id: null });
  if (!accountFromId) return validationError(res, 'Счет списания обязателен', { type: 'expense', amount, account_id: accountFromId, receipt_id: null, sale_id: null });
  if (await getAccountBalance(accountFromId) < amount) return validationError(res, 'Недостаточно средств в кассе', { type: 'expense', amount, account_id: accountFromId, receipt_id: null, sale_id: null });

  try {
    const purchase = await get('SELECT * FROM purchases WHERE id=$1', [id]);
    if (!purchase) return res.status(404).json({ error: 'Приход не найден' });
    if (!purchase.receipt_id) return validationError(res, 'Expense должен быть привязан к приходу (receipt_id обязателен)', { type: 'expense', amount, account_id: accountFromId, receipt_id: null, sale_id: null });

    const remaining = +(purchase.total_cost || 0) - +(purchase.paid_amount || 0);
    if (amount > remaining) return validationError(res, 'Сумма оплаты превышает остаток долга', { type: 'expense', amount, account_id: accountFromId, receipt_id: +purchase.receipt_id, sale_id: null });

    await withTx(async (client) => {
      const payment = await get('INSERT INTO payments(entity_type,entity_id,amount,date,comment) VALUES($1,$2,$3,$4,$5) RETURNING id', ['purchase', id, amount, date, comment], client);
      const transaction = await get(`
        INSERT INTO transactions(type,amount,account_from_id,receipt_id,date,comment,related_type,related_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id
      `, ['expense', amount, accountFromId, +purchase.receipt_id, date, comment, 'payment', payment.id], client);
      await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);
      await rebalanceReceiptPurchasePaidAmounts(+purchase.receipt_id, client);
    });

    const paidAmount = +(await getReceiptPaidAmount(+purchase.receipt_id));
    const receiptTotal = await get('SELECT COALESCE(SUM(total_cost::numeric),0) AS total FROM purchases WHERE receipt_id=$1', [+purchase.receipt_id]);
    res.json({ success: true, paid_amount: paidAmount, payable: +(receiptTotal?.total || 0) - paidAmount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/purchases/:id', async (req, res) => {
  await query('DELETE FROM purchases WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

app.post('/api/sales-documents', async (req, res) => {
  const body = req.body;
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы один товар' });
  if (!body.date) return res.status(400).json({ error: 'Дата обязательна' });

  try {
    const result = await withTx(async (client) => {
      const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id, client);
      const salesDocument = await get(
        'INSERT INTO sales_documents(date,client_id,marking_id) VALUES($1,$2,$3) RETURNING id',
        [body.date, cid, mid],
        client
      );

      for (const item of items) {
        if (!item.product_id) throw new Error('Выберите товар в каждой строке');
        if (!item.sale_unit) throw new Error('Укажите единицу продажи в каждой строке');
        if (!(+item.quantity > 0)) throw new Error('Количество в каждой строке должно быть больше 0');
        if (!(+item.price_per_unit > 0)) throw new Error('Цена в каждой строке должна быть больше 0');
        await query(
          'INSERT INTO sales_items(sales_document_id,product_id,sale_unit,quantity,price_per_unit,note) VALUES($1,$2,$3,$4,$5,$6)',
          [salesDocument.id, +item.product_id, item.sale_unit, +item.quantity, +item.price_per_unit, item.note || item.notes || null],
          client
        );
      }

      const saleIds = await createLegacySalesForDocument({
        date: body.date,
        clientId: cid,
        markingId: mid,
        items,
        salesDocumentId: salesDocument.id,
      }, client);

      return { id: salesDocument.id, sale_ids: saleIds };
    });

    res.json({ id: result.id, items_count: items.length, sale_ids: result.sale_ids });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/sales-documents/:id/pay', async (req, res) => {
  const salesDocumentId = +req.params.id;
  const amount = +req.body.amount;
  const accountToId = +req.body.account_to_id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const comment = req.body.comment || null;

  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { type: 'income', amount, account_id: accountToId, receipt_id: null, sale_id: salesDocumentId });
  if (!accountToId) return validationError(res, 'Счет зачисления обязателен', { type: 'income', amount, account_id: accountToId, receipt_id: null, sale_id: salesDocumentId });

  try {
    const anchorSale = await get('SELECT id FROM sales WHERE sales_document_id=$1 ORDER BY id LIMIT 1', [salesDocumentId]);
    if (!anchorSale) return res.status(404).json({ error: 'Документ продажи не найден' });

    const result = await withTx((client) => paySalesDocumentByAnchorSale(anchorSale.id, { amount, accountToId, date, comment }, client));
    res.json({ success: true, sales_document_id: result.sales_document_id, paid_amount: result.paid_amount, debt: result.debt });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Sales
app.get('/api/sales', async (req, res) => {
  const { client_id, product_id, from_date, to_date } = req.query;
  const params = [];
  const where = ['1=1'];
  if (client_id) { params.push(+client_id); where.push(`s.client_id=$${params.length}`); }
  if (product_id) { params.push(+product_id); where.push(`s.product_id=$${params.length}`); }
  if (from_date) { params.push(from_date); where.push(`s.date >= $${params.length}`); }
  if (to_date) { params.push(to_date); where.push(`s.date <= $${params.length}`); }

  res.json(await all(`
    SELECT s.*, c.name AS client_name, m.marking, p.name AS product_name
    FROM sales s
    LEFT JOIN clients c ON c.id = s.client_id
    LEFT JOIN markings m ON m.id = s.marking_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.date DESC, s.created_at DESC
  `, params));
});

app.post('/api/sales', async (req, res) => {
  const body = req.body;
  if (!body.date || !body.product_id || !body.sale_unit || body.quantity == null || body.price_per_unit == null) {
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  }
  try {
    await validateSale(body.product_id, body.sale_unit, body.quantity, body.price_per_unit);
    const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id);
    const totalAmount = Math.round(+body.quantity * +body.price_per_unit * 100) / 100;
    const paidAmount = +body.paid_amount || 0;
    const row = await get(`
      INSERT INTO sales(date,client_id,marking_id,product_id,sale_unit,quantity,price_per_unit,total_amount,paid_amount,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `, [body.date, cid, mid, +body.product_id, body.sale_unit, +body.quantity, +body.price_per_unit, totalAmount, paidAmount, body.notes || null]);
    res.json({ id: row.id, total_amount: totalAmount, paid_amount: paidAmount, debt: totalAmount - paidAmount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/sales/:id', async (req, res) => {
  const body = req.body;
  if (!body.date || !body.product_id || !body.sale_unit || body.quantity == null || body.price_per_unit == null) {
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  }
  try {
    await validateSale(body.product_id, body.sale_unit, body.quantity, body.price_per_unit);
    const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id);
    const totalAmount = Math.round(+body.quantity * +body.price_per_unit * 100) / 100;
    await query(`
      UPDATE sales
      SET date=$1,client_id=$2,marking_id=$3,product_id=$4,sale_unit=$5,quantity=$6,price_per_unit=$7,total_amount=$8,notes=$9
      WHERE id=$10
    `, [body.date, cid, mid, +body.product_id, body.sale_unit, +body.quantity, +body.price_per_unit, totalAmount, body.notes || null, +req.params.id]);
    res.json({ success: true, total_amount: totalAmount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/sales/:id/pay', async (req, res) => {
  const id = +req.params.id;
  const amount = +req.body.amount;
  const accountToId = +req.body.account_to_id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const comment = req.body.comment || null;
  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { type: 'income', amount, account_id: accountToId, receipt_id: null, sale_id: id });
  if (!accountToId) return validationError(res, 'Счет зачисления обязателен', { type: 'income', amount, account_id: accountToId, receipt_id: null, sale_id: id });

  try {
    const sale = await get('SELECT * FROM sales WHERE id=$1', [id]);
    if (!sale) return res.status(404).json({ error: 'Продажа не найдена' });
    if (sale.sales_document_id) {
      const result = await withTx((client) => paySalesDocumentByAnchorSale(id, { amount, accountToId, date, comment }, client));
      return res.json({ success: true, sales_document_id: result.sales_document_id, paid_amount: result.paid_amount, debt: result.debt });
    }

    const remaining = +(sale.total_amount || 0) - +(sale.paid_amount || 0);
    if (amount > remaining) return validationError(res, 'Сумма оплаты превышает остаток долга', { type: 'income', amount, account_id: accountToId, receipt_id: null, sale_id: id });

    await withTx(async (client) => {
      const payment = await get('INSERT INTO payments(entity_type,entity_id,amount,date,comment) VALUES($1,$2,$3,$4,$5) RETURNING id', ['sale', id, amount, date, comment], client);
      const transaction = await get(`
        INSERT INTO transactions(type,amount,account_to_id,sale_id,date,comment,related_type,related_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id
      `, ['income', amount, accountToId, id, date, comment, 'payment', payment.id], client);
      await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);
      await query('UPDATE sales SET paid_amount = COALESCE(paid_amount,0) + $1 WHERE id=$2', [amount, id], client);
    });

    const updated = await get('SELECT paid_amount,total_amount FROM sales WHERE id=$1', [id]);
    res.json({ success: true, paid_amount: +(updated.paid_amount || 0), debt: +(updated.total_amount || 0) - +(updated.paid_amount || 0) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/sales/:id', async (req, res) => {
  const id = +req.params.id;
  try {
    await withTx(async (client) => {
      await query('DELETE FROM transactions WHERE sale_id=$1', [id], client);
      await query("DELETE FROM payments WHERE entity_type='sale' AND entity_id=$1", [id], client);
      await query('DELETE FROM sales WHERE id=$1', [id], client);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Debts
app.get('/api/debts', async (req, res) => {
  const debts = await all(`
    WITH receivable_totals AS (
      SELECT
        COALESCE(sd.id, -s.id) AS receivable_group_id,
        sd.id AS sales_document_id,
        COALESCE(sd.date, s.date) AS date,
        COALESCE(sd.created_at, s.created_at) AS created_at,
        COALESCE(sd.client_id, s.client_id) AS client_id,
        COALESCE(sd.marking_id, s.marking_id) AS marking_id,
        c.name AS client_name,
        m.marking,
        COALESCE(SUM(s.total_amount::numeric),0) AS total,
        COUNT(s.id)::int AS items_count,
        MIN(s.id) AS anchor_sale_id
      FROM sales s
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      LEFT JOIN clients c ON c.id = COALESCE(sd.client_id, s.client_id)
      LEFT JOIN markings m ON m.id = COALESCE(sd.marking_id, s.marking_id)
      GROUP BY COALESCE(sd.id, -s.id), sd.id, COALESCE(sd.date, s.date), COALESCE(sd.created_at, s.created_at), COALESCE(sd.client_id, s.client_id), COALESCE(sd.marking_id, s.marking_id), c.name, m.marking
    ),
    receivable_payments AS (
      SELECT x.receivable_group_id, COALESCE(SUM(x.amount::numeric),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(s.sales_document_id, s2.sales_document_id, -COALESCE(s.id, s2.id)) AS receivable_group_id, p.amount::numeric AS amount
        FROM payments p
        LEFT JOIN sales s ON p.entity_type='sale' AND s.id = p.entity_id
        LEFT JOIN transactions t ON t.id = p.transaction_id
        LEFT JOIN sales s2 ON s2.id = t.sale_id
        WHERE COALESCE(s.id, s2.id) IS NOT NULL
      ) x
      GROUP BY x.receivable_group_id
    ),
    receipt_totals AS (
      SELECT r.id AS receipt_id, r.date, r.created_at, r.supplier_id, s.name AS supplier_name, COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      LEFT JOIN suppliers s ON s.id = r.supplier_id
      GROUP BY r.id, r.date, r.created_at, r.supplier_id, s.name
    ),
    receipt_payments AS (
      SELECT x.receipt_id, COALESCE(SUM(x.amount::numeric),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(t.receipt_id, pu.receipt_id) AS receipt_id, p.amount::numeric AS amount
        FROM payments p
        LEFT JOIN transactions t ON t.id = p.transaction_id
        LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id = p.entity_id
        WHERE COALESCE(t.receipt_id, pu.receipt_id) IS NOT NULL
      ) x
      GROUP BY x.receipt_id
    )
    SELECT *
    FROM (
      SELECT
        'receivable' AS type,
        rt.anchor_sale_id AS id,
        rt.date,
        rt.client_id,
        rt.client_name,
        rt.marking_id,
        rt.marking,
        NULL::INTEGER AS supplier_id,
        NULL::TEXT AS supplier_name,
        s.product_id,
        CASE
          WHEN rt.items_count = 1 THEN p.name
          ELSE rt.items_count::text || ' тов.'
        END AS product_name,
        rt.total::numeric AS amount,
        COALESCE(rp.paid::numeric,0) AS paid_amount,
        rt.total::numeric - COALESCE(rp.paid::numeric,0) AS debt,
        NULL::TEXT AS notes,
        rt.total::numeric AS total,
        COALESCE(rp.paid::numeric,0) AS paid,
        CASE
          WHEN rt.sales_document_id IS NOT NULL THEN 'Продажа №' || rt.sales_document_id
          ELSE NULL::TEXT
        END AS document_label,
        rt.created_at::timestamp AS created_at
      FROM receivable_totals rt
      LEFT JOIN receivable_payments rp ON rp.receivable_group_id = rt.receivable_group_id
      LEFT JOIN sales s ON s.id = rt.anchor_sale_id
      LEFT JOIN products p ON p.id = s.product_id
      WHERE rt.total::numeric - COALESCE(rp.paid::numeric,0) > 0
      UNION ALL
      SELECT
        'payable' AS type,
        rt.receipt_id AS id,
        rt.date,
        NULL::INTEGER AS client_id,
        NULL::TEXT AS client_name,
        NULL::INTEGER AS marking_id,
        NULL::TEXT AS marking,
        rt.supplier_id,
        rt.supplier_name,
        NULL::INTEGER AS product_id,
        NULL::TEXT AS product_name,
        rt.total::numeric AS amount,
        COALESCE(rp.paid::numeric,0) AS paid_amount,
        rt.total::numeric - COALESCE(rp.paid::numeric,0) AS debt,
        NULL::TEXT AS notes,
        rt.total::numeric AS total,
        COALESCE(rp.paid::numeric,0) AS paid,
        'Приход №' || rt.receipt_id AS document_label,
        rt.created_at::timestamp AS created_at
      FROM receipt_totals rt
      LEFT JOIN receipt_payments rp ON rp.receipt_id = rt.receipt_id
      WHERE rt.total::numeric - COALESCE(rp.paid::numeric,0) > 0
    ) q
    ORDER BY date DESC, created_at DESC
  `);
  res.json(debts);
});

app.get('/api/debts/by-suppliers', async (req, res) => {
  res.json(await all(`
    WITH receipt_totals AS (
      SELECT r.id, r.supplier_id, COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      GROUP BY r.id, r.supplier_id
    ),
    receipt_payments AS (
      SELECT x.receipt_id, COALESCE(SUM(x.amount::numeric),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(t.receipt_id, pu.receipt_id) AS receipt_id, p.amount::numeric AS amount
        FROM payments p
        LEFT JOIN transactions t ON t.id = p.transaction_id
        LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id = p.entity_id
        WHERE COALESCE(t.receipt_id, pu.receipt_id) IS NOT NULL
      ) x
      GROUP BY x.receipt_id
    )
    SELECT s.id, s.name, COALESCE(SUM(rt.total::numeric - COALESCE(rp.paid::numeric,0)),0) AS debt
    FROM suppliers s
    LEFT JOIN receipt_totals rt ON rt.supplier_id = s.id
    LEFT JOIN receipt_payments rp ON rp.receipt_id = rt.id
    GROUP BY s.id, s.name
    HAVING COALESCE(SUM(rt.total::numeric - COALESCE(rp.paid::numeric,0)),0) > 0
    ORDER BY debt DESC
  `));
});

app.get('/api/debts/summary', async (req, res) => {
  res.json(await debtSummaryData());
});

// Payments
app.get('/api/payments', async (req, res) => {
  res.json(await all(`
    SELECT
      p.id,
      p.entity_type,
      p.entity_id,
      p.amount,
      p.date,
      p.comment,
      p.transaction_id,
      t.type,
      a.name AS account_name,
      p.created_at,
      c.name AS client_name,
      pr.name AS product_name
    FROM payments p
    LEFT JOIN transactions t ON t.id = p.transaction_id
    LEFT JOIN accounts a ON a.id = COALESCE(t.account_to_id, t.account_from_id)
    LEFT JOIN sales s ON p.entity_type='sale' AND s.id = p.entity_id
    LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id = p.entity_id
    LEFT JOIN clients c ON c.id = COALESCE(s.client_id, pu.client_id)
    LEFT JOIN products pr ON pr.id = COALESCE(s.product_id, pu.product_id)
    ORDER BY p.date DESC, p.created_at DESC
  `));
});

// Ledger
app.get('/api/ledger', async (req, res) => {
  const { type, id } = req.query;
  const entityId = +id;
  if (!['client', 'supplier'].includes(type) || !entityId) return res.status(400).json({ error: 'type и id обязательны' });

  const rows = type === 'client'
    ? await all(`
        SELECT * FROM (
          SELECT
            s.date::text AS date,
            'sale'::text AS type,
            s.id::integer AS id,
            s.total_amount::numeric AS amount,
            s.paid_amount::numeric AS paid_amount,
            s.notes::text AS comment,
            NULL::text AS account_name,
            NULL::text AS transaction_type,
            s.created_at::timestamp AS created_at,
            0::integer AS sort_order
          FROM sales s
          WHERE s.client_id=$1
          UNION ALL
          SELECT
            p.date::text AS date,
            'payment'::text AS type,
            p.id::integer AS id,
            p.amount::numeric AS amount,
            NULL::numeric AS paid_amount,
            p.comment::text AS comment,
            a.name::text AS account_name,
            t.type::text AS transaction_type,
            p.created_at::timestamp AS created_at,
            1::integer AS sort_order
          FROM payments p
          JOIN sales s ON p.entity_type='sale' AND s.id=p.entity_id
          LEFT JOIN transactions t ON t.id=p.transaction_id
          LEFT JOIN accounts a ON a.id=COALESCE(t.account_to_id,t.account_from_id)
          WHERE s.client_id=$1
        ) x
        ORDER BY date ASC, created_at ASC, sort_order ASC, id ASC
      `, [entityId])
    : await all(`
        SELECT * FROM (
          SELECT
            p.date::text AS date,
            'purchase'::text AS type,
            p.id::integer AS id,
            p.total_cost::numeric AS amount,
            p.paid_amount::numeric AS paid_amount,
            p.notes::text AS comment,
            NULL::text AS account_name,
            NULL::text AS transaction_type,
            p.created_at::timestamp AS created_at,
            0::integer AS sort_order
          FROM purchases p
          WHERE p.supplier_id=$1
          UNION ALL
          SELECT
            pay.date::text AS date,
            'payment'::text AS type,
            pay.id::integer AS id,
            pay.amount::numeric AS amount,
            NULL::numeric AS paid_amount,
            pay.comment::text AS comment,
            a.name::text AS account_name,
            t.type::text AS transaction_type,
            pay.created_at::timestamp AS created_at,
            1::integer AS sort_order
          FROM payments pay
          JOIN purchases p ON pay.entity_type='purchase' AND p.id=pay.entity_id
          LEFT JOIN transactions t ON t.id=pay.transaction_id
          LEFT JOIN accounts a ON a.id=COALESCE(t.account_to_id,t.account_from_id)
          WHERE p.supplier_id=$1
        ) x
        ORDER BY date ASC, created_at ASC, sort_order ASC, id ASC
      `, [entityId]);

  let balance = 0;
  res.json(rows.map((row) => {
    balance += row.type === 'payment' ? -(+row.amount || 0) : (+row.amount || 0);
    return { ...row, balance };
  }));
});

// Withdrawals
app.get('/api/withdrawals', async (req, res) => {
  res.json(await all('SELECT * FROM withdrawals ORDER BY date DESC, created_at DESC'));
});

app.post('/api/withdrawals', async (req, res) => {
  const { amount, date, comment } = req.body;
  if (!(+amount > 0) || !date) return res.status(400).json({ error: 'Сумма и дата обязательны' });
  const row = await get('INSERT INTO withdrawals(amount,date,comment) VALUES($1,$2,$3) RETURNING id', [+amount, date, comment || null]);
  res.json({ id: row.id });
});

// Accounts & Transactions
app.get('/api/accounts', async (req, res) => {
  res.json(await all(`
    SELECT
      a.*,
      COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='income' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='expense' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='withdraw' AND account_from_id=a.id),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_from_id=a.id),0)
      AS balance
    FROM accounts a
    ORDER BY a.name
  `));
});

app.post('/api/accounts', async (req, res) => {
  const { name, currency } = req.body;
  if (!name?.trim() || !currency?.trim()) return res.status(400).json({ error: 'Название и валюта обязательны' });
  const row = await get('INSERT INTO accounts(name,currency) VALUES($1,$2) RETURNING id', [name.trim(), currency.trim().toUpperCase()]);
  res.json({ id: row.id });
});

app.get('/api/transactions', async (req, res) => {
  res.json(await all(`
    SELECT t.*, af.name AS account_from_name, at.name AS account_to_name
    FROM transactions t
    LEFT JOIN accounts af ON af.id = t.account_from_id
    LEFT JOIN accounts at ON at.id = t.account_to_id
    ORDER BY t.date DESC, t.created_at DESC
  `));
});

app.post('/api/transactions', async (req, res) => {
  const { type, amount, date, comment, related_type, related_id } = req.body;
  const accountFromId = req.body.account_from_id || req.body.from_account_id || ((type === 'expense' || type === 'withdraw') ? req.body.account_id : null);
  const accountToId = req.body.account_to_id || req.body.to_account_id || (type === 'income' ? req.body.account_id : null);
  const receiptId = type === 'expense' && req.body.receipt_id ? +req.body.receipt_id : null;
  const saleId = type === 'income' && req.body.sale_id ? +req.body.sale_id : null;
  const context = { type, amount: +amount, account_id: accountFromId || accountToId || null, receipt_id: receiptId, sale_id: saleId };

  if (!['income', 'expense', 'transfer', 'withdraw'].includes(type)) return validationError(res, 'Некорректный тип операции', context);
  if (!(+amount > 0)) return validationError(res, 'Сумма должна быть больше 0', context);
  if (!date) return validationError(res, 'Дата обязательна', context);
  if (type === 'income' && !saleId) return validationError(res, 'Income должен быть привязан к продаже (sale_id обязателен)', context);
  if (type === 'expense' && !receiptId) return validationError(res, 'Expense должен быть привязан к приходу (receipt_id обязателен)', context);
  if ((type === 'expense' || type === 'transfer' || type === 'withdraw') && !accountFromId) return validationError(res, 'Счет списания обязателен', context);
  if ((type === 'income' || type === 'transfer') && !accountToId) return validationError(res, 'Счет зачисления обязателен', context);
  if (type === 'transfer' && String(accountFromId) === String(accountToId)) return validationError(res, 'Кассы перевода должны отличаться', context);
  if ((type === 'expense' || type === 'transfer' || type === 'withdraw') && await getAccountBalance(+accountFromId) < +amount) return validationError(res, 'Недостаточно средств в кассе', context);

  const row = await get(`
    INSERT INTO transactions(type,amount,account_from_id,account_to_id,receipt_id,sale_id,date,comment,related_type,related_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING id
  `, [type, +amount, accountFromId || null, accountToId || null, receiptId, saleId, date, comment || null, related_type || null, related_id || null]);
  res.json({ id: row.id });
});

// Audit
app.get('/api/audit', async (req, res) => {
  const paymentsTotal = +(await get('SELECT COALESCE(SUM(amount::numeric),0) AS total FROM payments'))?.total || 0;
  const paymentTransactionsTotal = +(await get(`
    SELECT COALESCE(SUM(t.amount::numeric),0) AS total
    FROM payments p
    LEFT JOIN transactions t ON t.id = p.transaction_id
  `))?.total || 0;

  const accounts = (await all(`
    SELECT
      a.id AS account_id,
      a.name AS account_name,
      COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='income' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='expense' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='withdraw' AND account_from_id=a.id),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_from_id=a.id),0)
      AS balance_actual,
      COALESCE(SUM(CASE
        WHEN t.type='income' AND t.account_to_id=a.id THEN t.amount::numeric
        WHEN t.type='expense' AND t.account_from_id=a.id THEN -t.amount::numeric
        WHEN t.type='withdraw' AND t.account_from_id=a.id THEN -t.amount::numeric
        WHEN t.type='transfer' AND t.account_to_id=a.id THEN t.amount::numeric
        WHEN t.type='transfer' AND t.account_from_id=a.id THEN -t.amount::numeric
        ELSE 0
      END),0) AS balance_calculated
    FROM accounts a
    LEFT JOIN transactions t ON t.account_to_id=a.id OR t.account_from_id=a.id
    GROUP BY a.id,a.name
    ORDER BY a.name
  `)).map((account) => ({
    ...account,
    id: account.account_id,
    name: account.account_name,
    balance: +account.balance_actual || 0,
    recalculated_balance: +account.balance_calculated || 0,
    diff: (+account.balance_actual || 0) - (+account.balance_calculated || 0),
    difference: (+account.balance_actual || 0) - (+account.balance_calculated || 0),
  }));

  const orphanTransactions = await all(`
    SELECT id,type,amount,comment
    FROM transactions
    WHERE (type='income' AND sale_id IS NULL)
       OR (type='expense' AND receipt_id IS NULL)
    ORDER BY id DESC
  `);

  const receivableSystem = +(await get(`
    WITH receivable_groups AS (
      SELECT
        COALESCE(sd.id, -s.id) AS receivable_group_id,
        COALESCE(SUM(s.total_amount::numeric),0) AS total,
        COALESCE(SUM(COALESCE(s.paid_amount::numeric,0)),0) AS paid
      FROM sales s
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      GROUP BY COALESCE(sd.id, -s.id)
    )
    SELECT COALESCE(SUM(total - paid),0) AS total
    FROM receivable_groups
  `))?.total || 0;
  const receivableLedger = +(await get(`
    WITH receivable_groups AS (
      SELECT
        COALESCE(sd.id, -s.id) AS receivable_group_id,
        COALESCE(SUM(s.total_amount::numeric),0) AS total
      FROM sales s
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      GROUP BY COALESCE(sd.id, -s.id)
    ),
    receivable_payments AS (
      SELECT x.receivable_group_id, COALESCE(SUM(x.amount::numeric),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(s.sales_document_id, s2.sales_document_id, -COALESCE(s.id, s2.id)) AS receivable_group_id, p.amount::numeric AS amount
        FROM payments p
        LEFT JOIN sales s ON p.entity_type='sale' AND s.id = p.entity_id
        LEFT JOIN transactions t ON t.id = p.transaction_id
        LEFT JOIN sales s2 ON s2.id = t.sale_id
        WHERE COALESCE(s.id, s2.id) IS NOT NULL
      ) x
      GROUP BY x.receivable_group_id
    )
    SELECT COALESCE(SUM(rg.total - COALESCE(rp.paid,0)),0) AS total
    FROM receivable_groups rg
    LEFT JOIN receivable_payments rp ON rp.receivable_group_id = rg.receivable_group_id
  `))?.total || 0;
  const payableSystem = (await debtSummaryData()).payable.total;
  const payableLedger = payableSystem;
  const debtsDiff = (receivableSystem - receivableLedger) + (payableSystem - payableLedger);

  const accountsTotal = accounts.reduce((sum, account) => sum + (+account.balance_actual || +account.balance || 0), 0);
  const transactionsTotal = +(await get(`
    SELECT COALESCE(SUM(CASE
      WHEN type='income' THEN amount::numeric
      WHEN type='expense' THEN -amount::numeric
      WHEN type='withdraw' THEN -amount::numeric
      ELSE 0
    END),0) AS total
    FROM transactions
  `))?.total || 0;
  const globalDiff = accountsTotal - transactionsTotal;

  res.json({
    payments_vs_transactions: {
      payments_total: paymentsTotal,
      transactions_total: paymentTransactionsTotal,
      difference: paymentsTotal - paymentTransactionsTotal,
    },
    accounts_balance_check: accounts,
    accounts,
    orphan_transactions: orphanTransactions,
    debts_check: {
      receivable_total: receivableSystem,
      ledger_total: receivableLedger,
      payable_total: payableSystem,
      payable_ledger_total: payableLedger,
      receivable_system: receivableSystem,
      receivable_ledger: receivableLedger,
      payable_system: payableSystem,
      payable_ledger: payableLedger,
      difference: debtsDiff,
      diff: debtsDiff,
      ok: Math.abs(debtsDiff) < 0.01,
    },
    global_check: {
      accounts_total: accountsTotal,
      transactions_total: transactionsTotal,
      diff: globalDiff,
      ok: Math.abs(globalDiff) < 0.01,
    },
  });
});

// Money assets
app.get('/api/money-assets', async (req, res) => {
  res.json(await all('SELECT * FROM money_assets ORDER BY date DESC, created_at DESC'));
});

app.post('/api/money-assets', async (req, res) => {
  const { asset_type, amount, comment, date } = req.body;
  if (!asset_type || !amount || !date) return res.status(400).json({ error: 'Тип, сумма и дата обязательны' });
  const row = await get('INSERT INTO money_assets(asset_type,amount,comment,date) VALUES($1,$2,$3,$4) RETURNING id', [asset_type, +amount, comment || null, date]);
  res.json({ id: row.id });
});

app.put('/api/money-assets/:id', async (req, res) => {
  const { asset_type, amount, comment, date } = req.body;
  if (!asset_type || !amount || !date) return res.status(400).json({ error: 'Тип, сумма и дата обязательны' });
  await query('UPDATE money_assets SET asset_type=$1,amount=$2,comment=$3,date=$4 WHERE id=$5', [asset_type, +amount, comment || null, date, +req.params.id]);
  res.json({ success: true });
});

app.delete('/api/money-assets/:id', async (req, res) => {
  await query('DELETE FROM money_assets WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

// Liabilities
app.get('/api/liabilities', async (req, res) => {
  res.json(await all('SELECT * FROM liabilities ORDER BY date DESC, created_at DESC'));
});

app.post('/api/liabilities', async (req, res) => {
  const { title, amount, comment, date } = req.body;
  if (!title || !amount || !date) return res.status(400).json({ error: 'Название, сумма и дата обязательны' });
  const row = await get('INSERT INTO liabilities(title,amount,comment,date) VALUES($1,$2,$3,$4) RETURNING id', [title, +amount, comment || null, date]);
  res.json({ id: row.id });
});

app.put('/api/liabilities/:id', async (req, res) => {
  const { title, amount, comment, date } = req.body;
  if (!title || !amount || !date) return res.status(400).json({ error: 'Название, сумма и дата обязательны' });
  await query('UPDATE liabilities SET title=$1,amount=$2,comment=$3,date=$4 WHERE id=$5', [title, +amount, comment || null, date, +req.params.id]);
  res.json({ success: true });
});

app.delete('/api/liabilities/:id', async (req, res) => {
  await query('DELETE FROM liabilities WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

// Profit / analytics
app.get('/api/profit/summary', async (req, res) => {
  res.json(await profitSummaryData());
});

app.get('/api/analytics/dashboard', async (req, res) => {
  const profit = await profitSummaryData();
  const clients = await get('SELECT COUNT(*)::int AS count FROM clients');
  const sales = await get('SELECT COUNT(*)::int AS count FROM sales');
  const purchases = await get('SELECT COUNT(*)::int AS count FROM purchases');
  const debts = await debtSummaryData();
  const profitByDate = await all(`
    WITH purchase_costs AS (
      SELECT product_id, COALESCE(SUM(total_cost::numeric),0) AS total_cost, COALESCE(SUM(weight_kg::numeric),0) AS total_weight, COALESCE(SUM(quantity_pcs::numeric),0) AS total_quantity
      FROM purchases
      GROUP BY product_id
    ),
    sales_base AS (
      SELECT DISTINCT
        id,
        date,
        product_id,
        sale_unit,
        quantity::numeric AS quantity,
        COALESCE(total_amount::numeric, quantity::numeric * price_per_unit::numeric) AS revenue
      FROM sales
    )
    SELECT
      sb.date::text AS date,
      COALESCE(SUM(sb.revenue),0) AS sales,
      COALESCE(SUM(CASE
        WHEN sb.sale_unit='kg' AND COALESCE(pc.total_weight,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_weight
        WHEN sb.sale_unit='pcs' AND COALESCE(pc.total_quantity,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_quantity
        ELSE 0
      END),0) AS costs,
      COALESCE(SUM(sb.revenue),0) - COALESCE(SUM(CASE
        WHEN sb.sale_unit='kg' AND COALESCE(pc.total_weight,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_weight
        WHEN sb.sale_unit='pcs' AND COALESCE(pc.total_quantity,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_quantity
        ELSE 0
      END),0) AS profit
    FROM sales_base sb
    LEFT JOIN purchase_costs pc ON pc.product_id = sb.product_id
    GROUP BY sb.date
    ORDER BY sb.date
    LIMIT 30
  `);
  const topClients = await all(`
    WITH purchase_costs AS (
      SELECT product_id, COALESCE(SUM(total_cost::numeric),0) AS total_cost, COALESCE(SUM(weight_kg::numeric),0) AS total_weight, COALESCE(SUM(quantity_pcs::numeric),0) AS total_quantity
      FROM purchases
      GROUP BY product_id
    ),
    sales_base AS (
      SELECT DISTINCT
        id,
        client_id,
        product_id,
        sale_unit,
        quantity::numeric AS quantity,
        COALESCE(total_amount::numeric, quantity::numeric * price_per_unit::numeric) AS revenue
      FROM sales
    )
    SELECT
      c.name,
      COALESCE(SUM(sb.revenue),0) AS value,
      COALESCE(SUM(sb.revenue),0) AS total_sales,
      COALESCE(SUM(CASE
        WHEN sb.sale_unit='kg' AND COALESCE(pc.total_weight,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_weight
        WHEN sb.sale_unit='pcs' AND COALESCE(pc.total_quantity,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_quantity
        ELSE 0
      END),0) AS total_costs,
      COALESCE(SUM(sb.revenue),0) - COALESCE(SUM(CASE
        WHEN sb.sale_unit='kg' AND COALESCE(pc.total_weight,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_weight
        WHEN sb.sale_unit='pcs' AND COALESCE(pc.total_quantity,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_quantity
        ELSE 0
      END),0) AS profit
    FROM sales_base sb
    LEFT JOIN clients c ON c.id = sb.client_id
    LEFT JOIN purchase_costs pc ON pc.product_id = sb.product_id
    GROUP BY c.name
    ORDER BY value DESC
    LIMIT 5
  `);

  res.json({
    totalProfit: profit.profit,
    totalSales: profit.revenue,
    todayProfit: profit.profit,
    weekProfit: profit.profit,
    monthProfit: profit.profit,
    clientCount: +(clients?.count || 0),
    saleCount: +(sales?.count || 0),
    purchaseCount: +(purchases?.count || 0),
    totalBalance: debts.balance,
    totalAssets: debts.receivable.total,
    totalLiab: debts.payable.total,
    profitByDate,
    topClients,
  });
});

app.get('/api/analytics/profit', async (req, res) => {
  const rows = await all(`
    WITH purchase_costs AS (
      SELECT product_id, COALESCE(SUM(total_cost::numeric),0) AS total_cost, COALESCE(SUM(weight_kg::numeric),0) AS total_weight, COALESCE(SUM(quantity_pcs::numeric),0) AS total_quantity
      FROM purchases
      GROUP BY product_id
    ),
    sales_base AS (
      SELECT DISTINCT
        id,
        date,
        product_id,
        sale_unit,
        quantity::numeric AS quantity,
        COALESCE(total_amount::numeric, quantity::numeric * price_per_unit::numeric) AS revenue
      FROM sales
    )
    SELECT
      sb.date::text AS date,
      COALESCE(SUM(sb.revenue),0) AS revenue,
      COALESCE(SUM(CASE
        WHEN sb.sale_unit='kg' AND COALESCE(pc.total_weight,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_weight
        WHEN sb.sale_unit='pcs' AND COALESCE(pc.total_quantity,0) > 0 THEN sb.quantity * pc.total_cost / pc.total_quantity
        ELSE 0
      END),0) AS cost
    FROM sales_base sb
    LEFT JOIN purchase_costs pc ON pc.product_id = sb.product_id
    GROUP BY sb.date
    ORDER BY sb.date
  `);
  res.json(rows.map((row) => ({ ...row, profit: (+row.revenue || 0) - (+row.cost || 0) })));
});

app.post('/api/ai/command', async (req, res) => {
  res.json({ reply: `Команда принята: ${req.body.command || ''}`.trim() });
});

const dist = process.env.CLIENT_DIST || '/root/cargo-app/client/dist';

if (fs.existsSync(dist)) {
  app.use(express.static(dist));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

async function connectDatabaseSafely() {
  if (!pool) {
    console.warn('⚠️ Running without database');
    return;
  }

  try {
    await initDb();
    await pool.query('SELECT 1');
    databaseReady = true;
    console.log('✅ Running with database');
  } catch (error) {
    databaseReady = false;
    console.error('❌ Database connection failed:', error.message);
    console.warn('⚠️ Server continues without database. API will return 503.');
  }
}

async function start() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    connectDatabaseSafely();
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
});
