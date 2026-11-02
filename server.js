const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const db = new Database(process.env.DB_PATH || 'queue.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

app.use(express.json());
app.use(express.static('public'));

// ==================== Schema ====================
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT,
  motivity_webhook TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, tenant_id TEXT, username TEXT UNIQUE,
  password_hash TEXT, role TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, prefix TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, service_id TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, tenant_id TEXT, service_id TEXT, number INTEGER,
  priority INTEGER DEFAULT 0, status TEXT DEFAULT 'waiting',
  counter_id TEXT, created_at TEXT, called_at TEXT, served_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wait
  ON tickets(tenant_id, service_id, status, priority DESC, number);
CREATE INDEX IF NOT EXISTS idx_served
  ON tickets(tenant_id, status, served_at);
`);

// ==================== Seed ====================
if (!db.prepare('SELECT id FROM tenants WHERE slug=?').get('demo')) {
  const tid = crypto.randomUUID();
  db.prepare('INSERT INTO tenants (id,slug,name,motivity_webhook,created_at) VALUES (?,?,?,?,?)')
    .run(tid, 'demo', 'مركز خدمة تجريبي', '', new Date().toISOString());
  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO services (id,tenant_id,name,prefix) VALUES (?,?,?,?)')
    .run(sid, tid, 'خدمة عامة', 'A');
  const sid2 = crypto.randomUUID();
  db.prepare('INSERT INTO services (id,tenant_id,name,prefix) VALUES (?,?,?,?)')
    .run(sid2, tid, 'خدمة VIP', 'V');
  ['كاونتر 1','كاونتر 2','كاونتر 3'].forEach(n =>
    db.prepare('INSERT INTO counters (id,tenant_id,name,service_id) VALUES (?,?,?,?)')
      .run(crypto.randomUUID(), tid, n, sid));
}
if (!db.prepare('SELECT id FROM users WHERE username=?').get('admin')) {
  const demoTenant = db.prepare('SELECT id FROM tenants WHERE slug=?').get('demo');
  db.prepare('INSERT INTO users (id,tenant_id,username,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(), demoTenant.id, 'admin',
      bcrypt.hashSync('admin123', 10), 'tenant_admin', new Date().toISOString());
}
if (!db.prepare('SELECT id FROM users WHERE username=?').get('super')) {
  db.prepare('INSERT INTO users (id,tenant_id,username,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(), null, 'super',
      bcrypt.hashSync('super123', 10), 'super_admin', new Date().toISOString());
}

// ==================== SSE ====================
const clients = new Map();
function broadcast(tenantSlug, event, data) {
  const set = clients.get(tenantSlug);
  if (set) for (const res of set) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ==================== Auth middleware ====================
function auth(role) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no token' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload;
      if (role && payload.role !== role) return res.status(403).json({ error: 'forbidden' });
      next();
    } catch {
      res.status(401).json({ error: 'invalid token' });
    }
  };
}

// ==================== Login ====================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'بيانات دخول غير صحيحة' });
  let tenantSlug = null;
  if (user.tenant_id) {
    const t = db.prepare('SELECT slug FROM tenants WHERE id=?').get(user.tenant_id);
    tenantSlug = t ? t.slug : null;
  }
  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role,
      tenant_id: user.tenant_id, tenant_slug: tenantSlug },
    JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, role: user.role, tenant_slug: tenantSlug });
});

// ==================== Tenant resolver ====================
app.use('/api/:tenant', (req, res, next) => {
  const t = db.prepare('SELECT * FROM tenants WHERE slug=?').get(req.params.tenant);
  if (!t) return res.status(404).json({ error: 'tenant not found' });
  req.tenant = t;
  next();
});

// ==================== Public kiosk & display ====================
app.get('/api/:tenant/services', (req, res) =>
  res.json(db.prepare('SELECT * FROM services WHERE tenant_id=? ORDER BY name')
    .all(req.tenant.id)));

app.get('/api/:tenant/counters', (req, res) =>
  res.json(db.prepare('SELECT * FROM counters WHERE tenant_id=? ORDER BY name')
    .all(req.tenant.id)));

app.post('/api/:tenant/tickets', (req, res) => {
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND tenant_id=?')
    .get(req.body.service_id, req.tenant.id);
  if (!svc) return res.status(400).json({ error: 'invalid service' });
  const max = db.prepare('SELECT MAX(number) m FROM tickets WHERE tenant_id=? AND service_id=?')
    .get(req.tenant.id, svc.id);
  const num = (max.m || 0) + 1;
  const id = crypto.randomUUID();
  const priority = req.body.priority ? 1 : 0;
  db.prepare('INSERT INTO tickets (id,tenant_id,service_id,number,priority,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, req.tenant.id, svc.id, num, priority, new Date().toISOString());
  const ticket = { id, number: num, prefix: svc.prefix, service: svc.name, priority };
  broadcast(req.tenant.slug, 'ticket_created', ticket);
  res.json(ticket);
});

app.get('/api/:tenant/queue', (req, res) => {
  const waiting = db.prepare(`
    SELECT t.*, s.prefix, s.name service FROM tickets t
    JOIN services s ON s.id=t.service_id
    WHERE t.tenant_id=? AND t.status='waiting'
    ORDER BY t.priority DESC, t.number`).all(req.tenant.id);
  const called = db.prepare(`
    SELECT t.*, s.prefix, s.name service, c.name counter FROM tickets t
    JOIN services s ON s.id=t.service_id
    LEFT JOIN counters c ON c.id=t.counter_id
    WHERE t.tenant_id=? AND t.status='called'
    ORDER BY t.called_at DESC LIMIT 10`).all(req.tenant.id);
  res.json({ waiting, called });
});

app.get('/api/:tenant/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write('\n');
  const slug = req.tenant.slug;
  if (!clients.has(slug)) clients.set(slug, new Set());
  clients.get(slug).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.get(slug).delete(res); });
});

// ==================== Agent operations ====================
app.post('/api/:tenant/tickets/:id/call', auth(), async (req, res) => {
  if (req.user.tenant_id !== req.tenant.id) return res.status(403).json({ error: 'forbidden' });
  const t = db.prepare('SELECT * FROM tickets WHERE id=? AND tenant_id=?')
    .get(req.params.id, req.tenant.id);
  const c = db.prepare('SELECT * FROM counters WHERE id=? AND tenant_id=?')
    .get(req.body.counter_id, req.tenant.id);
  if (!t || !c) return res.status(400).json({ error: 'invalid ticket/counter' });
  db.prepare('UPDATE tickets SET status=?, counter_id=?, called_at=? WHERE id=?')
    .run('called', c.id, new Date().toISOString(), t.id);
  const svc = db.prepare('SELECT * FROM services WHERE id=?').get(t.service_id);
  const payload = {
    ticket: { number: t.number, prefix: svc.prefix, priority: t.priority },
    counter: c.name,
    called_at: new Date().toISOString()
  };
  broadcast(req.tenant.slug, 'ticket_called', payload);
  if (req.tenant.motivity_webhook) {
    try {
      await fetch(req.tenant.motivity_webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'queue.call', tenant: req.tenant.slug, ...payload })
      });
    } catch (e) { console.error('Motivity webhook failed:', e.message); }
  }
  res.json(payload);
});

app.post('/api/:tenant/tickets/:id/serve', auth(), (req, res) => {
  if (req.user.tenant_id !== req.tenant.id) return res.status(403).json({ error: 'forbidden' });
  db.prepare('UPDATE tickets SET status=?, served_at=? WHERE id=? AND tenant_id=?')
    .run('served', new Date().toISOString(), req.params.id, req.tenant.id);
  broadcast(req.tenant.slug, 'ticket_served', { id: req.params.id });
  res.json({ ok: true });
});

// ==================== Admin (tenant) ====================
app.get('/api/admin/services', auth('tenant_admin'), (req, res) =>
  res.json(db.prepare('SELECT * FROM services WHERE tenant_id=?').all(req.user.tenant_id)));

app.post('/api/admin/services', auth('tenant_admin'), (req, res) => {
  const { name, prefix } = req.body || {};
  if (!name || !prefix) return res.status(400).json({ error: 'بيانات ناقصة' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO services (id,tenant_id,name,prefix) VALUES (?,?,?,?)')
    .run(id, req.user.tenant_id, name, prefix);
  res.json({ id });
});

app.delete('/api/admin/services/:id', auth('tenant_admin'), (req, res) => {
  db.prepare('DELETE FROM services WHERE id=? AND tenant_id=?')
    .run(req.params.id, req.user.tenant_id);
  res.json({ ok: true });
});

app.get('/api/admin/counters', auth('tenant_admin'), (req, res) =>
  res.json(db.prepare(`
    SELECT c.*, s.name service FROM counters c
    LEFT JOIN services s ON s.id=c.service_id
    WHERE c.tenant_id=?`).all(req.user.tenant_id)));

app.post('/api/admin/counters', auth('tenant_admin'), (req, res) => {
  const { name, service_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'بيانات ناقصة' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO counters (id,tenant_id,name,service_id) VALUES (?,?,?,?)')
    .run(id, req.user.tenant_id, name, service_id || null);
  res.json({ id });
});

app.delete('/api/admin/counters/:id', auth('tenant_admin'), (req, res) => {
  db.prepare('DELETE FROM counters WHERE id=? AND tenant_id=?')
    .run(req.params.id, req.user.tenant_id);
  res.json({ ok: true });
});

app.get('/api/admin/users', auth('tenant_admin'), (req, res) =>
  res.json(db.prepare('SELECT id,username,role,created_at FROM users WHERE tenant_id=?')
    .all(req.user.tenant_id)));

app.post('/api/admin/users', auth('tenant_admin'), (req, res) => {
  const { username, password, role = 'agent' } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'بيانات ناقصة' });
  try {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users (id,tenant_id,username,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, req.user.tenant_id, username, bcrypt.hashSync(password, 10), role, new Date().toISOString());
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
  }
});

app.delete('/api/admin/users/:id', auth('tenant_admin'), (req, res) => {
  db.prepare("DELETE FROM users WHERE id=? AND tenant_id=? AND role!='tenant_admin'")
    .run(req.params.id, req.user.tenant_id);
  res.json({ ok: true });
});

app.get('/api/admin/tenant', auth('tenant_admin'), (req, res) => {
  const t = db.prepare('SELECT slug,name,motivity_webhook FROM tenants WHERE id=?')
    .get(req.user.tenant_id);
  res.json(t);
});

app.put('/api/admin/tenant', auth('tenant_admin'), (req, res) => {
  db.prepare('UPDATE tenants SET name=?, motivity_webhook=? WHERE id=?')
    .run(req.body.name, req.body.motivity_webhook || '', req.user.tenant_id);
  res.json({ ok: true });
});

app.get('/api/admin/reports/summary', auth('tenant_admin'), (req, res) => {
  const tid = req.user.tenant_id;
  const today = new Date().toISOString().slice(0, 10);
  const total = db.prepare("SELECT COUNT(*) c FROM tickets WHERE tenant_id=? AND date(created_at)=?")
    .get(tid, today).c;
  const waiting = db.prepare("SELECT COUNT(*) c FROM tickets WHERE tenant_id=? AND status='waiting'")
    .get(tid).c;
  const served = db.prepare("SELECT COUNT(*) c FROM tickets WHERE tenant_id=? AND status='served' AND date(served_at)=?")
    .get(tid, today).c;
  const avgWait = db.prepare(`
    SELECT AVG((julianday(called_at)-julianday(created_at))*24*60) m FROM tickets
    WHERE tenant_id=? AND called_at IS NOT NULL AND date(created_at)=?`).get(tid, today).m || 0;
  const avgServe = db.prepare(`
    SELECT AVG((julianday(served_at)-julianday(called_at))*24*60) m FROM tickets
    WHERE tenant_id=? AND served_at IS NOT NULL AND date(created_at)=?`).get(tid, today).m || 0;
  const byService = db.prepare(`
    SELECT s.name service, COUNT(t.id) total,
      SUM(CASE WHEN t.status='served' THEN 1 ELSE 0 END) served
    FROM services s LEFT JOIN tickets t
      ON t.service_id=s.id AND date(t.created_at)=?
    WHERE s.tenant_id=? GROUP BY s.id`).all(today, tid);
  const byCounter = db.prepare(`
    SELECT c.name counter, COUNT(t.id) served
    FROM counters c LEFT JOIN tickets t
      ON t.counter_id=c.id AND t.status='served' AND date(t.served_at)=?
    WHERE c.tenant_id=? GROUP BY c.id`).all(today, tid);
  res.json({
    total, waiting, served,
    avgWaitMin: Math.round(avgWait),
    avgServeMin: Math.round(avgServe),
    byService, byCounter
  });
});

// ==================== Super Admin ====================
app.get('/api/super/tenants', auth('super_admin'), (req, res) => {
  const list = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) users,
      (SELECT COUNT(*) FROM tickets k WHERE k.tenant_id=t.id) tickets
    FROM tenants t ORDER BY t.created_at DESC`).all();
  res.json(list);
});

