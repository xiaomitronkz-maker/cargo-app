/**
 * Cargo Manager — Backend
 *
 * Запуск (после npm install):
 *   node server.js                    ← dev, порт 3001
 *   NODE_ENV=production node server.js ← прод (отдаёт client/dist/)
 */

'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function validationError(res, message, context = {}) {
  console.warn('VALIDATION ERROR:', context);
  return res.status(400).json({ error: message });
}

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'cargo.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS client_markings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    marking TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS product_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
    sale_type TEXT NOT NULL CHECK(sale_type IN ('kg','pcs','both'))
  );
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id),
    marking_id INTEGER REFERENCES client_markings(id),
    supplier_id INTEGER REFERENCES suppliers(id),
    receipt_id INTEGER REFERENCES receipts(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity_pcs REAL DEFAULT 0,
    weight_kg REAL DEFAULT 0,
    boxes_count INTEGER DEFAULT 0,
    cost_almaty REAL DEFAULT 0,
    cost_dubai REAL DEFAULT 0,
    cost_per_kg REAL DEFAULT 0,
    total_cost REAL DEFAULT 0,
    paid_amount REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    supplier_id INTEGER,
    client_id INTEGER,
    marking_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS receipt_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER,
    product_id INTEGER,
    weight REAL,
    quantity INTEGER,
    cost_almaty REAL,
    cost_dubai REAL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id),
    marking_id INTEGER REFERENCES client_markings(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    sale_unit TEXT NOT NULL CHECK(sale_unit IN ('kg','pcs')),
    quantity REAL NOT NULL,
    price_per_unit REAL NOT NULL,
    total_amount REAL NOT NULL,
    paid_amount REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS money_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_type TEXT NOT NULL CHECK(asset_type IN ('cash','in_transit','debtors','transfer')),
    amount REAL NOT NULL,
    comment TEXT,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS liabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    comment TEXT,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('sale','purchase')),
    entity_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    comment TEXT,
    transaction_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('income','expense','transfer','withdraw')),
    amount REAL NOT NULL,
    account_from_id INTEGER REFERENCES accounts(id),
    account_to_id INTEGER REFERENCES accounts(id),
    receipt_id INTEGER,
    sale_id INTEGER,
    date TEXT NOT NULL,
    comment TEXT,
    related_type TEXT,
    related_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── Migrations (safe: ignore if column exists) ───────────────────────────────
// Добавить total_cost к существующим БД, в которых его ещё нет
try { db.exec('ALTER TABLE purchases ADD COLUMN total_cost REAL DEFAULT 0'); } catch (_) {}
// Добавить cost_per_kg к существующим БД, в которых его ещё нет
try { db.exec('ALTER TABLE purchases ADD COLUMN cost_per_kg REAL DEFAULT 0'); } catch (_) {}
// Добавить paid_amount к существующим БД, в которых его ещё нет
try { db.exec('ALTER TABLE purchases ADD COLUMN paid_amount REAL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE sales ADD COLUMN paid_amount REAL DEFAULT 0'); } catch (_) {}
// Добавить supplier_id к существующим БД, в которых его ещё нет
try { db.exec('ALTER TABLE purchases ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)'); } catch (_) {}
try { db.exec('ALTER TABLE purchases ADD COLUMN receipt_id INTEGER REFERENCES receipts(id)'); } catch (_) {}
// Добавить связь payment -> transaction к существующим БД
try { db.exec('ALTER TABLE payments ADD COLUMN transaction_id INTEGER'); } catch (_) {}
// Добавить связь transaction -> receipt/sale к существующим БД
try { db.exec('ALTER TABLE transactions ADD COLUMN receipt_id INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE transactions ADD COLUMN sale_id INTEGER'); } catch (_) {}
try {
  const txSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get()?.sql || '';
  if (txSchema.includes("CHECK(type IN ('income','expense','transfer'))")) {
    db.exec(`
      ALTER TABLE transactions RENAME TO transactions_old;
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('income','expense','transfer','withdraw')),
        amount REAL NOT NULL,
        account_from_id INTEGER REFERENCES accounts(id),
        account_to_id INTEGER REFERENCES accounts(id),
        receipt_id INTEGER,
        sale_id INTEGER,
        date TEXT NOT NULL,
        comment TEXT,
        related_type TEXT,
        related_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO transactions(id,type,amount,account_from_id,account_to_id,receipt_id,sale_id,date,comment,related_type,related_id,created_at)
      SELECT id,type,amount,account_from_id,account_to_id,receipt_id,sale_id,date,comment,related_type,related_id,created_at
      FROM transactions_old;
      DROP TABLE transactions_old;
    `);
  }
} catch (_) {}
db.exec(`
  UPDATE payments
  SET transaction_id = (
    SELECT t.id FROM transactions t
    WHERE t.related_type='payment' AND t.related_id=payments.id
    LIMIT 1
  )
  WHERE transaction_id IS NULL
`);
db.exec(`
  UPDATE transactions
  SET sale_id = (
    SELECT p.entity_id FROM payments p
    WHERE p.transaction_id=transactions.id AND p.entity_type='sale'
    LIMIT 1
  )
  WHERE sale_id IS NULL
    AND EXISTS (
      SELECT 1 FROM payments p
      WHERE p.transaction_id=transactions.id AND p.entity_type='sale'
    )
`);
db.exec(`
  UPDATE transactions
  SET receipt_id = (
    SELECT pu.receipt_id FROM payments p
    JOIN purchases pu ON pu.id=p.entity_id
    WHERE p.transaction_id=transactions.id
      AND p.entity_type='purchase'
      AND pu.receipt_id IS NOT NULL
    LIMIT 1
  )
  WHERE receipt_id IS NULL
    AND EXISTS (
      SELECT 1 FROM payments p
      JOIN purchases pu ON pu.id=p.entity_id
      WHERE p.transaction_id=transactions.id
        AND p.entity_type='purchase'
        AND pu.receipt_id IS NOT NULL
    )
`);
// Пересчитать total_cost для старых строк (где cost_usd мог использоваться вместо)
db.exec('UPDATE purchases SET cost_per_kg = cost_almaty + cost_dubai WHERE cost_per_kg = 0 AND (cost_almaty > 0 OR cost_dubai > 0)');
db.exec('UPDATE purchases SET total_cost = cost_per_kg * weight_kg WHERE total_cost = 0 AND cost_per_kg > 0 AND weight_kg > 0');

// ─── Business Validation ──────────────────────────────────────────────────────

/** Правило 1: хотя бы client_id или marking_id. Если только marking — клиент определяется авто. */
function resolveClientMarking(client_id, marking_id) {
  const cid = client_id ? +client_id : null;
  const mid = marking_id ? +marking_id : null;
  if (!cid && !mid) throw new Error('Укажите клиента или маркировку (обязательно хотя бы одно)');
  if (mid && !cid) {
    const m = db.prepare('SELECT * FROM client_markings WHERE id=?').get(mid);
    if (!m) throw new Error(`Маркировка с id=${mid} не найдена`);
    return { cid: m.client_id, mid };
  }
  if (mid && cid) {
    const m = db.prepare('SELECT id FROM client_markings WHERE id=? AND client_id=?').get(mid, cid);
    if (!m) throw new Error('Маркировка не принадлежит выбранному клиенту');
  }
  return { cid, mid };
}

/** Правило 2: числовые ограничения для прихода */
function validatePurchaseNums({ weight_kg = 0, quantity_pcs = 0, cost_almaty = 0, cost_dubai = 0 }) {
  if (+weight_kg < 0)    throw new Error('Вес (weight_kg) не может быть отрицательным');
  if (+quantity_pcs < 0) throw new Error('Количество (quantity_pcs) не может быть отрицательным');
  if (+cost_almaty < 0)  throw new Error('Стоимость Алматы не может быть отрицательной');
  if (+cost_dubai < 0)   throw new Error('Стоимость Дубай не может быть отрицательной');
}

function getAccountBalance(accountId) {
  return db.prepare(`
    SELECT
      COALESCE((SELECT SUM(amount) FROM transactions WHERE type='income' AND account_to_id=?),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='expense' AND account_from_id=?),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='withdraw' AND account_from_id=?),0)
      + COALESCE((SELECT SUM(amount) FROM transactions WHERE type='transfer' AND account_to_id=?),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='transfer' AND account_from_id=?),0)
      AS balance
  `).get(accountId, accountId, accountId, accountId, accountId).balance;
}

