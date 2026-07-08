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
const XLSX = require('xlsx');
const { google } = require('googleapis');
const { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require('crypto');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const REQUEST_BODY_LIMIT = '10mb';
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

const allowedCorsOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
}));
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const SESSION_COOKIE_NAME = 'cargo_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function isAuthConfigured() {
  return Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH && process.env.SESSION_SECRET);
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return cookies;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_) {
      cookies[key] = value;
    }
    return cookies;
  }, {});
}

function signSessionPayload(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET || '')
    .update(payload)
    .digest('base64url');
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

function createSessionToken(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    exp: Date.now() + SESSION_TTL_MS,
    nonce: randomBytes(12).toString('base64url'),
  })).toString('base64url');
  return `${payload}.${signSessionPayload(payload)}`;
}

function getSessionFromRequest(req) {
  if (!isAuthConfigured()) return null;
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE_NAME];
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqualText(signature, signSessionPayload(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session?.username || !session?.exp || Date.now() > +session.exp) return null;
    if (session.username !== process.env.ADMIN_USERNAME) return null;
    return { username: session.username };
  } catch (_) {
    return null;
  }
}

function verifyPassword(password, passwordHash) {
  const [scheme, salt, expectedHash] = String(passwordHash || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHash) return false;
  const actualHash = scryptSync(String(password || ''), salt, 64).toString('hex');
  return safeEqualText(actualHash, expectedHash);
}

function shouldUseSecureCookie() {
  const value = String(process.env.AUTH_COOKIE_SECURE || '').trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return isProduction;
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookie(),
    path: '/',
  };
}

function setSessionCookie(req, res, username) {
  res.cookie(SESSION_COOKIE_NAME, createSessionToken(username), {
    ...sessionCookieOptions(),
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
}

app.post('/api/auth/login', (req, res) => {
  if (!isAuthConfigured()) return res.status(503).json({ error: 'Authentication is not configured' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (username !== process.env.ADMIN_USERNAME || !verifyPassword(password, process.env.ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  setSessionCookie(req, res, username);
  res.json({ authenticated: true, user: { username } });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSessionFromRequest(req);
  res.json({
    authenticated: Boolean(session),
    configured: isAuthConfigured(),
    user: session ? { username: session.username } : null,
  });
});

app.use('/api', (req, res, next) => {
  if (!pool || !databaseReady) {
    return res.status(503).json({ error: 'Database is not available' });
  }
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Требуется вход', code: 'UNAUTHORIZED' });
  req.user = session;
  next();
});

function validationError(res, message, context = {}) {
  console.warn('VALIDATION ERROR:', context);
  return res.status(400).json({ error: message });
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clampLimit(value, defaultValue = 100, maxValue = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function safeOffset(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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

async function logOperation(clientOrOptions, maybeOptions) {
  const hasClient = clientOrOptions && typeof clientOrOptions.query === 'function';
  const client = hasClient ? clientOrOptions : pool;
  const options = maybeOptions || clientOrOptions || {};
  if (!client || !options.action) return;
  const useSavepoint = hasClient && client !== pool;

  try {
    if (useSavepoint) await client.query('SAVEPOINT operation_log_sp');
    await query(`
      INSERT INTO operation_logs(actor,action,entity_type,entity_id,entity_label,amount,currency,description,meta)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `, [
      options.actor || 'system',
      options.action,
      options.entity_type || null,
      options.entity_id != null ? +options.entity_id : null,
      options.entity_label || null,
      options.amount != null && options.amount !== '' ? +options.amount : null,
      options.currency || 'USD',
      options.description || null,
      JSON.stringify(options.meta || {}),
    ], client);
    if (useSavepoint) await client.query('RELEASE SAVEPOINT operation_log_sp');
  } catch (error) {
    if (useSavepoint) {
      try {
        await client.query('ROLLBACK TO SAVEPOINT operation_log_sp');
        await client.query('RELEASE SAVEPOINT operation_log_sp');
      } catch (rollbackError) {
        console.error('Operation log rollback failed:', rollbackError.message);
      }
    }
    console.error('Operation log failed:', error.message);
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
      keywords TEXT,
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
      ala_unit TEXT CHECK(ala_unit IN ('kg','pcs')) DEFAULT 'kg',
      total_cost NUMERIC DEFAULT 0,
      class_code TEXT,
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
      ala_unit TEXT CHECK(ala_unit IN ('kg','pcs')) DEFAULT 'kg',
      class_code TEXT,
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
      manual_cost NUMERIC,
      manual_cost_reason TEXT,
      manual_cost_updated_at TIMESTAMP,
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
      entity_type TEXT NOT NULL CHECK(entity_type IN ('sale','purchase','client_advance')),
      entity_id INTEGER NOT NULL,
      amount NUMERIC NOT NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      comment TEXT,
      transaction_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payment_allocations (
      id SERIAL PRIMARY KEY,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      document_type TEXT NOT NULL,
      document_id INTEGER,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      cancelled_at TIMESTAMP NULL
    );

    CREATE TABLE IF NOT EXISTS debt_payment_idempotency (
      id SERIAL PRIMARY KEY,
      idempotency_key TEXT UNIQUE NOT NULL,
      request_hash TEXT NOT NULL,
      response_json JSONB,
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
      type TEXT NOT NULL CHECK(type IN ('income','expense','transfer','withdraw','owner_contribution','owner_withdrawal','cash_adjustment_in','cash_adjustment_out')),
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

    CREATE TABLE IF NOT EXISTS tariffs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tariff_type TEXT DEFAULT 'purchase',
      product_pattern TEXT,
      class_code TEXT,
      client_id INTEGER,
      dxb_rate NUMERIC DEFAULT 5,
      ala_rate NUMERIC DEFAULT 0,
      ala_unit TEXT CHECK(ala_unit IN ('kg','pcs')) DEFAULT 'kg',
      sale_rate NUMERIC DEFAULT 0,
      sale_unit TEXT DEFAULT 'kg',
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS import_records (
      id SERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      spreadsheet_id TEXT,
      gid TEXT,
      source_row INTEGER,
      source_date DATE,
      source_marking TEXT,
      receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_type, spreadsheet_id, gid, source_row)
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      actor TEXT DEFAULT 'system',
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      entity_label TEXT,
      amount NUMERIC DEFAULT NULL,
      currency TEXT DEFAULT 'USD',
      description TEXT,
      meta JSONB DEFAULT '{}'::jsonb
    );
  `);

  await query(`
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cost_almaty NUMERIC DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cost_dubai NUMERIC DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cost_per_kg NUMERIC DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS ala_unit TEXT DEFAULT 'kg';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS class_code TEXT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS total_cost NUMERIC DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;
    ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS ala_unit TEXT DEFAULT 'kg';
    ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS total_cost NUMERIC DEFAULT 0;
    ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS class_code TEXT;
    ALTER TABLE markings ADD COLUMN IF NOT EXISTS keywords TEXT;
    ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS tariff_type TEXT DEFAULT 'purchase';
    ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS client_id INTEGER;
    ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS sale_rate NUMERIC DEFAULT 0;
    ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS sale_unit TEXT DEFAULT 'kg';
    ALTER TABLE tariffs ALTER COLUMN dxb_rate SET DEFAULT 5;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS sales_document_id INTEGER REFERENCES sales_documents(id) ON DELETE SET NULL;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS manual_cost NUMERIC;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS manual_cost_reason TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS manual_cost_updated_at TIMESTAMP;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS comment TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_id INTEGER;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS debt_payment_group_id TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS cancelled_meta JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_entity_type_check;
    ALTER TABLE payments ADD CONSTRAINT payments_entity_type_check CHECK(entity_type IN ('sale','purchase','client_advance','client','supplier'));
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL;
    ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
    ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK(type IN ('income','expense','transfer','withdraw','owner_contribution','owner_withdrawal','cash_adjustment_in','cash_adjustment_out'));
  `);

  await query(`
    UPDATE payments p
    SET transaction_id = t.id
    FROM transactions t
    WHERE p.transaction_id IS NULL
      AND t.related_type = 'payment'
      AND t.related_id = p.id;
  `);

  await query('CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment_id ON payment_allocations(payment_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_payment_allocations_document ON payment_allocations(document_type, document_id)');

  await query(`
    UPDATE tariffs
    SET tariff_type='purchase'
    WHERE tariff_type IS NULL OR tariff_type NOT IN ('purchase','sale');
    UPDATE tariffs SET sale_unit='kg' WHERE sale_unit IS NULL OR sale_unit NOT IN ('kg','pcs');
    UPDATE tariffs
    SET dxb_rate=5
    WHERE tariff_type='purchase'
      AND name IN ('Базовый тариф','Телефоны')
      AND dxb_rate::numeric = 5.5;
    UPDATE markings SET keywords=marking WHERE keywords IS NULL OR trim(keywords) = '';
  `);

  const tariffCount = await get('SELECT COUNT(*)::int AS count FROM tariffs');
  if (!tariffCount?.count) {
    await query(`
      INSERT INTO tariffs(name,product_pattern,class_code,dxb_rate,ala_rate,ala_unit,is_default,is_active)
      VALUES
        ('Базовый тариф', NULL, NULL, 5, 3, 'kg', TRUE, TRUE),
        ('Телефоны', 'phone,iphone,айфон,телефон,smartphone', NULL, 5, 3, 'pcs', FALSE, TRUE)
    `);
  }

  const saleTariffCount = await get("SELECT COUNT(*)::int AS count FROM tariffs WHERE tariff_type='sale' AND is_active=TRUE");
  if (!saleTariffCount?.count) {
    await query(`
      INSERT INTO tariffs(name,tariff_type,product_pattern,class_code,dxb_rate,ala_rate,ala_unit,sale_rate,sale_unit,is_default,is_active)
      VALUES
        ('Реализация класс A', 'sale', NULL, 'A', 0, 0, 'kg', 0, 'kg', FALSE, TRUE),
        ('Реализация класс B', 'sale', NULL, 'B', 0, 0, 'kg', 0, 'kg', FALSE, TRUE),
        ('Реализация класс C', 'sale', NULL, 'C', 0, 0, 'kg', 0, 'kg', FALSE, TRUE),
        ('Реализация класс D', 'sale', NULL, 'D', 0, 0, 'kg', 0, 'kg', FALSE, TRUE),
        ('Реализация класс E', 'sale', NULL, 'E', 0, 0, 'kg', 0, 'kg', FALSE, TRUE)
    `);
  }

  await cleanupOrphanImportRecords();
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
  if (+cost_almaty < 0) throw new Error('Тариф Алматы не может быть отрицательным');
  if (+cost_dubai < 0) throw new Error('Тариф Дубай не может быть отрицательным');
}

function purchaseLogValues(purchase = {}) {
  return {
    purchase_id: purchase.id ? +purchase.id : null,
    date: purchase.date || null,
    receipt_id: purchase.receipt_id ? +purchase.receipt_id : null,
    supplier_id: purchase.supplier_id ? +purchase.supplier_id : null,
    client_id: purchase.client_id ? +purchase.client_id : null,
    marking_id: purchase.marking_id ? +purchase.marking_id : null,
    product_id: purchase.product_id ? +purchase.product_id : null,
    quantity_pcs: +(purchase.quantity_pcs || 0),
    weight_kg: +(purchase.weight_kg || 0),
    boxes_count: +(purchase.boxes_count || 0),
    cost_almaty: +(purchase.cost_almaty || 0),
    cost_dubai: +(purchase.cost_dubai || 0),
    cost_per_kg: +(purchase.cost_per_kg || 0),
    ala_unit: purchase.ala_unit || null,
    class_code: purchase.class_code || null,
    total_cost: +(purchase.total_cost || 0),
    paid_amount: +(purchase.paid_amount || 0),
    notes: purchase.notes || null,
  };
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMarking(value) {
  const normal = normalizeText(value)
    .replace(/[.,;:|/\\\-–—_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    normal,
    compact: normal.replace(/\s+/g, ''),
  };
}

function splitMarkingKeywords(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function markingCandidateTerms(marking) {
  const terms = [marking.marking, ...splitMarkingKeywords(marking.keywords)];
  return Array.from(new Set(terms.map((term) => String(term || '').trim()).filter(Boolean)));
}

function markingMatchReason(status, matchedKeyword = null) {
  const keyword = matchedKeyword ? `"${matchedKeyword}"` : 'ключевому слову';
  if (status === 'exact') return `Точное совпадение по ${keyword}`;
  if (status === 'keyword') return `Совпадение по ${keyword}`;
  if (status === 'compact') return `Совпадение без пробелов и знаков по ${keyword}`;
  return null;
}

function markingTermMatchScore(inputMarking, term, marking) {
  const input = normalizeMarking(inputMarking);
  if (!input.normal) return null;

  const normalizedTerm = normalizeMarking(term);
  if (!normalizedTerm.normal) return null;

  const compactLength = normalizedTerm.compact.length;
  const lengthBonus = Math.min(8, compactLength / 2);
  let score = 0;
  let status = null;

  if (input.normal === normalizedTerm.normal) {
    score = 100 + lengthBonus;
    status = 'exact';
  } else if (input.compact === normalizedTerm.compact) {
    score = 92 + lengthBonus;
    status = 'compact';
  } else if (
    input.normal.includes(normalizedTerm.normal) ||
    normalizedTerm.normal.includes(input.normal)
  ) {
    score = 88 + lengthBonus;
    status = 'keyword';
  } else if (
    (normalizedTerm.compact && input.compact.includes(normalizedTerm.compact)) ||
    (input.compact && normalizedTerm.compact.includes(input.compact))
  ) {
    score = 78 + lengthBonus;
    status = 'compact';
  }

  if (!score) return null;

  const inputClient = normalizeMarking(inputMarking);
  const clientName = normalizeMarking(marking.client_name || '');
  if (clientName.normal && (
    inputClient.normal.includes(clientName.normal) ||
    (clientName.compact && inputClient.compact.includes(clientName.compact))
  )) {
    score += 6;
  }

  return {
    score: Math.round(score * 10) / 10,
    status,
    matched_keyword: term,
    match_reason: markingMatchReason(status, term),
  };
}

function markingMatchScore(inputMarking, marking) {
  const best = markingCandidateTerms(marking).reduce((currentBest, term) => {
    const match = markingTermMatchScore(inputMarking, term, marking);
    if (!match) return currentBest;
    if (!currentBest || match.score > currentBest.score) return match;
    return currentBest;
  }, null);

  return best;
}

function matchMarking(inputMarking, markings = []) {
  const matches = markings
    .map((marking) => {
      const match = markingMatchScore(inputMarking, marking);
      return match ? { ...marking, ...match } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!matches.length) return { status: 'not_found', candidates: [] };

  const best = matches[0];
  const second = matches[1] || null;
  const isConfident = best.score >= 80 && (!second || best.score - second.score >= 10);
  if (second && !isConfident) {
    return {
      status: 'ambiguous',
      match_score: best.score,
      match_reason: 'Несколько близких вариантов',
      candidates: matches.slice(0, 8).map((match) => ({
        marking_id: match.id,
        marking: match.marking,
        client_id: match.client_id,
        client_name: match.client_name,
        matched_keyword: match.matched_keyword,
        match_score: match.score,
        match_reason: match.match_reason,
      })),
    };
  }

  return {
    status: second ? 'auto_selected' : best.status,
    marking: best,
    matched_keyword: best.matched_keyword,
    match_score: best.score,
    match_reason: second
      ? `Автовыбор: лучший score ${best.score}, следующий ${second.score}`
      : best.match_reason,
    candidates: matches.slice(0, 8).map((match) => ({
      marking_id: match.id,
      marking: match.marking,
      client_id: match.client_id,
      client_name: match.client_name,
      matched_keyword: match.matched_keyword,
      match_score: match.score,
      match_reason: match.match_reason,
    })),
  };
}

function appendMarkingKeyword(currentKeywords, keyword) {
  const normalizedKeyword = String(keyword || '').trim();
  if (!normalizedKeyword) return currentKeywords || '';
  const existing = splitMarkingKeywords(currentKeywords);
  const known = new Set(existing.map((term) => normalizeMarking(term).compact).filter(Boolean));
  if (known.has(normalizeMarking(normalizedKeyword).compact)) return currentKeywords || normalizedKeyword;
  return [...existing, normalizedKeyword].join(', ');
}

function isPhoneProduct(productName) {
  const name = normalizeText(productName);
  return (
    name.includes('iphone') ||
    name.includes('айфон') ||
    name.includes('smartphone') ||
    name.includes('android phone') ||
    name.includes('samsung phone') ||
    name.includes('телефон') ||
    /(^|[^a-z0-9])phone([^a-z0-9]|$)/i.test(name)
  );
}

function splitPattern(pattern) {
  return String(pattern || '')
    .split(',')
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function tariffProductMatches(tariff, productName) {
  const product = normalizeText(productName);
  const patterns = splitPattern(tariff.product_pattern);
  return patterns.length > 0 && patterns.some((pattern) => {
    if (pattern === 'phone') return /(^|[^a-z0-9])phone([^a-z0-9]|$)/i.test(product);
    return product.includes(pattern);
  });
}

function normalizeProductPatternValue(value) {
  return normalizeText(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function productPatternKeywords(productPattern) {
  return String(productPattern || '')
    .split(',')
    .map((part) => normalizeProductPatternValue(part))
    .filter(Boolean);
}

function productPatternMatchScore(productPattern, productName) {
  const product = normalizeProductPatternValue(productName);
  const compactProduct = product.replace(/\s+/g, '');
  return productPatternKeywords(productPattern).reduce((best, keyword) => {
    const compactKeyword = keyword.replace(/\s+/g, '');
    const matches = keyword === 'phone'
      ? /(^|[^a-z0-9])phone([^a-z0-9]|$)/i.test(product)
      : product.includes(keyword) || (compactKeyword && compactProduct.includes(compactKeyword));
    return matches ? Math.max(best, keyword.length) : best;
  }, 0);
}

function productPatternMatches(productPattern, productName) {
  return productPatternMatchScore(productPattern, productName) > 0;
}

function bestProductPatternTariff(tariffs, productName) {
  return tariffs.reduce((best, tariff) => {
    const score = productPatternMatchScore(tariff.product_pattern, productName);
    if (!score) return best;
    if (!best || score > best.score) return { tariff, score };
    return best;
  }, null)?.tariff || null;
}

function tariffClassMatches(tariff, classCode) {
  const tariffClass = normalizeText(tariff.class_code);
  return Boolean(tariffClass) && tariffClass === normalizeText(classCode);
}

function matchTariff(productName, classCode, tariffs = []) {
  const active = tariffs.filter((tariff) => tariff && tariff.is_active !== false && normalizeText(tariff.tariff_type || 'purchase') === 'purchase');
  const productAndClass = active.find((tariff) => tariffProductMatches(tariff, productName) && tariffClassMatches(tariff, classCode));
  if (productAndClass) return productAndClass;

  const productOnly = active.find((tariff) => tariffProductMatches(tariff, productName) && !normalizeText(tariff.class_code));
  if (productOnly) return productOnly;

  const classOnly = active.find((tariff) => !splitPattern(tariff.product_pattern).length && tariffClassMatches(tariff, classCode));
  if (classOnly) return classOnly;

  const defaultTariff = active.find((tariff) => tariff.is_default);
  if (defaultTariff) return defaultTariff;

  return {
    id: null,
    name: 'Авто',
    dxb_rate: 5,
    ala_rate: 0,
    ala_unit: isPhoneProduct(productName) ? 'pcs' : 'kg',
  };
}

function tariffClientMatches(tariff, clientId) {
  return Boolean(clientId) && tariff.client_id != null && +tariff.client_id === +clientId;
}

function isGeneralTariff(tariff) {
  return tariff.client_id == null || tariff.client_id === '';
}

function matchSaleTariff(productName, classCode, clientId, tariffs = []) {
  const active = tariffs.filter((tariff) => tariff && tariff.is_active !== false && normalizeText(tariff.tariff_type) === 'sale');

  const clientTariffs = active.filter((tariff) => tariffClientMatches(tariff, clientId));
  const clientProductAndClass = bestProductPatternTariff(
    clientTariffs.filter((tariff) => tariffClassMatches(tariff, classCode)),
    productName
  );
  if (clientProductAndClass) return clientProductAndClass;

  const clientProductOnly = bestProductPatternTariff(
    clientTariffs.filter((tariff) => !normalizeText(tariff.class_code)),
    productName
  );
  if (clientProductOnly) return clientProductOnly;

  const clientClassOnly = clientTariffs.find((tariff) => !productPatternKeywords(tariff.product_pattern).length && tariffClassMatches(tariff, classCode));
  if (clientClassOnly) return clientClassOnly;

  const generalTariffs = active.filter(isGeneralTariff);
  const productAndClass = bestProductPatternTariff(
    generalTariffs.filter((tariff) => tariffClassMatches(tariff, classCode)),
    productName
  );
  if (productAndClass) return productAndClass;

  const productOnly = bestProductPatternTariff(
    generalTariffs.filter((tariff) => !normalizeText(tariff.class_code)),
    productName
  );
  if (productOnly) return productOnly;

  const classOnly = generalTariffs.find((tariff) => !productPatternKeywords(tariff.product_pattern).length && tariffClassMatches(tariff, classCode));
  if (classOnly) return classOnly;

  const defaultTariff = generalTariffs.find((tariff) => tariff.is_default);
  if (defaultTariff) return defaultTariff;

  return {
    id: null,
    name: 'Не найден',
    sale_rate: 0,
    sale_unit: isPhoneProduct(productName) ? 'pcs' : 'kg',
    missing: true,
  };
}

function calculateImportCost({ productName = '', classCode = '', weightKg = 0, quantityPcs = 0, dxbRate = 5, alaRate = 0, alaUnit }) {
  const weight = +weightKg || 0;
  const quantity = +quantityPcs || 0;
  const dubaiRate = +dxbRate || 0;
  const almatyRate = +alaRate || 0;
  const resolvedAlaUnit = alaUnit === 'pcs' || alaUnit === 'kg'
    ? alaUnit
    : (isPhoneProduct(productName) ? 'pcs' : 'kg');
  const dxbCost = weight * dubaiRate;
  const alaBase = resolvedAlaUnit === 'pcs' ? quantity : weight;
  const alaCost = alaBase * almatyRate;
  return {
    dxbRate: dubaiRate,
    alaRate: almatyRate,
    alaUnit: resolvedAlaUnit,
    dxbCost,
    alaCost,
    totalCost: dxbCost + alaCost,
  };
}

function calculatePurchaseCost({ weight_kg = 0, quantity_pcs = 0, cost_almaty = 0, cost_dubai = 0, product_name = '', class_code = '', ala_unit = null }) {
  const result = calculateImportCost({
    productName: product_name,
    classCode: class_code,
    weightKg: weight_kg,
    quantityPcs: quantity_pcs,
    dxbRate: cost_dubai,
    alaRate: cost_almaty,
    alaUnit: ala_unit,
  });
  return {
    costPerKg: result.dxbRate,
    totalCost: result.totalCost,
    alaUnit: result.alaUnit,
    dxbCost: result.dxbCost,
    alaCost: result.alaCost,
  };
}

async function getAccountBalance(accountId, client = pool) {
  const row = await get(`
    SELECT
      COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='income' AND account_to_id=$1),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='owner_contribution' AND account_to_id=$1),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='cash_adjustment_in' AND account_to_id=$1),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='expense' AND account_from_id=$1),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='withdraw' AND account_from_id=$1),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='owner_withdrawal' AND account_from_id=$1),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='cash_adjustment_out' AND account_from_id=$1),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_to_id=$1),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_from_id=$1),0)
      AS balance
  `, [accountId], client);
  return +(row?.balance || 0);
}

function activePaymentAllocationsCte() {
  return `
    payment_allocations_effective AS (
      SELECT
        p.id::integer AS payment_id,
        p.entity_type::text AS payment_entity_type,
        p.entity_id::integer AS payment_entity_id,
        p.amount::numeric AS payment_amount,
        p.date::text AS payment_date,
        p.created_at::timestamp AS payment_created_at,
        p.comment::text AS payment_comment,
        p.transaction_id::integer AS transaction_id,
        p.debt_payment_group_id::text AS debt_payment_group_id,
        pa.document_type::text AS document_type,
        pa.document_id::integer AS document_id,
        pa.amount::numeric AS amount
      FROM payments p
      JOIN payment_allocations pa ON pa.payment_id = p.id
      WHERE p.cancelled_at IS NULL
        AND pa.cancelled_at IS NULL

      UNION ALL

      SELECT
        p.id::integer AS payment_id,
        p.entity_type::text AS payment_entity_type,
        p.entity_id::integer AS payment_entity_id,
        p.amount::numeric AS payment_amount,
        p.date::text AS payment_date,
        p.created_at::timestamp AS payment_created_at,
        p.comment::text AS payment_comment,
        p.transaction_id::integer AS transaction_id,
        p.debt_payment_group_id::text AS debt_payment_group_id,
        CASE WHEN s.sales_document_id IS NULL THEN 'sale' ELSE 'sales_document' END::text AS document_type,
        COALESCE(s.sales_document_id, s.id)::integer AS document_id,
        p.amount::numeric AS amount
      FROM payments p
      JOIN sales s ON p.entity_type='sale' AND s.id = p.entity_id
      WHERE p.cancelled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = p.id)

      UNION ALL

      SELECT
        p.id::integer AS payment_id,
        p.entity_type::text AS payment_entity_type,
        p.entity_id::integer AS payment_entity_id,
        p.amount::numeric AS payment_amount,
        p.date::text AS payment_date,
        p.created_at::timestamp AS payment_created_at,
        p.comment::text AS payment_comment,
        p.transaction_id::integer AS transaction_id,
        p.debt_payment_group_id::text AS debt_payment_group_id,
        CASE WHEN COALESCE(t.receipt_id, pu.receipt_id) IS NULL THEN 'purchase' ELSE 'receipt' END::text AS document_type,
        COALESCE(t.receipt_id, pu.receipt_id, pu.id)::integer AS document_id,
        p.amount::numeric AS amount
      FROM payments p
      LEFT JOIN transactions t ON t.id = p.transaction_id
      LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id = p.entity_id
      WHERE p.entity_type='purchase'
        AND p.cancelled_at IS NULL
        AND COALESCE(t.receipt_id, pu.receipt_id, pu.id) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = p.id)

      UNION ALL

      SELECT
        p.id::integer AS payment_id,
        p.entity_type::text AS payment_entity_type,
        p.entity_id::integer AS payment_entity_id,
        p.amount::numeric AS payment_amount,
        p.date::text AS payment_date,
        p.created_at::timestamp AS payment_created_at,
        p.comment::text AS payment_comment,
        p.transaction_id::integer AS transaction_id,
        p.debt_payment_group_id::text AS debt_payment_group_id,
        'client_advance'::text AS document_type,
        p.entity_id::integer AS document_id,
        p.amount::numeric AS amount
      FROM payments p
      WHERE p.entity_type='client_advance'
        AND p.cancelled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = p.id)
    )
  `;
}

async function getPaymentAllocations(paymentId, client = pool) {
  return all(`
    SELECT id,payment_id,document_type,document_id,amount,created_at,cancelled_at
    FROM payment_allocations
    WHERE payment_id=$1
    ORDER BY id
  `, [+paymentId], client);
}

function normalizeIntegerIds(values) {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map((value) => +value).filter((value) => Number.isInteger(value) && value > 0))];
}

async function getActivePaymentAllocationForDocuments({
  saleIds = [],
  salesDocumentIds = [],
  purchaseIds = [],
  receiptIds = [],
} = {}, client = pool) {
  const normalizedSaleIds = normalizeIntegerIds(saleIds);
  const normalizedSalesDocumentIds = normalizeIntegerIds(salesDocumentIds);
  const normalizedPurchaseIds = normalizeIntegerIds(purchaseIds);
  const normalizedReceiptIds = normalizeIntegerIds(receiptIds);

  if (!normalizedSaleIds.length && !normalizedSalesDocumentIds.length && !normalizedPurchaseIds.length && !normalizedReceiptIds.length) return null;

  return get(`
    SELECT pa.id,pa.payment_id,pa.document_type,pa.document_id,pa.amount
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    WHERE pa.cancelled_at IS NULL
      AND p.cancelled_at IS NULL
      AND (
        (pa.document_type='sale' AND pa.document_id = ANY($1::int[]))
        OR (pa.document_type='sales_document' AND pa.document_id = ANY($2::int[]))
        OR (pa.document_type='purchase' AND pa.document_id = ANY($3::int[]))
        OR (pa.document_type='receipt' AND pa.document_id = ANY($4::int[]))
      )
    LIMIT 1
  `, [normalizedSaleIds, normalizedSalesDocumentIds, normalizedPurchaseIds, normalizedReceiptIds], client);
}

async function getActiveEffectivePurchasePayment(purchaseId, receiptId, client = pool) {
  return get(`
    WITH ${activePaymentAllocationsCte()}
    SELECT payment_id,document_type,document_id,amount
    FROM payment_allocations_effective
    WHERE (document_type='purchase' AND document_id=$1)
      OR ($2::integer IS NOT NULL AND document_type='receipt' AND document_id=$2)
    LIMIT 1
  `, [+purchaseId, receiptId ? +receiptId : null], client);
}

async function getSaleUsingPurchaseAsExactCostSource(purchase, client = pool) {
  const sourceRow = purchase?.source_row == null ? null : +purchase.source_row;
  if (!Number.isInteger(sourceRow)) return null;

  return get(`
    ${salesCostCte(`
      WHERE NULLIF(substring(s.notes FROM 'Google Sheets row ([0-9]+)'), '')::int=$1
        AND s.product_id=$2
        AND COALESCE(sd.date, s.date)=$3::date
        AND COALESCE(sd.client_id, s.client_id) IS NOT DISTINCT FROM $4::integer
        AND COALESCE(sd.marking_id, s.marking_id) IS NOT DISTINCT FROM $5::integer
    `)}
    SELECT id,sales_document_id
    FROM sales_costed
    WHERE cost_method='actual_receipt_cost'
    LIMIT 1
  `, [
    sourceRow,
    +purchase.product_id,
    purchase.date,
    purchase.client_id == null ? null : +purchase.client_id,
    purchase.marking_id == null ? null : +purchase.marking_id,
  ], client);
}

async function getReceiptPaidAmount(receiptId, client = pool) {
  const row = await get(`
    WITH ${activePaymentAllocationsCte()}
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM payment_allocations_effective
    WHERE document_type='receipt' AND document_id=$1
  `, [receiptId], client);
  return +(row?.total || 0);
}

function parseGoogleSheetUrl(url) {
  const value = String(url || '').trim();
  const spreadsheetMatch = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || value.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (!spreadsheetMatch) throw new Error('Не удалось определить ID Google Sheets из ссылки');
  let gid = '0';
  let range = null;
  try {
    const parsed = new URL(value);
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    gid = parsed.searchParams.get('gid') || hashParams.get('gid') || '0';
    range = parsed.searchParams.get('range') || hashParams.get('range') || null;
  } catch (_) {
    gid = value.match(/gid=([0-9]+)/)?.[1] || '0';
    range = value.match(/range=([^&]+)/)?.[1] || null;
  }
  let decodedRange = range || '';
  try {
    decodedRange = decodedRange ? decodeURIComponent(decodedRange) : '';
  } catch (_) {
    decodedRange = range || '';
  }
  const cleanRange = decodedRange ? decodedRange.replace(/^range=/i, '').trim() : null;
  return { spreadsheetId: spreadsheetMatch[1], gid, range: cleanRange || null, rawUrl: value };
}

function sheetRangeStartRow(range) {
  const match = String(range || '').match(/[A-Z]+(\d+)/i);
  return match ? Math.max(+match[1], 1) : 1;
}

function stripSheetNameFromRange(range) {
  const value = String(range || '');
  return value.includes('!') ? value.split('!').pop() : value;
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName || '').replace(/'/g, "''")}'`;
}