app.post('/api/super/tenants', auth('super_admin'), (req, res) => {
  const { slug, name, admin_username, admin_password } = req.body || {};
  if (!slug || !name || !admin_username || !admin_password)
    return res.status(400).json({ error: 'كل الحقول مطلوبة' });
  try {
    const tid = crypto.randomUUID();
    db.prepare('INSERT INTO tenants (id,slug,name,motivity_webhook,created_at) VALUES (?,?,?,?,?)')
      .run(tid, slug, name, '', new Date().toISOString());
    const sid = crypto.randomUUID();
    db.prepare('INSERT INTO services (id,tenant_id,name,prefix) VALUES (?,?,?,?)')
      .run(sid, tid, 'خدمة عامة', 'A');
    db.prepare('INSERT INTO counters (id,tenant_id,name,service_id) VALUES (?,?,?,?)')
      .run(crypto.randomUUID(), tid, 'كاونتر 1', sid);
    db.prepare('INSERT INTO users (id,tenant_id,username,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), tid, admin_username,
        bcrypt.hashSync(admin_password, 10), 'tenant_admin', new Date().toISOString());
    res.json({ id: tid, slug });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/super/tenants/:id', auth('super_admin'), (req, res) => {
  const tid = req.params.id;
  db.prepare('DELETE FROM tickets WHERE tenant_id=?').run(tid);
  db.prepare('DELETE FROM counters WHERE tenant_id=?').run(tid);
  db.prepare('DELETE FROM services WHERE tenant_id=?').run(tid);
  db.prepare('DELETE FROM users WHERE tenant_id=?').run(tid);
  db.prepare('DELETE FROM tenants WHERE id=?').run(tid);
  res.json({ ok: true });
});

// ==================== Start ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   Kiosk:   /kiosk/demo`);
  console.log(`   Display: /display/demo`);
  console.log(`   Agent:   /agent/demo`);
  console.log(`   Admin:   /login  (admin / admin123)`);
  console.log(`   Super:   /login  (super / super123)`);
});