function getReceiptPaidAmount(receiptId) {
  return db.prepare(`
    SELECT COALESCE(SUM(x.amount),0) AS total
    FROM (
      SELECT DISTINCT p.id, p.amount
      FROM payments p
      LEFT JOIN transactions t ON t.id=p.transaction_id
      LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id=p.entity_id
      WHERE COALESCE(t.receipt_id, pu.receipt_id)=?
    ) x
  `).get(receiptId).total;
}

function rebalanceReceiptPurchasePaidAmounts(receiptId) {
  const purchases = db.prepare(`
    SELECT id,total_cost
    FROM purchases
    WHERE receipt_id=?
    ORDER BY id
  `).all(receiptId);
  let remainingPaid = +getReceiptPaidAmount(receiptId) || 0;
  for (const purchase of purchases) {
    const applied = Math.min(+purchase.total_cost || 0, remainingPaid);
    db.prepare('UPDATE purchases SET paid_amount=? WHERE id=?').run(applied, purchase.id);
    remainingPaid -= applied;
  }
}

/** Правило 3: total_amount НЕ принимается с фронта — считается только сервером */
function validateSale(product_id, sale_unit, quantity, price_per_unit) {
  if (+quantity <= 0)       throw new Error('Количество должно быть больше 0');
  if (+price_per_unit <= 0) throw new Error('Цена за единицу должна быть больше 0');
  const rule = db.prepare('SELECT * FROM product_rules WHERE product_id=?').get(+product_id);
  if (!rule) throw new Error('Правило продажи для товара не задано. Настройте правило в разделе Товары.');
  if (rule.sale_type === 'pcs' && sale_unit === 'kg')
    throw new Error('Для этого товара разрешена продажа только по штукам (pcs)');
  if (rule.sale_type === 'kg'  && sale_unit === 'pcs')
    throw new Error('Для этого товара разрешена продажа только по килограммам (kg)');
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
app.get('/api/clients', (req, res) => {
  res.json(db.prepare('SELECT * FROM clients ORDER BY name').all());
});

app.get('/api/clients/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id=?').get(+req.params.id);
  if (!c) return res.status(404).json({ error: 'Клиент не найден' });
  res.json({ ...c, markings: db.prepare('SELECT * FROM client_markings WHERE client_id=? ORDER BY marking').all(+req.params.id) });
});

app.post('/api/clients', (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя клиента обязательно' });
  const r = db.prepare('INSERT INTO clients(name,phone,notes) VALUES(?,?,?)').run(name.trim(), phone||null, notes||null);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/clients/:id', (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя клиента обязательно' });
  db.prepare('UPDATE clients SET name=?,phone=?,notes=? WHERE id=?').run(name.trim(), phone||null, notes||null, +req.params.id);
  res.json({ success: true });
});

app.delete('/api/clients/:id', (req, res) => {
  db.prepare('DELETE FROM clients WHERE id=?').run(+req.params.id);
  res.json({ success: true });
});

// ─── SUPPLIERS ────────────────────────────────────────────────────────────────
app.get('/api/suppliers', (req, res) => {
  res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all());
});

app.post('/api/suppliers', (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя поставщика обязательно' });
  const r = db.prepare('INSERT INTO suppliers(name,phone,notes) VALUES(?,?,?)').run(name.trim(), phone||null, notes||null);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/suppliers/:id', (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя поставщика обязательно' });
  db.prepare('UPDATE suppliers SET name=?,phone=?,notes=? WHERE id=?').run(name.trim(), phone||null, notes||null, +req.params.id);
  res.json({ success: true });
});

app.delete('/api/suppliers/:id', (req, res) => {
  const used = db.prepare('SELECT id FROM purchases WHERE supplier_id=? LIMIT 1').get(+req.params.id);
  if (used) return res.status(400).json({ error: 'Поставщик используется в приходах' });
  db.prepare('DELETE FROM suppliers WHERE id=?').run(+req.params.id);
  res.json({ success: true });
});

// ─── MARKINGS ─────────────────────────────────────────────────────────────────
app.get('/api/markings', (req, res) => {
  const { client_id } = req.query;
  let sql = 'SELECT cm.*,c.name AS client_name FROM client_markings cm JOIN clients c ON c.id=cm.client_id';
  const args = [];
  if (client_id) { sql += ' WHERE cm.client_id=?'; args.push(+client_id); }
  sql += ' ORDER BY cm.marking';
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/markings', (req, res) => {
  const { client_id, marking } = req.body;
  if (!client_id || !marking?.trim()) return res.status(400).json({ error: 'client_id и маркировка обязательны' });
  try {
    const r = db.prepare('INSERT INTO client_markings(client_id,marking) VALUES(?,?)').run(+client_id, marking.trim().toUpperCase());
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Такая маркировка уже существует' : e.message });
  }
});

app.put('/api/markings/:id', (req, res) => {
  const { client_id, marking } = req.body;
  if (!client_id || !marking?.trim()) return res.status(400).json({ error: 'client_id и маркировка обязательны' });
  try {
    db.prepare('UPDATE client_markings SET client_id=?,marking=? WHERE id=?').run(+client_id, marking.trim().toUpperCase(), +req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Такая маркировка уже существует' : e.message });
  }
});

app.delete('/api/markings/:id', (req, res) => {
  db.prepare('DELETE FROM client_markings WHERE id=?').run(+req.params.id);
  res.json({ success: true });
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT p.*,pr.sale_type FROM products p LEFT JOIN product_rules pr ON pr.product_id=p.id ORDER BY p.name').all());
});

app.post('/api/products', (req, res) => {
  const { name, category, is_active, sale_type } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Название товара обязательно' });
  const pr = db.prepare('INSERT INTO products(name,category,is_active) VALUES(?,?,?)').run(name.trim(), category||null, is_active!==false?1:0);
  if (sale_type) db.prepare('INSERT INTO product_rules(product_id,sale_type) VALUES(?,?)').run(pr.lastInsertRowid, sale_type);
  res.json({ id: pr.lastInsertRowid });
});

app.put('/api/products/:id', (req, res) => {
  const { name, category, is_active, sale_type } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Название товара обязательно' });
  db.prepare('UPDATE products SET name=?,category=?,is_active=? WHERE id=?').run(name.trim(), category||null, is_active?1:0, +req.params.id);
  if (sale_type) {
    const ex = db.prepare('SELECT id FROM product_rules WHERE product_id=?').get(+req.params.id);
    if (ex) db.prepare('UPDATE product_rules SET sale_type=? WHERE product_id=?').run(sale_type, +req.params.id);
    else    db.prepare('INSERT INTO product_rules(product_id,sale_type) VALUES(?,?)').run(+req.params.id, sale_type);
  }
  res.json({ success: true });
});

app.delete('/api/products/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(+req.params.id);
  res.json({ success: true });
});

// ─── RECEIPTS ─────────────────────────────────────────────────────────────────
app.get('/api/receipts', (req, res) => {
  res.json(db.prepare(`
    SELECT
      r.id,
      r.date,
      s.name AS supplier_name,
      c.name AS client_name,
      COUNT(ri.id) AS items_count,
      COALESCE(SUM(ri.weight),0) AS total_weight,
      COALESCE(SUM(ri.quantity),0) AS total_quantity
    FROM receipts r
    LEFT JOIN suppliers s ON s.id=r.supplier_id
    LEFT JOIN clients c ON c.id=r.client_id
    LEFT JOIN receipt_items ri ON ri.receipt_id=r.id
    GROUP BY r.id,r.date,s.name,c.name
    ORDER BY r.date DESC,r.created_at DESC
  `).all());
});

app.get('/api/receipts/:id', (req, res) => {
  const id = +req.params.id;
  const receipt = db.prepare(`
    SELECT r.*,s.name AS supplier_name,c.name AS client_name,cm.marking
    FROM receipts r
    LEFT JOIN suppliers s ON s.id=r.supplier_id
    LEFT JOIN clients c ON c.id=r.client_id
    LEFT JOIN client_markings cm ON cm.id=r.marking_id
    WHERE r.id=?
  `).get(id);
  if (!receipt) return res.status(404).json({ error: 'Приход не найден' });
  const items = db.prepare(`
    SELECT ri.*,p.name AS product_name
    FROM receipt_items ri
    LEFT JOIN products p ON p.id=ri.product_id
    WHERE ri.receipt_id=?
    ORDER BY ri.id
  `).all(id);
  res.json({ ...receipt, items });
});