function buildSheetA1Range(sheetName, range) {
  const cleanRange = range ? String(range).trim() : 'A:L';
  if (cleanRange.includes('!')) return cleanRange;
  return `${quoteSheetName(sheetName)}!${cleanRange || 'A:L'}`;
}

function getGoogleServiceAccountCredentials() {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 содержит некорректный JSON');
  }
}

function getGoogleSheetsAuth() {
  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  const credentials = getGoogleServiceAccountCredentials();
  if (credentials) return new google.auth.GoogleAuth({ credentials, scopes });
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes });
  }
  return null;
}

async function readGoogleSheetValuesViaApi({ spreadsheetId, gid, range }) {
  const auth = getGoogleSheetsAuth();
  if (!auth) {
    return {
      rows: null,
      mode: null,
      warnings: ['Google Sheets API credentials не настроены, используется fallback CSV'],
    };
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const sheet = (metadata.data.sheets || [])
    .map((item) => item.properties)
    .find((properties) => String(properties.sheetId) === String(gid)) || metadata.data.sheets?.[0]?.properties;
  if (!sheet?.title) throw new Error('Не удалось определить лист Google Sheets по gid');

  const a1Range = buildSheetA1Range(sheet.title, range);
  const values = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: a1Range,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  return {
    rows: values.data.values || [],
    mode: 'google_api',
    warnings: [],
    effectiveRange: stripSheetNameFromRange(range || 'A:L'),
  };
}

async function fetchCsvRows(url, mode) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Не удалось скачать Google Sheet. Проверьте доступ по ссылке.');
  const csv = await response.text();
  if (/^\s*</.test(csv)) throw new Error('Google Sheet не отдал CSV. Проверьте, что файл доступен по ссылке.');
  return { rows: parseCsv(csv), mode };
}

async function getGoogleSheetsValues({ spreadsheetId, gid, range }) {
  const warnings = [];
  try {
    const apiResult = await readGoogleSheetValuesViaApi({ spreadsheetId, gid, range });
    warnings.push(...(apiResult.warnings || []));
    if (apiResult.rows) return { ...apiResult, warnings, range: apiResult.effectiveRange || range || 'A:L' };
  } catch (error) {
    warnings.push(`Google Sheets API недоступен: ${error.message}`);
  }

  const cleanRange = stripSheetNameFromRange(range || 'A:L');
  const gvizUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}${cleanRange ? `&range=${encodeURIComponent(cleanRange)}` : ''}`;
  try {
    const result = await fetchCsvRows(gvizUrl, 'gviz_csv');
    return { ...result, warnings, range: cleanRange };
  } catch (error) {
    warnings.push(`GViz CSV недоступен: ${error.message}`);
  }

  const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${encodeURIComponent(gid)}${cleanRange ? `&range=${encodeURIComponent(cleanRange)}` : ''}`;
  const result = await fetchCsvRows(exportUrl, 'export_csv');
  return { ...result, warnings, range: cleanRange };
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const text = String(csv || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => String(value || '').trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => String(value || '').trim() !== '')) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-ZА-Я0-9]/g, '');
}

function buildSheetHeaderMap(row) {
  const map = {};
  row.forEach((cell, index) => {
    const header = normalizeHeader(cell);
    if (header === 'DATE' || header === 'ДАТА') map.date = index;
    if (header === 'MARKING' || header === 'МАРКИРОВКА') map.marking = index;
    if (header === 'BREAND' || header === 'BRAND' || header === 'ТОВАР' || header === 'БРЕНД') map.brand = index;
    if (header === 'PCS' || header === 'ШТ' || header === 'КОЛВО') map.pcs = index;
    if (header === 'BOX' || header === 'BOXES' || header === 'КОРОБ') map.box = index;
    if (header === 'KG' || header === 'КГ' || header === 'WEIGHT') map.kg = index;
    if (header === 'CLASS' || header === 'КЛАСС') map.class = index;
    if (header === 'TARIFDXB' || header === 'TARIFFDXB') map.tarifDxb = index;
    if (header === 'TARIFALA' || header === 'TARIFFALA') map.tarifAla = index;
    if (header === 'CREDITDXB') map.creditDxb = index;
    if (header === 'CREDITALA') map.creditAla = index;
    if (header === 'TOTAL' || header === 'ИТОГО') map.total = index;
  });
  return map.date != null && map.marking != null && map.brand != null && map.pcs != null && map.kg != null ? map : null;
}

function defaultSheetHeaderMap() {
  return {
    date: 0,
    marking: 1,
    brand: 2,
    pcs: 3,
    box: 4,
    kg: 5,
    class: 6,
    tarifDxb: 7,
    tarifAla: 8,
    creditDxb: 9,
    creditAla: 10,
    total: 11,
  };
}

function parseSheetNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  let cleaned = raw.replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!cleaned) return 0;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '');
  } else {
    cleaned = cleaned.replace(',', '.');
  }
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}

function excelSerialDateToIso(value) {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 1) return null;
  const millis = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseSheetDate(value, fallbackYear) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return excelSerialDateToIso(value);

  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+([.,]\d+)?$/.test(raw)) return excelSerialDateToIso(raw.replace(',', '.'));
  const iso = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const local = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (local) {
    const year = local[3].length === 2 ? `20${local[3]}` : local[3];
    return `${year}-${String(local[2]).padStart(2, '0')}-${String(local[1]).padStart(2, '0')}`;
  }
  const noYear = raw.match(/^(\d{1,2})[./-](\d{1,2})$/);
  if (noYear && fallbackYear) {
    return `${fallbackYear}-${String(noYear[2]).padStart(2, '0')}-${String(noYear[1]).padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeSheetDate(value) {
  return parseSheetDate(value);
}

function isTotalOrEmptySheetRow(row) {
  const joined = row.map((cell) => String(cell || '').trim()).filter(Boolean).join(' ').toLowerCase();
  if (!joined) return true;
  return /^(итого|total|grand total)\b/.test(joined) || /\b(итого|grand total)\b/.test(joined);
}

function isRepeatedSheetHeader(row) {
  return Boolean(buildSheetHeaderMap(row));
}

function isTotalSheetDataRow(row, headerMap) {
  if (isTotalOrEmptySheetRow(row)) return true;
  const dateValue = String(row[headerMap.date] || '').trim();
  const markingValue = String(row[headerMap.marking] || '').trim();
  const productValue = String(row[headerMap.brand] || '').trim();
  const totalValue = String(row[headerMap.total] || '').trim();
  if (normalizeHeader(dateValue) === 'DATE' || normalizeHeader(markingValue) === 'MARKING') return true;
  if (/^(итого|total|grand total)$/i.test(markingValue)) return true;
  if (!productValue && totalValue && !markingValue) return true;
  return false;
}

function sheetFallbackYear(dateFrom, dateTo) {
  return String(dateFrom || dateTo || '').match(/^(\d{4})/)?.[1] || String(new Date().getFullYear());
}

async function findOrCreateProductByName(productName, client = pool) {
  const name = String(productName || '').trim();
  if (!name) throw new Error('Название товара обязательно');
  const existing = await get('SELECT id,name FROM products WHERE lower(name)=lower($1) LIMIT 1', [name], client);
  if (existing) return existing;
  const product = await get('INSERT INTO products(name,is_active) VALUES($1,TRUE) RETURNING id,name', [name], client);
  await query(`
    INSERT INTO product_rules(product_id,sale_type)
    VALUES($1,'both')
    ON CONFLICT(product_id) DO NOTHING
  `, [product.id], client);
  await logOperation(client, {
    action: 'product_created',
    entity_type: 'product',
    entity_id: product.id,
    entity_label: product.name,
    description: 'Товар создан автоматически',
    meta: { source: 'google_sheets_import', sale_type: 'both' },
  });
  return product;
}

function normalizeCounterpartyName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[{}[\]"'<>]/g, ' ')
    .replace(/^[\s.,;:|/\\\-–—№#*()]+|[\s.,;:|/\\\-–—№#*()]+$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function counterpartyKey(value) {
  return normalizeCounterpartyName(value).toLowerCase();
}

function decodeWindows1251(buffer) {
  const map = [
    '\u0402', '\u0403', '\u201A', '\u0453', '\u201E', '\u2026', '\u2020', '\u2021',
    '\u20AC', '\u2030', '\u0409', '\u2039', '\u040A', '\u040C', '\u040B', '\u040F',
    '\u0452', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014',
    '\u0098', '\u2122', '\u0459', '\u203A', '\u045A', '\u045C', '\u045B', '\u045F',
    '\u00A0', '\u040E', '\u045E', '\u0408', '\u00A4', '\u0490', '\u00A6', '\u00A7',
    '\u0401', '\u00A9', '\u0404', '\u00AB', '\u00AC', '\u00AD', '\u00AE', '\u0407',
    '\u00B0', '\u00B1', '\u0406', '\u0456', '\u0491', '\u00B5', '\u00B6', '\u00B7',
    '\u0451', '\u2116', '\u0454', '\u00BB', '\u0458', '\u0405', '\u0455', '\u0457',
  ];

  let text = '';
  for (const byte of buffer) {
    if (byte < 0x80) text += String.fromCharCode(byte);
    else if (byte >= 0xC0) text += String.fromCharCode(0x0410 + byte - 0xC0);
    else text += map[byte - 0x80] || ' ';
  }
  return text;
}

function extractMultipartFileBuffer(req) {
  const contentType = req.get('content-type') || '';
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  if (!contentType.includes('multipart/form-data')) {
    return {
      buffer: body,
      originalName: '',
      mimeType: contentType,
    };
  }

  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('Не удалось прочитать multipart boundary');
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let start = body.indexOf(boundary);

  while (start !== -1) {
    start += boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    if (body.slice(start, start + 2).toString() === '\r\n') start += 2;

    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    let part = body.slice(start, next);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
    parts.push(part);
    start = next;
  }

  for (const part of parts) {
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator === -1) continue;
    const headers = part.slice(0, separator).toString('utf8');
    if (!/name="file"/i.test(headers) && !/filename=/i.test(headers)) continue;
    const filenameMatch = headers.match(/filename="([^"]*)"/i);
    const contentTypeMatch = headers.match(/content-type:\s*([^\r\n]+)/i);
    return {
      buffer: part.slice(separator + 4),
      originalName: filenameMatch?.[1] || '',
      mimeType: contentTypeMatch?.[1]?.trim() || '',
    };
  }

  throw new Error('Файл не найден в запросе');
}

function isTechnicalCounterpartyValue(value) {
  const name = normalizeCounterpartyName(value);
  const key = name.toLowerCase();
  const upper = name.toUpperCase();
  const technical = new Set([
    '#',
    'N',
    '№',
    'DATE',
    'MARKING',
    'BREAND',
    'BRAND',
    'PCS',
    'BOX',
    'KG',
    'CLASS',
    'TARIF DXB',
    'TARIF ALA',
    'CREDIT DXB',
    'CREDIT ALA',
    'TOTAL',
    'DEFAULT LANGUAGE',
    'MOXCEL',
    'SHEET',
    'PAGE',
    'ИТОГО',
    'ВСЕГО',
    'TOTAL',
    'GRAND TOTAL',
    'ЛИСТ',
    'СТРАНИЦА',
    'КОНТРАГЕНТЫ',
    'КОНТРАГЕНТ',
    'НАИМЕНОВАНИЕ',
    'НАЗВАНИЕ',
  ]);

  if (!name || name.length < 2) return true;
  if (technical.has(upper)) return true;
  if (/^\d+([.,]\d+)?$/.test(key)) return true;
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(key)) return true;
  if (!/[a-zа-яё]/i.test(name)) return true;
  if (/^moxel/i.test(key)) return true;
  return false;
}

function extractCounterpartyNamesFromMxl(buffer) {
  const variants = [
    buffer.toString('utf8'),
    buffer.toString('utf16le'),
    decodeWindows1251(buffer),
  ];
  const names = new Map();

  for (const text of variants) {
    const quoted = text.matchAll(/"([^"\r\n]{2,160})"/g);
    for (const match of quoted) {
      const name = normalizeCounterpartyName(match[1]);
      if (!isTechnicalCounterpartyValue(name)) names.set(counterpartyKey(name), name);
    }

    text
      .split(/\r?\n/)
      .map(normalizeCounterpartyName)
      .filter((line) => line.length >= 2 && line.length <= 160)
      .forEach((line) => {
        if (!isTechnicalCounterpartyValue(line)) names.set(counterpartyKey(line), line);
      });
  }

  return Array.from(names.values()).sort((a, b) => a.localeCompare(b, 'ru'));
}

function decodeTextBuffer(buffer) {
  const utf16 = buffer.toString('utf16le');
  if ((utf16.match(/[а-яёa-z]/gi) || []).length > 3 && !utf16.includes('\uFFFD')) return utf16;

  const utf8 = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (!utf8.includes('\uFFFD')) return utf8;

  return decodeWindows1251(buffer);
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function detectDelimiter(lines) {
  const delimiters = [';', ',', '\t'];
  let best = ';';
  let bestScore = -1;

  for (const delimiter of delimiters) {
    const score = lines.slice(0, 10).reduce((sum, line) => sum + splitDelimitedLine(line, delimiter).length, 0);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }

  return best;
}

function addCounterpartyName(names, value) {
  const name = normalizeCounterpartyName(value);
  if (!isTechnicalCounterpartyValue(name)) names.set(counterpartyKey(name), name);
}

function findCounterpartyColumnIndex(headerRow) {
  const candidates = new Set([
    'название',
    'контрагент',
    'контрагенты',
    'наименование',
    'name',
    'client',
    'supplier',
  ]);
  return headerRow.findIndex((cell) => candidates.has(counterpartyKey(cell)));
}

function extractCounterpartyNamesFromRows(rows) {
  const normalizedRows = rows
    .map((row) => row.map((cell) => normalizeCounterpartyName(cell)))
    .filter((row) => row.some(Boolean));
  const names = new Map();
  let headerIndex = -1;
  let headerRowIndex = -1;

  normalizedRows.some((row, index) => {
    const found = findCounterpartyColumnIndex(row);
    if (found !== -1) {
      headerIndex = found;
      headerRowIndex = index;
      return true;
    }
    return false;
  });

  if (headerIndex !== -1) {
    normalizedRows.slice(headerRowIndex + 1).forEach((row) => addCounterpartyName(names, row[headerIndex]));
  } else {
    normalizedRows.forEach((row) => {
      row.slice(0, 3).some((cell) => {
        const before = names.size;
        addCounterpartyName(names, cell);
        return names.size > before;
      });
    });
  }

  return Array.from(names.values()).sort((a, b) => a.localeCompare(b, 'ru'));
}

function extractCounterpartyNamesFromExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  return extractCounterpartyNamesFromRows(rows);
}

function extractCounterpartyNamesFromCsv(buffer) {
  const text = decodeTextBuffer(buffer);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const delimiter = detectDelimiter(lines);
  const rows = lines.map((line) => splitDelimitedLine(line, delimiter));
  return extractCounterpartyNamesFromRows(rows);
}

function extractCounterpartyNamesFromTxt(buffer) {
  const text = decodeTextBuffer(buffer);
  const rows = text
    .split(/\r?\n/)
    .flatMap((line) => line.includes(';') || line.includes(',') ? line.split(/[;,]/) : [line])
    .map((value) => [value]);
  return extractCounterpartyNamesFromRows(rows);
}

function getCounterpartyImportFileType({ originalName = '', mimeType = '' }) {
  const ext = path.extname(originalName).toLowerCase();
  const mime = String(mimeType || '').toLowerCase();

  if (ext === '.mxl') return 'mxl';
  if (ext === '.xlsx' || mime.includes('spreadsheetml')) return 'xlsx';
  if (ext === '.xls' || mime.includes('ms-excel')) return 'xls';
  if (ext === '.csv' || mime.includes('csv')) return 'csv';
  if (ext === '.txt' || mime.startsWith('text/plain')) return 'txt';
  return '';
}

function extractCounterpartyNamesFromFile(file) {
  const type = getCounterpartyImportFileType(file);
  if (!type) throw new Error('Поддерживаются файлы MXL, Excel, CSV и TXT');

  if (type === 'mxl') return extractCounterpartyNamesFromMxl(file.buffer);
  if (type === 'xlsx' || type === 'xls') return extractCounterpartyNamesFromExcel(file.buffer);
  if (type === 'csv') return extractCounterpartyNamesFromCsv(file.buffer);
  if (type === 'txt') return extractCounterpartyNamesFromTxt(file.buffer);

  throw new Error('Поддерживаются файлы MXL, Excel, CSV и TXT');
}

async function cleanupOrphanImportRecords(client = pool) {
  return all(`
    DELETE FROM import_records ir
    WHERE ir.receipt_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM receipts r WHERE r.id = ir.receipt_id
       )
    RETURNING spreadsheet_id,gid,source_row
  `, [], client);
}

async function buildCounterpartyPreview(names, client = pool) {
  const [clientsRows, suppliersRows] = await Promise.all([
    all('SELECT id,name FROM clients', [], client),
    all('SELECT id,name FROM suppliers', [], client),
  ]);
  const clientsByKey = new Map(clientsRows.map((row) => [counterpartyKey(row.name), row]));
  const suppliersByKey = new Map(suppliersRows.map((row) => [counterpartyKey(row.name), row]));

  const items = names.map((name) => {
    const key = counterpartyKey(name);
    const existsAsClient = clientsByKey.has(key);
    const existsAsSupplier = suppliersByKey.has(key);
    let status = 'new';
    let suggestedType = 'client';

    if (existsAsClient) {
      status = 'already_exists_client';
      suggestedType = 'client';
    } else if (existsAsSupplier) {
      status = 'already_exists_supplier';
      suggestedType = 'supplier';
    }

    return {
      name,
      exists_as_client: existsAsClient,
      exists_as_supplier: existsAsSupplier,
      suggested_type: suggestedType,
      status,
    };
  });

  return {
    ok: true,
    items,
    summary: {
      total: items.length,
      new: items.filter((item) => item.status === 'new').length,
      duplicates: items.filter((item) => item.status !== 'new').length,
    },
  };
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

async function payReceiptDocument(receiptId, { amount, accountFromId, date, comment, debtPaymentGroupId = null, skipOperationLog = false }, client = pool) {
  const paymentAmount = ledgerNumber(amount);
  const receipt = await get(`
    SELECT r.*, COALESCE(SUM(p.total_cost::numeric),0) AS total_cost, MIN(p.id) AS anchor_purchase_id
    FROM receipts r
    LEFT JOIN purchases p ON p.receipt_id = r.id
    WHERE r.id=$1
    GROUP BY r.id
  `, [receiptId], client);
  if (!receipt) throw new Error('Приход не найден');
  if (!receipt.anchor_purchase_id) throw new Error('В документе нет товаров для оплаты');

  const totalAmount = +(receipt.total_cost || 0);
  const paid = await getReceiptPaidAmount(receiptId, client);
  const remaining = ledgerNumber(totalAmount - paid);
  if (paymentAmount > remaining + 0.009) throw new Error('Сумма оплаты превышает остаток долга');

  const payment = await get('INSERT INTO payments(entity_type,entity_id,amount,date,comment,debt_payment_group_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', ['purchase', +receipt.anchor_purchase_id, paymentAmount, date, comment, debtPaymentGroupId], client);
  const transaction = await get(`
    INSERT INTO transactions(type,amount,account_from_id,receipt_id,date,comment,related_type,related_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, ['expense', paymentAmount, accountFromId, receiptId, date, comment, 'payment', payment.id], client);
  await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);
  await rebalanceReceiptPurchasePaidAmounts(receiptId, client);
  if (!skipOperationLog) {
    await logOperation(client, {
      action: 'supplier_payment',
      entity_type: 'receipt',
      entity_id: receiptId,
      entity_label: `Приход №${receiptId}`,
      amount: paymentAmount,
      currency: 'USD',
      description: 'Оплата поставщику',
      meta: { payment_id: payment.id, transaction_id: transaction.id, account_from_id: accountFromId, comment },
    });
  }

  const newPaid = await getReceiptPaidAmount(receiptId, client);
  return {
    receipt_id: receiptId,
    paid_amount: newPaid,
    payable: ledgerNumber(totalAmount - newPaid),
    payment_id: payment.id,
    transaction_id: transaction.id,
  };
}

