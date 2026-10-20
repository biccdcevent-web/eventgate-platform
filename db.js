'use strict';
// Database setup. Upgrades a single-event database (the first version of this system) into the
// multi-event layout automatically, after saving an untouched copy in backups/pre-upgrade-*.db.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const EG = require('./lib/shared');

const REG_COLUMNS = `
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER NOT NULL,
    pass_code       TEXT NOT NULL UNIQUE,
    first_name      TEXT,
    last_name       TEXT,
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL COLLATE NOCASE,
    designation     TEXT,
    company_name    TEXT,
    company_address TEXT,
    contact_number  TEXT,
    extra           TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    email_sent_at   TEXT,
    checked_in_at   TEXT,
    UNIQUE (event_id, email)`;

// Default charts on a new event's dashboard (only for fields the form actually has).
function defaultCharts(config) {
  const on = new Set(config.form.fields.filter((f) => f.enabled).map((f) => f.key));
  const out = [];
  if (on.has('designation')) out.push(['Registrants by designation', 'designation', 'count', 'bar', 'all']);
  if (on.has('company_name')) {
    out.push(['Share of registrants by company', 'company', 'count', 'pie', 'all']);
    out.push(['Attendance rate by company', 'company', 'rate', 'bar', 'all']);
  }
  const addr = config.form.fields.find((f) => f.key === 'company_address' && f.enabled && f.type === 'address_ph');
  if (addr) out.push(['Registrants by province', 'f:company_address@province', 'count', 'bar', 'all']);
  out.push(['Registrations by day of the week', 'regWeekday', 'count', 'column', 'all']);
  return out;
}

function slugify(s) {
  let out = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out.length > 40) out = out.slice(0, 40).replace(/-[^-]*$/, '');
  return out || 'event';
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function openDb(dbPath, env = process.env) {
  const dataDir = path.dirname(dbPath);
  const backupDir = path.join(dataDir, 'backups');
  const uploadsDir = path.join(dataDir, 'uploads');
  for (const d of [dataDir, backupDir, uploadsDir]) fs.mkdirSync(d, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const hasTable = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
  const cols = (t) => (hasTable(t) ? db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) : []);
  const legacy = hasTable('registrations') && !cols('registrations').includes('event_id');

  if (legacy) {
    const copy = path.join(backupDir, `pre-upgrade-${stamp()}.db`);
    db.prepare('VACUUM INTO ?').run(copy);
    console.log(`[upgrade] Saved a copy of the database before upgrading: ${copy}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      status     TEXT NOT NULL DEFAULT 'draft',
      staff_pin  TEXT NOT NULL,
      config     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      can_export    INTEGER NOT NULL DEFAULT 1,
      active        INTEGER NOT NULL DEFAULT 1,
      session_ver   INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_events (
      user_id  INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, event_id)
    );
  `);
  if (!hasTable('saved_charts')) {
    db.exec(`CREATE TABLE saved_charts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, dimension TEXT NOT NULL,
      metric TEXT NOT NULL, chart_type TEXT NOT NULL, filter TEXT NOT NULL DEFAULT 'all', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  } else if (!cols('saved_charts').includes('event_id')) {
    db.exec('ALTER TABLE saved_charts ADD COLUMN event_id INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasTable('backups')) {
    db.exec(`CREATE TABLE backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL DEFAULT 0, file TEXT NOT NULL UNIQUE, reason TEXT NOT NULL,
      created_by TEXT NOT NULL, registrations INTEGER NOT NULL, checked_in INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  } else if (!cols('backups').includes('event_id')) {
    db.exec('ALTER TABLE backups ADD COLUMN event_id INTEGER NOT NULL DEFAULT 0');
  }

  const insertEvent = db.prepare('INSERT INTO events (slug, status, staff_pin, config) VALUES (?, ?, ?, ?)');
  const insertChart = db.prepare('INSERT INTO saved_charts (event_id, title, dimension, metric, chart_type, filter) VALUES (?, ?, ?, ?, ?, ?)');

  // The first event is described by the old EVENT_* settings, so an upgraded portal keeps working unchanged.
  function createFirstEvent() {
    const name = env.EVENT_NAME || 'My first event';
    const config = EG.defaultConfig({
      name, date: env.EVENT_DATE || '', venue: env.EVENT_VENUE || '', organizer: env.ORGANIZER_NAME || '',
      timezone: env.EVENT_TZ || 'Asia/Manila',
    });
    const m = String(env.MAIL_FROM || '').match(/^\s*"?([^"<]*?)"?\s*</);
    if (m && m[1].trim()) config.email.fromName = m[1].trim();
    const clean = EG.sanitizeConfig(config, config);
    const slug = slugify(env.FIRST_EVENT_SLUG || name);
    const pin = env.STAFF_PIN || String(crypto.randomInt(100000, 999999));
    const id = insertEvent.run(slug, 'open', pin, JSON.stringify(clean)).lastInsertRowid;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('home_event', ?)").run(slug);
    return { id, config: clean, slug };
  }

  const migrate = db.transaction(() => {
    if (legacy) {
      const first = createFirstEvent();
      const have = new Set(cols('registrations'));
      const keep = ['id', 'pass_code', 'first_name', 'last_name', 'full_name', 'email', 'designation', 'company_name',
        'company_address', 'contact_number', 'created_at', 'email_sent_at', 'checked_in_at'].filter((c) => have.has(c));
      db.exec(`CREATE TABLE registrations_new (${REG_COLUMNS})`);
      db.prepare(`INSERT INTO registrations_new (event_id, ${keep.join(', ')}) SELECT ?, ${keep.join(', ')} FROM registrations`).run(first.id);
      db.exec('DROP TABLE registrations; ALTER TABLE registrations_new RENAME TO registrations;');
      db.prepare('UPDATE saved_charts SET event_id = ? WHERE event_id = 0').run(first.id);
      db.prepare('UPDATE backups SET event_id = ? WHERE event_id = 0').run(first.id);
      db.prepare('INSERT OR IGNORE INTO user_events (user_id, event_id) SELECT id, ? FROM users').run(first.id);
      if (!db.prepare('SELECT 1 FROM saved_charts WHERE event_id = ?').get(first.id)) {
        for (const c of defaultCharts(first.config)) insertChart.run(first.id, ...c);
      }
      console.log(`[upgrade] Moved ${db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n} registrations into event "${first.slug}".`);
    } else if (!hasTable('registrations')) {
      db.exec(`CREATE TABLE registrations (${REG_COLUMNS})`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS registrations_event ON registrations (event_id, id)');
    if (!db.prepare('SELECT 1 FROM events LIMIT 1').get() && env.EVENT_NAME) {
      const first = createFirstEvent();
      for (const c of defaultCharts(first.config)) insertChart.run(first.id, ...c);
    }
  });
  migrate();

  return { db, dataDir, backupDir, uploadsDir, defaultCharts, slugify };
}

module.exports = { openDb, defaultCharts, slugify };