app.post('/api/receipts', (req, res) => {
  const b = req.body;
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы один товар' });
  if (!b.date) return res.status(400).json({ error: 'Дата обязательна' });
  if (!b.supplier_id) return res.status(400).json({ error: 'Поставщик обязателен' });
  try {
    for (const item of items) {
      if (!item.product_id) throw new Error('Выберите товар в каждой строке');
      const weight = +(item.weight ?? item.weight_kg) || 0;
      const quantity = +(item.quantity ?? item.quantity_pcs) || 0;
      if (!(weight > 0) && !(quantity > 0)) throw new Error('Укажите вес или количество в каждой строке');
      validatePurchaseNums({
        weight_kg: weight,
        quantity_pcs: quantity,
        cost_almaty: item.cost_almaty,
        cost_dubai: item.cost_dubai
      });
    }

    const createReceipt = db.transaction(() => {
      const { cid, mid } = resolveClientMarking(b.client_id, b.marking_id);
      const receipt = db.prepare('INSERT INTO receipts(date,supplier_id,client_id,marking_id) VALUES(?,?,?,?)')
        .run(b.date, +b.supplier_id, cid, mid);
      const purchaseIds = [];

      for (const item of items) {
        const weight = +(item.weight ?? item.weight_kg) || 0;
        const quantity = +(item.quantity ?? item.quantity_pcs) || 0;
        const cost_almaty = +item.cost_almaty || 0;
        const cost_dubai = +item.cost_dubai || 0;
        const cost_per_kg = cost_almaty + cost_dubai;
        const total_cost = cost_per_kg * weight;
        const note = item.note || item.notes || null;

        db.prepare('INSERT INTO receipt_items(receipt_id,product_id,weight,quantity,cost_almaty,cost_dubai,note) VALUES(?,?,?,?,?,?,?)')
          .run(receipt.lastInsertRowid, +item.product_id, weight, quantity, cost_almaty, cost_dubai, note);

        const purchase = db.prepare('INSERT INTO purchases(date,client_id,marking_id,supplier_id,receipt_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,total_cost,paid_amount,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(b.date, cid, mid, +b.supplier_id, receipt.lastInsertRowid, +item.product_id, quantity, weight, +item.boxes_count || +item.boxes || 0, cost_almaty, cost_dubai, cost_per_kg, total_cost, 0, note);
        purchaseIds.push(purchase.lastInsertRowid);
      }

      return { receipt_id: receipt.lastInsertRowid, purchase_ids: purchaseIds };
    });

    const result = createReceipt();
    res.json({ id: result.receipt_id, items_count: items.length, purchase_ids: result.purchase_ids });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/receipts/:id', (req, res) => {
  const id = +req.params.id;
  const b = req.body;
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы один товар' });
  if (!b.date) return res.status(400).json({ error: 'Дата обязательна' });
  if (!b.supplier_id) return res.status(400).json({ error: 'Поставщик обязателен' });
  try {
    const existing = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'Приход не найден' });
    for (const item of items) {
      if (!item.product_id) throw new Error('Выберите товар в каждой строке');
      const weight = +(item.weight ?? item.weight_kg) || 0;
      const quantity = +(item.quantity ?? item.quantity_pcs) || 0;
      if (!(weight > 0) && !(quantity > 0)) throw new Error('Укажите вес или количество в каждой строке');
      validatePurchaseNums({
        weight_kg: weight,
        quantity_pcs: quantity,
        cost_almaty: item.cost_almaty,
        cost_dubai: item.cost_dubai
      });
    }

    const updateReceipt = db.transaction(() => {
      const { cid, mid } = resolveClientMarking(b.client_id, b.marking_id);
      db.prepare('UPDATE receipts SET date=?,supplier_id=?,client_id=?,marking_id=? WHERE id=?')
        .run(b.date, +b.supplier_id, cid, mid, id);
      db.prepare(`
        DELETE FROM purchases
        WHERE receipt_id=?
          OR (
            receipt_id IS NULL
            AND date=?
            AND supplier_id=?
            AND COALESCE(client_id,0)=COALESCE(?,0)
            AND COALESCE(marking_id,0)=COALESCE(?,0)
            AND EXISTS (
              SELECT 1 FROM receipt_items ri
              WHERE ri.receipt_id=?
                AND ri.product_id=purchases.product_id
                AND COALESCE(ri.weight,0)=COALESCE(purchases.weight_kg,0)
                AND COALESCE(ri.quantity,0)=COALESCE(purchases.quantity_pcs,0)
                AND COALESCE(ri.cost_almaty,0)=COALESCE(purchases.cost_almaty,0)
                AND COALESCE(ri.cost_dubai,0)=COALESCE(purchases.cost_dubai,0)
            )
          )
      `).run(id, existing.date, existing.supplier_id, existing.client_id, existing.marking_id, id);
      db.prepare('DELETE FROM receipt_items WHERE receipt_id=?').run(id);
      const purchaseIds = [];

      for (const item of items) {
        const weight = +(item.weight ?? item.weight_kg) || 0;
        const quantity = +(item.quantity ?? item.quantity_pcs) || 0;
        const cost_almaty = +item.cost_almaty || 0;
        const cost_dubai = +item.cost_dubai || 0;
        const cost_per_kg = cost_almaty + cost_dubai;
        const total_cost = cost_per_kg * weight;
        const note = item.note || item.notes || null;

        db.prepare('INSERT INTO receipt_items(receipt_id,product_id,weight,quantity,cost_almaty,cost_dubai,note) VALUES(?,?,?,?,?,?,?)')
          .run(id, +item.product_id, weight, quantity, cost_almaty, cost_dubai, note);

        const purchase = db.prepare('INSERT INTO purchases(date,client_id,marking_id,supplier_id,receipt_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,total_cost,paid_amount,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(b.date, cid, mid, +b.supplier_id, id, +item.product_id, quantity, weight, +item.boxes_count || +item.boxes || 0, cost_almaty, cost_dubai, cost_per_kg, total_cost, 0, note);
        purchaseIds.push(purchase.lastInsertRowid);
      }

      return purchaseIds;
    });

    const purchaseIds = updateReceipt();
    res.json({ success: true, id, items_count: items.length, purchase_ids: purchaseIds });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/receipts/:id', (req, res) => {
  const id = +req.params.id;
  try {
    const receipt = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    if (!receipt) return res.status(404).json({ error: 'Приход не найден' });
    const deleteReceipt = db.transaction(() => {
      const purchaseIds = db.prepare(`
        SELECT id FROM purchases
        WHERE receipt_id=?
          OR (
            receipt_id IS NULL
            AND supplier_id=?
            AND date=?
            AND EXISTS (
              SELECT 1 FROM receipt_items ri
              WHERE ri.receipt_id=?
                AND ri.product_id=purchases.product_id
            )
          )
      `).all(id, receipt.supplier_id, receipt.date, id).map(row => row.id);
      db.prepare('DELETE FROM transactions WHERE receipt_id=?').run(id);
      for (const purchaseId of purchaseIds) {
        db.prepare("DELETE FROM payments WHERE entity_type='purchase' AND entity_id=?").run(purchaseId);
      }
      db.prepare('DELETE FROM purchases WHERE receipt_id=?').run(id);
      db.prepare(`
        DELETE FROM purchases
        WHERE receipt_id IS NULL
          AND supplier_id=?
          AND date=?
          AND EXISTS (
            SELECT 1 FROM receipt_items ri
            WHERE ri.receipt_id=?
              AND ri.product_id=purchases.product_id
          )
      `).run(receipt.supplier_id, receipt.date, id);
      db.prepare('DELETE FROM receipt_items WHERE receipt_id=?').run(id);
      db.prepare('DELETE FROM receipts WHERE id=?').run(id);
    });
    deleteReceipt();
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/receipts/:id/pay', (req, res) => {
  const id = +req.params.id;
  const amount = +req.body.amount;
  const account_from_id = +req.body.account_from_id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const comment = req.body.comment || null;
  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { type: 'expense', amount, account_id: account_from_id, receipt_id: id, sale_id: null });
  if (!account_from_id) return validationError(res, 'Счет списания обязателен', { type: 'expense', amount, account_id: account_from_id, receipt_id: id, sale_id: null });
  if (getAccountBalance(account_from_id) < amount) return validationError(res, 'Недостаточно средств в кассе', { type: 'expense', amount, account_id: account_from_id, receipt_id: id, sale_id: null });
  try {
    const receipt = db.prepare(`
      SELECT r.*,COALESCE(SUM(p.total_cost),0) AS total_cost,MIN(p.id) AS anchor_purchase_id
      FROM receipts r
      LEFT JOIN purchases p ON p.receipt_id=r.id
      WHERE r.id=?
      GROUP BY r.id
    `).get(id);
    if (!receipt) return res.status(404).json({ error: 'Приход не найден' });
    if (!receipt.anchor_purchase_id) return res.status(400).json({ error: 'В документе нет товаров для оплаты' });
    const paid = +getReceiptPaidAmount(id) || 0;
    const remaining = (+receipt.total_cost || 0) - paid;
    if (amount > remaining) return validationError(res, 'Сумма оплаты превышает остаток долга', { type: 'expense', amount, account_id: account_from_id, receipt_id: id, sale_id: null });
    const payReceipt = db.transaction(() => {
      const payment = db.prepare('INSERT INTO payments(entity_type,entity_id,amount,date,comment) VALUES(?,?,?,?,?)')
        .run('purchase', receipt.anchor_purchase_id, amount, date, comment);
      const transaction = db.prepare('INSERT INTO transactions(type,amount,account_from_id,receipt_id,date,comment,related_type,related_id) VALUES(?,?,?,?,?,?,?,?)')
        .run('expense', amount, account_from_id, id, date, comment, 'payment', payment.lastInsertRowid);
      db.prepare('UPDATE payments SET transaction_id=? WHERE id=?').run(transaction.lastInsertRowid, payment.lastInsertRowid);
      rebalanceReceiptPurchasePaidAmounts(id);
    });
    payReceipt();
    const newPaid = +getReceiptPaidAmount(id) || 0;
    res.json({ success: true, receipt_id: id, paid_amount: newPaid, payable: (+receipt.total_cost || 0) - newPaid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── PURCHASES ────────────────────────────────────────────────────────────────
app.get('/api/purchases', (req, res) => {
  const { client_id, product_id, from_date, to_date } = req.query;
  let sql = `SELECT p.*,c.name AS client_name,cm.marking,pr.name AS product_name
    FROM purchases p
    LEFT JOIN clients c ON c.id=p.client_id
    LEFT JOIN client_markings cm ON cm.id=p.marking_id
    LEFT JOIN products pr ON pr.id=p.product_id WHERE 1=1`;
  const args = [];
  if (client_id)  { sql += ' AND p.client_id=?';  args.push(+client_id); }
  if (product_id) { sql += ' AND p.product_id=?'; args.push(+product_id); }
  if (from_date)  { sql += ' AND p.date>=?';       args.push(from_date); }
  if (to_date)    { sql += ' AND p.date<=?';       args.push(to_date); }
  sql += ' ORDER BY p.date DESC, p.created_at DESC';
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/purchases', (req, res) => {
  const b = req.body;
  if (!b.date || !b.product_id) return res.status(400).json({ error: 'Дата и товар обязательны' });
  if (!b.supplier_id) return res.status(400).json({ error: 'Поставщик обязателен' });
  try {
    validatePurchaseNums({ weight_kg: b.weight_kg, quantity_pcs: b.quantity_pcs, cost_almaty: b.cost_almaty, cost_dubai: b.cost_dubai });
    const { cid, mid } = resolveClientMarking(b.client_id, b.marking_id);
    // total_cost считается сервером — с фронта не принимается
    const weight = +b.weight_kg || 0;
    const cost_per_kg = (+b.cost_almaty || 0) + (+b.cost_dubai || 0);
    const total_cost = cost_per_kg * weight;
    const paid_amount = +b.paid_amount || 0;
    const payable = total_cost - paid_amount;
    const supplier_id = +b.supplier_id;
    const r = db.prepare('INSERT INTO purchases(date,client_id,marking_id,supplier_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,total_cost,paid_amount,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(b.date, cid, mid, supplier_id, +b.product_id, +b.quantity_pcs||0, weight, +b.boxes_count||0, +b.cost_almaty||0, +b.cost_dubai||0, cost_per_kg, total_cost, paid_amount, b.notes||null);
    res.json({ id: r.lastInsertRowid, cost_per_kg, total_cost, paid_amount, payable });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/purchases/:id', (req, res) => {
  const b = req.body;
  if (!b.date || !b.product_id) return res.status(400).json({ error: 'Дата и товар обязательны' });
  try {
    validatePurchaseNums({ weight_kg: b.weight_kg, quantity_pcs: b.quantity_pcs, cost_almaty: b.cost_almaty, cost_dubai: b.cost_dubai });
    const { cid, mid } = resolveClientMarking(b.client_id, b.marking_id);
    // total_cost считается сервером — с фронта не принимается
    const weight = +b.weight_kg || 0;
    const cost_per_kg = (+b.cost_almaty || 0) + (+b.cost_dubai || 0);
    const total_cost = cost_per_kg * weight;
    db.prepare('UPDATE purchases SET date=?,client_id=?,marking_id=?,product_id=?,quantity_pcs=?,weight_kg=?,boxes_count=?,cost_almaty=?,cost_dubai=?,cost_per_kg=?,total_cost=?,notes=? WHERE id=?')
      .run(b.date, cid, mid, +b.product_id, +b.quantity_pcs||0, weight, +b.boxes_count||0, +b.cost_almaty||0, +b.cost_dubai||0, cost_per_kg, total_cost, b.notes||null, +req.params.id);
    res.json({ success: true, cost_per_kg, total_cost });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/purchases/:id/pay', (req, res) => {
  const id = +req.params.id;
  const amount = +req.body.amount;
  const account_from_id = +req.body.account_from_id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const comment = req.body.comment || null;
  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { type: 'expense', amount, account_id: account_from_id, receipt_id: null, sale_id: null });
  if (!account_from_id) return validationError(res, 'Счет списания обязателен', { type: 'expense', amount, account_id: account_from_id, receipt_id: null, sale_id: null });
  if (getAccountBalance(account_from_id) < amount) return validationError(res, 'Недостаточно средств в кассе', { type: 'expense', amount, account_id: account_from_id, receipt_id: null, sale_id: null });
  try {
    const purchase = db.prepare('SELECT * FROM purchases WHERE id=?').get(id);
    if (!purchase) return res.status(404).json({ error: 'Приход не найден' });
    if (!purchase.receipt_id) return validationError(res, 'Expense должен быть привязан к приходу (receipt_id обязателен)', { type: 'expense', amount, account_id: account_from_id, receipt_id: null, sale_id: null });
    const newPaid = (+purchase.paid_amount || 0) + amount;
    const remaining = (+purchase.total_cost || 0) - (+purchase.paid_amount || 0);
    if (amount > remaining) return validationError(res, 'Сумма оплаты превышает остаток долга', { type: 'expense', amount, account_id: account_from_id, receipt_id: purchase.receipt_id || null, sale_id: null });
    const payPurchase = db.transaction(() => {
      const payment = db.prepare('INSERT INTO payments(entity_type,entity_id,amount,date,comment) VALUES(?,?,?,?,?)')
        .run('purchase', id, amount, date, comment);
      const transaction = db.prepare('INSERT INTO transactions(type,amount,account_from_id,receipt_id,date,comment,related_type,related_id) VALUES(?,?,?,?,?,?,?,?)')
        .run('expense', amount, account_from_id, purchase.receipt_id || null, date, comment, 'payment', payment.lastInsertRowid);
      db.prepare('UPDATE payments SET transaction_id=? WHERE id=?').run(transaction.lastInsertRowid, payment.lastInsertRowid);
      db.prepare('UPDATE purchases SET paid_amount=? WHERE id=?').run(newPaid, id);
    });
    payPurchase();
    res.json({ success: true, paid_amount: newPaid, payable: purchase.total_cost - newPaid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/purchases/:id', (req, res) => {
  db.prepare('DELETE FROM purchases WHERE id=?').run(+req.params.id);
  res.json({ success: true });
});

// ─── SALES ────────────────────────────────────────────────────────────────────
app.get('/api/sales', (req, res) => {
  const { client_id, product_id, from_date, to_date } = req.query;
  let sql = `SELECT s.*,c.name AS client_name,cm.marking,p.name AS product_name
    FROM sales s
    LEFT JOIN clients c ON c.id=s.client_id
    LEFT JOIN client_markings cm ON cm.id=s.marking_id
    LEFT JOIN products p ON p.id=s.product_id WHERE 1=1`;
  const args = [];
  if (client_id)  { sql += ' AND s.client_id=?';  args.push(+client_id); }
  if (product_id) { sql += ' AND s.product_id=?'; args.push(+product_id); }
  if (from_date)  { sql += ' AND s.date>=?';       args.push(from_date); }
  if (to_date)    { sql += ' AND s.date<=?';       args.push(to_date); }
  sql += ' ORDER BY s.date DESC, s.created_at DESC';
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/sales', (req, res) => {
  const b = req.body; // total_amount из body ИГНОРИРУЕТСЯ
  if (!b.date || !b.product_id || !b.sale_unit || b.quantity == null || b.price_per_unit == null)
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  try {
    validateSale(b.product_id, b.sale_unit, b.quantity, b.price_per_unit);
    const { cid, mid } = resolveClientMarking(b.client_id, b.marking_id);
    const total_amount = Math.round(+b.quantity * +b.price_per_unit * 100) / 100;
    const paid_amount = +b.paid_amount || 0;
    const debt = total_amount - paid_amount;
    const r = db.prepare('INSERT INTO sales(date,client_id,marking_id,product_id,sale_unit,quantity,price_per_unit,total_amount,paid_amount,notes) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(b.date, cid, mid, +b.product_id, b.sale_unit, +b.quantity, +b.price_per_unit, total_amount, paid_amount, b.notes||null);
    res.json({ id: r.lastInsertRowid, total_amount, paid_amount, debt });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/sales/:id', (req, res) => {
  const b = req.body; // total_amount ИГНОРИРУЕТСЯ
  if (!b.date || !b.product_id || !b.sale_unit || b.quantity == null || b.price_per_unit == null)
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  try {
    validateSale(b.product_id, b.sale_unit, b.quantity, b.price_per_unit);
    const { cid, mid } = resolveClientMarking(b.client_id, b.marking_id);
    const total_amount = Math.round(+b.quantity * +b.price_per_unit * 100) / 100;
    db.prepare('UPDATE sales SET date=?,client_id=?,marking_id=?,product_id=?,sale_unit=?,quantity=?,price_per_unit=?,total_amount=?,notes=? WHERE id=?')
      .run(b.date, cid, mid, +b.product_id, b.sale_unit, +b.quantity, +b.price_per_unit, total_amount, b.notes||null, +req.params.id);
    res.json({ success: true, total_amount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/sales/:id/pay', (req, res) => {
  const id = +req.params.id;
  const amount = +req.body.amount;
  const account_to_id = +req.body.account_to_id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const comment = req.body.comment || null;
  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { type: 'income', amount, account_id: account_to_id, receipt_id: null, sale_id: id });
  if (!account_to_id) return validationError(res, 'Счет зачисления обязателен', { type: 'income', amount, account_id: account_to_id, receipt_id: null, sale_id: id });
  try {
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (!sale) return res.status(404).json({ error: 'Продажа не найдена' });
    const newPaid = (+sale.paid_amount || 0) + amount;
    const remaining = (+sale.total_amount || 0) - (+sale.paid_amount || 0);
    if (amount > remaining) return validationError(res, 'Сумма оплаты превышает остаток долга', { type: 'income', amount, account_id: account_to_id, receipt_id: null, sale_id: id });
    const paySale = db.transaction(() => {
      const payment = db.prepare('INSERT INTO payments(entity_type,entity_id,amount,date,comment) VALUES(?,?,?,?,?)')
        .run('sale', id, amount, date, comment);
      const transaction = db.prepare('INSERT INTO transactions(type,amount,account_to_id,sale_id,date,comment,related_type,related_id) VALUES(?,?,?,?,?,?,?,?)')
        .run('income', amount, account_to_id, id, date, comment, 'payment', payment.lastInsertRowid);
      db.prepare('UPDATE payments SET transaction_id=? WHERE id=?').run(transaction.lastInsertRowid, payment.lastInsertRowid);
      db.prepare('UPDATE sales SET paid_amount=? WHERE id=?').run(newPaid, id);
    });
    paySale();
    res.json({ success: true, paid_amount: newPaid, debt: sale.total_amount - newPaid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/sales/:id', (req, res) => {
  const id = +req.params.id;
  try {
    const deleteSale = db.transaction(() => {
      db.prepare('DELETE FROM transactions WHERE sale_id=?').run(id);
      db.prepare("DELETE FROM payments WHERE entity_type='sale' AND entity_id=?").run(id);
      db.prepare('DELETE FROM sales WHERE id=?').run(id);
    });
    deleteSale();
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── DEBTS ────────────────────────────────────────────────────────────────────
app.get('/api/debts', (req, res) => {
  const debts = db.prepare(`
    WITH receipt_totals AS (
      SELECT
        r.id AS receipt_id,
        r.date,
        r.supplier_id,
        sup.name AS supplier_name,
        COALESCE(SUM(p.total_cost),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id=r.id
      LEFT JOIN suppliers sup ON sup.id=r.supplier_id
      GROUP BY r.id,r.date,r.supplier_id,sup.name
    ),
    receipt_payments AS (
      SELECT
        x.receipt_id,
        COALESCE(SUM(x.amount),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(t.receipt_id, pu.receipt_id) AS receipt_id, p.amount
        FROM payments p
        LEFT JOIN transactions t ON t.id=p.transaction_id
        LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id=p.entity_id
        WHERE COALESCE(t.receipt_id, pu.receipt_id) IS NOT NULL
      ) x
      GROUP BY x.receipt_id
    )
    SELECT type,id,date,client_id,client_name,marking_id,marking,supplier_id,supplier_name,product_id,product_name,amount,paid_amount,debt,notes,total,paid,document_label
    FROM (
      SELECT 'receivable' AS type,s.id,s.date,s.client_id,c.name AS client_name,s.marking_id,cm.marking,
             NULL AS supplier_id,NULL AS supplier_name,s.product_id,p.name AS product_name,s.total_amount AS amount,s.paid_amount,
             s.total_amount - COALESCE(s.paid_amount,0) AS debt,s.notes,s.created_at,
             s.total_amount AS total,COALESCE(s.paid_amount,0) AS paid,NULL AS document_label
      FROM sales s
      LEFT JOIN clients c ON c.id=s.client_id
      LEFT JOIN client_markings cm ON cm.id=s.marking_id
      LEFT JOIN products p ON p.id=s.product_id
      WHERE s.total_amount - COALESCE(s.paid_amount,0) > 0
      UNION ALL
      SELECT 'payable' AS type,rt.receipt_id AS id,rt.date,NULL AS client_id,NULL AS client_name,NULL AS marking_id,NULL AS marking,
             rt.supplier_id,rt.supplier_name,NULL AS product_id,NULL AS product_name,rt.total AS amount,COALESCE(rp.paid,0) AS paid_amount,
             rt.total - COALESCE(rp.paid,0) AS debt,NULL AS notes,rt.receipt_id AS created_at,
             rt.total AS total,COALESCE(rp.paid,0) AS paid,'Приход №' || rt.receipt_id AS document_label
      FROM receipt_totals rt
      LEFT JOIN receipt_payments rp ON rp.receipt_id=rt.receipt_id
      WHERE rt.total - COALESCE(rp.paid,0) > 0
    )
    ORDER BY date DESC, created_at DESC
  `).all();
  res.json(debts);
});

app.get('/api/debts/by-suppliers', (req, res) => {
  res.json(db.prepare(`
    WITH receipt_totals AS (
      SELECT r.id,r.supplier_id,COALESCE(SUM(p.total_cost),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id=r.id
      GROUP BY r.id,r.supplier_id
    ),
    receipt_payments AS (
      SELECT
        x.receipt_id,
        COALESCE(SUM(x.amount),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(t.receipt_id, pu.receipt_id) AS receipt_id, p.amount
        FROM payments p
        LEFT JOIN transactions t ON t.id=p.transaction_id
        LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id=p.entity_id
        WHERE COALESCE(t.receipt_id, pu.receipt_id) IS NOT NULL
      ) x
      GROUP BY x.receipt_id
    )
    SELECT
      sup.id,
      sup.name,
      COALESCE(SUM(rt.total - COALESCE(rp.paid,0)),0) AS debt
    FROM suppliers sup
    LEFT JOIN receipt_totals rt ON rt.supplier_id = sup.id
    LEFT JOIN receipt_payments rp ON rp.receipt_id = rt.id
    GROUP BY sup.id,sup.name
    HAVING debt > 0
    ORDER BY debt DESC
  `).all());
});

app.get('/api/debts/summary', (req, res) => {
  const receivable = db.prepare(`
    SELECT COUNT(*) AS count,COALESCE(SUM(total_amount - COALESCE(paid_amount,0)),0) AS total
    FROM sales
    WHERE total_amount - COALESCE(paid_amount,0) > 0
  `).get();
  const payable = db.prepare(`
    WITH receipt_totals AS (
      SELECT r.id,COALESCE(SUM(p.total_cost),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id=r.id
      GROUP BY r.id
    ),
    receipt_payments AS (
      SELECT
        x.receipt_id,
        COALESCE(SUM(x.amount),0) AS paid
      FROM (
        SELECT DISTINCT p.id, COALESCE(t.receipt_id, pu.receipt_id) AS receipt_id, p.amount
        FROM payments p
        LEFT JOIN transactions t ON t.id=p.transaction_id
        LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id=p.entity_id
        WHERE COALESCE(t.receipt_id, pu.receipt_id) IS NOT NULL
      ) x
      GROUP BY x.receipt_id
    )
    SELECT COUNT(*) AS count,COALESCE(SUM(total - COALESCE(paid,0)),0) AS total
    FROM (
      SELECT rt.id,rt.total,COALESCE(rp.paid,0) AS paid
      FROM receipt_totals rt
      LEFT JOIN receipt_payments rp ON rp.receipt_id=rt.id
      WHERE rt.total - COALESCE(rp.paid,0) > 0
    )
  `).get();
  const total_withdrawals = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM withdrawals').get().v;
  res.json({ receivable, payable, total_withdrawals, balance: receivable.total - payable.total });
});

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────
app.get('/api/payments', (req, res) => {
  const payments = db.prepare(`
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
    LEFT JOIN sales s ON p.entity_type='sale' AND s.id=p.entity_id
    LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id=p.entity_id
    LEFT JOIN clients c ON c.id = COALESCE(s.client_id, pu.client_id)
    LEFT JOIN products pr ON pr.id = COALESCE(s.product_id, pu.product_id)
    ORDER BY p.date DESC, p.created_at DESC
  `).all();
  res.json(payments);
});

app.get('/api/ledger', (req, res) => {
  const { type, id } = req.query;
  const entityId = +id;
  if (!['client', 'supplier'].includes(type) || !entityId) {
    return res.status(400).json({ error: 'type и id обязательны' });
  }

  const rows = type === 'client'
    ? db.prepare(`
      SELECT date,type,id,amount,paid_amount,comment,account_name,transaction_type,created_at
      FROM (
        SELECT s.date,'sale' AS type,s.id,s.total_amount AS amount,s.paid_amount,s.notes AS comment,
               NULL AS account_name,NULL AS transaction_type,s.created_at,0 AS sort_order
        FROM sales s
        WHERE s.client_id=?
        UNION ALL
        SELECT p.date,'payment' AS type,p.id,p.amount,NULL AS paid_amount,p.comment,
               a.name AS account_name,t.type AS transaction_type,p.created_at,1 AS sort_order
        FROM payments p
        JOIN sales s ON p.entity_type='sale' AND s.id=p.entity_id
        LEFT JOIN transactions t ON t.id = p.transaction_id
        LEFT JOIN accounts a ON a.id = COALESCE(t.account_to_id, t.account_from_id)
        WHERE s.client_id=?
      )
      ORDER BY date ASC,created_at ASC,sort_order ASC,id ASC
    `).all(entityId, entityId)
    : db.prepare(`
      SELECT date,type,id,amount,paid_amount,comment,account_name,transaction_type,created_at
      FROM (
        SELECT p.date,'purchase' AS type,p.id,p.total_cost AS amount,p.paid_amount,p.notes AS comment,
               NULL AS account_name,NULL AS transaction_type,p.created_at,0 AS sort_order
        FROM purchases p
        WHERE p.supplier_id=?
        UNION ALL
        SELECT pay.date,'payment' AS type,pay.id,pay.amount,NULL AS paid_amount,pay.comment,
               a.name AS account_name,t.type AS transaction_type,pay.created_at,1 AS sort_order
        FROM payments pay
        JOIN purchases p ON pay.entity_type='purchase' AND p.id=pay.entity_id
        LEFT JOIN transactions t ON t.id = pay.transaction_id
        LEFT JOIN accounts a ON a.id = COALESCE(t.account_to_id, t.account_from_id)
        WHERE p.supplier_id=?
      )
      ORDER BY date ASC,created_at ASC,sort_order ASC,id ASC
    `).all(entityId, entityId);

  let balance = 0;
  res.json(rows.map(row => {
    balance += row.type === 'payment' ? -(+row.amount || 0) : (+row.amount || 0);
    return { ...row, balance };
  }));
});

// ─── WITHDRAWALS ──────────────────────────────────────────────────────────────
app.get('/api/withdrawals', (req, res) => {
  res.json(db.prepare('SELECT * FROM withdrawals ORDER BY date DESC, created_at DESC').all());
});

app.post('/api/withdrawals', (req, res) => {
  const { amount, date, comment } = req.body;
  if (!(+amount > 0) || !date) return res.status(400).json({ error: 'Сумма и дата обязательны' });
  const r = db.prepare('INSERT INTO withdrawals(amount,date,comment) VALUES(?,?,?)').run(+amount, date, comment||null);
  res.json({ id: r.lastInsertRowid });
});

// ─── ACCOUNTS & TRANSACTIONS ─────────────────────────────────────────────────
app.get('/api/accounts', (req, res) => {
  res.json(db.prepare(`
    SELECT a.*,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE type='income' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='expense' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='withdraw' AND account_from_id=a.id),0)
      + COALESCE((SELECT SUM(amount) FROM transactions WHERE type='transfer' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='transfer' AND account_from_id=a.id),0)
      AS balance
    FROM accounts a
    ORDER BY a.name
  `).all());
});

app.post('/api/accounts', (req, res) => {
  const { name, currency } = req.body;
  if (!name?.trim() || !currency?.trim()) return res.status(400).json({ error: 'Название и валюта обязательны' });
  const r = db.prepare('INSERT INTO accounts(name,currency) VALUES(?,?)').run(name.trim(), currency.trim().toUpperCase());
  res.json({ id: r.lastInsertRowid });
});

app.get('/api/transactions', (req, res) => {
  res.json(db.prepare(`
    SELECT t.*,af.name AS account_from_name,at.name AS account_to_name
    FROM transactions t
    LEFT JOIN accounts af ON af.id=t.account_from_id
    LEFT JOIN accounts at ON at.id=t.account_to_id
    ORDER BY t.date DESC, t.created_at DESC
  `).all());
});

app.post('/api/transactions', (req, res) => {
  const { type, amount, date, comment, related_type, related_id } = req.body;
  const account_from_id = req.body.account_from_id || req.body.from_account_id || ((type === 'expense' || type === 'withdraw') ? req.body.account_id : null);
  const account_to_id = req.body.account_to_id || req.body.to_account_id || (type === 'income' ? req.body.account_id : null);
  const receipt_id = type === 'expense' && req.body.receipt_id ? +req.body.receipt_id : null;
  const sale_id = type === 'income' && req.body.sale_id ? +req.body.sale_id : null;
  const context = { type, amount: +amount, account_id: account_from_id || account_to_id || null, receipt_id, sale_id };
  if (!['income','expense','transfer','withdraw'].includes(type)) return validationError(res, 'Некорректный тип операции', context);
  if (!(+amount > 0)) return validationError(res, 'Сумма должна быть больше 0', context);
  if (!date) return validationError(res, 'Дата обязательна', context);
  if (type === 'income' && !sale_id) return validationError(res, 'Income должен быть привязан к продаже (sale_id обязателен)', context);
  if (type === 'expense' && !receipt_id) return validationError(res, 'Expense должен быть привязан к приходу (receipt_id обязателен)', context);
  if ((type === 'expense' || type === 'transfer' || type === 'withdraw') && !account_from_id) return validationError(res, 'Счет списания обязателен', context);
  if ((type === 'income' || type === 'transfer') && !account_to_id) return validationError(res, 'Счет зачисления обязателен', context);
  if (type === 'transfer' && String(account_from_id) === String(account_to_id)) return validationError(res, 'Кассы перевода должны отличаться', context);
  if ((type === 'expense' || type === 'transfer' || type === 'withdraw') && getAccountBalance(+account_from_id) < +amount) {
    return validationError(res, 'Недостаточно средств в кассе', context);
  }
  const r = db.prepare('INSERT INTO transactions(type,amount,account_from_id,account_to_id,receipt_id,sale_id,date,comment,related_type,related_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(type, +amount, account_from_id||null, account_to_id||null, receipt_id, sale_id, date, comment||null, related_type||null, related_id||null);
  res.json({ id: r.lastInsertRowid });
});

app.get('/api/audit', (req, res) => {
  const paymentsTotal = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM payments').get().total;
  const paymentTransactionsTotal = db.prepare(`
    SELECT COALESCE(SUM(t.amount),0) AS total
    FROM payments p
    LEFT JOIN transactions t ON t.id=p.transaction_id
  `).get().total;
  const accounts = db.prepare(`
    SELECT
      a.id AS account_id,
      a.name AS account_name,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE type='income' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='expense' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='withdraw' AND account_from_id=a.id),0)
      + COALESCE((SELECT SUM(amount) FROM transactions WHERE type='transfer' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount) FROM transactions WHERE type='transfer' AND account_from_id=a.id),0)
      AS balance_actual,
      COALESCE(SUM(CASE
        WHEN t.type='income' AND t.account_to_id=a.id THEN t.amount
        WHEN t.type='expense' AND t.account_from_id=a.id THEN -t.amount
        WHEN t.type='withdraw' AND t.account_from_id=a.id THEN -t.amount
        WHEN t.type='transfer' AND t.account_to_id=a.id THEN t.amount
        WHEN t.type='transfer' AND t.account_from_id=a.id THEN -t.amount
        ELSE 0
      END),0) AS balance_calculated
    FROM accounts a
    LEFT JOIN transactions t ON t.account_to_id=a.id OR t.account_from_id=a.id
    GROUP BY a.id,a.name
    ORDER BY a.name
  `).all().map(account => ({
    ...account,
    id: account.account_id,
    name: account.account_name,
    balance: account.balance_actual,
    recalculated_balance: account.balance_calculated,
    diff: (+account.balance_actual || 0) - (+account.balance_calculated || 0),
    difference: (+account.balance_actual || 0) - (+account.balance_calculated || 0)
  }));

  const orphanTransactions = db.prepare(`
    SELECT id,type,amount,comment
    FROM transactions
    WHERE (type='income' AND sale_id IS NULL)
       OR (type='expense' AND receipt_id IS NULL)
    ORDER BY id DESC
  `).all();

  const receivableSystem = db.prepare(`
    SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount,0)),0) AS total
    FROM sales
  `).get().total;
  const receivableLedger = db.prepare(`
    SELECT
      COALESCE((SELECT SUM(total_amount) FROM sales),0)
      - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.entity_type='sale'),0)
      AS total
  `).get().total;
  const payableSystem = db.prepare(`
    SELECT COALESCE(SUM(total_cost - COALESCE(paid_amount,0)),0) AS total
    FROM purchases
  `).get().total;
  const payableLedger = db.prepare(`
    SELECT
      COALESCE((SELECT SUM(total_cost) FROM purchases),0)
      - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.entity_type='purchase'),0)
      AS total
  `).get().total;
  const debtsDiff = (receivableSystem - receivableLedger) + (payableSystem - payableLedger);

  const accountsTotal = accounts.reduce((sum, account) => sum + (+account.balance_actual || 0), 0);
  const transactionsTotal = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN type='income' THEN amount
      WHEN type='expense' THEN -amount
      WHEN type='withdraw' THEN -amount
      ELSE 0
    END),0) AS total
    FROM transactions
  `).get().total;
  const globalDiff = accountsTotal - transactionsTotal;

  res.json({
    payments_vs_transactions: {
      payments_total: paymentsTotal,
      transactions_total: paymentTransactionsTotal,
      difference: paymentsTotal - paymentTransactionsTotal
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
      ok: Math.abs(debtsDiff) < 0.01
    },
    global_check: {
      accounts_total: accountsTotal,
      transactions_total: transactionsTotal,
      diff: globalDiff,
      ok: Math.abs(globalDiff) < 0.01
    }
  });
});

// ─── MONEY ASSETS ─────────────────────────────────────────────────────────────
app.get('/api/money-assets', (req, res) => {
  res.json(db.prepare('SELECT * FROM money_assets ORDER BY date DESC, created_at DESC').all());
});
app.post('/api/money-assets', (req, res) => {
  const { asset_type, amount, comment, date } = req.body;
  if (!asset_type || !amount || !date) return res.status(400).json({ error: 'Тип, сумма и дата обязательны' });
  const r = db.prepare('INSERT INTO money_assets(asset_type,amount,comment,date) VALUES(?,?,?,?)').run(asset_type, +amount, comment||null, date);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/money-assets/:id', (req, res) => {
  const { asset_type, amount, comment, date } = req.body;
  if (!asset_type || !amount || !date) return res.status(400).json({ error: 'Тип, сумма и дата обязательны' });
  db.prepare('UPDATE money_assets SET asset_type=?,amount=?,comment=?,date=? WHERE id=?').run(asset_type, +amount, comment||null, date, +req.params.id);
  res.json({ success: true });
});
app.delete('/api/money-assets/:id', (req, res) => {
  db.prepare('DELETE FROM money_assets WHERE id=?').run(+req.params.id);
  res.json({ success: true });
});

// ─── LIABILITIES ──────────────────────────────────────────────────────────────
app.get('/api/liabilities', (req, res) => {
  res.json(db.prepare('SELECT * FROM liabilities ORDER BY date DESC, created_at DESC').all());
});
app.post('/api/liabilities', (req, res) => {
  const { title, amount, comment, date } = req.body;
  if (!title?.trim() || !amount || !date) return res.status(400).json({ error: 'Название, сумма и дата обязательны' });
  const r = db.prepare('INSERT INTO liabilities(title,amount,comment,date) VALUES(?,?,?,?)').run(title.trim(), +amount, comment||null, date);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/liabilities/:id', (req, res) => {
  const { title, amount, comment, date } = req.body;
  if (!title?.trim() || !amount || !date) return res.status(400).json({ error: 'Название, сумма и дата обязательны' });
  db.prepare('UPDATE liabilities SET title=?,amount=?,comment=?,date=? WHERE id=?').run(title.trim(), +amount, comment||null, date, +req.params.id);
  res.json({ success: true });
});
app.delete('/api/liabilities/:id', (req, res) => {
  db.prepare('DELETE FROM liabilities WHERE id=?').run(+req.params.id);
  res.json({ success: true });
});

// ─── PROFIT ───────────────────────────────────────────────────────────────────
app.get('/api/profit/summary', (req, res) => {
  const revenue = db.prepare('SELECT COALESCE(SUM(total_amount),0) v FROM sales').get().v;
  const cost = db.prepare('SELECT COALESCE(SUM(total_cost),0) v FROM purchases').get().v;
  res.json({ revenue, cost, profit: revenue - cost });
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
app.get('/api/analytics/dashboard', (req, res) => {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const totalSales  = q('SELECT COALESCE(SUM(total_amount),0) v FROM sales').v;
  const totalCosts  = q('SELECT COALESCE(SUM(total_cost),0) v FROM purchases').v;
  const todaySales  = q("SELECT COALESCE(SUM(total_amount),0) v FROM sales WHERE date=date('now')").v;
  const todayCosts  = q("SELECT COALESCE(SUM(total_cost),0) v FROM purchases WHERE date=date('now')").v;
  const weekSales   = q("SELECT COALESCE(SUM(total_amount),0) v FROM sales WHERE date>=date('now','-7 days')").v;
  const weekCosts   = q("SELECT COALESCE(SUM(total_cost),0) v FROM purchases WHERE date>=date('now','-7 days')").v;
  const monthSales  = q("SELECT COALESCE(SUM(total_amount),0) v FROM sales WHERE date>=date('now','-30 days')").v;
  const monthCosts  = q("SELECT COALESCE(SUM(total_cost),0) v FROM purchases WHERE date>=date('now','-30 days')").v;
  const totalAssets = q('SELECT COALESCE(SUM(amount),0) v FROM money_assets').v;
  const totalLiab   = q('SELECT COALESCE(SUM(amount),0) v FROM liabilities').v;

  const profitByDate = db.prepare(`
    SELECT d.date,
      COALESCE(s.sv,0) AS sales,
      COALESCE(p.pv,0) AS costs,
      COALESCE(s.sv,0)-COALESCE(p.pv,0) AS profit
    FROM (
      SELECT date FROM sales     WHERE date>=date('now','-30 days')
      UNION
      SELECT date FROM purchases WHERE date>=date('now','-30 days')
    ) d
    LEFT JOIN (SELECT date,SUM(total_amount) sv FROM sales    GROUP BY date) s ON s.date=d.date
    LEFT JOIN (SELECT date,SUM(total_cost)  pv FROM purchases GROUP BY date) p ON p.date=d.date
    ORDER BY d.date`).all();

  const topClients = db.prepare(`
    SELECT c.id, c.name,
      COALESCE(SUM(s.total_amount),0) AS total_sales,
      COALESCE((SELECT SUM(total_cost) FROM purchases WHERE client_id=c.id),0) AS total_costs
    FROM clients c
    LEFT JOIN sales s ON s.client_id=c.id
    GROUP BY c.id ORDER BY total_sales DESC LIMIT 5
  `).all().map(r => ({ ...r, profit: r.total_sales - r.total_costs }));

  res.json({
    totalProfit:   totalSales - totalCosts,
    todayProfit:   todaySales - todayCosts,
    weekProfit:    weekSales  - weekCosts,
    monthProfit:   monthSales - monthCosts,
    totalSales, totalCosts, totalAssets, totalLiab,
    clientCount:   q('SELECT COUNT(*) v FROM clients').v,
    saleCount:     q('SELECT COUNT(*) v FROM sales').v,
    purchaseCount: q('SELECT COUNT(*) v FROM purchases').v,
    totalBalance:  totalAssets - totalLiab,
    profitByDate, topClients,
  });
});

app.get('/api/analytics/profit', (req, res) => {
  const { period } = req.query;
  let df = '';
  if (period === 'week')  df = "AND date>=date('now','-7 days')";
  if (period === 'month') df = "AND date>=date('now','-30 days')";
  if (period === 'year')  df = "AND date>=date('now','-365 days')";

  const byClient = db.prepare(`
    SELECT c.name,
      COALESCE(SUM(s.total_amount),0) AS total_sales,
      COALESCE((SELECT SUM(total_cost) FROM purchases WHERE client_id=c.id ${df.replace(/date/g,'purchases.date')}),0) AS total_costs
    FROM clients c LEFT JOIN sales s ON s.client_id=c.id ${df}
    GROUP BY c.id ORDER BY total_sales DESC`).all().map(r => ({ ...r, profit: r.total_sales - r.total_costs }));

  const byProduct = db.prepare(`
    SELECT p.name,
      COALESCE(SUM(s.total_amount),0) AS total_sales,
      COALESCE((SELECT SUM(total_cost) FROM purchases WHERE product_id=p.id ${df.replace(/date/g,'purchases.date')}),0) AS total_costs
    FROM products p LEFT JOIN sales s ON s.product_id=p.id ${df}
    GROUP BY p.id ORDER BY total_sales DESC`).all().map(r => ({ ...r, profit: r.total_sales - r.total_costs }));

  const salesByPeriod     = db.prepare(`SELECT date,SUM(total_amount) total FROM sales    WHERE 1=1 ${df} GROUP BY date ORDER BY date`).all();
  const purchasesByPeriod = db.prepare(`SELECT date,SUM(total_cost)   total FROM purchases WHERE 1=1 ${df} GROUP BY date ORDER BY date`).all();
  const assetsByType      = db.prepare('SELECT asset_type,SUM(amount) total FROM money_assets GROUP BY asset_type').all();
  const totalLiab         = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM liabilities').get().v;

  res.json({ byClient, byProduct, salesByPeriod, purchasesByPeriod, assetsByType, totalLiab });
});

// ─── AI COMMANDS ──────────────────────────────────────────────────────────────
app.post('/api/ai/command', (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'Команда пустая' });
  const cmd = command.trim();

  const saleRe = /продай?\s+(\S+)\s+([\d.]+)\s+(.+?)\s+по\s+([\d.]+)(?:\s+(кг|шт|kg|pcs))?/i;
  const sm = cmd.match(saleRe);
  if (sm) {
    const [, cS, qty, pS, price, unitRaw] = sm;
    const client  = db.prepare('SELECT * FROM clients WHERE LOWER(name) LIKE ?').get(`%${cS.toLowerCase()}%`);
    const product = db.prepare('SELECT p.*,pr.sale_type FROM products p LEFT JOIN product_rules pr ON pr.product_id=p.id WHERE LOWER(p.name) LIKE ?').get(`%${pS.toLowerCase()}%`);
    if (!client)  return res.json({ type: 'error', message: `Клиент "${cS}" не найден.` });
    if (!product) return res.json({ type: 'error', message: `Товар "${pS}" не найден.` });
    const sale_unit = unitRaw ? (/кг|kg/i.test(unitRaw) ? 'kg' : 'pcs') : (product.sale_type === 'pcs' ? 'pcs' : 'kg');
    const total = +(+qty * +price).toFixed(2);
    return res.json({ type: 'sale_preview',
      data: { client_id: client.id, client_name: client.name, product_id: product.id, product_name: product.name, sale_type: product.sale_type, sale_unit, quantity: +qty, price_per_unit: +price, total_amount: total },
      message: `✓ ${client.name} | ${product.name} | ${qty} ${sale_unit} × $${price} = $${total}` });
  }

  const pm = cmd.match(/прибыль?\s+за\s+(\S+)/i);
  if (pm) {
    const p = pm[1].toLowerCase(); let df = '1=1';
    if (/сегодня/.test(p)) df = "date=date('now')";
    else if (/недел/.test(p)) df = "date>=date('now','-7 days')";
    else if (/месяц/.test(p)) df = "date>=date('now','-30 days')";
    else if (/год/.test(p))   df = "date>=date('now','-365 days')";
    const s = db.prepare(`SELECT COALESCE(SUM(total_amount),0) v FROM sales WHERE ${df}`).get().v;
    const c = db.prepare(`SELECT COALESCE(SUM(total_cost),0) v FROM purchases WHERE ${df}`).get().v;
    return res.json({ type: 'analytics', data: { sales: s, costs: c, profit: s-c },
      message: `Прибыль за ${pm[1]}: ${s-c>=0?'+':''}$${(s-c).toFixed(2)} (продажи: $${s.toFixed(2)}, затраты: $${c.toFixed(2)})` });
  }
  if (/должник/i.test(cmd)) {
    const rows = db.prepare("SELECT * FROM money_assets WHERE asset_type='debtors' ORDER BY date DESC").all();
    return res.json({ type: 'debtors', data: rows, message: `Должники: ${rows.length} записей, сумма: $${rows.reduce((s,r)=>s+r.amount,0).toFixed(2)}` });
  }
  if (/баланс/i.test(cmd)) {
    const a = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM money_assets').get().v;
    const l = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM liabilities').get().v;
    return res.json({ type: 'balance', data: { assets: a, liabilities: l, balance: a-l },
      message: `Баланс: $${(a-l).toFixed(2)} (активы: $${a.toFixed(2)}, обязательства: $${l.toFixed(2)})` });
  }
  if (/клиент/i.test(cmd)) {
    const rows = db.prepare('SELECT id,name,phone FROM clients ORDER BY name').all();
    return res.json({ type: 'clients', data: rows, message: `Клиентов: ${rows.length}` });
  }
  res.json({ type: 'help', message: 'Команда не распознана.',
    suggestions: ['продай [клиент] [кол-во] [товар] по [цена]','прибыль за [сегодня/неделю/месяц/год]','должники','баланс','клиенты'] });
});

// ─── Static (production build) ────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(__dirname, 'client', 'dist');
  app.use(express.static(distDir));
  app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`\n🚀 Cargo Manager → http://localhost:${PORT}`);
  console.log(`   SQLite: ${path.join(__dirname, 'cargo.db')}`);
  console.log(`   API:    http://localhost:${PORT}/api/\n`);
});