async function getSalesDocumentPaidAmount(salesDocumentId, client = pool) {
  const row = await get(`
    WITH ${activePaymentAllocationsCte()}
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM payment_allocations_effective
    WHERE document_type='sales_document' AND document_id=$1
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

async function createLegacySalesForDocument({ date, clientId, markingId, items, salesDocumentId, allowZeroItems = false }, client = pool) {
  const saleIds = [];
  for (const item of items) {
    if (!item.product_id) throw new Error('Выберите товар в каждой строке');
    if (!item.sale_unit) throw new Error('Укажите единицу продажи в каждой строке');
    const quantity = item.quantity == null || item.quantity === '' ? 0 : +item.quantity;
    const pricePerUnit = item.price_per_unit == null || item.price_per_unit === '' ? 0 : +item.price_per_unit;
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Количество не может быть отрицательным');
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) throw new Error('Цена не может быть отрицательной');
    if (!allowZeroItems || quantity > 0) {
      if (!(quantity > 0)) throw new Error('Количество в каждой строке должно быть больше 0');
      if (!(pricePerUnit > 0)) throw new Error('Цена в каждой строке должна быть больше 0');
      await validateSale(item.product_id, item.sale_unit, quantity, pricePerUnit, client);
    }
    const totalAmount = Math.round(quantity * pricePerUnit * 100) / 100;
    const sale = await get(`
      INSERT INTO sales(date,client_id,marking_id,sales_document_id,product_id,sale_unit,quantity,price_per_unit,total_amount,paid_amount,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id
    `, [date, clientId, markingId, salesDocumentId, +item.product_id, item.sale_unit, quantity, pricePerUnit, totalAmount, 0, item.note || item.notes || null], client);
    saleIds.push(sale.id);
  }
  return saleIds;
}

async function paySalesDocumentByAnchorSale(anchorSaleId, { amount, accountToId, date, comment, debtPaymentGroupId = null, skipOperationLog = false }, client = pool) {
  const anchorSale = await get('SELECT * FROM sales WHERE id=$1', [anchorSaleId], client);
  if (!anchorSale) throw new Error('Продажа не найдена');
  if (!anchorSale.sales_document_id) throw new Error('Продажа не привязана к документу');

  const totalRow = await get('SELECT COALESCE(SUM(total_amount::numeric),0) AS total FROM sales WHERE sales_document_id=$1', [+anchorSale.sales_document_id], client);
  const totalAmount = +(totalRow?.total || 0);
  const paid = await getSalesDocumentPaidAmount(+anchorSale.sales_document_id, client);
  const remaining = totalAmount - paid;
  if (amount > remaining + 0.009) throw new Error('Сумма оплаты превышает остаток долга');

  const payment = await get('INSERT INTO payments(entity_type,entity_id,amount,date,comment,debt_payment_group_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', ['sale', anchorSaleId, amount, date, comment, debtPaymentGroupId], client);
  const transaction = await get(`
    INSERT INTO transactions(type,amount,account_to_id,sale_id,date,comment,related_type,related_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, ['income', amount, accountToId, anchorSaleId, date, comment, 'payment', payment.id], client);
  await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);
  await rebalanceSalesDocumentPaidAmounts(+anchorSale.sales_document_id, client);
  if (!skipOperationLog) {
    await logOperation(client, {
      action: 'client_payment',
      entity_type: 'sales_document',
      entity_id: +anchorSale.sales_document_id,
      entity_label: `Реализация №${anchorSale.sales_document_id}`,
      amount,
      currency: 'USD',
      description: 'Оплата клиента',
      meta: { anchor_sale_id: anchorSaleId, payment_id: payment.id, transaction_id: transaction.id, account_to_id: accountToId, comment },
    });
  }

  const newPaid = await getSalesDocumentPaidAmount(+anchorSale.sales_document_id, client);
  return {
    sales_document_id: +anchorSale.sales_document_id,
    paid_amount: newPaid,
    debt: totalAmount - newPaid,
  };
}

async function payLegacySaleDocument(saleId, { amount, accountToId, date, comment, debtPaymentGroupId = null, skipOperationLog = false }, client = pool) {
  const paymentAmount = ledgerNumber(amount);
  const sale = await get('SELECT * FROM sales WHERE id=$1', [saleId], client);
  if (!sale) throw new Error('Продажа не найдена');
  if (sale.sales_document_id) return paySalesDocumentByAnchorSale(saleId, { amount: paymentAmount, accountToId, date, comment, debtPaymentGroupId, skipOperationLog }, client);

  const totalAmount = +(sale.total_amount || 0);
  const paidAmount = +(sale.paid_amount || 0);
  const remaining = ledgerNumber(totalAmount - paidAmount);
  if (paymentAmount > remaining + 0.009) throw new Error('Сумма оплаты превышает остаток долга');

  const payment = await get('INSERT INTO payments(entity_type,entity_id,amount,date,comment,debt_payment_group_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', ['sale', saleId, paymentAmount, date, comment, debtPaymentGroupId], client);
  const transaction = await get(`
    INSERT INTO transactions(type,amount,account_to_id,sale_id,date,comment,related_type,related_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, ['income', paymentAmount, accountToId, saleId, date, comment, 'payment', payment.id], client);
  await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);
  await query('UPDATE sales SET paid_amount = COALESCE(paid_amount,0) + $1 WHERE id=$2', [paymentAmount, saleId], client);
  if (!skipOperationLog) {
    await logOperation(client, {
      action: 'client_payment',
      entity_type: 'sale',
      entity_id: saleId,
      entity_label: `Реализация №${saleId}`,
      amount: paymentAmount,
      currency: 'USD',
      description: 'Оплата клиента',
      meta: { payment_id: payment.id, transaction_id: transaction.id, account_to_id: accountToId, comment },
    });
  }

  const updated = await get('SELECT paid_amount,total_amount FROM sales WHERE id=$1', [saleId], client);
  return {
    sale_id: saleId,
    paid_amount: +(updated?.paid_amount || 0),
    debt: ledgerNumber(+(updated?.total_amount || 0) - +(updated?.paid_amount || 0)),
    payment_id: payment.id,
    transaction_id: transaction.id,
  };
}

async function paySalesDocumentAllowClientAdvance(anchorSaleId, { amount, accountToId, date, comment, debtPaymentGroupId = null, skipOperationLog = false }, client = pool) {
  const paymentAmount = ledgerNumber(amount);
  const anchorSale = await get(`
    SELECT s.*, COALESCE(sd.client_id, s.client_id) AS effective_client_id
    FROM sales s
    LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
    WHERE s.id=$1
  `, [anchorSaleId], client);
  if (!anchorSale) throw new Error('Продажа не найдена');
  if (!anchorSale.sales_document_id) throw new Error('Продажа не привязана к документу');
  const totalRow = await get('SELECT COALESCE(SUM(total_amount::numeric),0) AS total FROM sales WHERE sales_document_id=$1', [+anchorSale.sales_document_id], client);
  const totalAmount = +(totalRow?.total || 0);
  const paid = await getSalesDocumentPaidAmount(+anchorSale.sales_document_id, client);
  const remaining = ledgerNumber(totalAmount - paid);
  if (paymentAmount <= remaining + 0.009) {
    return paySalesDocumentByAnchorSale(anchorSaleId, { amount: paymentAmount, accountToId, date, comment, debtPaymentGroupId, skipOperationLog }, client);
  }

  let applied = null;
  if (remaining > 0.009) {
    applied = await paySalesDocumentByAnchorSale(anchorSaleId, { amount: remaining, accountToId, date, comment, debtPaymentGroupId, skipOperationLog }, client);
  }
  const advance = await createClientAdvancePayment(+anchorSale.effective_client_id, {
    amount: ledgerNumber(paymentAmount - Math.max(0, remaining)),
    accountToId,
    date,
    comment,
    debtBefore: remaining,
    paymentAmount,
    debtPaymentGroupId,
    skipOperationLog,
  }, client);
  const newPaid = await getSalesDocumentPaidAmount(+anchorSale.sales_document_id, client);

  return {
    sales_document_id: +anchorSale.sales_document_id,
    paid_amount: newPaid,
    debt: await getClientLedgerBalance(+anchorSale.effective_client_id, client),
    advance_amount: advance?.advance_after || 0,
    allocations: [applied, advance].filter(Boolean),
  };
}

async function payLegacySaleAllowClientAdvance(saleId, { amount, accountToId, date, comment, debtPaymentGroupId = null, skipOperationLog = false }, client = pool) {
  const paymentAmount = ledgerNumber(amount);
  const sale = await get('SELECT * FROM sales WHERE id=$1', [saleId], client);
  if (!sale) throw new Error('Продажа не найдена');
  if (sale.sales_document_id) return paySalesDocumentAllowClientAdvance(saleId, { amount: paymentAmount, accountToId, date, comment, debtPaymentGroupId, skipOperationLog }, client);

  const totalAmount = +(sale.total_amount || 0);
  const paidAmount = +(sale.paid_amount || 0);
  const remaining = ledgerNumber(totalAmount - paidAmount);
  if (paymentAmount <= remaining + 0.009) {
    return payLegacySaleDocument(saleId, { amount: paymentAmount, accountToId, date, comment, debtPaymentGroupId, skipOperationLog }, client);
  }

  let applied = null;
  if (remaining > 0.009) {
    applied = await payLegacySaleDocument(saleId, { amount: remaining, accountToId, date, comment, debtPaymentGroupId, skipOperationLog }, client);
  }
  const advance = await createClientAdvancePayment(+sale.client_id, {
    amount: ledgerNumber(paymentAmount - Math.max(0, remaining)),
    accountToId,
    date,
    comment,
    debtBefore: remaining,
    paymentAmount,
    debtPaymentGroupId,
    skipOperationLog,
  }, client);

  const updated = await get('SELECT paid_amount,total_amount FROM sales WHERE id=$1', [saleId], client);
  return {
    sale_id: saleId,
    paid_amount: +(updated?.paid_amount || 0),
    debt: await getClientLedgerBalance(+sale.client_id, client),
    advance_amount: advance?.advance_after || 0,
    allocations: [applied, advance].filter(Boolean),
  };
}

async function createClientAdvancePayment(clientId, { amount, accountToId, date, comment, debtBefore = null, paymentAmount = null, debtPaymentGroupId = null, skipOperationLog = false }, client = pool) {
  const advanceAmount = ledgerNumber(amount);
  if (!(advanceAmount > 0)) return null;
  const customer = await get('SELECT id,name FROM clients WHERE id=$1', [clientId], client);
  if (!customer) throw new Error('Клиент не найден');

  const payment = await get(`
    INSERT INTO payments(entity_type,entity_id,amount,date,comment,debt_payment_group_id)
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING id
  `, ['client_advance', clientId, advanceAmount, date, comment, debtPaymentGroupId], client);
  const transaction = await get(`
    INSERT INTO transactions(type,amount,account_to_id,date,comment,related_type,related_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    RETURNING id
  `, ['income', advanceAmount, accountToId, date, comment, 'client_advance', payment.id], client);
  await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);

  const balanceAfter = await getClientLedgerBalance(clientId, client);
  const advanceAfter = balanceAfter < -0.009 ? ledgerNumber(Math.abs(balanceAfter)) : 0;
  const overpaymentAmount = debtBefore == null
    ? advanceAmount
    : ledgerNumber(Math.max(0, +(paymentAmount || advanceAmount) - Math.max(0, +debtBefore || 0)));

  if (!skipOperationLog) {
    await logOperation(client, {
      action: 'client_payment',
      entity_type: 'client',
      entity_id: clientId,
      entity_label: customer.name || `Клиент №${clientId}`,
      amount: advanceAmount,
      currency: 'USD',
      description: 'Аванс клиента',
      meta: {
        payment_id: payment.id,
        transaction_id: transaction.id,
        account_to_id: accountToId,
        comment,
        debt_before: debtBefore,
        payment_amount: paymentAmount == null ? advanceAmount : paymentAmount,
        overpayment_amount: overpaymentAmount,
        advance_after: advanceAfter,
      },
    });
  }

  return {
    payment_id: payment.id,
    transaction_id: transaction.id,
    amount: advanceAmount,
    balance_after: balanceAfter,
    advance_after: advanceAfter,
  };
}

async function getPaymentTransaction(payment, client = pool) {
  if (payment.transaction_id) {
    const byId = await get('SELECT * FROM transactions WHERE id=$1', [+payment.transaction_id], client);
    if (byId) return byId;
  }
  const relatedTypes = payment.entity_type === 'client_advance' ? ['client_advance', 'payment'] : ['payment'];
  return get(`
    SELECT *
    FROM transactions
    WHERE related_id=$1 AND related_type = ANY($2::text[])
    ORDER BY id DESC
    LIMIT 1
  `, [+payment.id, relatedTypes], client);
}

async function validatePaymentCashEdit({ direction, oldAccountId, oldAmount, newAccountId, newAmount }, client = pool) {
  const deltas = new Map();
  const addDelta = (accountId, delta) => {
    if (!accountId) return;
    const key = String(accountId);
    deltas.set(key, (deltas.get(key) || 0) + delta);
  };

  if (direction === 'in') {
    addDelta(oldAccountId, -oldAmount);
    addDelta(newAccountId, newAmount);
  } else {
    addDelta(oldAccountId, oldAmount);
    addDelta(newAccountId, -newAmount);
  }

  for (const [accountId, delta] of deltas.entries()) {
    const currentBalance = await getAccountBalance(+accountId, client);
    if (currentBalance + delta < -0.009) {
      throw new Error('Недостаточно средств в кассе');
    }
  }
}

async function getReceiptPaidAmountExcluding(receiptId, paymentId, client = pool) {
  const row = await get(`
    WITH ${activePaymentAllocationsCte()}
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM payment_allocations_effective
    WHERE document_type='receipt'
      AND document_id=$1
      AND payment_id<>$2
  `, [receiptId, paymentId], client);
  return +(row?.total || 0);
}

async function rebalancePaymentDocument(payment, client = pool) {
  if (payment.entity_type === 'client' || payment.entity_type === 'supplier') {
    const allocations = await getPaymentAllocations(+payment.id, client);
    for (const allocation of allocations) {
      await rebalanceAllocationDocument(allocation.document_type, allocation.document_id, client);
    }
    return;
  }

  if (payment.entity_type === 'purchase') {
    const purchase = await get('SELECT id,receipt_id FROM purchases WHERE id=$1', [+payment.entity_id], client);
    if (purchase?.receipt_id) {
      await rebalanceReceiptPurchasePaidAmounts(+purchase.receipt_id, client);
    } else if (purchase) {
      const paid = +(await get(`
        SELECT COALESCE(SUM(amount::numeric),0) AS total
        FROM payments
        WHERE entity_type='purchase' AND entity_id=$1 AND cancelled_at IS NULL
      `, [+purchase.id], client))?.total || 0;
      await query('UPDATE purchases SET paid_amount=$1 WHERE id=$2', [paid, +purchase.id], client);
    }
    return;
  }

  if (payment.entity_type === 'sale') {
    const sale = await get('SELECT id,sales_document_id,total_amount FROM sales WHERE id=$1', [+payment.entity_id], client);
    if (sale?.sales_document_id) {
      await rebalanceSalesDocumentPaidAmounts(+sale.sales_document_id, client);
    } else if (sale) {
      const paid = +(await get(`
        SELECT COALESCE(SUM(amount::numeric),0) AS total
        FROM payments
        WHERE entity_type='sale' AND entity_id=$1 AND cancelled_at IS NULL
      `, [+sale.id], client))?.total || 0;
      await query('UPDATE sales SET paid_amount=$1 WHERE id=$2', [Math.min(+(sale.total_amount || 0), paid), +sale.id], client);
    }
  }
}

async function rebalanceAllocationDocument(documentType, documentId, client = pool) {
  if (!documentType || documentId == null) return;
  if (documentType === 'receipt') {
    await rebalanceReceiptPurchasePaidAmounts(+documentId, client);
    return;
  }
  if (documentType === 'sales_document') {
    await rebalanceSalesDocumentPaidAmounts(+documentId, client);
    return;
  }
  if (documentType === 'sale') {
    const sale = await get('SELECT id,total_amount FROM sales WHERE id=$1', [+documentId], client);
    if (!sale) return;
    const paid = +(await get(`
      WITH ${activePaymentAllocationsCte()}
      SELECT COALESCE(SUM(amount::numeric),0) AS total
      FROM payment_allocations_effective
      WHERE document_type='sale' AND document_id=$1
    `, [+documentId], client))?.total || 0;
    await query('UPDATE sales SET paid_amount=$1 WHERE id=$2', [Math.min(+(sale.total_amount || 0), paid), +documentId], client);
    return;
  }
  if (documentType === 'purchase') {
    const paid = +(await get(`
      WITH ${activePaymentAllocationsCte()}
      SELECT COALESCE(SUM(amount::numeric),0) AS total
      FROM payment_allocations_effective
      WHERE document_type='purchase' AND document_id=$1
    `, [+documentId], client))?.total || 0;
    await query('UPDATE purchases SET paid_amount=$1 WHERE id=$2', [paid, +documentId], client);
  }
}

async function getSupplierOpenDebtDocuments(supplierId, client = pool, excludePaymentId = null) {
  const rows = await all(`
    WITH ${activePaymentAllocationsCte()},
    receipt_totals AS (
      SELECT
        r.id AS receipt_id,
        r.date,
        r.created_at,
        COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      WHERE r.supplier_id=$1
      GROUP BY r.id, r.date, r.created_at
    ),
    receipt_payments AS (
      SELECT document_id AS receipt_id, COALESCE(SUM(amount::numeric),0) AS paid
      FROM payment_allocations_effective
      WHERE document_type='receipt'
        AND ($2::integer IS NULL OR payment_id<>$2::integer)
      GROUP BY document_id
    )
    SELECT
      rt.receipt_id AS document_id,
      'receipt'::text AS document_type,
      rt.date,
      rt.created_at,
      rt.total::numeric AS total,
      COALESCE(rp.paid::numeric,0) AS paid,
      rt.total::numeric - COALESCE(rp.paid::numeric,0) AS remaining
    FROM receipt_totals rt
    LEFT JOIN receipt_payments rp ON rp.receipt_id = rt.receipt_id
    WHERE rt.total::numeric - COALESCE(rp.paid::numeric,0) > 0
    ORDER BY rt.date ASC NULLS LAST, rt.created_at ASC NULLS LAST, rt.receipt_id ASC
  `, [supplierId, excludePaymentId], client);

  return rows.map((row) => ({
    ...row,
    document_id: +row.document_id,
    total: +(row.total || 0),
    paid: +(row.paid || 0),
    remaining: +(row.remaining || 0),
  }));
}

async function getClientOpenDebtDocuments(clientId, client = pool, excludePaymentId = null) {
  const rows = await all(`
    WITH ${activePaymentAllocationsCte()},
    receivable_totals AS (
      SELECT
        COALESCE(sd.id, -s.id) AS receivable_group_id,
        sd.id AS sales_document_id,
        MIN(s.id) AS anchor_sale_id,
        COALESCE(sd.date, s.date) AS date,
        COALESCE(sd.created_at, s.created_at) AS created_at,
        COALESCE(SUM(s.total_amount::numeric),0) AS total
      FROM sales s
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      WHERE COALESCE(sd.client_id, s.client_id)=$1
      GROUP BY COALESCE(sd.id, -s.id), sd.id, COALESCE(sd.date, s.date), COALESCE(sd.created_at, s.created_at)
    ),
    receivable_payments AS (
      SELECT
        CASE WHEN pae.document_type='sales_document' THEN pae.document_id ELSE -pae.document_id END AS receivable_group_id,
        COALESCE(SUM(pae.amount::numeric),0) AS paid
      FROM payment_allocations_effective pae
      LEFT JOIN sales s ON pae.document_type='sale' AND s.id=pae.document_id
      LEFT JOIN sales_documents sd ON pae.document_type='sales_document' AND sd.id=pae.document_id
      WHERE pae.document_type IN ('sale','sales_document')
        AND COALESCE(sd.client_id, s.client_id)=$1
        AND ($2::integer IS NULL OR pae.payment_id<>$2::integer)
      GROUP BY CASE WHEN pae.document_type='sales_document' THEN pae.document_id ELSE -pae.document_id END
    )
    SELECT
      CASE WHEN rt.sales_document_id IS NULL THEN 'sale' ELSE 'sales_document' END AS document_type,
      CASE WHEN rt.sales_document_id IS NULL THEN rt.anchor_sale_id ELSE rt.sales_document_id END AS document_id,
      rt.anchor_sale_id,
      rt.date,
      rt.created_at,
      rt.total::numeric AS total,
      COALESCE(rp.paid::numeric,0) AS paid,
      rt.total::numeric - COALESCE(rp.paid::numeric,0) AS remaining
    FROM receivable_totals rt
    LEFT JOIN receivable_payments rp ON rp.receivable_group_id = rt.receivable_group_id
    WHERE rt.total::numeric - COALESCE(rp.paid::numeric,0) > 0
    ORDER BY rt.date ASC NULLS LAST, rt.created_at ASC NULLS LAST, document_id ASC
  `, [clientId, excludePaymentId], client);

  return rows.map((row) => ({
    ...row,
    document_id: +row.document_id,
    anchor_sale_id: +row.anchor_sale_id,
    total: ledgerNumber(row.total),
    paid: ledgerNumber(row.paid),
    remaining: ledgerNumber(row.remaining),
  })).filter((row) => row.remaining > 0.009);
}

async function validateSale(productId, saleUnit, quantity, pricePerUnit, client = pool) {
  if (+quantity <= 0) throw new Error('Количество должно быть больше 0');
  if (+pricePerUnit <= 0) throw new Error('Цена за единицу должна быть больше 0');
  const rule = await get('SELECT * FROM product_rules WHERE product_id=$1', [+productId], client);
  if (!rule) throw new Error('Правило продажи для товара не задано. Настройте правило в разделе Товары.');
  if (rule.sale_type === 'pcs' && saleUnit === 'kg') throw new Error('Для этого товара разрешена продажа только по штукам (pcs)');
  if (rule.sale_type === 'kg' && saleUnit === 'pcs') throw new Error('Для этого товара разрешена продажа только по килограммам (kg)');
}

async function getClientPaymentTotal(clientId, client = pool, excludePaymentId = null) {
  const row = await get(`
    WITH ${activePaymentAllocationsCte()}
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM (
      SELECT payment_id AS id, amount::numeric AS amount
      FROM payment_allocations_effective pae
      LEFT JOIN sales s ON pae.document_type='sale' AND s.id=pae.document_id
      LEFT JOIN sales_documents sd ON pae.document_type='sales_document' AND sd.id=pae.document_id
      WHERE COALESCE(sd.client_id, s.client_id)=$1
        AND ($2::integer IS NULL OR payment_id<>$2::integer)
      UNION ALL
      SELECT payment_id AS id, amount::numeric AS amount
      FROM payment_allocations_effective
      WHERE document_type='client_advance'
        AND document_id=$1
        AND ($2::integer IS NULL OR payment_id<>$2::integer)
    ) x
  `, [clientId, excludePaymentId], client);
  return +(row?.total || 0);
}

async function getClientLedgerBalance(clientId, client = pool) {
  const charged = +(await get(`
    SELECT COALESCE(SUM(s.total_amount::numeric),0) AS total
    FROM sales s
    LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
    WHERE COALESCE(sd.client_id, s.client_id)=$1
  `, [clientId], client))?.total || 0;
  const paid = await getClientPaymentTotal(clientId, client);
  return ledgerNumber(charged - paid);
}

async function debtSummaryData(client = pool) {
  const clientBalances = await get(`
    WITH ${activePaymentAllocationsCte()},
    charge_by_client AS (
      SELECT
        COALESCE(sd.client_id, s.client_id)::integer AS client_id,
        COALESCE(SUM(s.total_amount::numeric),0) AS charged
      FROM sales s
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      WHERE COALESCE(sd.client_id, s.client_id) IS NOT NULL
      GROUP BY COALESCE(sd.client_id, s.client_id)
    ),
    payment_by_client AS (
      SELECT client_id, COALESCE(SUM(amount::numeric),0) AS paid
      FROM (
        SELECT
          pae.payment_id AS id,
          COALESCE(sd.client_id, s.client_id)::integer AS client_id,
          pae.amount::numeric AS amount
        FROM payment_allocations_effective pae
        LEFT JOIN sales s ON pae.document_type='sale' AND s.id=pae.document_id
        LEFT JOIN sales_documents sd ON pae.document_type='sales_document' AND sd.id=pae.document_id
        WHERE pae.document_type IN ('sale','sales_document')
          AND COALESCE(sd.client_id, s.client_id) IS NOT NULL
        UNION ALL
        SELECT
          pae.payment_id AS id,
          pae.document_id::integer AS client_id,
          pae.amount::numeric AS amount
        FROM payment_allocations_effective pae
        WHERE pae.document_type='client_advance'
      ) x
      GROUP BY client_id
    ),
    client_ids AS (
      SELECT client_id FROM charge_by_client
      UNION
      SELECT client_id FROM payment_by_client
    ),
    balances AS (
      SELECT
        ids.client_id,
        COALESCE(c.charged,0) - COALESCE(p.paid,0) AS balance
      FROM client_ids ids
      LEFT JOIN charge_by_client c ON c.client_id = ids.client_id
      LEFT JOIN payment_by_client p ON p.client_id = ids.client_id
    )
    SELECT
      COUNT(*) FILTER (WHERE balance > 0.009)::int AS receivable_count,
      COALESCE(SUM(balance) FILTER (WHERE balance > 0.009),0) AS receivable_total,
      COUNT(*) FILTER (WHERE balance < -0.009)::int AS advance_count,
      COALESCE(SUM(-balance) FILTER (WHERE balance < -0.009),0) AS advance_total
    FROM balances
  `, [], client);

  const payable = await get(`
    WITH ${activePaymentAllocationsCte()},
    receipt_totals AS (
      SELECT r.id, COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      GROUP BY r.id
    ),
    receipt_payments AS (
      SELECT document_id AS receipt_id, COALESCE(SUM(amount::numeric),0) AS paid
      FROM payment_allocations_effective
      WHERE document_type='receipt'
      GROUP BY document_id
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
  const supplierPayableTotal = +(payable?.total || 0);
  const clientAdvancesTotal = +(clientBalances?.advance_total || 0);
  const payableTotal = supplierPayableTotal + clientAdvancesTotal;
  const receivableTotal = +(clientBalances?.receivable_total || 0);

  return {
    receivable: { count: +(clientBalances?.receivable_count || 0), total: receivableTotal },
    payable: { count: +(payable?.count || 0) + +(clientBalances?.advance_count || 0), total: payableTotal },
    supplier_payable: { count: +(payable?.count || 0), total: supplierPayableTotal },
    client_advances: { count: +(clientBalances?.advance_count || 0), total: clientAdvancesTotal },
    total_withdrawals: +(totalWithdrawals?.v || 0),
    balance: receivableTotal - payableTotal,
  };
}

function ledgerNumber(value) {
  return Math.round((+value || 0) * 100) / 100;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  return key || null;
}

function debtPaymentRequestHash(payload) {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

async function reserveDebtPaymentIdempotency(client, idempotencyKey, requestHash) {
  if (!idempotencyKey) return { isReplay: false, id: null, response: null };

  const inserted = await get(`
    INSERT INTO debt_payment_idempotency(idempotency_key,request_hash)
    VALUES($1,$2)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id,response_json
  `, [idempotencyKey, requestHash], client);

  if (inserted) return { isReplay: false, id: inserted.id, response: null };

  const existing = await get(`
    SELECT id,request_hash,response_json
    FROM debt_payment_idempotency
    WHERE idempotency_key=$1
    FOR UPDATE
  `, [idempotencyKey], client);

  if (!existing) throw new Error('Не удалось проверить повтор платежа. Попробуйте еще раз.');
  if (existing.request_hash !== requestHash) {
    throw new Error('Этот idempotency key уже использован для другого платежа. Откройте форму оплаты заново.');
  }
  if (!existing.response_json) {
    throw new Error('Платеж с таким idempotency key уже обрабатывается. Повторите запрос позже.');
  }

  return { isReplay: true, id: existing.id, response: existing.response_json };
}

async function manualExpensesTotal(filters = {}, client = pool) {
  const params = [];
  const where = ["type='expense'", "COALESCE(related_type,'')='manual'"];
  if (filters.date_from) {
    params.push(filters.date_from);
    where.push(`date >= $${params.length}::date`);
  }
  if (filters.date_to) {
    params.push(filters.date_to);
    where.push(`date <= $${params.length}::date`);
  }

  const row = await get(`
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM transactions
    WHERE ${where.join(' AND ')}
  `, params, client);
  return +(row?.total || 0);
}

// Profit cost should prefer persisted receipt line totals; product averages are only a legacy fallback.
function salesCostCte(salesWhere = '') {
  return `
    WITH sales_base AS (
      SELECT DISTINCT
        s.id,
        s.sales_document_id,
        COALESCE(sd.date, s.date) AS date,
        COALESCE(sd.client_id, s.client_id) AS client_id,
        COALESCE(sd.marking_id, s.marking_id) AS marking_id,
        s.product_id,
        s.sale_unit,
        s.quantity::numeric AS quantity,
        COALESCE(s.total_amount::numeric, s.quantity::numeric * s.price_per_unit::numeric) AS revenue,
        s.manual_cost::numeric AS manual_cost,
        s.manual_cost_reason::text AS manual_cost_reason,
        s.manual_cost_updated_at::text AS manual_cost_updated_at,
        s.notes,
        NULLIF(substring(s.notes FROM 'Google Sheets row ([0-9]+)'), '')::int AS source_row
      FROM sales s
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      ${salesWhere}
    ),
    purchase_lines AS (
      SELECT
        p.id,
        p.date,
        p.client_id,
        p.marking_id,
        p.product_id,
        p.weight_kg::numeric AS weight_kg,
        p.quantity_pcs::numeric AS quantity_pcs,
        p.total_cost::numeric AS total_cost,
        p.notes,
        NULLIF(substring(p.notes FROM 'Google Sheets row ([0-9]+)'), '')::int AS source_row
      FROM purchases p
    ),
    source_purchase_matches AS (
      SELECT
        sb.id AS sale_id,
        SUM(CASE
          WHEN sb.sale_unit='kg' AND COALESCE(pl.weight_kg,0) > 0
            THEN sb.quantity * pl.total_cost / pl.weight_kg
          WHEN sb.sale_unit='pcs' AND COALESCE(pl.quantity_pcs,0) > 0
            THEN sb.quantity * pl.total_cost / pl.quantity_pcs
          WHEN sb.quantity = 0
            THEN 0
          ELSE pl.total_cost
        END) AS cost
      FROM sales_base sb
      JOIN purchase_lines pl ON sb.source_row IS NOT NULL
        AND pl.source_row = sb.source_row
        AND pl.product_id = sb.product_id
        AND pl.date = sb.date
        AND pl.client_id = sb.client_id
        AND (pl.marking_id IS NOT DISTINCT FROM sb.marking_id)
      GROUP BY sb.id
    ),
    used_purchase_sources AS (
      SELECT DISTINCT date, product_id, source_row
      FROM sales_base
      WHERE source_row IS NOT NULL
    ),
    manual_purchase_candidates AS (
      SELECT
        sb.id AS sale_id,
        pl.id AS purchase_id,
        CASE
          WHEN sb.sale_unit='kg' AND COALESCE(pl.weight_kg,0) > 0
            THEN sb.quantity * pl.total_cost / pl.weight_kg
          WHEN sb.sale_unit='pcs' AND COALESCE(pl.quantity_pcs,0) > 0
            THEN sb.quantity * pl.total_cost / pl.quantity_pcs
          WHEN sb.quantity = 0
            THEN 0
          ELSE pl.total_cost
        END AS cost,
        COUNT(*) OVER (PARTITION BY sb.id) AS candidate_count
      FROM sales_base sb
      JOIN purchase_lines pl ON sb.source_row IS NULL
        AND pl.date = sb.date
        AND pl.product_id = sb.product_id
        AND (
          (sb.sale_unit='kg' AND pl.weight_kg = sb.quantity)
          OR (sb.sale_unit='pcs' AND pl.quantity_pcs = sb.quantity)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM used_purchase_sources ups
          WHERE ups.date = pl.date
            AND ups.product_id = pl.product_id
            AND ups.source_row IS NOT DISTINCT FROM pl.source_row
        )
    ),
    manual_purchase_matches AS (
      SELECT sale_id, cost
      FROM manual_purchase_candidates
      WHERE candidate_count = 1
    ),
    purchase_costs AS (
      SELECT
        product_id,
        COALESCE(SUM(total_cost::numeric),0) AS total_cost,
        COALESCE(SUM(weight_kg::numeric),0) AS total_weight,
        COALESCE(SUM(quantity_pcs::numeric),0) AS total_quantity
      FROM purchases
      GROUP BY product_id
    ),
    sales_costed AS (
      SELECT
        sb.*,
        COALESCE(
          sb.manual_cost,
          spm.cost,
          mpm.cost,
          CASE
            WHEN sb.sale_unit='kg' AND COALESCE(pc.total_weight,0) > 0
              THEN sb.quantity * pc.total_cost / pc.total_weight
            WHEN sb.sale_unit='pcs' AND COALESCE(pc.total_quantity,0) > 0
              THEN sb.quantity * pc.total_cost / pc.total_quantity
            ELSE 0
          END
        ) AS cost,
        CASE
          WHEN sb.manual_cost IS NOT NULL THEN 'manual_override'
          WHEN spm.cost IS NOT NULL THEN 'actual_receipt_cost'
          WHEN mpm.cost IS NOT NULL THEN 'legacy_fallback'
          WHEN (
            (sb.sale_unit='kg' AND COALESCE(pc.total_weight,0) > 0)
            OR (sb.sale_unit='pcs' AND COALESCE(pc.total_quantity,0) > 0)
          ) THEN 'product_average'
          ELSE 'unknown'
        END AS cost_method
      FROM sales_base sb
      LEFT JOIN source_purchase_matches spm ON spm.sale_id = sb.id
      LEFT JOIN manual_purchase_matches mpm ON mpm.sale_id = sb.id
      LEFT JOIN purchase_costs pc ON pc.product_id = sb.product_id
    )
  `;
}

function buildCounterpartyLedger(type, chargeRows, paymentRows) {
  const groups = new Map();
  const ensureGroup = (row) => {
    const id = +(row.counterparty_id || 0);
    if (!id) return null;
    const key = `${type}-${id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        type,
        counterparty_id: id,
        counterparty_name: row.counterparty_name || 'Без названия',
        total_charged: 0,
        total_paid: 0,
        balance: 0,
        documents_count: 0,
        payments_count: 0,
        last_operation_date: null,
        status: 'closed',
        advance_amount: 0,
        entries: [],
      });
    }
    return groups.get(key);
  };

  for (const row of chargeRows) {
    const group = ensureGroup(row);
    if (!group) continue;
    const amount = ledgerNumber(row.charge);
    group.total_charged += amount;
    group.documents_count += 1;
    group.entries.push({
      date: row.date || null,
      kind: row.kind || (type === 'customer' ? 'sale' : 'receipt'),
      document_type: row.document_type || (type === 'customer' ? 'sale' : 'receipt'),
      document_id: row.document_id == null ? null : +row.document_id,
      description: row.description || (type === 'customer' ? 'Реализация' : 'Приход'),
      charge: amount,
      payment: 0,
      balance_after: 0,
      comment: row.comment || '',
      created_at: row.created_at || null,
      sort_order: 0,
      source_id: row.source_id == null ? null : +row.source_id,
      debt_payment_group_id: row.debt_payment_group_id || null,
      cancelled_at: row.cancelled_at || null,
    });
  }

  const groupedPaymentRows = new Map();
  for (const row of paymentRows) {
    const groupKey = row.debt_payment_group_id
      ? `${row.counterparty_id || 0}:${row.debt_payment_group_id}`
      : `payment:${row.source_id || `${row.counterparty_id || 0}:${row.date || ''}:${row.created_at || ''}`}`;
    if (!groupedPaymentRows.has(groupKey)) {
      groupedPaymentRows.set(groupKey, {
        ...row,
        payment: 0,
        active_payment: 0,
        payment_count: 0,
        payment_ids: [],
      });
    }
    const grouped = groupedPaymentRows.get(groupKey);
    const paymentAmount = ledgerNumber(row.payment);
    grouped.payment = ledgerNumber(+(grouped.payment || 0) + paymentAmount);
    grouped.active_payment = ledgerNumber(+(grouped.active_payment || 0) + (row.cancelled_at ? 0 : paymentAmount));
    grouped.payment_count += +(row.allocation_count || 1);
    if (row.source_id != null) {
      grouped.payment_ids.push(+row.source_id);
      grouped.source_id = grouped.source_id == null ? +row.source_id : Math.min(+grouped.source_id, +row.source_id);
    }
    if (!grouped.comment && row.comment) grouped.comment = row.comment;
    if (!grouped.cancelled_at && row.cancelled_at) grouped.cancelled_at = row.cancelled_at;
    if (!grouped.cancelled_reason && row.cancelled_reason) grouped.cancelled_reason = row.cancelled_reason;
  }

  for (const row of groupedPaymentRows.values()) {
    const group = ensureGroup(row);
    if (!group) continue;
    const amount = ledgerNumber(row.payment);
    const activeAmount = ledgerNumber(row.active_payment == null ? (row.cancelled_at ? 0 : amount) : row.active_payment);
    if (activeAmount) group.total_paid += activeAmount;
    group.payments_count += 1;
    group.entries.push({
      date: row.date || null,
      kind: 'payment',
      document_id: null,
      description: row.description || (type === 'customer' ? 'Оплата клиента' : 'Оплата поставщику'),
      charge: 0,
      payment: amount,
      active_payment: activeAmount,
      balance_after: 0,
      comment: row.comment || '',
      created_at: row.created_at || null,
      sort_order: 1,
      source_id: row.source_id == null ? null : +row.source_id,
      debt_payment_group_id: row.debt_payment_group_id || null,
      payment_count: row.payment_count || 1,
      payment_ids: row.payment_ids || [],
      cancelled_at: row.cancelled_at || null,
      cancelled_reason: row.cancelled_reason || '',
    });
  }

  return Array.from(groups.values()).map((group) => {
    group.entries.sort((a, b) => {
      const dateA = `${a.date || ''}T${a.created_at || ''}`;
      const dateB = `${b.date || ''}T${b.created_at || ''}`;
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return (a.source_id || 0) - (b.source_id || 0);
    });

    let running = 0;
    group.entries = group.entries.map((entry) => {
      const activePayment = entry.kind === 'payment'
        ? ledgerNumber(entry.active_payment == null ? entry.payment : entry.active_payment)
        : ledgerNumber(entry.payment);
      running = ledgerNumber(running + entry.charge - activePayment);
      return {
        date: entry.date,
        kind: entry.kind,
        document_type: entry.document_type || null,
        document_id: entry.document_id,
        payment_id: entry.kind === 'payment' ? entry.source_id : null,
        debt_payment_group_id: entry.kind === 'payment' ? entry.debt_payment_group_id : null,
        group_id: entry.kind === 'payment' ? entry.debt_payment_group_id : null,
        payment_count: entry.kind === 'payment' ? entry.payment_count || 1 : 0,
        payment_ids: entry.kind === 'payment' ? entry.payment_ids || [] : [],
        is_group: entry.kind === 'payment' && +(entry.payment_count || 1) > 1,
        cancelled_at: entry.cancelled_at,
        cancelled_reason: entry.cancelled_reason || '',
        description: entry.description,
        charge: ledgerNumber(entry.charge),
        payment: ledgerNumber(entry.payment),
        active_payment: activePayment,
        balance_after: running,
        comment: entry.comment,
      };
    });

    group.total_charged = ledgerNumber(group.total_charged);
    group.total_paid = ledgerNumber(group.total_paid);
    group.balance = ledgerNumber(group.total_charged - group.total_paid);
    group.advance_amount = group.balance < -0.009 ? ledgerNumber(Math.abs(group.balance)) : 0;
    group.last_operation_date = group.entries.length ? group.entries[group.entries.length - 1].date : null;
    group.status = Math.abs(group.balance) < 0.01
      ? 'closed'
      : (type === 'customer' && group.balance < 0 ? 'advance' : 'open');
    return group;
  }).sort((a, b) => {
    const statusWeight = { open: 0, advance: 1, closed: 2 };
    if (a.status !== b.status) return (statusWeight[a.status] ?? 3) - (statusWeight[b.status] ?? 3);
    if (Math.abs(a.balance) !== Math.abs(b.balance)) return Math.abs(b.balance) - Math.abs(a.balance);
    return (a.counterparty_name || '').localeCompare(b.counterparty_name || '');
  });
}

async function debtsLedgerData(client = pool) {
  const customerCharges = await all(`
      SELECT
        MIN(s.id)::integer AS source_id,
        CASE WHEN sd.id IS NOT NULL THEN sd.id ELSE MIN(s.id) END::integer AS document_id,
      COALESCE(sd.date, s.date)::text AS date,
      COALESCE(sd.created_at, s.created_at)::text AS created_at,
      COALESCE(sd.client_id, s.client_id)::integer AS counterparty_id,
      c.name::text AS counterparty_name,
      COALESCE(SUM(s.total_amount::numeric),0) AS charge,
      'sale'::text AS kind,
      CASE WHEN sd.id IS NOT NULL THEN 'sales_document' ELSE 'sale' END::text AS document_type,
      CASE
        WHEN sd.id IS NOT NULL THEN 'Реализация №' || sd.id
        ELSE 'Реализация №' || MIN(s.id)
      END AS description,
      NULL::text AS comment
    FROM sales s
    LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
    LEFT JOIN clients c ON c.id = COALESCE(sd.client_id, s.client_id)
    WHERE COALESCE(sd.client_id, s.client_id) IS NOT NULL
    GROUP BY
      COALESCE(sd.id, -s.id),
      sd.id,
      COALESCE(sd.date, s.date),
      COALESCE(sd.created_at, s.created_at),
      COALESCE(sd.client_id, s.client_id),
      c.name
    HAVING COALESCE(SUM(s.total_amount::numeric),0) <> 0
  `, [], client);

  const customerPayments = await all(`
    WITH ${activePaymentAllocationsCte()}
    SELECT
        pae.payment_id::integer AS source_id,
        NULL::integer AS document_id,
        MIN(pae.payment_date)::text AS date,
        MIN(pae.payment_created_at)::text AS created_at,
        COALESCE(sd.client_id, s.client_id)::integer AS counterparty_id,
        MAX(c.name)::text AS counterparty_name,
        COALESCE(SUM(pae.amount::numeric),0) AS payment,
        COUNT(*)::integer AS allocation_count,
        'payment'::text AS kind,
        'Оплата клиента'::text AS description,
        MIN(pae.payment_comment)::text AS comment,
        MAX(pae.debt_payment_group_id)::text AS debt_payment_group_id,
        NULL::timestamp AS cancelled_at,
        NULL::text AS cancelled_reason
      FROM payment_allocations_effective pae
      LEFT JOIN sales s ON pae.document_type='sale' AND s.id=pae.document_id
      LEFT JOIN sales_documents sd ON pae.document_type='sales_document' AND sd.id=pae.document_id
      LEFT JOIN clients c ON c.id = COALESCE(sd.client_id, s.client_id)
      WHERE pae.document_type IN ('sale','sales_document')
        AND COALESCE(sd.client_id, s.client_id) IS NOT NULL
      GROUP BY pae.payment_id, COALESCE(sd.client_id, s.client_id)
    UNION ALL
    SELECT
      pae.payment_id::integer AS source_id,
      NULL::integer AS document_id,
      MIN(pae.payment_date)::text AS date,
      MIN(pae.payment_created_at)::text AS created_at,
      pae.document_id::integer AS counterparty_id,
      MAX(c.name)::text AS counterparty_name,
      COALESCE(SUM(pae.amount::numeric),0) AS payment,
      COUNT(*)::integer AS allocation_count,
      'payment'::text AS kind,
      'Аванс клиента'::text AS description,
      MIN(pae.payment_comment)::text AS comment,
      MAX(pae.debt_payment_group_id)::text AS debt_payment_group_id,
      NULL::timestamp AS cancelled_at,
      NULL::text AS cancelled_reason
    FROM payment_allocations_effective pae
    LEFT JOIN clients c ON c.id = pae.document_id
    WHERE pae.document_type='client_advance'
    GROUP BY pae.payment_id, pae.document_id
  `, [], client);

  const supplierCharges = await all(`
    SELECT * FROM (
      SELECT
        r.id::integer AS source_id,
        r.id::integer AS document_id,
        r.date::text AS date,
        r.created_at::text AS created_at,
        r.supplier_id::integer AS counterparty_id,
        s.name::text AS counterparty_name,
        COALESCE(SUM(p.total_cost::numeric),0) AS charge,
        'receipt'::text AS kind,
        'receipt'::text AS document_type,
        'Приход №' || r.id AS description,
        NULL::text AS comment
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE r.supplier_id IS NOT NULL
      GROUP BY r.id, r.date, r.created_at, r.supplier_id, s.name
      HAVING COALESCE(SUM(p.total_cost::numeric),0) <> 0
      UNION ALL
      SELECT
        p.id::integer AS source_id,
        p.id::integer AS document_id,
        p.date::text AS date,
        p.created_at::text AS created_at,
        p.supplier_id::integer AS counterparty_id,
        s.name::text AS counterparty_name,
        COALESCE(p.total_cost::numeric,0) AS charge,
        'receipt'::text AS kind,
        'purchase'::text AS document_type,
        'Приход №' || p.id AS description,
        p.notes::text AS comment
      FROM purchases p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.receipt_id IS NULL
        AND p.supplier_id IS NOT NULL
        AND COALESCE(p.total_cost::numeric,0) <> 0
    ) q
  `, [], client);

  const supplierPayments = await all(`
    WITH ${activePaymentAllocationsCte()}
    SELECT
      pae.payment_id::integer AS source_id,
      NULL::integer AS document_id,
      MIN(pae.payment_date)::text AS date,
      MIN(pae.payment_created_at)::text AS created_at,
      COALESCE(r.supplier_id, pu.supplier_id)::integer AS counterparty_id,
      MAX(s.name)::text AS counterparty_name,
      COALESCE(SUM(pae.amount::numeric),0) AS payment,
      COUNT(*)::integer AS allocation_count,
      'payment'::text AS kind,
      'Оплата поставщику'::text AS description,
      MIN(pae.payment_comment)::text AS comment,
      MAX(pae.debt_payment_group_id)::text AS debt_payment_group_id,
      NULL::timestamp AS cancelled_at,
      NULL::text AS cancelled_reason
    FROM payment_allocations_effective pae
    LEFT JOIN receipts r ON pae.document_type='receipt' AND r.id=pae.document_id
    LEFT JOIN purchases pu ON pae.document_type='purchase' AND pu.id=pae.document_id
    LEFT JOIN suppliers s ON s.id = COALESCE(r.supplier_id, pu.supplier_id)
    WHERE pae.document_type IN ('receipt','purchase')
      AND COALESCE(r.supplier_id, pu.supplier_id) IS NOT NULL
    GROUP BY pae.payment_id, COALESCE(r.supplier_id, pu.supplier_id)
  `, [], client);

  const customers = buildCounterpartyLedger('customer', customerCharges, customerPayments);
  const suppliers = buildCounterpartyLedger('supplier', supplierCharges, supplierPayments);
  const closed = [...customers, ...suppliers]
    .filter((row) => Math.abs(row.balance) < 0.01 && (row.total_charged > 0 || row.total_paid > 0))
    .sort((a, b) => (b.last_operation_date || '').localeCompare(a.last_operation_date || ''));
  const history = [...customers, ...suppliers]
    .filter((row) => row.entries.length > 0)
    .sort((a, b) => {
      const dateCompare = (b.last_operation_date || '').localeCompare(a.last_operation_date || '');
      if (dateCompare) return dateCompare;
      return (a.counterparty_name || '').localeCompare(b.counterparty_name || '');
    });
  const receivable = customers.reduce((sum, row) => sum + (row.balance > 0 ? row.balance : 0), 0);
  const supplierPayable = suppliers.reduce((sum, row) => sum + (row.balance > 0 ? row.balance : 0), 0);
  const clientAdvances = customers.reduce((sum, row) => sum + (row.balance < 0 ? Math.abs(row.balance) : 0), 0);
  const payable = supplierPayable + clientAdvances;

  return {
    summary: {
      receivable: ledgerNumber(receivable),
      payable: ledgerNumber(payable),
      supplier_payable: ledgerNumber(supplierPayable),
      client_advances: ledgerNumber(clientAdvances),
      balance: ledgerNumber(receivable - payable),
      customersCount: customers.length,
      suppliersCount: suppliers.length,
      closedCount: closed.length,
    },
    customers,
    suppliers,
    closed,
    history,
  };
}

function isDateParam(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isStrictIsoDate(value) {
  if (!isDateParam(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

async function reconciliationActData({ type, id, date_from, date_to }, client = pool) {
  const counterpartyId = +id;
  if (!['customer', 'supplier'].includes(type) || !counterpartyId) {
    const error = new Error('type=customer|supplier и id обязательны');
    error.statusCode = 400;
    throw error;
  }
  if (!isDateParam(date_from) || !isDateParam(date_to)) {
    const error = new Error('date_from и date_to обязательны в формате YYYY-MM-DD');
    error.statusCode = 400;
    throw error;
  }
  if (date_from > date_to) {
    const error = new Error('date_from не может быть позже date_to');
    error.statusCode = 400;
    throw error;
  }

  const table = type === 'customer' ? 'clients' : 'suppliers';
  const counterparty = await get(`SELECT id,name FROM ${table} WHERE id=$1`, [counterpartyId], client);
  if (!counterparty) {
    const error = new Error(type === 'customer' ? 'Клиент не найден' : 'Поставщик не найден');
    error.statusCode = 404;
    throw error;
  }

  const ledger = await debtsLedgerData(client);
  const group = (type === 'customer' ? ledger.customers : ledger.suppliers)
    .find((row) => +row.counterparty_id === counterpartyId);
  const allEntries = group?.entries || [];

  const openingBalance = allEntries
    .filter((entry) => (entry.date || '') < date_from)
    .reduce((sum, entry) => sum + ledgerNumber(entry.charge) - ledgerNumber(entry.payment), 0);
  const periodEntries = allEntries.filter((entry) => {
    const date = entry.date || '';
    return date >= date_from && date <= date_to;
  });
  const totalCharged = periodEntries.reduce((sum, entry) => sum + ledgerNumber(entry.charge), 0);
  const totalPaid = periodEntries.reduce((sum, entry) => sum + ledgerNumber(entry.payment), 0);

  let running = ledgerNumber(openingBalance);
  const entries = periodEntries.map((entry) => {
    running = ledgerNumber(running + ledgerNumber(entry.charge) - ledgerNumber(entry.payment));
    return {
      date: entry.date,
      operation: entry.description || (entry.kind === 'payment'
        ? (type === 'customer' ? 'Оплата клиента' : 'Оплата поставщику')
        : type === 'customer' ? 'Реализация' : 'Приход'),
      document_id: entry.document_id,
      charge: ledgerNumber(entry.charge),
      payment: ledgerNumber(entry.payment),
      balance_after: running,
      comment: entry.comment || '',
    };
  });

  return {
    type,
    counterparty_id: counterpartyId,
    counterparty_name: counterparty.name,
    date_from,
    date_to,
    opening_balance: ledgerNumber(openingBalance),
    total_charged: ledgerNumber(totalCharged),
    total_paid: ledgerNumber(totalPaid),
    closing_balance: ledgerNumber(openingBalance + totalCharged - totalPaid),
    entries,
  };
}

async function profitSummaryData(filters = {}, client = pool) {
  const dateFrom = filters.date_from || null;
  const dateTo = filters.date_to || null;
  const params = [];
  const where = [];
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`COALESCE(sd.date, s.date) >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`COALESCE(sd.date, s.date) <= $${params.length}::date`);
  }
  const salesWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const row = await get(`
    ${salesCostCte(salesWhere)}
    SELECT
      COALESCE(SUM(sc.revenue),0) AS revenue,
      COALESCE(SUM(sc.cost),0) AS cost,
      COUNT(DISTINCT COALESCE(sc.sales_document_id, -sc.id))::int AS sales_count,
      COUNT(sc.id)::int AS items_count
    FROM sales_costed sc
  `, params, client);

  const revenue = +(row?.revenue || 0);
  const cost = +(row?.cost || 0);
  const manualExpenses = await manualExpensesTotal({ date_from: dateFrom, date_to: dateTo }, client);
  const grossProfit = revenue - cost;
  return {
    revenue,
    cost,
    manual_expenses: manualExpenses,
    expenses: manualExpenses,
    gross_profit: grossProfit,
    profit: grossProfit - manualExpenses,
    sales_count: +(row?.sales_count || 0),
    items_count: +(row?.items_count || 0),
    date_from: dateFrom,
    date_to: dateTo,
  };
}

function periodStartDate(period) {
  const toDateOnly = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const key = String(period || '').toLowerCase();
  const now = new Date();
  if (key === 'today') return toDateOnly(now);
  if (key === 'week') {
    now.setDate(now.getDate() - 6);
    return toDateOnly(now);
  }
  if (key === 'month') {
    return toDateOnly(new Date(now.getFullYear(), now.getMonth(), 1));
  }
  if (key === 'year') {
    return toDateOnly(new Date(now.getFullYear(), 0, 1));
  }
  return null;
}

async function analyticsProfitData(period = '', filters = {}) {
  const startDate = filters.date_from || periodStartDate(period);
  const endDate = filters.date_to || null;
  const params = [];
  const salesConditions = [];
  const purchasesConditions = [];
  const expenseConditions = ["t.type='expense'", "COALESCE(t.related_type,'')='manual'"];
  if (startDate) {
    params.push(startDate);
    salesConditions.push(`COALESCE(sd.date, s.date) >= $${params.length}::date`);
    purchasesConditions.push(`p.date >= $${params.length}::date`);
    expenseConditions.push(`t.date >= $${params.length}::date`);
  }
  if (endDate) {
    params.push(endDate);
    salesConditions.push(`COALESCE(sd.date, s.date) <= $${params.length}::date`);
    purchasesConditions.push(`p.date <= $${params.length}::date`);
    expenseConditions.push(`t.date <= $${params.length}::date`);
  }
  const salesWhere = salesConditions.length ? `WHERE ${salesConditions.join(' AND ')}` : '';
  const purchasesWhere = purchasesConditions.length ? `WHERE ${purchasesConditions.join(' AND ')}` : '';
  const expensesWhere = `WHERE ${expenseConditions.join(' AND ')}`;

  const baseCte = salesCostCte(salesWhere);

  const [byClient, byProduct, salesByPeriod, purchasesByPeriod, expensesByPeriod, expensesTotal, totals, debts, accounts] = await Promise.all([
    all(`
      ${baseCte}
      SELECT
        COALESCE(c.name, 'Без клиента') AS name,
        COALESCE(SUM(sc.revenue),0) AS total_sales,
        COALESCE(SUM(sc.cost),0) AS total_costs,
        COALESCE(SUM(sc.revenue),0) - COALESCE(SUM(sc.cost),0) AS profit
      FROM sales_costed sc
      LEFT JOIN clients c ON c.id = sc.client_id
      GROUP BY COALESCE(c.name, 'Без клиента')
      ORDER BY total_sales DESC
    `, params),
    all(`
      ${baseCte}
      SELECT
        COALESCE(pr.name, 'Без товара') AS name,
        COALESCE(SUM(sc.revenue),0) AS total_sales,
        COALESCE(SUM(sc.cost),0) AS total_costs,
        COALESCE(SUM(sc.revenue),0) - COALESCE(SUM(sc.cost),0) AS profit
      FROM sales_costed sc
      LEFT JOIN products pr ON pr.id = sc.product_id
      GROUP BY COALESCE(pr.name, 'Без товара')
      ORDER BY total_sales DESC
    `, params),
    all(`
      ${baseCte}
      SELECT
        sc.date::text AS date,
        COALESCE(SUM(sc.revenue),0) AS total
      FROM sales_costed sc
      GROUP BY sc.date
      ORDER BY sc.date
    `, params),
    all(`
      SELECT
        p.date::text AS date,
        COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM purchases p
      ${purchasesWhere}
      GROUP BY p.date
      ORDER BY p.date
    `, params),
    all(`
      SELECT
        t.date::text AS date,
        COALESCE(SUM(t.amount::numeric),0) AS total
      FROM transactions t
      ${expensesWhere}
      GROUP BY t.date
      ORDER BY t.date
    `, params),
    get(`
      SELECT COALESCE(SUM(t.amount::numeric),0) AS total
      FROM transactions t
      ${expensesWhere}
    `, params),
    get(`
      ${baseCte}
      SELECT
        COALESCE(SUM(sc.revenue),0) AS revenue,
        COALESCE(SUM(sc.cost),0) AS cost
      FROM sales_costed sc
    `, params),
    debtSummaryData(),
    all(`
      SELECT
        COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='income' AND account_to_id=a.id),0)
        + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='owner_contribution' AND account_to_id=a.id),0)
        + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='cash_adjustment_in' AND account_to_id=a.id),0)
        - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='expense' AND account_from_id=a.id),0)
        - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='withdraw' AND account_from_id=a.id),0)
        - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='owner_withdrawal' AND account_from_id=a.id),0)
        - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='cash_adjustment_out' AND account_from_id=a.id),0)
        + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_to_id=a.id),0)
        - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_from_id=a.id),0)
        AS balance
      FROM accounts a
    `),
  ]);

  const cash = accounts.reduce((sum, account) => sum + (+(account.balance || 0)), 0);
  const receivable = +(debts?.receivable?.total || 0);
  const payable = +(debts?.payable?.total || 0);
  const revenue = +(totals?.revenue || 0);
  const cost = +(totals?.cost || 0);
  const manualExpenses = +(expensesTotal?.total || 0);

  return {
    byClient,
    byProduct,
    salesByPeriod,
    purchasesByPeriod,
    expensesByPeriod,
    assetsByType: [
      { asset_type: 'cash', total: cash },
      { asset_type: 'debtors', total: receivable },
    ],
    totalLiab: payable,
    totalSales: revenue,
    totalCosts: cost + manualExpenses,
    salesCost: cost,
    manualExpenses,
    grossProfit: revenue - cost,
    profit: revenue - cost - manualExpenses,
    date_from: startDate || null,
    date_to: endDate || null,
  };
}

// Clients
app.get('/api/clients', async (req, res) => {
  res.json(await all('SELECT * FROM clients ORDER BY name'));
});

app.get('/api/operation-logs', async (req, res) => {
  const {
    date_from,
    date_to,
    action,
    entity_type,
    search,
  } = req.query;
  const limit = clampLimit(req.query.limit);
  const offset = safeOffset(req.query.offset);
  const params = [];
  const where = ['1=1'];

  if (date_from) {
    params.push(date_from);
    where.push(`created_at::date >= $${params.length}::date`);
  }
  if (date_to) {
    params.push(date_to);
    where.push(`created_at::date <= $${params.length}::date`);
  }
  if (action) {
    params.push(action);
    where.push(`action = $${params.length}`);
  }
  if (entity_type) {
    params.push(entity_type);
    where.push(`entity_type = $${params.length}`);
  }
  if (search?.trim()) {
    params.push(`%${search.trim()}%`);
    where.push(`(
      action ILIKE $${params.length}
      OR COALESCE(entity_label,'') ILIKE $${params.length}
      OR COALESCE(description,'') ILIKE $${params.length}
      OR COALESCE(amount::text,'') ILIKE $${params.length}
    )`);
  }

  const whereSql = where.join(' AND ');
  const totalRow = await get(`SELECT COUNT(*)::int AS total FROM operation_logs WHERE ${whereSql}`, params);
  const items = await all(`
    SELECT
      id,
      created_at,
      actor,
      action,
      entity_type,
      entity_id,
      entity_label,
      amount,
      currency,
      description,
      meta
    FROM operation_logs
    WHERE ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `, [...params, limit, offset]);

  res.json({
    items: items.map((item) => ({
      ...item,
      amount: item.amount == null ? null : +item.amount,
      meta: item.meta && typeof item.meta === 'object' ? item.meta : {},
    })),
    total: +(totalRow?.total || 0),
    limit,
    offset,
  });
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
  await logOperation({
    action: 'client_created',
    entity_type: 'client',
    entity_id: row.id,
    entity_label: name.trim(),
    description: 'Создан клиент',
  });
  res.json({ id: row.id });
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя клиента обязательно' });
  await query('UPDATE clients SET name=$1,phone=$2,notes=$3 WHERE id=$4', [name.trim(), phone || null, notes || null, +req.params.id]);
  await logOperation({
    action: 'client_updated',
    entity_type: 'client',
    entity_id: +req.params.id,
    entity_label: name.trim(),
    description: 'Изменён клиент',
  });
  res.json({ success: true });
});

app.delete('/api/clients/:id', async (req, res) => {
  const client = await get('SELECT name FROM clients WHERE id=$1', [+req.params.id]);
  await query('DELETE FROM clients WHERE id=$1', [+req.params.id]);
  await logOperation({
    action: 'client_deleted',
    entity_type: 'client',
    entity_id: +req.params.id,
    entity_label: client?.name || null,
    description: 'Удалён клиент',
  });
  res.json({ success: true });
});

// Counterparties import
app.post('/api/import/counterparties/preview', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    const file = extractMultipartFileBuffer(req);
    if (!file.buffer.length) return res.status(400).json({ error: 'Файл пустой' });
    const names = extractCounterpartyNamesFromFile(file);
    if (!names.length) {
      return res.status(400).json({ error: 'Не удалось найти контрагентов в файле. Проверьте, что в файле есть колонка Название/Контрагент или список имён.' });
    }
    res.json(await buildCounterpartyPreview(names));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось прочитать файл' });
  }
});

app.post('/api/import/counterparties/commit', async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Нет строк для импорта' });

  try {
    const result = await withTx(async (client) => {
      let createdClients = 0;
      let createdSuppliers = 0;
      let skipped = 0;

      for (const item of items) {
        const name = normalizeCounterpartyName(item.name);
        const type = item.type;
        if (!name || type === 'skip') {
          skipped += 1;
          continue;
        }
        if (!['client', 'supplier'].includes(type)) {
          skipped += 1;
          continue;
        }

        const table = type === 'client' ? 'clients' : 'suppliers';
        const existing = await get(`SELECT id FROM ${table} WHERE lower(regexp_replace(trim(name), '[[:space:]]+', ' ', 'g')) = lower($1) LIMIT 1`, [name], client);
        if (existing) {
          skipped += 1;
          continue;
        }

        await query(`INSERT INTO ${table}(name) VALUES($1)`, [name], client);
        if (type === 'client') createdClients += 1;
        else createdSuppliers += 1;
      }

      return {
        created_clients: createdClients,
        created_suppliers: createdSuppliers,
        skipped,
      };
    });

    await logOperation({
      action: 'counterparty_import',
      entity_type: 'counterparty_import',
      description: 'Импортированы контрагенты',
      meta: result,
    });

    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Не удалось импортировать контрагентов' });
  }
});

// Suppliers
app.get('/api/suppliers', async (req, res) => {
  res.json(await all('SELECT * FROM suppliers ORDER BY name'));
});

app.post('/api/suppliers', async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя поставщика обязательно' });
  const row = await get('INSERT INTO suppliers(name,phone,notes) VALUES($1,$2,$3) RETURNING id', [name.trim(), phone || null, notes || null]);
  await logOperation({
    action: 'supplier_created',
    entity_type: 'supplier',
    entity_id: row.id,
    entity_label: name.trim(),
    description: 'Создан поставщик',
  });
  res.json({ id: row.id });
});

app.put('/api/suppliers/:id', async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Имя поставщика обязательно' });
  await query('UPDATE suppliers SET name=$1,phone=$2,notes=$3 WHERE id=$4', [name.trim(), phone || null, notes || null, +req.params.id]);
  await logOperation({
    action: 'supplier_updated',
    entity_type: 'supplier',
    entity_id: +req.params.id,
    entity_label: name.trim(),
    description: 'Изменён поставщик',
  });
  res.json({ success: true });
});

app.delete('/api/suppliers/:id', async (req, res) => {
  const used = await get('SELECT id FROM purchases WHERE supplier_id=$1 LIMIT 1', [+req.params.id]);
  if (used) return res.status(400).json({ error: 'Поставщик используется в приходах' });
  const supplier = await get('SELECT name FROM suppliers WHERE id=$1', [+req.params.id]);
  await query('DELETE FROM suppliers WHERE id=$1', [+req.params.id]);
  await logOperation({
    action: 'supplier_deleted',
    entity_type: 'supplier',
    entity_id: +req.params.id,
    entity_label: supplier?.name || null,
    description: 'Удалён поставщик',
  });
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
  const { client_id, marking, keywords } = req.body;
  if (!client_id || !marking?.trim()) return res.status(400).json({ error: 'client_id и маркировка обязательны' });
  try {
    const normalizedMarking = marking.trim().toUpperCase();
    const row = await get(
      'INSERT INTO markings(client_id,marking,keywords) VALUES($1,$2,$3) RETURNING id',
      [+client_id, normalizedMarking, keywords?.trim() || normalizedMarking]
    );
    await logOperation({
      action: 'marking_created',
      entity_type: 'marking',
      entity_id: row.id,
      entity_label: normalizedMarking,
      description: 'Создана маркировка',
      meta: { client_id: +client_id },
    });
    res.json({ id: row.id });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Такая маркировка уже существует' : e.message });
  }
});

app.put('/api/markings/:id', async (req, res) => {
  const { client_id, marking, keywords } = req.body;
  if (!client_id || !marking?.trim()) return res.status(400).json({ error: 'client_id и маркировка обязательны' });
  try {
    const normalizedMarking = marking.trim().toUpperCase();
    await query(
      'UPDATE markings SET client_id=$1,marking=$2,keywords=$3 WHERE id=$4',
      [+client_id, normalizedMarking, keywords?.trim() || normalizedMarking, +req.params.id]
    );
    await logOperation({
      action: 'marking_updated',
      entity_type: 'marking',
      entity_id: +req.params.id,
      entity_label: normalizedMarking,
      description: 'Изменена маркировка',
      meta: { client_id: +client_id },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Такая маркировка уже существует' : e.message });
  }
});

app.delete('/api/markings/:id', async (req, res) => {
  const marking = await get('SELECT marking FROM markings WHERE id=$1', [+req.params.id]);
  await query('DELETE FROM markings WHERE id=$1', [+req.params.id]);
  await logOperation({
    action: 'marking_deleted',
    entity_type: 'marking',
    entity_id: +req.params.id,
    entity_label: marking?.marking || null,
    description: 'Удалена маркировка',
  });
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
  await logOperation({
    action: 'product_created',
    entity_type: 'product',
    entity_id: product.id,
    entity_label: name.trim(),
    description: 'Создан товар',
    meta: { category: category || null, sale_type: sale_type || null },
  });
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
  await logOperation({
    action: 'product_updated',
    entity_type: 'product',
    entity_id: +req.params.id,
    entity_label: name.trim(),
    description: 'Изменён товар',
    meta: { category: category || null, sale_type: sale_type || null },
  });
  res.json({ success: true });
});

app.delete('/api/products/:id', async (req, res) => {
  const product = await get('SELECT name FROM products WHERE id=$1', [+req.params.id]);
  await query('DELETE FROM products WHERE id=$1', [+req.params.id]);
  await logOperation({
    action: 'product_deleted',
    entity_type: 'product',
    entity_id: +req.params.id,
    entity_label: product?.name || null,
    description: 'Удалён товар',
  });
  res.json({ success: true });
});

// Tariffs
app.get('/api/tariffs', async (req, res) => {
  res.json(await all(`
    SELECT t.*, c.name AS client_name
    FROM tariffs t
    LEFT JOIN clients c ON c.id = t.client_id
    ORDER BY t.is_default DESC, t.is_active DESC, t.name
  `));
});

app.post('/api/tariffs', async (req, res) => {
  const body = req.body;
  const tariffType = body.tariff_type || 'purchase';
  if (!body.name?.trim()) return res.status(400).json({ error: 'Название обязательно' });
  if (!['purchase', 'sale'].includes(tariffType)) return res.status(400).json({ error: 'Тип тарифа обязателен' });
  if (!['kg', 'pcs'].includes(body.ala_unit || 'kg')) return res.status(400).json({ error: 'ALA единица обязательна' });
  if (!['kg', 'pcs'].includes(body.sale_unit || 'kg')) return res.status(400).json({ error: 'Единица реализации обязательна' });
  const clientId = tariffType === 'sale' && +body.client_id > 0 ? +body.client_id : null;
  if (clientId) {
    const client = await get('SELECT id FROM clients WHERE id=$1', [clientId]);
    if (!client) return res.status(400).json({ error: 'Клиент для тарифа не найден' });
  }
  const row = await get(`
    INSERT INTO tariffs(name,tariff_type,product_pattern,class_code,client_id,dxb_rate,ala_rate,ala_unit,sale_rate,sale_unit,is_default,is_active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `, [
    body.name.trim(),
    tariffType,
    body.product_pattern?.trim() || null,
    body.class_code?.trim() || null,
    clientId,
    +body.dxb_rate || 0,
    +body.ala_rate || 0,
    body.ala_unit || 'kg',
    +body.sale_rate || 0,
    body.sale_unit || 'kg',
    Boolean(body.is_default),
    body.is_active !== false,
  ]);
  await logOperation({
    action: 'tariff_created',
    entity_type: 'tariff',
    entity_id: row.id,
    entity_label: body.name.trim(),
    description: 'Создан тариф',
    meta: { tariff_type: tariffType, class_code: body.class_code || null, client_id: clientId },
  });
  res.json({ id: row.id });
});

app.put('/api/tariffs/:id', async (req, res) => {
  const body = req.body;
  const tariffType = body.tariff_type || 'purchase';
  if (!body.name?.trim()) return res.status(400).json({ error: 'Название обязательно' });
  if (!['purchase', 'sale'].includes(tariffType)) return res.status(400).json({ error: 'Тип тарифа обязателен' });
  if (!['kg', 'pcs'].includes(body.ala_unit || 'kg')) return res.status(400).json({ error: 'ALA единица обязательна' });
  if (!['kg', 'pcs'].includes(body.sale_unit || 'kg')) return res.status(400).json({ error: 'Единица реализации обязательна' });
  const clientId = tariffType === 'sale' && +body.client_id > 0 ? +body.client_id : null;
  if (clientId) {
    const client = await get('SELECT id FROM clients WHERE id=$1', [clientId]);
    if (!client) return res.status(400).json({ error: 'Клиент для тарифа не найден' });
  }
  await query(`
    UPDATE tariffs
    SET name=$1,tariff_type=$2,product_pattern=$3,class_code=$4,client_id=$5,dxb_rate=$6,ala_rate=$7,ala_unit=$8,sale_rate=$9,sale_unit=$10,is_default=$11,is_active=$12
    WHERE id=$13
  `, [
    body.name.trim(),
    tariffType,
    body.product_pattern?.trim() || null,
    body.class_code?.trim() || null,
    clientId,
    +body.dxb_rate || 0,
    +body.ala_rate || 0,
    body.ala_unit || 'kg',
    +body.sale_rate || 0,
    body.sale_unit || 'kg',
    Boolean(body.is_default),
    body.is_active !== false,
    +req.params.id,
  ]);
  await logOperation({
    action: 'tariff_updated',
    entity_type: 'tariff',
    entity_id: +req.params.id,
    entity_label: body.name.trim(),
    description: 'Изменён тариф',
    meta: { tariff_type: tariffType, class_code: body.class_code || null, client_id: clientId },
  });
  res.json({ success: true });
});

app.delete('/api/tariffs/:id', async (req, res) => {
  const tariff = await get('SELECT name,tariff_type FROM tariffs WHERE id=$1', [+req.params.id]);
  await query('UPDATE tariffs SET is_active=FALSE WHERE id=$1', [+req.params.id]);
  await logOperation({
    action: 'tariff_deleted',
    entity_type: 'tariff',
    entity_id: +req.params.id,
    entity_label: tariff?.name || null,
    description: 'Отключён тариф',
    meta: { tariff_type: tariff?.tariff_type || null },
  });
  res.json({ success: true, soft_deleted: true });
});

// Google Sheets import
app.post('/api/import/google-sheets/preview', async (req, res) => {
  try {
    const { url, date_from, date_to } = req.body;
    if (!url?.trim()) return res.status(400).json({ error: 'Ссылка на Google Sheet обязательна' });

    const { spreadsheetId, gid, range } = parseGoogleSheetUrl(url);
    const sheetRead = await getGoogleSheetsValues({ spreadsheetId, gid, range });
    const sheetRows = Array.isArray(sheetRead.rows) ? sheetRead.rows : [];

    const cleanedImportRecords = await cleanupOrphanImportRecords();
    const tariffs = await all(`
      SELECT t.*, c.name AS client_name
      FROM tariffs t
      LEFT JOIN clients c ON c.id = t.client_id
      WHERE t.is_active=TRUE
      ORDER BY t.is_default DESC, t.name
    `);
    const markings = await all(`
      SELECT m.id,m.marking,m.keywords,m.client_id,c.name AS client_name
      FROM markings m
      JOIN clients c ON c.id = m.client_id
    `);
    const products = await all('SELECT id,name FROM products');
    const imported = await all(
      `
        SELECT ir.source_row
        FROM import_records ir
        JOIN receipts r ON r.id = ir.receipt_id
        WHERE ir.source_type=$1
          AND ir.spreadsheet_id=$2
          AND ir.gid=$3
      `,
      ['google_sheets', spreadsheetId, gid]
    );
    const sourceRowOffset = sheetRangeStartRow(range) - 1;
    const importedRows = new Set(imported.map((row) => +row.source_row));
    const deletedReceiptRows = new Set(cleanedImportRecords
      .filter((row) => row.spreadsheet_id === spreadsheetId && String(row.gid || '0') === String(gid || '0'))
      .map((row) => +row.source_row));
    const productByName = new Map(products.map((product) => [normalizeText(product.name), product]));

    let headerMap = null;
    const fallbackHeaderMap = defaultSheetHeaderMap();
    let lastSeenDate = null;
    const fallbackYear = sheetFallbackYear(date_from, date_to);
    const rows = [];
    const datesFound = new Set();
    let rowsAfterCleanup = 0;
    let rowsAfterDateFilter = 0;

    sheetRows.forEach((sheetRow, rowIndex) => {
      const row = Array.from({ length: 12 }, (_, index) => sheetRow[index] ?? '');
      const maybeHeader = buildSheetHeaderMap(sheetRow);
      if (maybeHeader) {
        headerMap = maybeHeader;
        return;
      }
      const activeHeaderMap = headerMap || fallbackHeaderMap;
      if (isRepeatedSheetHeader(row) || isTotalSheetDataRow(row, activeHeaderMap)) return;

      const parsedDate = parseSheetDate(row[activeHeaderMap.date], fallbackYear);
      if (parsedDate) lastSeenDate = parsedDate;
      const markingName = String(row[activeHeaderMap.marking] || '').trim();
      const productName = String(row[activeHeaderMap.brand] || '').trim();
      const quantityPcs = parseSheetNumber(row[activeHeaderMap.pcs]);
      const weightKg = parseSheetNumber(row[activeHeaderMap.kg]);
      const hasImportData = Boolean(markingName || productName || quantityPcs > 0 || weightKg > 0);
      const date = parsedDate || (hasImportData ? lastSeenDate : null);
      if (!date || !markingName || !productName || (!(quantityPcs > 0) && !(weightKg > 0))) return;

      rowsAfterCleanup += 1;
      datesFound.add(date);
      if (date_from && date < date_from) return;
      if (date_to && date > date_to) return;
      rowsAfterDateFilter += 1;

      const classCode = String(row[activeHeaderMap.class] || '').trim() || null;
      const markingMatch = matchMarking(markingName, markings);
      const marking = markingMatch.marking || null;
      const product = productByName.get(normalizeText(productName));
      const tariff = matchTariff(productName, classCode, tariffs);
      const saleTariff = matchSaleTariff(productName, classCode, marking?.client_id || null, tariffs);
      const cost = calculateImportCost({
        productName,
        classCode,
        weightKg,
        quantityPcs,
        dxbRate: tariff.dxb_rate,
        alaRate: tariff.ala_rate,
        alaUnit: tariff.ala_unit,
      });
      const sheetDxbRate = parseSheetNumber(row[activeHeaderMap.tarifDxb]);
      const sheetAlaRate = parseSheetNumber(row[activeHeaderMap.tarifAla]);
      const sheetCreditDxb = parseSheetNumber(row[activeHeaderMap.creditDxb]);
      const sheetCreditAla = parseSheetNumber(row[activeHeaderMap.creditAla]);
      const sheetTotal = parseSheetNumber(row[activeHeaderMap.total]);
      const warnings = [];
      const suggestedSaleUnit = ['kg', 'pcs'].includes(saleTariff.sale_unit) ? saleTariff.sale_unit : (isPhoneProduct(productName) ? 'pcs' : 'kg');
      const suggestedSalePrice = +saleTariff.sale_rate || 0;
      const suggestedSaleBase = suggestedSaleUnit === 'pcs' ? quantityPcs : weightKg;
      const suggestedSaleTotal = suggestedSaleBase * suggestedSalePrice;
      const sourceRow = sourceRowOffset + rowIndex + 1;
      if (!product) warnings.push('Товар будет создан при импорте');
      if (['keyword', 'compact'].includes(markingMatch.status)) warnings.push(`Маркировка найдена по ключевому слову: ${markingMatch.matched_keyword}`);
      if (markingMatch.status === 'auto_selected') warnings.push(`Маркировка выбрана автоматически: ${markingMatch.match_reason}`);
      if (saleTariff.missing) warnings.push('Тариф реализации не найден');
      if (deletedReceiptRows.has(sourceRow)) warnings.push('Ранее импортировалось, но приход был удалён');
      if (sheetTotal && Math.abs(sheetTotal - cost.totalCost) > 0.01) warnings.push('TOTAL в таблице отличается от расчёта приложения');

      let status = 'ready';
      if (markingMatch.status === 'not_found') status = 'marking_not_found';
      if (markingMatch.status === 'ambiguous') status = 'marking_ambiguous';
      if (importedRows.has(sourceRow)) status = 'already_imported';

      rows.push({
        spreadsheet_id: spreadsheetId,
        gid,
        source_row: sourceRow,
        date,
        marking: markingName,
        marking_id: marking?.id || null,
        matched_marking: marking?.marking || null,
        selected_marking_id: marking?.id || null,
        selected_marking_name: marking?.marking || null,
        client_id: marking?.client_id || null,
        client_name: marking?.client_name || null,
        match_status: markingMatch.status,
        match_reason: markingMatch.match_reason || null,
        match_score: markingMatch.match_score || null,
        candidates: markingMatch.candidates || [],
        needs_manual_selection: markingMatch.status === 'ambiguous',
        marking_match_status: markingMatch.status,
        matched_keyword: markingMatch.matched_keyword || null,
        marking_candidates: markingMatch.candidates || [],
        product_id: product?.id || null,
        product_name: productName,
        quantity_pcs: quantityPcs,
        box: parseSheetNumber(row[activeHeaderMap.box]),
        weight_kg: weightKg,
        class: classCode,
        sheet_dxb_rate: sheetDxbRate,
        sheet_ala_rate: sheetAlaRate,
        sheet_credit_dxb: sheetCreditDxb,
        sheet_credit_ala: sheetCreditAla,
        sheet_total: sheetTotal,
        tariff_id: tariff.id || null,
        tariff_name: tariff.name || 'Авто',
        app_dxb_rate: cost.dxbRate,
        app_ala_rate: cost.alaRate,
        app_ala_unit: cost.alaUnit,
        app_dxb_cost: cost.dxbCost,
        app_ala_cost: cost.alaCost,
        app_total: cost.totalCost,
        sale_tariff_id: saleTariff.id || null,
        sale_tariff_name: saleTariff.name || 'Не найден',
        sale_tariff_client_id: saleTariff.client_id || null,
        sale_tariff_client_name: saleTariff.client_name || null,
        suggested_sale_unit: suggestedSaleUnit,
        suggested_sale_price: suggestedSalePrice,
        suggested_sale_total: suggestedSaleTotal,
        status,
        warnings,
      });
    });

    const groupsMap = new Map();
    rows.forEach((row) => {
      const key = `${row.date}||${row.marking}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          date: row.date,
          marking: row.marking,
          client_id: row.client_id,
          client_name: row.client_name,
          items_count: 0,
          total_weight: 0,
          total_quantity: 0,
          app_total: 0,
          status: 'ready',
        });
      }
      const group = groupsMap.get(key);
      group.items_count += 1;
      group.total_weight += +row.weight_kg || 0;
      group.total_quantity += +row.quantity_pcs || 0;
      group.app_total += +row.app_total || 0;
      if (row.status === 'marking_not_found') group.status = 'marking_not_found';
      if (row.status === 'marking_ambiguous' && group.status !== 'marking_not_found') group.status = 'marking_ambiguous';
      if (group.status === 'ready' && row.status === 'already_imported') group.status = 'already_imported';
      if (group.status === 'already_imported' && row.status === 'ready') group.status = 'partial';
    });

    res.json({
      spreadsheet_id: spreadsheetId,
      gid,
      rows,
      groups: Array.from(groupsMap.values()),
      summary: {
        rows_count: rows.length,
        ready_count: rows.filter((row) => row.status === 'ready').length,
        already_imported_count: rows.filter((row) => row.status === 'already_imported').length,
        marking_not_found_count: rows.filter((row) => row.status === 'marking_not_found').length,
        marking_ambiguous_count: rows.filter((row) => row.status === 'marking_ambiguous').length,
      },
      debug_summary: {
        read_mode: sheetRead.mode,
        spreadsheet_id: spreadsheetId,
        gid,
        range: sheetRead.range || range || 'A:L',
        rows_read: sheetRows.length,
        rows_after_cleanup: rowsAfterCleanup,
        dates_found: Array.from(datesFound).sort(),
        filtered_date_from: date_from || null,
        filtered_date_to: date_to || null,
        rows_after_date_filter: rowsAfterDateFilter,
        warnings: sheetRead.warnings || [],
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/import/google-sheets/commit', async (req, res) => {
  const { supplier_id, mode = 'receipt_only' } = req.body;
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const createSales = mode === 'receipt_and_sale';
  if (!['receipt_only', 'receipt_and_sale'].includes(mode)) return res.status(400).json({ error: 'Неизвестный режим импорта' });
  if (!supplier_id) return res.status(400).json({ error: 'Поставщик обязателен' });
  if (!rows.length) return res.status(400).json({ error: 'Нет строк для импорта' });
  if (rows.some((row) => row.status !== 'already_imported' && (!row.marking_id || !row.client_id))) {
    return res.status(400).json({ error: 'Есть строки без найденной маркировки' });
  }

  try {
    const result = await withTx(async (client) => {
      await cleanupOrphanImportRecords(client);
      const importMarkings = await all(`
        SELECT m.id,m.marking,m.keywords,m.client_id,c.name AS client_name
        FROM markings m
        JOIN clients c ON c.id = m.client_id
      `, [], client);
      const groups = new Map();
      let skippedRows = 0;
      for (const row of rows) {
        const existing = await get(`
          SELECT ir.id
          FROM import_records ir
          JOIN receipts r ON r.id = ir.receipt_id
          WHERE ir.source_type=$1
            AND ir.spreadsheet_id=$2
            AND ir.gid=$3
            AND ir.source_row=$4
        `, ['google_sheets', row.spreadsheet_id, row.gid || '0', +row.source_row], client);
        if (existing) {
          skippedRows += 1;
          continue;
        }

        let resolvedMarking = null;
        if (row.marking_id) {
          resolvedMarking = await get(`
            SELECT m.id,m.marking,m.keywords,m.client_id,c.name AS client_name
            FROM markings m
            JOIN clients c ON c.id = m.client_id
            WHERE m.id=$1
          `, [+row.marking_id], client);
          if (!resolvedMarking) throw new Error('Выбранная маркировка не найдена');
          if (row.client_id && +row.client_id !== +resolvedMarking.client_id) {
            throw new Error('Выбранная маркировка не принадлежит выбранному клиенту');
          }
        } else {
          const markingMatch = matchMarking(row.marking, importMarkings);
          if (markingMatch.status === 'ambiguous') throw new Error('Маркировка найдена неоднозначно. Выберите маркировку вручную');
          if (markingMatch.status === 'not_found') throw new Error('Есть строки без найденной маркировки');
          resolvedMarking = markingMatch.marking;
        }

        const importRow = {
          ...row,
          marking_id: resolvedMarking.id,
          matched_marking: resolvedMarking.marking,
          selected_marking_id: resolvedMarking.id,
          selected_marking_name: resolvedMarking.marking,
          client_id: resolvedMarking.client_id,
          client_name: resolvedMarking.client_name,
        };

        if (row.marking_match_status === 'selected' && row.marking?.trim()) {
          const currentMarking = await get('SELECT keywords FROM markings WHERE id=$1', [+resolvedMarking.id], client);
          const nextKeywords = appendMarkingKeyword(currentMarking?.keywords || resolvedMarking.keywords || resolvedMarking.marking, row.marking);
          if (nextKeywords !== (currentMarking?.keywords || '')) {
            await query('UPDATE markings SET keywords=$1 WHERE id=$2', [nextKeywords, +resolvedMarking.id], client);
          }
        }

        if (!row.product_name?.trim()) throw new Error('В каждой строке должен быть товар');
        if (createSales && !row.date) throw new Error('Дата обязательна для реализации');
        if (createSales) {
          const saleUnit = row.sale_unit;
          if (!['kg', 'pcs'].includes(saleUnit)) throw new Error('Единица реализации должна быть кг или шт');
          const salePrice = row.sale_price == null || row.sale_price === '' ? 0 : +row.sale_price;
          const saleBase = saleUnit === 'pcs'
            ? (row.quantity_pcs == null || row.quantity_pcs === '' ? 0 : +row.quantity_pcs)
            : (row.weight_kg == null || row.weight_kg === '' ? 0 : +row.weight_kg);
          if (!Number.isFinite(saleBase) || saleBase < 0) throw new Error('База реализации не может быть отрицательной');
          if (!Number.isFinite(salePrice) || salePrice < 0) throw new Error('Цена реализации не может быть отрицательной');
          if (saleBase > 0 && !(salePrice > 0)) throw new Error('Укажите цену реализации для строк с количеством или весом');
        }
        const key = `${importRow.date}||${importRow.marking_id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(importRow);
      }

      const receiptIds = [];
      const salesDocumentIds = [];
      let importedRows = 0;
      let totalPurchaseAmount = 0;
      let totalSaleAmount = 0;
      for (const groupRows of groups.values()) {
        if (!groupRows.length) continue;
        const first = groupRows[0];
        const receipt = await get(
          'INSERT INTO receipts(date,supplier_id,client_id,marking_id) VALUES($1,$2,$3,$4) RETURNING id',
          [first.date, +supplier_id, +first.client_id, +first.marking_id],
          client
        );
        receiptIds.push(receipt.id);
        let receiptTotal = 0;
        let saleTotal = 0;

        let salesDocument = null;
        const saleItems = [];
        if (createSales) {
          salesDocument = await get(
            'INSERT INTO sales_documents(date,client_id,marking_id) VALUES($1,$2,$3) RETURNING id',
            [first.date, +first.client_id, +first.marking_id],
            client
          );
          salesDocumentIds.push(salesDocument.id);
        }

        for (const row of groupRows) {
          const product = row.product_id
            ? await get('SELECT id,name FROM products WHERE id=$1', [+row.product_id], client)
            : await findOrCreateProductByName(row.product_name, client);
          const productRow = product || await findOrCreateProductByName(row.product_name, client);
          const cost = calculateImportCost({
            productName: row.product_name,
            classCode: row.class,
            weightKg: row.weight_kg,
            quantityPcs: row.quantity_pcs,
            dxbRate: row.app_dxb_rate,
            alaRate: row.app_ala_rate,
            alaUnit: row.app_ala_unit,
          });
          receiptTotal += cost.totalCost;
          const noteParts = [`Google Sheets row ${row.source_row}`];
          if (row.class) noteParts.push(`CLASS ${row.class}`);
          const note = noteParts.join(' · ');

          await query(`
            INSERT INTO receipt_items(receipt_id,product_id,weight,quantity,cost_almaty,cost_dubai,ala_unit,total_cost,class_code,note)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `, [receipt.id, +productRow.id, +row.weight_kg || 0, +row.quantity_pcs || 0, cost.alaRate, cost.dxbRate, cost.alaUnit, cost.totalCost, row.class || null, note], client);

          await query(`
            INSERT INTO purchases(date,client_id,marking_id,supplier_id,receipt_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,ala_unit,class_code,total_cost,paid_amount,notes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          `, [first.date, +first.client_id, +first.marking_id, +supplier_id, receipt.id, +productRow.id, +row.quantity_pcs || 0, +row.weight_kg || 0, +row.box || 0, cost.alaRate, cost.dxbRate, cost.dxbRate, cost.alaUnit, row.class || null, cost.totalCost, 0, note], client);

          await query(`
            INSERT INTO import_records(source_type,spreadsheet_id,gid,source_row,source_date,source_marking,receipt_id)
            VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT(source_type, spreadsheet_id, gid, source_row) DO NOTHING
          `, ['google_sheets', row.spreadsheet_id, row.gid || '0', +row.source_row, row.date, row.marking, receipt.id], client);

          if (createSales) {
            const saleUnit = row.sale_unit;
            const salePrice = row.sale_price == null || row.sale_price === '' ? 0 : +row.sale_price;
            const saleQuantity = saleUnit === 'pcs'
              ? (row.quantity_pcs == null || row.quantity_pcs === '' ? 0 : +row.quantity_pcs)
              : (row.weight_kg == null || row.weight_kg === '' ? 0 : +row.weight_kg);
            const saleNote = `${note} · Реализация из Google Sheets import`;
            saleTotal += saleQuantity * salePrice;
            await query(
              'INSERT INTO sales_items(sales_document_id,product_id,sale_unit,quantity,price_per_unit,note) VALUES($1,$2,$3,$4,$5,$6)',
              [salesDocument.id, +productRow.id, saleUnit, saleQuantity, salePrice, saleNote],
              client
            );
            saleItems.push({
              product_id: +productRow.id,
              sale_unit: saleUnit,
              quantity: saleQuantity,
              price_per_unit: salePrice,
              note: saleNote,
            });
          }

          importedRows += 1;
        }

        if (createSales) {
          const saleIds = await createLegacySalesForDocument({
            date: first.date,
            clientId: +first.client_id,
            markingId: +first.marking_id,
            items: saleItems,
            salesDocumentId: salesDocument.id,
            allowZeroItems: true,
          }, client);
          await logOperation(client, {
            action: 'sale_created',
            entity_type: 'sales_document',
            entity_id: salesDocument.id,
            entity_label: `Реализация №${salesDocument.id}`,
            amount: Math.round(saleTotal * 100) / 100,
            currency: 'USD',
            description: 'Создана реализация из Google Sheets import',
            meta: { source: 'google_sheets_import', sale_ids: saleIds, items_count: saleItems.length, client_id: +first.client_id, marking_id: +first.marking_id },
          });
        }
        await logOperation(client, {
          action: 'receipt_created',
          entity_type: 'receipt',
          entity_id: receipt.id,
          entity_label: `Приход №${receipt.id}`,
          amount: Math.round(receiptTotal * 100) / 100,
          currency: 'USD',
          description: 'Создан приход из Google Sheets import',
          meta: { source: 'google_sheets_import', items_count: groupRows.length, supplier_id: +supplier_id, client_id: +first.client_id, marking_id: +first.marking_id },
        });
        totalPurchaseAmount += receiptTotal;
        totalSaleAmount += saleTotal;
      }

      const importResult = {
        created_receipts: receiptIds.length,
        receipt_ids: receiptIds,
        created_sales_documents: salesDocumentIds.length,
        sales_document_ids: salesDocumentIds,
        imported_rows: importedRows,
        skipped_rows: skippedRows,
        purchase_total: Math.round(totalPurchaseAmount * 100) / 100,
        sale_total: Math.round(totalSaleAmount * 100) / 100,
      };
      await logOperation(client, {
        action: 'google_sheets_import',
        entity_type: 'google_sheets_import',
        description: createSales
          ? 'Импортированы приходы и реализации из Google Sheets'
          : 'Импортированы приходы из Google Sheets',
        meta: { mode, ...importResult },
      });
      return importResult;
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Receipts
app.get('/api/receipts', async (req, res) => {
  const receipts = await all(`
    SELECT
      r.id,
      r.date,
      s.name AS supplier_name,
      c.name AS client_name,
      COUNT(ri.id)::int AS items_count,
      COALESCE(SUM(ri.weight::numeric),0) AS total_weight,
      COALESCE(SUM(ri.quantity::numeric),0) AS total_quantity,
      COALESCE(
        NULLIF((SELECT COALESCE(SUM(p.total_cost::numeric),0) FROM purchases p WHERE p.receipt_id = r.id),0),
        (SELECT COALESCE(SUM(ri2.total_cost::numeric),0) FROM receipt_items ri2 WHERE ri2.receipt_id = r.id),
        0
      ) AS total_cost
    FROM receipts r
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
    GROUP BY r.id, r.date, s.name, c.name, r.created_at
    ORDER BY r.date DESC, r.created_at DESC
  `);
  res.json(receipts.map((receipt) => ({
    ...receipt,
    items_count: +receipt.items_count || 0,
    total_weight: +receipt.total_weight || 0,
    total_quantity: +receipt.total_quantity || 0,
    total_cost: +receipt.total_cost || 0,
  })));
});

app.get('/api/receipts/:id', async (req, res) => {
  const id = +req.params.id;
  const receipt = await get(`
    SELECT
      r.*,
      s.name AS supplier_name,
      c.name AS client_name,
      m.marking,
      COALESCE(
        NULLIF((SELECT COALESCE(SUM(p.total_cost::numeric),0) FROM purchases p WHERE p.receipt_id = r.id),0),
        (SELECT COALESCE(SUM(ri.total_cost::numeric),0) FROM receipt_items ri WHERE ri.receipt_id = r.id),
        0
      ) AS total_cost
    FROM receipts r
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN markings m ON m.id = r.marking_id
    WHERE r.id=$1
  `, [id]);
  if (!receipt) return res.status(404).json({ error: 'Приход не найден' });
  const items = await all(`
    SELECT
      ri.*,
      p.name AS product_name,
      COALESCE(
        NULLIF(ri.total_cost::numeric,0),
        (COALESCE(ri.weight::numeric,0) * COALESCE(ri.cost_dubai::numeric,0))
          + (
            CASE WHEN ri.ala_unit = 'pcs'
              THEN COALESCE(ri.quantity::numeric,0)
              ELSE COALESCE(ri.weight::numeric,0)
            END * COALESCE(ri.cost_almaty::numeric,0)
          ),
        0
      ) AS total_cost
    FROM receipt_items ri
    LEFT JOIN products p ON p.id = ri.product_id
    WHERE ri.receipt_id=$1
    ORDER BY ri.id
  `, [id]);
  res.json({
    ...receipt,
    total_cost: +receipt.total_cost || 0,
    items: items.map((item) => ({
      ...item,
      weight: +item.weight || 0,
      quantity: +item.quantity || 0,
      cost_almaty: +item.cost_almaty || 0,
      cost_dubai: +item.cost_dubai || 0,
      total_cost: +item.total_cost || 0,
    })),
  });
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
      let totalCostSum = 0;
      for (const item of items) {
        if (!item.product_id) throw new Error('Выберите товар в каждой строке');
        const product = await get('SELECT name FROM products WHERE id=$1', [+item.product_id], client);
        const weight = +(item.weight ?? item.weight_kg) || 0;
        const quantity = +(item.quantity ?? item.quantity_pcs) || 0;
        if (!(weight > 0) && !(quantity > 0)) throw new Error('Укажите вес или количество в каждой строке');
        validatePurchaseNums({ weight_kg: weight, quantity_pcs: quantity, cost_almaty: item.cost_almaty, cost_dubai: item.cost_dubai });

        const costAlmaty = +item.cost_almaty || 0;
        const costDubai = +item.cost_dubai || 0;
        const classCode = item.class_code || item.class || null;
        const { costPerKg, totalCost, alaUnit } = calculatePurchaseCost({
          weight_kg: weight,
          quantity_pcs: quantity,
          cost_almaty: costAlmaty,
          cost_dubai: costDubai,
          product_name: product?.name,
          class_code: classCode,
          ala_unit: item.ala_unit,
        });
        const note = item.note || item.notes || null;
        totalCostSum += totalCost;

        await query(
          'INSERT INTO receipt_items(receipt_id,product_id,weight,quantity,cost_almaty,cost_dubai,ala_unit,total_cost,class_code,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [receipt.id, +item.product_id, weight, quantity, costAlmaty, costDubai, alaUnit, totalCost, classCode, note],
          client
        );

        const purchase = await get(`
          INSERT INTO purchases(date,client_id,marking_id,supplier_id,receipt_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,ala_unit,class_code,total_cost,paid_amount,notes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          RETURNING id
        `, [body.date, cid, mid, +body.supplier_id, receipt.id, +item.product_id, quantity, weight, +(item.boxes_count || item.boxes || 0), costAlmaty, costDubai, costPerKg, alaUnit, classCode, totalCost, 0, note], client);
        purchaseIds.push(purchase.id);
      }

      await logOperation(client, {
        action: 'receipt_created',
        entity_type: 'receipt',
        entity_id: receipt.id,
        entity_label: `Приход №${receipt.id}`,
        amount: totalCostSum,
        currency: 'USD',
        description: 'Создан приход',
        meta: { purchase_ids: purchaseIds, items_count: items.length, supplier_id: +body.supplier_id, client_id: cid, marking_id: mid },
      });

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
      let totalCostSum = 0;
      for (const item of items) {
        if (!item.product_id) throw new Error('Выберите товар в каждой строке');
        const product = await get('SELECT name FROM products WHERE id=$1', [+item.product_id], client);
        const weight = +(item.weight ?? item.weight_kg) || 0;
        const quantity = +(item.quantity ?? item.quantity_pcs) || 0;
        if (!(weight > 0) && !(quantity > 0)) throw new Error('Укажите вес или количество в каждой строке');
        validatePurchaseNums({ weight_kg: weight, quantity_pcs: quantity, cost_almaty: item.cost_almaty, cost_dubai: item.cost_dubai });

        const costAlmaty = +item.cost_almaty || 0;
        const costDubai = +item.cost_dubai || 0;
        const classCode = item.class_code || item.class || null;
        const { costPerKg, totalCost, alaUnit } = calculatePurchaseCost({
          weight_kg: weight,
          quantity_pcs: quantity,
          cost_almaty: costAlmaty,
          cost_dubai: costDubai,
          product_name: product?.name,
          class_code: classCode,
          ala_unit: item.ala_unit,
        });
        const note = item.note || item.notes || null;
        totalCostSum += totalCost;

        await query('INSERT INTO receipt_items(receipt_id,product_id,weight,quantity,cost_almaty,cost_dubai,ala_unit,total_cost,class_code,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, +item.product_id, weight, quantity, costAlmaty, costDubai, alaUnit, totalCost, classCode, note], client);
        const purchase = await get(`
          INSERT INTO purchases(date,client_id,marking_id,supplier_id,receipt_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,ala_unit,class_code,total_cost,paid_amount,notes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          RETURNING id
        `, [body.date, cid, mid, +body.supplier_id, id, +item.product_id, quantity, weight, +(item.boxes_count || item.boxes || 0), costAlmaty, costDubai, costPerKg, alaUnit, classCode, totalCost, 0, note], client);
        ids.push(purchase.id);
      }
      await logOperation(client, {
        action: 'receipt_updated',
        entity_type: 'receipt',
        entity_id: id,
        entity_label: `Приход №${id}`,
        amount: totalCostSum,
        currency: 'USD',
        description: 'Изменён приход',
        meta: { purchase_ids: ids, items_count: items.length, supplier_id: +body.supplier_id, client_id: cid, marking_id: mid },
      });
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
    await withTx(async (client) => {
      const receipt = await get('SELECT * FROM receipts WHERE id=$1', [id], client);
      if (!receipt) throw new Error('Приход не найден');
      const totalRow = await get('SELECT COALESCE(SUM(total_cost::numeric),0) AS total FROM purchases WHERE receipt_id=$1', [id], client);

      const usedSale = await get(`
        SELECT s.id, pr.name AS product_name
        FROM sales s
        JOIN (
          SELECT DISTINCT product_id
          FROM purchases
          WHERE receipt_id=$1
        ) rp ON rp.product_id = s.product_id
        LEFT JOIN products pr ON pr.id = s.product_id
        WHERE COALESCE(s.quantity::numeric,0) > 0
        LIMIT 1
      `, [id], client);
      if (usedSale) {
        throw new Error('Нельзя удалить приход: товар уже использован в реализации');
      }

      const purchaseRows = await all('SELECT id FROM purchases WHERE receipt_id=$1', [id], client);
      const purchaseIds = purchaseRows.map((purchase) => +purchase.id);
      const transactionRows = await all(`
        SELECT DISTINCT t.id
        FROM transactions t
        LEFT JOIN payments p ON p.transaction_id = t.id
        WHERE t.receipt_id=$1
           OR (p.entity_type='purchase' AND p.entity_id = ANY($2::int[]))
      `, [id, purchaseIds], client);
      const transactionIds = transactionRows.map((transaction) => +transaction.id);

      await query(`
        DELETE FROM payments
        WHERE (entity_type='purchase' AND entity_id = ANY($1::int[]))
           OR transaction_id = ANY($2::int[])
      `, [purchaseIds, transactionIds], client);
      await query('DELETE FROM transactions WHERE id = ANY($1::int[])', [transactionIds], client);
      await query('DELETE FROM import_records WHERE receipt_id=$1', [id], client);
      await query('DELETE FROM purchases WHERE receipt_id=$1', [id], client);
      await query('DELETE FROM receipt_items WHERE receipt_id=$1', [id], client);
      await query('DELETE FROM receipts WHERE id=$1', [id], client);
      await logOperation(client, {
        action: 'receipt_deleted',
        entity_type: 'receipt',
        entity_id: id,
        entity_label: `Приход №${id}`,
        amount: +(totalRow?.total || 0),
        currency: 'USD',
        description: 'Удалён приход',
        meta: { supplier_id: receipt.supplier_id, client_id: receipt.client_id, marking_id: receipt.marking_id },
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.message === 'Приход не найден' ? 404 : 400).json({ error: e.message });
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
    const result = await withTx((client) => payReceiptDocument(id, { amount, accountFromId, date, comment }, client));
    res.json({ success: true, receipt_id: result.receipt_id, paid_amount: result.paid_amount, payable: result.payable });
  } catch (e) {
    res.status(e.message === 'Приход не найден' ? 404 : 400).json({ error: e.message });
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
    const result = await withTx(async (client) => {
      const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id, client);
      const weight = +body.weight_kg || 0;
      const quantity = +body.quantity_pcs || 0;
      const costAlmaty = +body.cost_almaty || 0;
      const costDubai = +body.cost_dubai || 0;
      const product = await get('SELECT name FROM products WHERE id=$1', [+body.product_id], client);
      const classCode = body.class_code || body.class || null;
      const { costPerKg, totalCost, alaUnit } = calculatePurchaseCost({
        weight_kg: weight,
        quantity_pcs: quantity,
        cost_almaty: costAlmaty,
        cost_dubai: costDubai,
        product_name: product?.name,
        class_code: classCode,
        ala_unit: body.ala_unit,
      });
      const paidAmount = +body.paid_amount || 0;
      const row = await get(`
        INSERT INTO purchases(date,client_id,marking_id,supplier_id,product_id,quantity_pcs,weight_kg,boxes_count,cost_almaty,cost_dubai,cost_per_kg,ala_unit,class_code,total_cost,paid_amount,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING *
      `, [body.date, cid, mid, +body.supplier_id, +body.product_id, quantity, weight, +body.boxes_count || 0, costAlmaty, costDubai, costPerKg, alaUnit, classCode, totalCost, paidAmount, body.notes || null], client);
      const values = purchaseLogValues(row);
      await logOperation(client, {
        action: 'purchase_created',
        entity_type: 'purchase',
        entity_id: row.id,
        entity_label: `Приход №${row.id}`,
        amount: totalCost,
        currency: 'USD',
        description: 'Создана строка прихода',
        meta: values,
      });
      return {
        id: row.id,
        cost_per_kg: costPerKg,
        ala_unit: alaUnit,
        total_cost: totalCost,
        paid_amount: paidAmount,
        payable: totalCost - paidAmount,
      };
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/purchases/:id', async (req, res) => {
  const body = req.body;
  if (!body.date || !body.product_id) return res.status(400).json({ error: 'Дата и товар обязательны' });
  try {
    validatePurchaseNums(body);
    const result = await withTx(async (client) => {
      const id = +req.params.id;
      const previous = await get('SELECT * FROM purchases WHERE id=$1 FOR UPDATE', [id], client);
      if (!previous) throw httpError('Приход не найден', 404);
      const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id, client);
      const weight = +body.weight_kg || 0;
      const quantity = +body.quantity_pcs || 0;
      const costAlmaty = +body.cost_almaty || 0;
      const costDubai = +body.cost_dubai || 0;
      const product = await get('SELECT name FROM products WHERE id=$1', [+body.product_id], client);
      const classCode = body.class_code || body.class || null;
      const { costPerKg, totalCost, alaUnit } = calculatePurchaseCost({
        weight_kg: weight,
        quantity_pcs: quantity,
        cost_almaty: costAlmaty,
        cost_dubai: costDubai,
        product_name: product?.name,
        class_code: classCode,
        ala_unit: body.ala_unit,
      });
      const updated = await get(`
        UPDATE purchases
        SET date=$1,client_id=$2,marking_id=$3,product_id=$4,quantity_pcs=$5,weight_kg=$6,boxes_count=$7,cost_almaty=$8,cost_dubai=$9,cost_per_kg=$10,ala_unit=$11,class_code=$12,total_cost=$13,notes=$14
        WHERE id=$15
        RETURNING *
      `, [body.date, cid, mid, +body.product_id, quantity, weight, +body.boxes_count || 0, costAlmaty, costDubai, costPerKg, alaUnit, classCode, totalCost, body.notes || null, id], client);
      await logOperation(client, {
        action: 'purchase_updated',
        entity_type: 'purchase',
        entity_id: id,
        entity_label: `Приход №${id}`,
        amount: totalCost,
        currency: 'USD',
        description: 'Изменена строка прихода',
        meta: {
          purchase_id: id,
          receipt_id: updated.receipt_id || null,
          supplier_id: updated.supplier_id || null,
          client_id: updated.client_id || null,
          marking_id: updated.marking_id || null,
          product_id: updated.product_id || null,
          old_values: purchaseLogValues(previous),
          new_values: purchaseLogValues(updated),
        },
      });
      return { success: true, cost_per_kg: costPerKg, ala_unit: alaUnit, total_cost: totalCost };
    });
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
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
      await logOperation(client, {
        action: 'supplier_payment',
        entity_type: 'receipt',
        entity_id: +purchase.receipt_id,
        entity_label: `Приход №${purchase.receipt_id}`,
        amount,
        currency: 'USD',
        description: 'Оплата поставщику',
        meta: { purchase_id: id, payment_id: payment.id, transaction_id: transaction.id, account_from_id: accountFromId, comment },
      });
    });

    const paidAmount = +(await getReceiptPaidAmount(+purchase.receipt_id));
    const receiptTotal = await get('SELECT COALESCE(SUM(total_cost::numeric),0) AS total FROM purchases WHERE receipt_id=$1', [+purchase.receipt_id]);
    res.json({ success: true, paid_amount: paidAmount, payable: +(receiptTotal?.total || 0) - paidAmount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/purchases/:id', async (req, res) => {
  const id = +req.params.id;
  try {
    await withTx(async (client) => {
      const purchase = await get(`
        SELECT p.*, NULLIF(substring(p.notes FROM 'Google Sheets row ([0-9]+)'), '')::int AS source_row
        FROM purchases p
        WHERE p.id=$1
        FOR UPDATE
      `, [id], client);
      if (!purchase) throw httpError('Приход не найден', 404);

      const exactCostSale = await getSaleUsingPurchaseAsExactCostSource(purchase, client);
      if (exactCostSale) {
        throw httpError('Нельзя удалить приход: он используется как точный источник себестоимости продажи. Сначала удалите или исправьте связанную реализацию.');
      }

      const activePayment = await getActiveEffectivePurchasePayment(id, purchase.receipt_id, client);
      if (activePayment) {
        throw httpError('Нельзя удалить приход: по нему есть активные оплаты. Сначала отмените или отредактируйте оплату.');
      }

      await query('DELETE FROM purchases WHERE id=$1', [id], client);
      if (purchase.receipt_id) await rebalanceReceiptPurchasePaidAmounts(+purchase.receipt_id, client);
      await logOperation(client, {
        action: 'purchase_deleted',
        entity_type: 'purchase',
        entity_id: id,
        entity_label: `Приход №${id}`,
        amount: +(purchase.total_cost || 0),
        currency: 'USD',
        description: 'Удалён приход',
        meta: {
          receipt_id: purchase.receipt_id || null,
          supplier_id: purchase.supplier_id || null,
          client_id: purchase.client_id || null,
          marking_id: purchase.marking_id || null,
          product_id: purchase.product_id || null,
        },
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
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
      const totalAmount = items.reduce((sum, item) => sum + Math.round(+item.quantity * +item.price_per_unit * 100) / 100, 0);
      await logOperation(client, {
        action: 'sale_created',
        entity_type: 'sales_document',
        entity_id: salesDocument.id,
        entity_label: `Реализация №${salesDocument.id}`,
        amount: Math.round(totalAmount * 100) / 100,
        currency: 'USD',
        description: 'Создана реализация',
        meta: { sale_ids: saleIds, items_count: items.length, client_id: cid, marking_id: mid },
      });

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

    const result = await withTx((client) => paySalesDocumentAllowClientAdvance(anchorSale.id, { amount, accountToId, date, comment }, client));
    res.json({ success: true, sales_document_id: result.sales_document_id, paid_amount: result.paid_amount, debt: result.debt, advance_amount: result.advance_amount || 0 });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Sales
app.get('/api/sales', async (req, res) => {
  const { client_id, product_id, from_date, to_date } = req.query;
  const params = [];
  const where = ['1=1'];
  const having = [];
  if (client_id) { params.push(+client_id); where.push(`client_id=$${params.length}`); }
  if (from_date) { params.push(from_date); where.push(`date >= $${params.length}`); }
  if (to_date) { params.push(to_date); where.push(`date <= $${params.length}`); }
  if (product_id) { params.push(+product_id); having.push(`BOOL_OR(product_id=$${params.length})`); }

  res.json(await all(`
    WITH ${activePaymentAllocationsCte()},
    sales_base AS (
      SELECT
        s.id,
        COALESCE(s.sales_document_id, -s.id) AS group_id,
        s.sales_document_id,
        COALESCE(sd.date, s.date) AS date,
        COALESCE(sd.created_at, s.created_at) AS created_at,
        COALESCE(sd.client_id, s.client_id) AS client_id,
        COALESCE(sd.marking_id, s.marking_id) AS marking_id,
        s.product_id,
        s.sale_unit,
        s.quantity::numeric AS quantity,
        s.price_per_unit::numeric AS price_per_unit,
        COALESCE(s.total_amount::numeric, s.quantity::numeric * s.price_per_unit::numeric) AS total_amount,
        COALESCE(s.paid_amount::numeric,0) AS paid_amount,
        s.notes,
        p.name AS product_name
      FROM sales s
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      LEFT JOIN products p ON p.id = s.product_id
    ),
    documents AS (
      SELECT
        group_id,
        MIN(id) AS anchor_sale_id,
        sales_document_id,
        date,
        created_at,
        client_id,
        marking_id,
        COALESCE(SUM(total_amount),0) AS total_amount,
        COALESCE(SUM(paid_amount),0) AS fallback_paid_amount,
        COUNT(*)::int AS items_count,
        CASE
          WHEN COUNT(*) = 1 THEN MAX(product_name)
          ELSE COUNT(*)::text || ' тов.'
        END AS product_name,
        json_agg(json_build_object(
          'id', id,
          'product_id', product_id,
          'product_name', product_name,
          'sale_unit', sale_unit,
          'quantity', quantity,
          'price_per_unit', price_per_unit,
          'total_amount', total_amount,
          'notes', notes
        ) ORDER BY id) AS items
      FROM sales_base
      WHERE ${where.join(' AND ')}
      GROUP BY group_id, sales_document_id, date, created_at, client_id, marking_id
      HAVING ${having.length ? having.join(' AND ') : '1=1'}
    ),
    receivable_payments AS (
      SELECT
        CASE WHEN document_type='sales_document' THEN document_id ELSE -document_id END AS group_id,
        COALESCE(SUM(amount::numeric),0) AS paid_amount
      FROM payment_allocations_effective
      WHERE document_type IN ('sale','sales_document')
      GROUP BY CASE WHEN document_type='sales_document' THEN document_id ELSE -document_id END
    )
    SELECT
      d.anchor_sale_id AS id,
      d.sales_document_id,
      d.date::text AS date,
      d.created_at,
      d.client_id,
      c.name AS client_name,
      d.marking_id,
      m.marking,
      d.items_count,
      d.product_name,
      d.total_amount,
      COALESCE(rp.paid_amount, d.fallback_paid_amount, 0) AS paid_amount,
      d.total_amount - COALESCE(rp.paid_amount, d.fallback_paid_amount, 0) AS debt,
      d.items
    FROM documents d
    LEFT JOIN clients c ON c.id = d.client_id
    LEFT JOIN markings m ON m.id = d.marking_id
    LEFT JOIN receivable_payments rp ON rp.group_id = d.group_id
    ORDER BY d.date DESC, d.created_at DESC
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
    await logOperation({
      action: 'sale_created',
      entity_type: 'sale',
      entity_id: row.id,
      entity_label: `Реализация №${row.id}`,
      amount: totalAmount,
      currency: 'USD',
      description: 'Создана реализация',
      meta: { client_id: cid, marking_id: mid, product_id: +body.product_id, sale_unit: body.sale_unit },
    });
    res.json({ id: row.id, total_amount: totalAmount, paid_amount: paidAmount, debt: totalAmount - paidAmount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/sales/:id/manual-cost', async (req, res) => {
  const saleId = +req.params.id;
  const costValue = req.body?.cost;
  const cost = Number(req.body?.cost);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(saleId) || saleId <= 0) return validationError(res, 'Продажа не найдена', { sale_id: req.params.id });
  if (costValue == null || costValue === '' || !Number.isFinite(cost) || cost < 0) {
    return validationError(res, 'Себестоимость должна быть числом 0 или больше', { sale_id: saleId, cost: req.body?.cost });
  }

  try {
    const result = await withTx(async (client) => {
      const sale = await get('SELECT id,total_amount FROM sales WHERE id=$1', [saleId], client);
      if (!sale) throw new Error('Продажа не найдена');
      const oldCostRow = await get(`
        ${salesCostCte('WHERE s.id=$1')}
        SELECT cost,cost_method
        FROM sales_costed
        WHERE id=$1
      `, [saleId], client);
      await query(`
        UPDATE sales
        SET manual_cost=$1, manual_cost_reason=$2, manual_cost_updated_at=CURRENT_TIMESTAMP
        WHERE id=$3
      `, [cost, reason || null, saleId], client);
      const newCostRow = await get(`
        ${salesCostCte('WHERE s.id=$1')}
        SELECT cost,cost_method
        FROM sales_costed
        WHERE id=$1
      `, [saleId], client);
      await logOperation(client, {
        action: 'sale_cost_manual_override',
        entity_type: 'sale',
        entity_id: saleId,
        entity_label: `Реализация №${saleId}`,
        amount: cost,
        currency: 'USD',
        description: 'Ручная корректировка себестоимости продажи',
        meta: {
          sale_id: saleId,
          old_cost: +(oldCostRow?.cost || 0),
          old_cost_method: oldCostRow?.cost_method || null,
          new_cost: +(newCostRow?.cost || cost),
          new_cost_method: newCostRow?.cost_method || 'manual_override',
          reason: reason || null,
        },
      });
      return {
        sale_id: saleId,
        revenue: +(sale.total_amount || 0),
        old_cost: +(oldCostRow?.cost || 0),
        old_cost_method: oldCostRow?.cost_method || null,
        new_cost: +(newCostRow?.cost || cost),
        new_cost_method: newCostRow?.cost_method || 'manual_override',
        manual_cost_reason: reason || null,
      };
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/sales/:id', async (req, res) => {
  const body = req.body;
  const documentItems = Array.isArray(body.items) ? body.items : null;

  if (documentItems) {
    if (!body.date || !documentItems.length) {
      return res.status(400).json({ error: 'Заполните все обязательные поля' });
    }
    try {
      const sale = await get('SELECT * FROM sales WHERE id=$1', [+req.params.id]);
      if (!sale) return res.status(404).json({ error: 'Продажа не найдена' });
      if (!sale.sales_document_id && documentItems.length > 1) {
        return res.status(400).json({ error: 'Продажа не привязана к документу' });
      }
      if (!sale.sales_document_id) {
        const item = documentItems[0];
        await validateSale(item.product_id, item.sale_unit, item.quantity, item.price_per_unit);
        const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id);
        const totalAmount = Math.round(+item.quantity * +item.price_per_unit * 100) / 100;
        await query(`
          UPDATE sales
          SET date=$1,client_id=$2,marking_id=$3,product_id=$4,sale_unit=$5,quantity=$6,price_per_unit=$7,total_amount=$8,notes=$9
          WHERE id=$10
        `, [body.date, cid, mid, +item.product_id, item.sale_unit, +item.quantity, +item.price_per_unit, totalAmount, item.notes || item.note || null, +req.params.id]);
        await logOperation({
          action: 'sale_updated',
          entity_type: 'sale',
          entity_id: +req.params.id,
          entity_label: `Реализация №${req.params.id}`,
          amount: totalAmount,
          currency: 'USD',
          description: 'Изменена реализация',
          meta: { client_id: cid, marking_id: mid, product_id: +item.product_id, sale_unit: item.sale_unit },
        });
        return res.json({ success: true, total_amount: totalAmount });
      }

      const result = await withTx(async (client) => {
        const salesDocumentId = +sale.sales_document_id;
        const { cid, mid } = await resolveClientMarking(body.client_id, body.marking_id, client);
        await query('UPDATE sales_documents SET date=$1,client_id=$2,marking_id=$3 WHERE id=$4', [body.date, cid, mid, salesDocumentId], client);
        await query('DELETE FROM sales_items WHERE sales_document_id=$1', [salesDocumentId], client);

        const existingSales = await all('SELECT id FROM sales WHERE sales_document_id=$1 ORDER BY id', [salesDocumentId], client);
        let totalAmount = 0;

        for (let index = 0; index < documentItems.length; index += 1) {
          const item = documentItems[index];
          if (!item.product_id) throw new Error('Выберите товар в каждой строке');
          if (!item.sale_unit) throw new Error('Укажите единицу продажи в каждой строке');
          if (item.quantity == null || !(+item.quantity > 0)) throw new Error('Количество в каждой строке должно быть больше 0');
          if (item.price_per_unit == null || !(+item.price_per_unit > 0)) throw new Error('Цена в каждой строке должна быть больше 0');
          await validateSale(item.product_id, item.sale_unit, item.quantity, item.price_per_unit, client);

          const itemTotal = Math.round(+item.quantity * +item.price_per_unit * 100) / 100;
          totalAmount += itemTotal;
          await query(
            'INSERT INTO sales_items(sales_document_id,product_id,sale_unit,quantity,price_per_unit,note) VALUES($1,$2,$3,$4,$5,$6)',
            [salesDocumentId, +item.product_id, item.sale_unit, +item.quantity, +item.price_per_unit, item.note || item.notes || null],
            client
          );

          const existingSale = existingSales[index];
          if (existingSale) {
            await query(`
              UPDATE sales
              SET date=$1,client_id=$2,marking_id=$3,product_id=$4,sale_unit=$5,quantity=$6,price_per_unit=$7,total_amount=$8,notes=$9
              WHERE id=$10
            `, [body.date, cid, mid, +item.product_id, item.sale_unit, +item.quantity, +item.price_per_unit, itemTotal, item.notes || item.note || null, existingSale.id], client);
          } else {
            await query(`
              INSERT INTO sales(date,client_id,marking_id,sales_document_id,product_id,sale_unit,quantity,price_per_unit,total_amount,paid_amount,notes)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `, [body.date, cid, mid, salesDocumentId, +item.product_id, item.sale_unit, +item.quantity, +item.price_per_unit, itemTotal, 0, item.notes || item.note || null], client);
          }
        }

        const staleIds = existingSales.slice(documentItems.length).map((row) => +row.id);
        if (staleIds.length) {
          await query('DELETE FROM transactions WHERE sale_id = ANY($1::int[])', [staleIds], client);
          await query("DELETE FROM payments WHERE entity_type='sale' AND entity_id = ANY($1::int[])", [staleIds], client);
          await query('DELETE FROM sales WHERE id = ANY($1::int[])', [staleIds], client);
        }

        await rebalanceSalesDocumentPaidAmounts(salesDocumentId, client);
        await logOperation(client, {
          action: 'sale_updated',
          entity_type: 'sales_document',
          entity_id: salesDocumentId,
          entity_label: `Реализация №${salesDocumentId}`,
          amount: Math.round(totalAmount * 100) / 100,
          currency: 'USD',
          description: 'Изменена реализация',
          meta: { items_count: documentItems.length, client_id: cid, marking_id: mid },
        });
        return { total_amount: Math.round(totalAmount * 100) / 100 };
      });

      return res.json({ success: true, total_amount: result.total_amount });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

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
    await logOperation({
      action: 'sale_updated',
      entity_type: 'sale',
      entity_id: +req.params.id,
      entity_label: `Реализация №${req.params.id}`,
      amount: totalAmount,
      currency: 'USD',
      description: 'Изменена реализация',
      meta: { client_id: cid, marking_id: mid, product_id: +body.product_id, sale_unit: body.sale_unit },
    });
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
      const result = await withTx((client) => paySalesDocumentAllowClientAdvance(id, { amount, accountToId, date, comment }, client));
      return res.json({ success: true, sales_document_id: result.sales_document_id, paid_amount: result.paid_amount, debt: result.debt, advance_amount: result.advance_amount || 0 });
    }

    const result = await withTx((client) => payLegacySaleAllowClientAdvance(id, { amount, accountToId, date, comment }, client));
    res.json({ success: true, paid_amount: result.paid_amount, debt: result.debt, advance_amount: result.advance_amount || 0 });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/sales/:id', async (req, res) => {
  const id = +req.params.id;
  try {
    await withTx(async (client) => {
      const sale = await get('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [id], client);
      if (!sale) return;

      if (sale.sales_document_id) {
        const saleRows = await all('SELECT id FROM sales WHERE sales_document_id=$1 FOR UPDATE', [+sale.sales_document_id], client);
        const saleIds = saleRows.map((row) => +row.id);
        const activeAllocation = await getActivePaymentAllocationForDocuments({
          saleIds,
          salesDocumentIds: [+sale.sales_document_id],
        }, client);
        if (activeAllocation) {
          throw httpError('Нельзя удалить продажу: по ней есть активные оплаты. Сначала отмените/отредактируйте оплату.');
        }
        const totalRow = await get('SELECT COALESCE(SUM(total_amount::numeric),0) AS total FROM sales WHERE sales_document_id=$1', [+sale.sales_document_id], client);
        await query('DELETE FROM transactions WHERE sale_id = ANY($1::int[])', [saleIds], client);
        await query("DELETE FROM payments WHERE entity_type='sale' AND entity_id = ANY($1::int[])", [saleIds], client);
        await query('DELETE FROM sales_items WHERE sales_document_id=$1', [+sale.sales_document_id], client);
        await query('DELETE FROM sales WHERE sales_document_id=$1', [+sale.sales_document_id], client);
        await query('DELETE FROM sales_documents WHERE id=$1', [+sale.sales_document_id], client);
        await logOperation(client, {
          action: 'sale_deleted',
          entity_type: 'sales_document',
          entity_id: +sale.sales_document_id,
          entity_label: `Реализация №${sale.sales_document_id}`,
          amount: +(totalRow?.total || 0),
          currency: 'USD',
          description: 'Удалена реализация',
          meta: { sale_ids: saleIds },
        });
        return;
      }

      const activeAllocation = await getActivePaymentAllocationForDocuments({ saleIds: [id] }, client);
      if (activeAllocation) {
        throw httpError('Нельзя удалить продажу: по ней есть активные оплаты. Сначала отмените/отредактируйте оплату.');
      }

      await query('DELETE FROM transactions WHERE sale_id=$1', [id], client);
      await query("DELETE FROM payments WHERE entity_type='sale' AND entity_id=$1", [id], client);
      await query('DELETE FROM sales WHERE id=$1', [id], client);
      await logOperation(client, {
        action: 'sale_deleted',
        entity_type: 'sale',
        entity_id: id,
        entity_label: `Реализация №${id}`,
        amount: +(sale.total_amount || 0),
        currency: 'USD',
        description: 'Удалена реализация',
        meta: { client_id: sale.client_id, marking_id: sale.marking_id, product_id: sale.product_id },
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Debts
app.get('/api/reconciliation-act', async (req, res) => {
  try {
    res.json(await reconciliationActData(req.query));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/debts/ledger', async (req, res) => {
  try {
    res.json(await debtsLedgerData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/debts/pay', async (req, res) => {
  const rawEntityType = String(req.body.entity_type || '').trim();
  const entityType = rawEntityType === 'customer' ? 'client' : rawEntityType;
  const entityId = +req.body.entity_id;
  const cashboxId = +req.body.cashbox_id;
  const amount = ledgerNumber(req.body.amount);
  const date = String(req.body.date || new Date().toISOString().slice(0, 10)).trim();
  const comment = req.body.comment || null;
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotency_key || req.get('Idempotency-Key'));

  if (!['supplier', 'client'].includes(entityType)) return validationError(res, 'Тип контрагента должен быть supplier или client', { entity_type: rawEntityType });
  if (!Number.isInteger(entityId) || entityId <= 0) return validationError(res, 'Контрагент обязателен', { entity_type: entityType, entity_id: req.body.entity_id });
  if (!Number.isInteger(cashboxId) || cashboxId <= 0) return validationError(res, 'Касса обязательна', { entity_type: entityType, entity_id: entityId, cashbox_id: req.body.cashbox_id });
  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { entity_type: entityType, entity_id: entityId, amount });
  if (!isStrictIsoDate(date)) return validationError(res, 'Дата должна быть существующей датой в формате YYYY-MM-DD', { entity_type: entityType, entity_id: entityId, date });
  if (idempotencyKey && idempotencyKey.length > 200) return validationError(res, 'Idempotency key слишком длинный', { idempotency_key_length: idempotencyKey.length });

  try {
    const requestHash = debtPaymentRequestHash({
      entity_type: entityType,
      entity_id: entityId,
      cashbox_id: cashboxId,
      amount,
      date,
      comment,
    });

    const response = await withTx(async (client) => {
      const idempotency = await reserveDebtPaymentIdempotency(client, idempotencyKey, requestHash);
      if (idempotency.isReplay) return { ...idempotency.response, idempotent: true };

      const cashbox = await get('SELECT id FROM accounts WHERE id=$1', [cashboxId], client);
      if (!cashbox) throw new Error('Касса не найдена');

      if (entityType === 'supplier') {
        const supplier = await get('SELECT id FROM suppliers WHERE id=$1', [entityId], client);
        if (!supplier) throw httpError('Поставщик не найден', 404);
      }

      const documents = entityType === 'supplier'
        ? await getSupplierOpenDebtDocuments(entityId, client)
        : await getClientOpenDebtDocuments(entityId, client);
      const totalDebt = ledgerNumber(documents.reduce((sum, document) => sum + +(document.remaining || 0), 0));

      if (entityType === 'supplier' && (!documents.length || totalDebt <= 0.009)) throw new Error('Открытых документов для оплаты нет');
      if (entityType === 'supplier' && amount > totalDebt + 0.009) {
        throw new Error('Сумма оплаты превышает общий долг поставщика');
      }
      if (entityType === 'supplier' && await getAccountBalance(cashboxId, client) < amount) {
        throw new Error('Недостаточно средств в кассе');
      }

      const debtPaymentGroupId = randomUUID();
      const payment = await get(`
        INSERT INTO payments(entity_type,entity_id,amount,date,comment,debt_payment_group_id)
        VALUES($1,$2,$3,$4,$5,$6)
        RETURNING id
      `, [entityType, entityId, amount, date, comment, debtPaymentGroupId], client);
      const transaction = await get(`
        INSERT INTO transactions(type,amount,account_from_id,account_to_id,date,comment,related_type,related_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id
      `, [
        entityType === 'supplier' ? 'expense' : 'income',
        amount,
        entityType === 'supplier' ? cashboxId : null,
        entityType === 'client' ? cashboxId : null,
        date,
        comment,
        'payment',
        payment.id,
      ], client);
      await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, payment.id], client);

      let remainingPayment = amount;
      const allocations = [];

      for (const document of documents) {
        if (remainingPayment <= 0.009) break;
        const part = ledgerNumber(Math.min(remainingPayment, +(document.remaining || 0)));
        if (!(part > 0)) continue;

        if (entityType === 'supplier') {
          await query(`
            INSERT INTO payment_allocations(payment_id,document_type,document_id,amount)
            VALUES($1,$2,$3,$4)
          `, [payment.id, 'receipt', document.document_id, part], client);
          allocations.push({
            document_type: 'receipt',
            document_id: document.document_id,
            amount: part,
            paid_amount: ledgerNumber(+(document.paid || 0) + part),
            debt: ledgerNumber(+(document.remaining || 0) - part),
          });
        } else if (document.document_type === 'sales_document') {
          await query(`
            INSERT INTO payment_allocations(payment_id,document_type,document_id,amount)
            VALUES($1,$2,$3,$4)
          `, [payment.id, 'sales_document', document.document_id, part], client);
          allocations.push({
            document_type: 'sales_document',
            document_id: document.document_id,
            amount: part,
            paid_amount: ledgerNumber(+(document.paid || 0) + part),
            debt: ledgerNumber(+(document.remaining || 0) - part),
          });
        } else {
          await query(`
            INSERT INTO payment_allocations(payment_id,document_type,document_id,amount)
            VALUES($1,$2,$3,$4)
          `, [payment.id, 'sale', document.document_id, part], client);
          allocations.push({
            document_type: 'sale',
            document_id: document.document_id,
            amount: part,
            paid_amount: ledgerNumber(+(document.paid || 0) + part),
            debt: ledgerNumber(+(document.remaining || 0) - part),
          });
        }

        remainingPayment = ledgerNumber(remainingPayment - part);
      }

      if (remainingPayment > 0.009) {
        if (entityType !== 'client') throw new Error('Не удалось распределить оплату по открытым документам');
        await query(`
          INSERT INTO payment_allocations(payment_id,document_type,document_id,amount)
          VALUES($1,$2,$3,$4)
        `, [payment.id, 'client_advance', entityId, remainingPayment], client);
        const balanceAfter = ledgerNumber(totalDebt - amount);
        allocations.push({
          document_type: 'client_advance',
          document_id: entityId,
          amount: remainingPayment,
          paid_amount: remainingPayment,
          debt: balanceAfter,
          advance_after: balanceAfter < -0.009 ? ledgerNumber(Math.abs(balanceAfter)) : 0,
        });
        remainingPayment = 0;
      }

      for (const allocation of allocations) {
        await rebalanceAllocationDocument(allocation.document_type, allocation.document_id, client);
      }

      await logOperation(client, {
        action: 'debt_payment_created',
        entity_type: entityType,
        entity_id: entityId,
        entity_label: `${entityType === 'supplier' ? 'Поставщик' : 'Клиент'} №${entityId}`,
        amount,
        currency: 'USD',
        description: entityType === 'supplier' ? 'Групповая оплата поставщику' : 'Групповая оплата клиента',
        meta: {
          payment_id: payment.id,
          transaction_id: transaction.id,
          group_id: debtPaymentGroupId,
          entity_type: entityType,
          entity_id: entityId,
          amount_total: amount,
          allocation_count: allocations.length,
          cashbox_id: cashboxId,
          comment,
          allocations,
        },
      });

      const finalBalance = entityType === 'client'
        ? await getClientLedgerBalance(entityId, client)
        : ledgerNumber(totalDebt - amount);

      const body = {
        success: true,
        idempotent: false,
        entity_type: entityType,
        entity_id: entityId,
        paid_amount: amount,
        previous_debt: totalDebt,
        remaining_debt: finalBalance,
        advance_amount: entityType === 'client' && finalBalance < -0.009 ? ledgerNumber(Math.abs(finalBalance)) : 0,
        payment_id: payment.id,
        transaction_id: transaction.id,
        debt_payment_group_id: debtPaymentGroupId,
        allocations,
      };

      if (idempotency.id) {
        await query('UPDATE debt_payment_idempotency SET response_json=$1::jsonb WHERE id=$2', [JSON.stringify(body), idempotency.id], client);
      }

      return body;
    });

    res.json(response);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post('/api/debts/payments/:groupId/cancel', async (req, res) => {
  const groupId = String(req.params.groupId || '').trim();
  const reason = String(req.body?.reason || 'Отмена погашения долга').trim();
  const date = String(req.body?.date || new Date().toISOString().slice(0, 10)).trim();

  if (!groupId) return validationError(res, 'Группа погашения обязательна', { group_id: req.params.groupId });
  if (!isStrictIsoDate(date)) return validationError(res, 'Дата должна быть существующей датой в формате YYYY-MM-DD', { group_id: groupId, date });

  try {
    const result = await withTx(async (client) => {
      const payments = await all(`
        SELECT
          p.*,
          t.type AS transaction_type,
          t.account_from_id,
          t.account_to_id,
          t.receipt_id,
          t.sale_id
        FROM payments p
        LEFT JOIN transactions t ON t.id = p.transaction_id
        WHERE p.debt_payment_group_id=$1
        ORDER BY p.id
        FOR UPDATE OF p
      `, [groupId], client);

      if (!payments.length) {
        const legacyPaymentId = Number.isInteger(+groupId) ? +groupId : 0;
        if (legacyPaymentId > 0) {
          const legacy = await get('SELECT id,debt_payment_group_id FROM payments WHERE id=$1', [legacyPaymentId], client);
          if (legacy && !legacy.debt_payment_group_id) {
            throw new Error('Старое погашение без группы нельзя отменить автоматически');
          }
        }
        const error = new Error('Группа погашения не найдена');
        error.statusCode = 404;
        throw error;
      }

      if (payments.some((payment) => payment.cancelled_at)) {
        throw new Error('Погашение уже отменено');
      }

      const unsupported = payments.find((payment) => !['sale', 'purchase', 'client_advance', 'client', 'supplier'].includes(payment.entity_type));
      if (unsupported) throw new Error('Этот тип платежа нельзя отменить как погашение долга');

      const refundByAccount = new Map();
      for (const payment of payments) {
        const amount = ledgerNumber(payment.amount);
        const isClientPayment = payment.entity_type === 'sale' || payment.entity_type === 'client_advance' || payment.entity_type === 'client';
        const accountId = isClientPayment ? +(payment.account_to_id || 0) : +(payment.account_from_id || 0);
        if (!accountId) throw new Error('Платеж без кассовой операции нельзя отменить автоматически');
        if (isClientPayment) {
          refundByAccount.set(accountId, ledgerNumber((refundByAccount.get(accountId) || 0) + amount));
        }
      }

      for (const [accountId, refundAmount] of refundByAccount.entries()) {
        if (await getAccountBalance(accountId, client) < refundAmount - 0.009) {
          throw new Error('Недостаточно средств в кассе для отмены погашения');
        }
      }

      const reverseTransactionIds = [];
      for (const payment of payments) {
        const amount = ledgerNumber(payment.amount);
        const isClientPayment = payment.entity_type === 'sale' || payment.entity_type === 'client_advance' || payment.entity_type === 'client';
        const accountId = isClientPayment ? +(payment.account_to_id || 0) : +(payment.account_from_id || 0);
        const reverse = await get(`
          INSERT INTO transactions(type,amount,account_from_id,account_to_id,receipt_id,sale_id,date,comment,related_type,related_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id
        `, [
          isClientPayment ? 'expense' : 'income',
          amount,
          isClientPayment ? accountId : null,
          isClientPayment ? null : accountId,
          payment.entity_type === 'purchase' ? (payment.receipt_id || null) : null,
          payment.entity_type === 'sale' ? (payment.sale_id || payment.entity_id || null) : null,
          date,
          reason,
          'debt_payment_cancel',
          payment.id,
        ], client);
        reverseTransactionIds.push(reverse.id);
      }

      await query(`
        UPDATE payments
        SET cancelled_at=CURRENT_TIMESTAMP,
            cancelled_reason=$2,
            cancelled_meta=$3::jsonb
        WHERE debt_payment_group_id=$1
      `, [
        groupId,
        reason,
        JSON.stringify({ reverse_transaction_ids: reverseTransactionIds, cancelled_date: date }),
      ], client);

      await query(`
        UPDATE payment_allocations pa
        SET cancelled_at=CURRENT_TIMESTAMP
        FROM payments p
        WHERE pa.payment_id=p.id
          AND p.debt_payment_group_id=$1
      `, [groupId], client);

      for (const payment of payments) {
        await rebalancePaymentDocument(payment, client);
      }

      const totalAmount = ledgerNumber(payments.reduce((sum, payment) => sum + +(payment.amount || 0), 0));
      await logOperation(client, {
        action: 'debt_payment_cancelled',
        entity_type: 'debt_payment_group',
        entity_id: null,
        entity_label: `Погашение ${groupId}`,
        amount: totalAmount,
        currency: 'USD',
        description: 'Отмена погашения долга',
        meta: {
          group_id: groupId,
          reason,
          payment_ids: payments.map((payment) => payment.id),
          reverse_transaction_ids: reverseTransactionIds,
        },
      });

      return {
        group_id: groupId,
        cancelled_payments: payments.length,
        amount: totalAmount,
        reverse_transaction_ids: reverseTransactionIds,
      };
    });

    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.get('/api/debts', async (req, res) => {
  const debts = await all(`
    WITH ${activePaymentAllocationsCte()},
    receivable_totals AS (
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
      SELECT
        CASE WHEN pae.document_type='sales_document' THEN pae.document_id ELSE -pae.document_id END AS receivable_group_id,
        COALESCE(SUM(pae.amount::numeric),0) AS paid
      FROM payment_allocations_effective pae
      WHERE pae.document_type IN ('sale','sales_document')
      GROUP BY CASE WHEN pae.document_type='sales_document' THEN pae.document_id ELSE -pae.document_id END
    ),
    receipt_totals AS (
      SELECT r.id AS receipt_id, r.date, r.created_at, r.supplier_id, s.name AS supplier_name, COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      LEFT JOIN suppliers s ON s.id = r.supplier_id
      GROUP BY r.id, r.date, r.created_at, r.supplier_id, s.name
    ),
    receipt_payments AS (
      SELECT document_id AS receipt_id, COALESCE(SUM(amount::numeric),0) AS paid
      FROM payment_allocations_effective
      WHERE document_type='receipt'
      GROUP BY document_id
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
    WITH ${activePaymentAllocationsCte()},
    receipt_totals AS (
      SELECT r.id, r.supplier_id, COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      GROUP BY r.id, r.supplier_id
    ),
    receipt_payments AS (
      SELECT document_id AS receipt_id, COALESCE(SUM(amount::numeric),0) AS paid
      FROM payment_allocations_effective
      WHERE document_type='receipt'
      GROUP BY document_id
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
    WITH payment_base AS (
      SELECT
        p.id,
        CASE
          WHEN p.debt_payment_group_id IS NOT NULL THEN 'group:' || p.debt_payment_group_id
          ELSE 'payment:' || p.id::text
        END AS group_key,
        p.entity_type,
        p.entity_id,
        p.amount::numeric AS amount,
        p.date,
        p.comment,
        p.transaction_id,
        p.debt_payment_group_id,
        COALESCE(pa_alloc.allocation_count, 0)::integer AS allocation_count,
        p.cancelled_at,
        p.cancelled_reason,
        p.cancelled_meta,
        t.type,
        COALESCE(t.account_to_id, t.account_from_id) AS cashbox_id,
        a.name AS account_name,
        p.created_at,
        COALESCE(c.name, cp.name) AS client_name,
        COALESCE(su.name, sp.name) AS supplier_name,
        pr.name AS product_name
      FROM payments p
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS allocation_count
        FROM payment_allocations pa
        WHERE pa.payment_id = p.id
          AND pa.cancelled_at IS NULL
      ) pa_alloc ON TRUE
      LEFT JOIN transactions t ON t.id = p.transaction_id
      LEFT JOIN accounts a ON a.id = COALESCE(t.account_to_id, t.account_from_id)
      LEFT JOIN sales s ON p.entity_type='sale' AND s.id = p.entity_id
      LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
      LEFT JOIN sales s2 ON s2.id = t.sale_id
      LEFT JOIN sales_documents sd2 ON sd2.id = s2.sales_document_id
      LEFT JOIN purchases pu ON p.entity_type='purchase' AND pu.id = p.entity_id
      LEFT JOIN receipts r ON r.id = t.receipt_id
      LEFT JOIN clients ca ON p.entity_type='client_advance' AND ca.id = p.entity_id
      LEFT JOIN clients cp ON p.entity_type='client' AND cp.id = p.entity_id
      LEFT JOIN suppliers sp ON p.entity_type='supplier' AND sp.id = p.entity_id
      LEFT JOIN clients c ON c.id = COALESCE(sd.client_id, s.client_id, sd2.client_id, s2.client_id, pu.client_id, ca.id)
      LEFT JOIN suppliers su ON su.id = COALESCE(pu.supplier_id, r.supplier_id)
      LEFT JOIN products pr ON pr.id = COALESCE(s.product_id, s2.product_id, pu.product_id)
    )
    SELECT
      MIN(id)::integer AS id,
      CASE
        WHEN BOOL_OR(entity_type='purchase') THEN 'purchase'
        WHEN BOOL_OR(entity_type='sale') THEN 'sale'
        WHEN BOOL_OR(entity_type='client_advance') THEN 'client_advance'
        ELSE MIN(entity_type)
      END AS entity_type,
      MIN(entity_id)::integer AS entity_id,
      SUM(amount::numeric) AS amount,
      MIN(date)::text AS date,
      MIN(NULLIF(comment, '')) AS comment,
      MIN(transaction_id)::integer AS transaction_id,
      MAX(debt_payment_group_id)::text AS debt_payment_group_id,
      MAX(debt_payment_group_id)::text AS group_id,
      COUNT(*)::integer AS payment_count,
      MAX(allocation_count)::integer AS allocation_count,
      ((MAX(debt_payment_group_id) IS NOT NULL AND COUNT(*) > 1) OR MAX(allocation_count) > 1) AS is_group,
      ARRAY_AGG(id ORDER BY id)::integer[] AS payment_ids,
      MAX(cancelled_at)::timestamp AS cancelled_at,
      MAX(cancelled_reason)::text AS cancelled_reason,
      COALESCE(MAX(cancelled_meta::text), '{}')::jsonb AS cancelled_meta,
      CASE
        WHEN BOOL_OR(type='expense') THEN 'expense'
        WHEN BOOL_OR(type='income') THEN 'income'
        ELSE MIN(type)
      END AS type,
      CASE WHEN COUNT(DISTINCT cashbox_id) = 1 THEN MAX(cashbox_id)::integer ELSE NULL::integer END AS cashbox_id,
      CASE WHEN COUNT(DISTINCT account_name) = 1 THEN MAX(account_name) ELSE 'Несколько касс' END AS account_name,
      MIN(created_at)::timestamp AS created_at,
      MAX(client_name)::text AS client_name,
      MAX(supplier_name)::text AS supplier_name,
      CASE WHEN COUNT(*) = 1 THEN MAX(product_name) ELSE NULL::text END AS product_name,
      COALESCE(MAX(client_name), MAX(supplier_name), '—')::text AS entity_name
    FROM payment_base
    GROUP BY group_key
    ORDER BY MIN(date) DESC, MIN(id) DESC, MIN(created_at) DESC
  `));
});

app.put('/api/payments/:id', async (req, res) => {
  const paymentId = +req.params.id;
  const amount = ledgerNumber(req.body.amount);
  const cashboxId = +(req.body.cashbox_id || req.body.account_id || req.body.account_to_id || req.body.account_from_id);
  const date = req.body.date || null;
  const comment = req.body.comment || null;

  if (!paymentId) return validationError(res, 'Платеж не найден', { payment_id: req.params.id });
  if (!(amount > 0)) return validationError(res, 'Сумма должна быть больше 0', { payment_id: paymentId, amount });
  if (!cashboxId) return validationError(res, 'Касса обязательна', { payment_id: paymentId, cashbox_id: cashboxId });
  if (!date) return validationError(res, 'Дата обязательна', { payment_id: paymentId, date });

  try {
    const result = await withTx(async (client) => {
      const payment = await get('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId], client);
      if (!payment) {
        const error = new Error('Платеж не найден');
        error.statusCode = 404;
        throw error;
      }
      if (payment.cancelled_at) throw new Error('Отменённый платеж нельзя редактировать');
      if (payment.debt_payment_group_id) {
        const groupCount = await get(
          'SELECT COUNT(*)::int AS cnt FROM payments WHERE debt_payment_group_id=$1 AND cancelled_at IS NULL',
          [payment.debt_payment_group_id],
          client
        );
        if (groupCount.cnt > 1) {
          throw new Error('Групповое погашение из нескольких платежей нельзя редактировать частично. Отмените погашение целиком и создайте новое.');
        }
      }

      const oldAmount = ledgerNumber(payment.amount);
      const transaction = await getPaymentTransaction(payment, client);
      const direction = ['purchase', 'supplier'].includes(payment.entity_type) ? 'out' : 'in';
      const oldCashboxId = direction === 'out' ? +(transaction?.account_from_id || 0) : +(transaction?.account_to_id || 0);
      let transactionType = direction === 'out' ? 'expense' : 'income';
      let receiptId = transaction?.receipt_id ? +transaction.receipt_id : null;
      let saleId = transaction?.sale_id ? +transaction.sale_id : null;
      let entityLabel = `Платеж №${paymentId}`;
      let description = 'Изменён платеж';
      let logEntityType = 'payment';
      let logEntityId = paymentId;
      let counterpartyName = '';

      if (payment.entity_type === 'client' || payment.entity_type === 'supplier') {
        const isSupplier = payment.entity_type === 'supplier';
        const counterparty = isSupplier
          ? await get('SELECT id,name FROM suppliers WHERE id=$1', [+payment.entity_id], client)
          : await get('SELECT id,name FROM clients WHERE id=$1', [+payment.entity_id], client);
        if (!counterparty) throw new Error(isSupplier ? 'Поставщик для платежа не найден' : 'Клиент для платежа не найден');

        const oldAllocations = await all('SELECT document_type,document_id FROM payment_allocations WHERE payment_id=$1', [paymentId], client);
        const documents = isSupplier
          ? await getSupplierOpenDebtDocuments(+payment.entity_id, client, paymentId)
          : await getClientOpenDebtDocuments(+payment.entity_id, client, paymentId);
        const totalDebt = ledgerNumber(documents.reduce((sum, document) => sum + +(document.remaining || 0), 0));
        if (isSupplier && amount > totalDebt + 0.009) throw new Error('Сумма оплаты превышает общий долг поставщика');

        await validatePaymentCashEdit({
          direction,
          oldAccountId: oldCashboxId || null,
          oldAmount: transaction ? oldAmount : 0,
          newAccountId: cashboxId,
          newAmount: amount,
        }, client);

        await query('DELETE FROM payment_allocations WHERE payment_id=$1', [paymentId], client);

        let remainingPayment = amount;
        const newAllocations = [];
        for (const document of documents) {
          if (remainingPayment <= 0.009) break;
          const part = ledgerNumber(Math.min(remainingPayment, +(document.remaining || 0)));
          if (!(part > 0)) continue;
          const documentType = isSupplier
            ? 'receipt'
            : (document.document_type === 'sales_document' ? 'sales_document' : 'sale');
          await query(`
            INSERT INTO payment_allocations(payment_id,document_type,document_id,amount)
            VALUES($1,$2,$3,$4)
          `, [paymentId, documentType, document.document_id, part], client);
          newAllocations.push({ document_type: documentType, document_id: document.document_id, amount: part });
          remainingPayment = ledgerNumber(remainingPayment - part);
        }

        if (remainingPayment > 0.009) {
          if (isSupplier) throw new Error('Не удалось распределить оплату по открытым документам');
          await query(`
            INSERT INTO payment_allocations(payment_id,document_type,document_id,amount)
            VALUES($1,$2,$3,$4)
          `, [paymentId, 'client_advance', +payment.entity_id, remainingPayment], client);
          newAllocations.push({ document_type: 'client_advance', document_id: +payment.entity_id, amount: remainingPayment });
        }

        await query('UPDATE payments SET amount=$1,date=$2,comment=$3 WHERE id=$4', [amount, date, comment, paymentId], client);
        if (transaction) {
          await query(`
            UPDATE transactions
            SET type=$1,
                amount=$2,
                account_from_id=$3,
                account_to_id=$4,
                receipt_id=NULL,
                sale_id=NULL,
                date=$5,
                comment=$6,
                related_type='payment',
                related_id=$7
            WHERE id=$8
          `, [
            transactionType,
            amount,
            isSupplier ? cashboxId : null,
            isSupplier ? null : cashboxId,
            date,
            comment,
            paymentId,
            transaction.id,
          ], client);
          if (!payment.transaction_id) {
            await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, paymentId], client);
          }
        } else {
          const created = await get(`
            INSERT INTO transactions(type,amount,account_from_id,account_to_id,date,comment,related_type,related_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            RETURNING id
          `, [
            transactionType,
            amount,
            isSupplier ? cashboxId : null,
            isSupplier ? null : cashboxId,
            date,
            comment,
            'payment',
            paymentId,
          ], client);
          await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [created.id, paymentId], client);
        }

        for (const allocation of [...oldAllocations, ...newAllocations]) {
          await rebalanceAllocationDocument(allocation.document_type, allocation.document_id, client);
        }

        await logOperation(client, {
          action: 'payment_updated',
          entity_type: payment.entity_type,
          entity_id: +payment.entity_id,
          entity_label: counterparty.name || (isSupplier ? `Поставщик №${payment.entity_id}` : `Клиент №${payment.entity_id}`),
          amount,
          currency: 'USD',
          description: isSupplier ? `Изменён платеж поставщику ${counterparty.name || ''}` : `Изменён платеж клиента ${counterparty.name || ''}`,
          meta: {
            old_amount: oldAmount,
            new_amount: amount,
            old_cashbox_id: oldCashboxId || null,
            new_cashbox_id: cashboxId,
            old_date: payment.date,
            new_date: date,
            old_comment: payment.comment || null,
            new_comment: comment,
            entity_type: payment.entity_type,
            entity_id: +payment.entity_id,
            payment_id: paymentId,
            allocation_count: newAllocations.length,
          },
        });

        return {
          id: paymentId,
          entity_type: payment.entity_type,
          entity_id: +payment.entity_id,
          amount,
          cashbox_id: cashboxId,
          date,
          comment,
        };
      }

      if (payment.entity_type === 'purchase') {
        const purchase = await get(`
          SELECT p.*, r.id AS receipt_id, COALESCE(r.supplier_id, p.supplier_id) AS effective_supplier_id, s.name AS supplier_name
          FROM purchases p
          LEFT JOIN receipts r ON r.id = p.receipt_id
          LEFT JOIN suppliers s ON s.id = COALESCE(r.supplier_id, p.supplier_id)
          WHERE p.id=$1
        `, [+payment.entity_id], client);
        if (!purchase) throw new Error('Приход для платежа не найден');
        receiptId = receiptId || (purchase.receipt_id ? +purchase.receipt_id : null);
        counterpartyName = purchase.supplier_name || 'Поставщик';
        entityLabel = receiptId ? `Приход №${receiptId}` : `Приход №${payment.entity_id}`;
        description = `Изменён платеж поставщику ${counterpartyName}`;
        logEntityType = receiptId ? 'receipt' : 'purchase';
        logEntityId = receiptId || +payment.entity_id;

        let availableDebt = 0;
        if (receiptId) {
          const totalRow = await get('SELECT COALESCE(SUM(total_cost::numeric),0) AS total FROM purchases WHERE receipt_id=$1', [receiptId], client);
          const paidExcluding = await getReceiptPaidAmountExcluding(receiptId, paymentId, client);
          availableDebt = ledgerNumber(+(totalRow?.total || 0) - paidExcluding);
        } else {
          const paidExcluding = +(await get(`
            SELECT COALESCE(SUM(amount::numeric),0) AS total
            FROM payments
            WHERE entity_type='purchase' AND entity_id=$1 AND id<>$2 AND cancelled_at IS NULL
          `, [+payment.entity_id, paymentId], client))?.total || 0;
          availableDebt = ledgerNumber(+(purchase.total_cost || 0) - paidExcluding);
        }
        if (amount > availableDebt + 0.009) throw new Error('Сумма оплаты превышает доступный долг поставщика');
      } else if (payment.entity_type === 'sale') {
        const sale = await get(`
          SELECT s.*, COALESCE(sd.client_id, s.client_id) AS effective_client_id, c.name AS client_name
          FROM sales s
          LEFT JOIN sales_documents sd ON sd.id = s.sales_document_id
          LEFT JOIN clients c ON c.id = COALESCE(sd.client_id, s.client_id)
          WHERE s.id=$1
        `, [+payment.entity_id], client);
        if (!sale) throw new Error('Реализация для платежа не найдена');
        saleId = +payment.entity_id;
        counterpartyName = sale.client_name || 'Клиент';
        entityLabel = sale.sales_document_id ? `Реализация №${sale.sales_document_id}` : `Реализация №${sale.id}`;
        description = `Изменён платеж клиента ${counterpartyName}`;
        logEntityType = sale.sales_document_id ? 'sales_document' : 'sale';
        logEntityId = sale.sales_document_id ? +sale.sales_document_id : +sale.id;
      } else if (payment.entity_type === 'client_advance') {
        const customer = await get('SELECT id,name FROM clients WHERE id=$1', [+payment.entity_id], client);
        if (!customer) throw new Error('Клиент для аванса не найден');
        counterpartyName = customer.name || 'Клиент';
        entityLabel = counterpartyName;
        description = `Изменён аванс клиента ${counterpartyName}`;
        logEntityType = 'client';
        logEntityId = +payment.entity_id;
      } else {
        throw new Error('Неподдерживаемый тип платежа');
      }

      await validatePaymentCashEdit({
        direction,
        oldAccountId: oldCashboxId || null,
        oldAmount: transaction ? oldAmount : 0,
        newAccountId: cashboxId,
        newAmount: amount,
      }, client);

      await query('UPDATE payments SET amount=$1,date=$2,comment=$3 WHERE id=$4', [amount, date, comment, paymentId], client);

      if (transaction) {
        await query(`
          UPDATE transactions
          SET type=$1,
              amount=$2,
              account_from_id=$3,
              account_to_id=$4,
              receipt_id=$5,
              sale_id=$6,
              date=$7,
              comment=$8,
              related_type=$9,
              related_id=$10
          WHERE id=$11
        `, [
          transactionType,
          amount,
          direction === 'out' ? cashboxId : null,
          direction === 'in' ? cashboxId : null,
          direction === 'out' ? receiptId : null,
          payment.entity_type === 'sale' ? saleId : null,
          date,
          comment,
          payment.entity_type === 'client_advance' ? 'client_advance' : 'payment',
          paymentId,
          transaction.id,
        ], client);
        if (!payment.transaction_id) {
          await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [transaction.id, paymentId], client);
        }
      } else {
        const created = await get(`
          INSERT INTO transactions(type,amount,account_from_id,account_to_id,receipt_id,sale_id,date,comment,related_type,related_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id
        `, [
          transactionType,
          amount,
          direction === 'out' ? cashboxId : null,
          direction === 'in' ? cashboxId : null,
          direction === 'out' ? receiptId : null,
          payment.entity_type === 'sale' ? saleId : null,
          date,
          comment,
          payment.entity_type === 'client_advance' ? 'client_advance' : 'payment',
          paymentId,
        ], client);
        await query('UPDATE payments SET transaction_id=$1 WHERE id=$2', [created.id, paymentId], client);
      }

      await rebalancePaymentDocument({ ...payment, amount }, client);

      await logOperation(client, {
        action: 'payment_updated',
        entity_type: logEntityType,
        entity_id: logEntityId,
        entity_label: entityLabel,
        amount,
        currency: 'USD',
        description,
        meta: {
          old_amount: oldAmount,
          new_amount: amount,
          old_cashbox_id: oldCashboxId || null,
          new_cashbox_id: cashboxId,
          old_date: payment.date,
          new_date: date,
          old_comment: payment.comment || null,
          new_comment: comment,
          entity_type: payment.entity_type,
          entity_id: +payment.entity_id,
          payment_id: paymentId,
        },
      });

      return {
        id: paymentId,
        entity_type: payment.entity_type,
        entity_id: +payment.entity_id,
        amount,
        cashbox_id: cashboxId,
        date,
        comment,
      };
    });

    res.json({ success: true, payment: result });
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

// Ledger
app.get('/api/ledger', async (req, res) => {
  const { type, id } = req.query;
  const entityId = +id;
  if (!['client', 'supplier'].includes(type) || !entityId) return res.status(400).json({ error: 'type и id обязательны' });

  const rows = type === 'client'
    ? await all(`
        WITH ${activePaymentAllocationsCte()}
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
            MIN(pae.payment_date)::text AS date,
            'payment'::text AS type,
            pae.payment_id::integer AS id,
            COALESCE(SUM(pae.amount::numeric),0) AS amount,
            NULL::numeric AS paid_amount,
            MIN(pae.payment_comment)::text AS comment,
            a.name::text AS account_name,
            t.type::text AS transaction_type,
            MIN(pae.payment_created_at)::timestamp AS created_at,
            1::integer AS sort_order
          FROM payment_allocations_effective pae
          LEFT JOIN sales s ON pae.document_type='sale' AND s.id=pae.document_id
          LEFT JOIN sales_documents sd ON pae.document_type='sales_document' AND sd.id=pae.document_id
          LEFT JOIN transactions t ON t.id=pae.transaction_id
          LEFT JOIN accounts a ON a.id=COALESCE(t.account_to_id,t.account_from_id)
          WHERE pae.document_type IN ('sale','sales_document','client_advance')
            AND COALESCE(sd.client_id, s.client_id, CASE WHEN pae.document_type='client_advance' THEN pae.document_id ELSE NULL END)=$1
          GROUP BY pae.payment_id, a.name, t.type
        ) x
        ORDER BY date ASC, created_at ASC, sort_order ASC, id ASC
      `, [entityId])
    : await all(`
        WITH ${activePaymentAllocationsCte()}
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
            MIN(pae.payment_date)::text AS date,
            'payment'::text AS type,
            pae.payment_id::integer AS id,
            COALESCE(SUM(pae.amount::numeric),0) AS amount,
            NULL::numeric AS paid_amount,
            MIN(pae.payment_comment)::text AS comment,
            a.name::text AS account_name,
            t.type::text AS transaction_type,
            MIN(pae.payment_created_at)::timestamp AS created_at,
            1::integer AS sort_order
          FROM payment_allocations_effective pae
          LEFT JOIN receipts r ON pae.document_type='receipt' AND r.id=pae.document_id
          LEFT JOIN purchases p ON pae.document_type='purchase' AND p.id=pae.document_id
          LEFT JOIN transactions t ON t.id=pae.transaction_id
          LEFT JOIN accounts a ON a.id=COALESCE(t.account_to_id,t.account_from_id)
          WHERE pae.document_type IN ('receipt','purchase')
            AND COALESCE(r.supplier_id, p.supplier_id)=$1
          GROUP BY pae.payment_id, a.name, t.type
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
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='owner_contribution' AND account_to_id=a.id),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='cash_adjustment_in' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='expense' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='withdraw' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='owner_withdrawal' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='cash_adjustment_out' AND account_from_id=a.id),0)
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
  await logOperation({
    action: 'cashbox_created',
    entity_type: 'account',
    entity_id: row.id,
    entity_label: name.trim(),
    description: 'Создана касса',
    meta: { currency: currency.trim().toUpperCase() },
  });
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

app.get('/api/expenses', async (req, res) => {
  try {
    const params = [];
    const where = ["t.type='expense'", "COALESCE(t.related_type,'')='manual'"];
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;
    const cashboxId = req.query.cashbox_id ? +req.query.cashbox_id : null;
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    if (dateFrom) {
      if (!isDateParam(dateFrom)) return res.status(400).json({ error: 'date_from должен быть в формате YYYY-MM-DD' });
      params.push(dateFrom);
      where.push(`t.date >= $${params.length}::date`);
    }
    if (dateTo) {
      if (!isDateParam(dateTo)) return res.status(400).json({ error: 'date_to должен быть в формате YYYY-MM-DD' });
      params.push(dateTo);
      where.push(`t.date <= $${params.length}::date`);
    }
    if (cashboxId) {
      params.push(cashboxId);
      where.push(`t.account_from_id = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(COALESCE(t.comment,'') ILIKE $${params.length} OR COALESCE(a.name,'') ILIKE $${params.length})`);
    }

    const whereSql = where.join(' AND ');
    const summary = await get(`
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(t.amount::numeric),0) AS total_amount
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_from_id
      WHERE ${whereSql}
    `, params);

    const items = await all(`
      SELECT
        t.id,
        t.date::text AS date,
        t.created_at::text AS created_at,
        t.account_from_id AS cashbox_id,
        a.name AS cashbox_name,
        t.amount::numeric AS amount,
        t.comment,
        COALESCE(NULLIF(t.comment,''), 'Расход бизнеса') AS description,
        t.type
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_from_id
      WHERE ${whereSql}
      ORDER BY t.date DESC, t.id DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({
      items: items.map((item) => ({
        ...item,
        id: +item.id,
        cashbox_id: item.cashbox_id == null ? null : +item.cashbox_id,
        amount: +(item.amount || 0),
      })),
      summary: {
        total_amount: +(summary?.total_amount || 0),
        count: +(summary?.count || 0),
      },
      total: +(summary?.count || 0),
      limit,
      offset,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const actionByType = {
    transfer: 'cashbox_transfer',
    income: 'income',
    expense: 'expense',
    withdraw: 'owner_withdrawal',
  };
  await logOperation({
    action: actionByType[type] || type,
    entity_type: 'transaction',
    entity_id: row.id,
    entity_label: `Движение №${row.id}`,
    amount: +amount,
    currency: 'USD',
    description: type === 'transfer' ? 'Перевод между кассами' : 'Создано движение денег',
    meta: { type, account_from_id: accountFromId || null, account_to_id: accountToId || null, receipt_id: receiptId, sale_id: saleId, related_type: related_type || null, related_id: related_id || null, comment: comment || null },
  });
  res.json({ id: row.id });
});

app.post('/api/transactions/manual', async (req, res) => {
  const { type, amount, date, comment } = req.body;
  const accountId = +(req.body.cash_account_id || req.body.account_id);
  const context = { type, amount: +amount, account_id: accountId || null, receipt_id: null, sale_id: null };

  if (!['owner_contribution', 'owner_withdrawal', 'cash_adjustment_in', 'cash_adjustment_out', 'income', 'expense'].includes(type)) {
    return validationError(res, 'Некорректный тип операции', context);
  }
  if (!accountId) return validationError(res, 'Касса обязательна', context);
  if (!(+amount > 0)) return validationError(res, 'Сумма должна быть больше 0', context);
  if (!date) return validationError(res, 'Дата обязательна', context);

  const isOutflow = type === 'owner_withdrawal' || type === 'cash_adjustment_out' || type === 'expense';
  const isInflow = type === 'owner_contribution' || type === 'cash_adjustment_in' || type === 'income';
  const accountFromId = isOutflow ? accountId : null;
  const accountToId = isInflow ? accountId : null;

  if (isOutflow && await getAccountBalance(accountId) < +amount) {
    return validationError(res, 'Недостаточно средств в кассе', context);
  }

  const row = await get(`
    INSERT INTO transactions(type,amount,account_from_id,account_to_id,date,comment,related_type)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    RETURNING id
  `, [type, +amount, accountFromId, accountToId, date, comment || null, 'manual']);
  await logOperation({
    action: type,
    entity_type: 'transaction',
    entity_id: row.id,
    entity_label: `Движение №${row.id}`,
    amount: +amount,
    currency: 'USD',
    description: 'Создано ручное движение денег',
    meta: { type, account_id: accountId, account_from_id: accountFromId, account_to_id: accountToId, comment: comment || null },
  });
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
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='owner_contribution' AND account_to_id=a.id),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='cash_adjustment_in' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='expense' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='withdraw' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='owner_withdrawal' AND account_from_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='cash_adjustment_out' AND account_from_id=a.id),0)
      + COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_to_id=a.id),0)
      - COALESCE((SELECT SUM(amount::numeric) FROM transactions WHERE type='transfer' AND account_from_id=a.id),0)
      AS balance_actual,
      COALESCE(SUM(CASE
        WHEN t.type='income' AND t.account_to_id=a.id THEN t.amount::numeric
        WHEN t.type='owner_contribution' AND t.account_to_id=a.id THEN t.amount::numeric
        WHEN t.type='cash_adjustment_in' AND t.account_to_id=a.id THEN t.amount::numeric
        WHEN t.type='expense' AND t.account_from_id=a.id THEN -t.amount::numeric
        WHEN t.type='withdraw' AND t.account_from_id=a.id THEN -t.amount::numeric
        WHEN t.type='owner_withdrawal' AND t.account_from_id=a.id THEN -t.amount::numeric
        WHEN t.type='cash_adjustment_out' AND t.account_from_id=a.id THEN -t.amount::numeric
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
    WHERE (
      type='income'
      AND sale_id IS NULL
      AND COALESCE(related_type,'') NOT IN ('manual','client_advance','payment')
    )
       OR (
      type='expense'
      AND receipt_id IS NULL
      AND COALESCE(related_type,'') NOT IN ('manual','payment','debt_payment_cancel')
    )
    ORDER BY id DESC
  `);

  const debtSummary = await debtSummaryData();
  const debtLedger = await debtsLedgerData();
  const receivableSystem = +(debtSummary.receivable?.total || 0);
  const receivableLedger = +(debtLedger.summary?.receivable || 0);
  const payableSystem = debtSummary.payable.total;
  const payableLedger = +(debtLedger.summary?.payable || 0);
  const debtsDiff = (receivableSystem - receivableLedger) + (payableSystem - payableLedger);
  const profit = await profitSummaryData();
  const costMethodSummary = await all(`
    ${salesCostCte()}
    SELECT
      cost_method AS method,
      COUNT(*)::int AS count,
      COALESCE(SUM(revenue::numeric),0) AS revenue,
      COALESCE(SUM(cost::numeric),0) AS cost,
      COALESCE(SUM(revenue::numeric - cost::numeric),0) AS profit,
      CASE
        WHEN cost_method IN ('product_average','legacy_fallback','unknown') THEN 'warning'
        WHEN cost_method='manual_override' THEN 'manual'
        ELSE 'ok'
      END AS status
    FROM sales_costed
    GROUP BY cost_method
    ORDER BY
      CASE
        WHEN cost_method='manual_override' THEN 1
        WHEN cost_method='actual_receipt_cost' THEN 2
        WHEN cost_method='legacy_fallback' THEN 3
        WHEN cost_method='product_average' THEN 4
        ELSE 5
      END
  `);
  const costMethodDetails = await all(`
    ${salesCostCte()},
    ranked AS (
      SELECT
        sc.cost_method AS method,
        sc.id::integer AS sale_id,
        sc.sales_document_id::integer AS sales_document_id,
        sc.date::text AS sale_date,
        c.name::text AS client_name,
        pr.name::text AS product_name,
        m.marking::text AS marking_name,
        sc.sale_unit::text AS sale_unit,
        CASE WHEN sc.sale_unit='pcs' THEN sc.quantity ELSE NULL END AS quantity,
        CASE WHEN sc.sale_unit='kg' THEN sc.quantity ELSE NULL END AS weight_kg,
        sc.revenue::numeric AS revenue,
        sc.cost::numeric AS cost,
        (sc.revenue::numeric - sc.cost::numeric) AS profit,
        sc.source_row::integer AS source_row,
        sc.notes::text AS source_info,
        CASE
          WHEN sc.cost_method='product_average' THEN 'Нет точной связи с приходом/source_row, себестоимость взята как средняя по товару.'
          WHEN sc.cost_method='legacy_fallback' THEN 'Legacy продажа без точного purchase match.'
          ELSE 'Не удалось определить точный метод себестоимости.'
        END AS reason,
        ROW_NUMBER() OVER (PARTITION BY sc.cost_method ORDER BY sc.date DESC NULLS LAST, sc.id DESC) AS rn
      FROM sales_costed sc
      LEFT JOIN clients c ON c.id=sc.client_id
      LEFT JOIN products pr ON pr.id=sc.product_id
      LEFT JOIN markings m ON m.id=sc.marking_id
      WHERE sc.cost_method IN ('product_average','legacy_fallback','unknown')
    )
    SELECT *
    FROM ranked
    WHERE rn <= 50
    ORDER BY
      CASE
        WHEN method='legacy_fallback' THEN 1
        WHEN method='product_average' THEN 2
        ELSE 3
      END,
      sale_date DESC NULLS LAST,
      sale_id DESC
  `);
  const ownerContributionRow = await get(`
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM transactions
    WHERE type='owner_contribution'
  `);
  const ownerWithdrawalRow = await get(`
    SELECT COALESCE(SUM(amount::numeric),0) AS total
    FROM transactions
    WHERE type='owner_withdrawal'
  `);
  const ownerContributionTotal = +(ownerContributionRow?.total || 0);
  const ownerWithdrawalTotal = +(ownerWithdrawalRow?.total || 0);
  const ownerCapitalTotal = ownerContributionTotal - ownerWithdrawalTotal;
  const supplierBySuppliers = await get(`
    WITH ${activePaymentAllocationsCte()},
    receipt_totals AS (
      SELECT r.id, r.supplier_id, COALESCE(SUM(p.total_cost::numeric),0) AS total
      FROM receipts r
      JOIN purchases p ON p.receipt_id = r.id
      GROUP BY r.id, r.supplier_id
    ),
    receipt_payments AS (
      SELECT document_id AS receipt_id, COALESCE(SUM(amount::numeric),0) AS paid
      FROM payment_allocations_effective
      WHERE document_type='receipt'
      GROUP BY document_id
    ),
    supplier_debts AS (
      SELECT s.id, COALESCE(SUM(rt.total::numeric - COALESCE(rp.paid::numeric,0)),0) AS debt
      FROM suppliers s
      LEFT JOIN receipt_totals rt ON rt.supplier_id = s.id
      LEFT JOIN receipt_payments rp ON rp.receipt_id = rt.id
      GROUP BY s.id
      HAVING COALESCE(SUM(rt.total::numeric - COALESCE(rp.paid::numeric,0)),0) > 0
    )
    SELECT COALESCE(SUM(debt::numeric),0) AS total
    FROM supplier_debts
  `);

  const accountsTotal = accounts.reduce((sum, account) => sum + (+account.balance_actual || +account.balance || 0), 0);
  const transactionsTotal = +(await get(`
    SELECT COALESCE(SUM(CASE
      WHEN type='income' THEN amount::numeric
      WHEN type='owner_contribution' THEN amount::numeric
      WHEN type='cash_adjustment_in' THEN amount::numeric
      WHEN type='expense' THEN -amount::numeric
      WHEN type='withdraw' THEN -amount::numeric
      WHEN type='owner_withdrawal' THEN -amount::numeric
      WHEN type='cash_adjustment_out' THEN -amount::numeric
      ELSE 0
    END),0) AS total
    FROM transactions
  `))?.total || 0;
  const globalDiff = accountsTotal - transactionsTotal;
  const controlWithOwnerOps = accountsTotal
    + (+(debtSummary.receivable?.total || 0))
    - (+(debtSummary.payable?.total || 0))
    - (+(profit.profit || 0))
    - ownerCapitalTotal;
  const impliedProfit = accountsTotal
    + (+(debtSummary.receivable?.total || 0))
    - (+(debtSummary.payable?.total || 0))
    - ownerCapitalTotal;
  const reportedProfit = +(profit.profit || 0);
  const profitDifference = reportedProfit - impliedProfit;
  const supplierSummaryTotal = +(debtSummary.supplier_payable?.total || 0);
  const supplierLedgerTotal = +(debtLedger.summary?.supplier_payable || 0);
  const supplierBySuppliersTotal = +(supplierBySuppliers?.total || 0);
  const supplierLedgerDifference = supplierSummaryTotal - supplierLedgerTotal;
  const supplierBySuppliersDifference = supplierSummaryTotal - supplierBySuppliersTotal;

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
      supplier_payable_total: +(debtSummary.supplier_payable?.total || 0),
      supplier_payable_ledger_total: +(debtLedger.summary?.supplier_payable || 0),
      client_advances_total: +(debtSummary.client_advances?.total || 0),
      difference: debtsDiff,
      diff: debtsDiff,
      ok: Math.abs(debtsDiff) < 0.01,
    },
    supplier_reconciliation: {
      summary_total: supplierSummaryTotal,
      ledger_total: supplierLedgerTotal,
      by_suppliers_total: supplierBySuppliersTotal,
      ledger_difference: supplierLedgerDifference,
      by_suppliers_difference: supplierBySuppliersDifference,
      status: Math.abs(supplierLedgerDifference) < 0.01 && Math.abs(supplierBySuppliersDifference) < 0.01 ? 'ok' : 'warning',
      note: Math.abs(supplierLedgerDifference) < 0.01 && Math.abs(supplierBySuppliersDifference) < 0.01
        ? 'Поставщики сходятся между audit, ledger и /api/debts/by-suppliers.'
        : 'Проверьте legacy payments, cancelled payments или allocation-aware расчёт поставщиков.',
    },
    profit_reconciliation: {
      reported_profit: reportedProfit,
      implied_profit: impliedProfit,
      profit_difference: profitDifference,
      formula: 'cash + receivable - payable - owner_capital',
      status: Math.abs(profitDifference) <= 0.05 ? 'ok' : 'warning',
      note: Math.abs(profitDifference) <= 0.05
        ? 'Прибыль по P&L сходится с балансной прибылью.'
        : 'Прибыль по P&L отличается от балансной прибыли. Возможная причина — legacy/fallback себестоимость или продажи без точной связи с приходом.',
    },
    cost_method_summary: costMethodSummary.map((row) => ({
      method: row.method || 'unknown',
      count: +(row.count || 0),
      revenue: +(row.revenue || 0),
      cost: +(row.cost || 0),
      profit: +(row.profit || 0),
      status: row.status || 'warning',
    })),
    cost_method_details: costMethodDetails.map((row) => ({
      method: row.method || 'unknown',
      sale_id: row.sale_id == null ? null : +row.sale_id,
      sales_document_id: row.sales_document_id == null ? null : +row.sales_document_id,
      sale_date: row.sale_date || null,
      document_date: row.sale_date || null,
      client_name: row.client_name || 'Без клиента',
      product_name: row.product_name || 'Без товара',
      marking_name: row.marking_name || '',
      sale_unit: row.sale_unit || '',
      quantity: row.quantity == null ? null : +(row.quantity || 0),
      weight_kg: row.weight_kg == null ? null : +(row.weight_kg || 0),
      revenue: +(row.revenue || 0),
      cost: +(row.cost || 0),
      profit: +(row.profit || 0),
      source_row: row.source_row == null ? null : +row.source_row,
      source_info: row.source_info || '',
      reason: row.reason || '',
    })),
    global_check: {
      accounts_total: accountsTotal,
      transactions_total: transactionsTotal,
      receivable_total: +(debtSummary.receivable?.total || 0),
      payable_total: +(debtSummary.payable?.total || 0),
      supplier_payable_total: +(debtSummary.supplier_payable?.total || 0),
      client_advances_total: +(debtSummary.client_advances?.total || 0),
      profit_total: +(profit.profit || 0),
      manual_expenses_total: +(profit.manual_expenses || 0),
      owner_contribution_total: ownerContributionTotal,
      owner_withdrawal_total: ownerWithdrawalTotal,
      owner_capital_total: ownerCapitalTotal,
      control_with_owner_ops: controlWithOwnerOps,
      control_with_owner_ok: Math.abs(controlWithOwnerOps) < 0.01,
      diff: globalDiff,
      ok: Math.abs(globalDiff) < 0.01,
    },
    owner_contribution_total: ownerContributionTotal,
    owner_withdrawal_total: ownerWithdrawalTotal,
    owner_capital_total: ownerCapitalTotal,
    client_advances_total: +(debtSummary.client_advances?.total || 0),
    control_with_owner_ops: controlWithOwnerOps,
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
  res.json(await profitSummaryData({
    date_from: req.query.date_from || null,
    date_to: req.query.date_to || null,
  }));
});

app.get('/api/analytics/dashboard', async (req, res) => {
  const profit = await profitSummaryData();
  const clients = await get('SELECT COUNT(*)::int AS count FROM clients');
  const sales = await get('SELECT COUNT(*)::int AS count FROM sales');
  const purchases = await get('SELECT COUNT(*)::int AS count FROM purchases');
  const debts = await debtSummaryData();
  const profitByDate = await all(`
    ${salesCostCte()}
    SELECT
      sc.date::text AS date,
      COALESCE(SUM(sc.revenue),0) AS sales,
      COALESCE(SUM(sc.cost),0) AS costs,
      COALESCE((
        SELECT SUM(t.amount::numeric)
        FROM transactions t
        WHERE t.type='expense'
          AND COALESCE(t.related_type,'')='manual'
          AND t.date = sc.date
      ),0) AS expenses,
      COALESCE(SUM(sc.revenue),0) - COALESCE(SUM(sc.cost),0) AS gross_profit,
      COALESCE(SUM(sc.revenue),0) - COALESCE(SUM(sc.cost),0) - COALESCE((
        SELECT SUM(t.amount::numeric)
        FROM transactions t
        WHERE t.type='expense'
          AND COALESCE(t.related_type,'')='manual'
          AND t.date = sc.date
      ),0) AS profit
    FROM sales_costed sc
    GROUP BY sc.date
    ORDER BY sc.date
    LIMIT 30
  `);
  const topClients = await all(`
    ${salesCostCte()}
    SELECT
      c.name,
      COALESCE(SUM(sc.revenue),0) AS value,
      COALESCE(SUM(sc.revenue),0) AS total_sales,
      COALESCE(SUM(sc.cost),0) AS total_costs,
      COALESCE(SUM(sc.revenue),0) - COALESCE(SUM(sc.cost),0) AS profit
    FROM sales_costed sc
    LEFT JOIN clients c ON c.id = sc.client_id
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
  res.json(await analyticsProfitData(req.query.period, {
    date_from: req.query.date_from || null,
    date_to: req.query.date_to || null,
  }));
});

app.post('/api/ai/command', async (req, res) => {
  const command = String(req.body.command || '').trim();
  const text = command.toLowerCase();

  if (!command) {
    return res.status(400).json({ type: 'error', message: 'Введите команду' });
  }

  if (text.includes('прибыл')) {
    const period = text.includes('сегодня')
      ? 'today'
      : text.includes('недел')
        ? 'week'
        : text.includes('месяц')
          ? 'month'
          : text.includes('год')
            ? 'year'
            : '';
    const data = await analyticsProfitData(period);
    const label = period === 'today'
      ? 'за сегодня'
      : period === 'week'
        ? 'за неделю'
        : period === 'month'
          ? 'за месяц'
          : period === 'year'
            ? 'за год'
            : 'за всё время';
    return res.json({
      type: 'analytics',
      message: `Прибыль ${label}: $${(+(data.profit || 0)).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      data: {
        sales: +(data.totalSales || 0),
        costs: +(data.totalCosts || 0),
        profit: +(data.profit || 0),
      },
    });
  }

  if (text.includes('баланс')) {
    const debts = await debtSummaryData();
    return res.json({
      type: 'balance',
      message: 'Баланс рассчитан',
      data: {
        assets: +(debts?.receivable?.total || 0),
        liabilities: +(debts?.payable?.total || 0),
        balance: +(debts?.balance || 0),
      },
    });
  }

  if (text.includes('должник') || text.includes('долг')) {
    const rows = await all(`
      SELECT id,date,total_amount::numeric - COALESCE(paid_amount::numeric,0) AS amount, notes AS comment
      FROM sales
      WHERE total_amount::numeric - COALESCE(paid_amount::numeric,0) > 0
      ORDER BY date DESC
      LIMIT 10
    `);
    return res.json({
      type: 'debtors',
      message: rows.length ? `Найдено долгов: ${rows.length}` : 'Должников нет',
      data: rows,
    });
  }

  if (text.includes('клиент')) {
    const rows = await all('SELECT id,name,phone FROM clients ORDER BY name LIMIT 20');
    return res.json({
      type: 'clients',
      message: rows.length ? `Клиентов в списке: ${rows.length}` : 'Клиентов пока нет',
      data: rows,
    });
  }

  return res.json({
    type: 'info',
    message: `Команда принята: ${command}. Для отчётов попробуйте “прибыль за неделю”, “баланс” или “должники”.`,
  });
});

const dist = path.join(__dirname, 'client', 'dist');
console.log('Serving frontend from:', dist);

app.use(express.static(dist));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'));
});

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
