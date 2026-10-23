'use strict';
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const sharp = require('sharp');
const EG = require('./lib/shared');
const PH = require('./lib/ph');
const { openDb, defaultCharts, slugify } = require('./db');
const { sendPassEmail, renderPassEmail, senderAddress, imageSize } = require('./mailer');

const PORT = Number(process.env.PORT) || 3000;
const PASS_SECRET = process.env.PASS_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!PASS_SECRET || PASS_SECRET.length < 16) {
  console.error('PASS_SECRET must be set to a long random value (run: npm run secret).');
  process.exit(1);
}
if (!ADMIN_KEY) console.warn('ADMIN_KEY is not set: the administrator cannot sign in to the admin page.');

// ---------------------------------------------------------------- database
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'registrations.db');
const { db, backupDir, uploadsDir } = openDb(dbPath);
const PUBLIC_DIR = path.join(__dirname, 'public');

const q = {
  byCode: db.prepare('SELECT * FROM registrations WHERE pass_code = ?'),
  byEmail: db.prepare('SELECT * FROM registrations WHERE event_id = ? AND email = ?'),
  // Without an email, the same name with the same contact number counts as already registered.
  byNameContact: db.prepare(`SELECT * FROM registrations WHERE event_id = ? AND full_name = ? COLLATE NOCASE AND IFNULL(contact_number, '') = ? LIMIT 1`),
  insert: db.prepare(`INSERT INTO registrations
      (event_id, pass_code, first_name, last_name, full_name, email, designation, company_name, company_address, contact_number, extra)
      VALUES (@event_id, @pass_code, @first_name, @last_name, @full_name, @email, @designation, @company_name, @company_address, @contact_number, @extra)`),
  markSent: db.prepare(`UPDATE registrations SET email_sent_at = datetime('now') WHERE id = ?`),
  checkIn: db.prepare(`UPDATE registrations SET checked_in_at = datetime('now') WHERE id = ? AND checked_in_at IS NULL`),
  all: db.prepare('SELECT * FROM registrations WHERE event_id = ? ORDER BY id'),
  counts: db.prepare('SELECT COUNT(*) AS total, COUNT(checked_in_at) AS checkedIn FROM registrations WHERE event_id = ?'),
};
const evQ = {
  byId: db.prepare('SELECT * FROM events WHERE id = ?'),
  bySlug: db.prepare('SELECT * FROM events WHERE slug = ?'),
  all: db.prepare('SELECT * FROM events ORDER BY id DESC'),
  insert: db.prepare('INSERT INTO events (slug, status, staff_pin, config) VALUES (?, ?, ?, ?)'),
  update: db.prepare("UPDATE events SET slug = @slug, status = @status, staff_pin = @staff_pin, config = @config, updated_at = datetime('now') WHERE id = @id"),
  remove: db.prepare('DELETE FROM events WHERE id = ?'),
};
const getSetting = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);

const STATUSES = ['draft', 'open', 'closed', 'archived'];
// Pixel sizes of uploaded images (read once from the file), so pages can size two logos evenly.
const dimsCache = new Map();
function fileDims(src) {
  if (!src) return null;
  if (!dimsCache.has(src)) {
    const d = imageSize(path.join(uploadsDir, path.basename(src)));
    dimsCache.set(src, d && d.w && d.h ? { w: d.w, h: d.h } : null);
  }
  return dimsCache.get(src);
}
function withImageDims(config) {
  const b = config.branding;
  b.logoDims = fileDims(b.logo);
  b.logo2Dims = fileDims(b.logo2);
  return config;
}
function loadEvent(row) {
  if (!row) return null;
  let config;
  try { config = withImageDims(EG.sanitizeConfig(JSON.parse(row.config))); } catch { config = EG.defaultConfig(); }
  return { id: row.id, slug: row.slug, status: row.status, staffPin: row.staff_pin, config, createdAt: row.created_at, clientId: row.client_id || null };
}
const eventById = (id) => loadEvent(evQ.byId.get(Number(id)));
const eventBySlug = (slug) => loadEvent(evQ.bySlug.get(String(slug || '').toLowerCase()));
const homeEvent = () => { const s = getSetting('home_event'); return s ? eventBySlug(s) : null; };

// Live updates for the admin dashboards.
const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------------------------------------------------------------- passes
// Pass code: 8 characters without look-alikes (no 0/O, 1/I). The QR holds "CODE.SIGNATURE",
// where the signature is an HMAC, so a pass can't be invented without PASS_SECRET.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const sign = (code) => crypto.createHmac('sha256', PASS_SECRET).update(code).digest('base64url').slice(0, 16);
const tokenFor = (code) => `${code}.${sign(code)}`;
const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const sqlTimeToIso = (t) => (t ? t.replace(' ', 'T') + 'Z' : null);
const swapCase = (s) => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

function parseToken(raw) {
  const s = String(raw || '').trim();
  // Barcode scanners with Caps Lock on flip letter case, so also try the case-swapped version.
  for (const candidate of [s, swapCase(s)]) {
    const signed = candidate.match(/^([A-Z2-9]{8})\.([A-Za-z0-9_-]{16})$/);
    if (signed && crypto.timingSafeEqual(Buffer.from(sign(signed[1])), Buffer.from(signed[2]))) return { code: signed[1] };
  }
  if (/^[A-Za-z2-9]{8}\.[A-Za-z0-9_-]{16}$/.test(s)) return null; // a pass-shaped code with a bad signature
  const typed = s.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-9]{8}$/.test(typed) ? { code: typed } : null;
}

const qrPng = (text) => QRCode.toBuffer(text, { type: 'png', width: 520, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#FFFFFF' } });

// A field's answer as one short line (addresses become "City, Province"), for name tags and lists.
function shortValue(config, values, key) {
  if (!key) return '';
  const f = config.form.fields.find((x) => x.key === key);
  if (f && f.type === 'address_ph' && values[`${key}__parts`]) return EG.shortAddress(values[`${key}__parts`]);
  return values[key] || '';
}

// All answers of one registration, keyed by field.
function rowValues(r) {
  let extra = {};
  try { extra = JSON.parse(r.extra || '{}'); } catch {}
  const v = { ...extra };
  for (const k of EG.BUILTIN) if (r[k] != null) v[k] = r[k];
  if (!v.first_name && !v.last_name && r.full_name) {
    const i = r.full_name.lastIndexOf(' ');
    v.first_name = i > 0 ? r.full_name.slice(0, i) : r.full_name;
    v.last_name = i > 0 ? r.full_name.slice(i + 1) : '';
  }
  return v;
}

// Whether this registration gets an email: the event sends them, and the registrant gave an address.
const mailsTo = (ev, row) => Boolean(row.email) && ev.config.email.send !== false;

async function sendPass(ev, row, png) {
  if (!mailsTo(ev, row)) return false;
  png = png || (await qrPng(tokenFor(row.pass_code)));
  await sendPassEmail({ event: ev, values: rowValues(row), passCode: pretty(row.pass_code), qrPng: png, uploadsDir });
  q.markSent.run(row.id);
  return true;
}

function secretMatches(given, expected) {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- app
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  // The admin's settings editor previews the registration page in a frame on the same site.
  if (!req.query.preview) res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '256kb' }));

const tooMany = (message) => (req, res) => res.status(429).json({ message });
const REGISTER_LIMIT = Number(process.env.REGISTER_LIMIT) || 60;
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: REGISTER_LIMIT, handler: tooMany('Too many registrations from this network. Try again in a few minutes.') });
const onlyWrongSecret = { skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode !== 401 };
const staffPinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, ...onlyWrongSecret, handler: tooMany('Too many wrong PIN attempts. Wait 15 minutes.') });
const adminKeyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, ...onlyWrongSecret, handler: tooMany('Too many wrong sign-in attempts. Wait 15 minutes.') });
const checkinLimiter = rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.CHECKIN_LIMIT) || 600, handler: tooMany('Scanning too fast. Wait a moment.') });
const testMailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, handler: tooMany('Too many test emails. Wait a few minutes.') });

// ---------------------------------------------------------------- public event API
function publicEvent(ev) {
  const c = ev.config;
  const counts = q.counts.get(ev.id);
  return {
    slug: ev.slug,
    status: ev.status,
    full: Boolean(c.details.capacity && counts.total >= c.details.capacity),
    details: { name: c.details.name, date: c.details.date, venue: c.details.venue, organizer: c.details.organizer, intro: c.details.intro },
    branding: c.branding,
    form: {
      fields: c.form.fields.filter((f) => f.enabled),
      consent: c.form.consent,
      submitLabel: c.form.submitLabel,
      allowAnother: c.form.allowAnother,
      successTitle: c.form.successTitle,
      closedMessage: c.form.closedMessage,
    },
    badge: c.badge,
    checkin: c.checkin,
  };
}
const isPublic = (ev) => ev && (ev.status === 'open' || ev.status === 'closed' || ev.status === 'archived');
const notFound = (res) => res.status(404).json({ message: 'This event was not found. Check the link in your invitation.' });

function eventForPublic(req) {
  const ev = req.params.slug ? eventBySlug(req.params.slug) : homeEvent();
  return isPublic(ev) ? ev : null;
}

function handleEvent(req, res) {
  const ev = eventForPublic(req);
  if (!ev) return notFound(res);
  res.json(publicEvent(ev));
}

async function handleRegister(req, res) {
  const ev = eventForPublic(req);
  if (!ev) return notFound(res);
  const c = ev.config;
  if (ev.status !== 'open') return res.status(403).json({ message: ev.status === 'archived' ? 'This event has ended.' : c.form.closedMessage, closed: true });

  const { values, errors } = EG.checkSubmission(c, req.body || {});
  for (const f of c.form.fields) {
    const parts = values[`${f.key}__parts`];
    if (f.enabled && f.type === 'address_ph' && parts && !errors[f.key]) {
      const problem = PH.verify(parts);
      if (problem) errors[f.key] = problem;
    }
  }
  if (Object.keys(errors).length) return res.status(422).json({ errors });

  const fullName = `${values.first_name} ${values.last_name}`.trim();
  const alreadyRegistered = (row) => {
    if (!values.email || !row.email) return res.status(409).json({ message: `${row.full_name} is already registered.` });
    // Never return the existing QR here: anyone could type someone else's email.
    if (!mailsTo(ev, row)) return res.status(409).json({ message: `${row.email} is already registered.` });
    sendPass(ev, row).catch((err) => console.error(`[mail] Resend to ${row.email} failed:`, err.message));
    return res.status(409).json({ message: `${row.email} is already registered. We're sending ${c.checkin.qr ? 'that pass' : 'the confirmation'} to the same address again.` });
  };
  const existing = values.email ? q.byEmail.get(ev.id, values.email) : q.byNameContact.get(ev.id, fullName, values.contact_number || '');
  if (existing) return alreadyRegistered(existing);
  if (c.details.capacity && q.counts.get(ev.id).total >= c.details.capacity) {
    return res.status(403).json({ message: 'Sorry, this event is full.', closed: true });
  }

  const extra = {};
  for (const [k, v] of Object.entries(values)) if (!EG.BUILTIN.includes(k)) extra[k] = v;
  const rec = {
    event_id: ev.id,
    first_name: values.first_name, last_name: values.last_name, full_name: fullName,
    email: values.email || null,
    designation: values.designation || null, company_name: values.company_name || null,
    company_address: values.company_address || null, contact_number: values.contact_number || null,
    extra: JSON.stringify(extra),
  };
  let row = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const code = newCode();
    try {
      q.insert.run({ ...rec, pass_code: code });
      row = q.byCode.get(code);
    } catch (err) {
      if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
      if (err.message.includes('email')) return alreadyRegistered(q.byEmail.get(ev.id, values.email));
    }
  }
  if (!row) return res.status(500).json({ message: 'Registration could not be saved. Try again.' });
  bus.emit('change', { type: 'registered', eventId: ev.id });

  const png = await qrPng(tokenFor(row.pass_code));
  let emailSent = false;
  const emailing = mailsTo(ev, row);
  try { emailSent = await sendPass(ev, row, png); } catch (err) { console.error(`[mail] Sending to ${row.email} failed:`, err.message); }

  res.status(201).json({
    passCode: pretty(row.pass_code),
    fullName: row.full_name,
    email: row.email || '',
    emailing,
    emailSent,
    qr: c.checkin.qr ? `data:image/png;base64,${png.toString('base64')}` : null,
  });
}

// ---- staff check-in (each event has its own staff PIN)
function badgeLines(ev, row) {
  const v = rowValues(row);
  const b = ev.config.badge;
  return { name: row.full_name, line2: shortValue(ev.config, v, b.line2), line3: shortValue(ev.config, v, b.line3), passCode: pretty(row.pass_code) };
}
function staffEvent(req, res) {
  const ev = eventForPublic(req);
  if (!ev || ev.status === 'archived') { notFound(res); return null; }
  if (!ev.config.checkin.enabled) { res.status(403).json({ message: 'Check-in is turned off for this event.', disabled: true }); return null; }
  if (!secretMatches(req.get('x-staff-pin'), ev.staffPin)) { res.status(401).json({ message: 'That PIN is incorrect.' }); return null; }
  return ev;
}
// Staff look attendees up by name, email or company (used when the event has no QR pass, or someone lost theirs).
const searchQ = db.prepare(`SELECT * FROM registrations WHERE event_id = @event
  AND (full_name LIKE @q ESCAPE '\\' OR email LIKE @q ESCAPE '\\' OR company_name LIKE @q ESCAPE '\\' OR (first_name || ' ' || last_name) LIKE @q ESCAPE '\\')
  ORDER BY (checked_in_at IS NOT NULL), full_name COLLATE NOCASE LIMIT 12`);
function handleSearch(req, res) {
  const ev = staffEvent(req, res);
  if (!ev) return;
  const term = String((req.body || {}).q || '').replace(/\s+/g, ' ').trim();
  if (term.length < 2) return res.json({ results: [] });
  const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const results = searchQ.all({ event: ev.id, q: like }).map((r) => ({ ...badgeLines(ev, r), email: r.email, checkedInAt: sqlTimeToIso(r.checked_in_at) }));
  res.json({ results });
}
function handleVerify(req, res) {
  const ev = staffEvent(req, res);
  if (ev) res.json({ ok: true, counts: q.counts.get(ev.id) });
}
function handleCheckin(req, res) {
  const ev = staffEvent(req, res);
  if (!ev) return;
  const parsed = parseToken(req.body && req.body.token);
  const row = parsed && q.byCode.get(parsed.code);
  if (!row) return res.json({ status: 'invalid', message: 'This is not a valid pass for this event.', counts: q.counts.get(ev.id) });
  if (row.event_id !== ev.id) {
    const other = eventById(row.event_id);
    return res.json({ status: 'other_event', message: `This pass is for a different event${other ? `: ${other.config.details.name}` : ''}.`, counts: q.counts.get(ev.id) });
  }
  const firstTime = q.checkIn.run(row.id).changes === 1;
  if (firstTime) bus.emit('change', { type: 'checked_in', eventId: ev.id });
  const fresh = q.byCode.get(row.pass_code);
  res.json({ status: firstTime ? 'checked_in' : 'already', attendee: badgeLines(ev, fresh), checkedInAt: sqlTimeToIso(fresh.checked_in_at), counts: q.counts.get(ev.id) });
}

app.get('/api/e/:slug', handleEvent);
app.post('/api/e/:slug/register', registerLimiter, handleRegister);
app.post('/api/e/:slug/staff/verify', staffPinLimiter, handleVerify);
app.post('/api/e/:slug/checkin', checkinLimiter, staffPinLimiter, handleCheckin);
app.post('/api/e/:slug/staff/search', checkinLimiter, staffPinLimiter, handleSearch);
// Addresses used by the first version: they now mean "the event on the home page".
app.get('/api/event', handleEvent);
app.post('/api/register', registerLimiter, handleRegister);
app.post('/api/staff/verify', staffPinLimiter, handleVerify);
app.post('/api/checkin', checkinLimiter, staffPinLimiter, handleCheckin);

// ---------------------------------------------------------------- accounts
// Three kinds of account:
// - platform administrator ("owner"): signs in as ADMIN_USERNAME (default "admin") with ADMIN_KEY; sees everything.
// - client administrator ("manager"): belongs to one client; creates and manages that client's events,
//   settings, backups and accounts, and nothing else.
// - viewer ("client"): sees only the dashboards of the events assigned to them.
const clientQ = {
  list: db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE'),
  byId: db.prepare('SELECT * FROM clients WHERE id = ?'),
  byName: db.prepare('SELECT * FROM clients WHERE name = ?'),
  insert: db.prepare('INSERT INTO clients (name, contact, max_events) VALUES (?, ?, ?)'),
  update: db.prepare('UPDATE clients SET name = @name, contact = @contact, active = @active, max_events = @max_events WHERE id = @id'),
  remove: db.prepare('DELETE FROM clients WHERE id = ?'),
  eventIds: db.prepare('SELECT id FROM events WHERE client_id = ?'),
  activeEvents: db.prepare("SELECT COUNT(*) AS n FROM events WHERE client_id = ? AND status != 'archived'"),
  allEvents: db.prepare('SELECT COUNT(*) AS n FROM events WHERE client_id = ?'),
  users: db.prepare("SELECT COUNT(*) AS n, SUM(role = 'manager') AS managers FROM users WHERE client_id = ?"),
};
const clientNames = () => new Map(clientQ.list.all().map((c) => [c.id, c.name]));
// Whether a client may have one more event that isn't archived. Returns an error message, or ''.
function clientLimitProblem(clientId, exceptEventId) {
  const c = clientQ.byId.get(clientId);
  if (!c) return 'That client was not found.';
  if (!c.active) return `${c.name} is turned off. Turn the client on first.`;
  if (c.max_events) {
    let n = clientQ.activeEvents.get(c.id).n;
    if (exceptEventId) { const row = evQ.byId.get(exceptEventId); if (row && row.client_id === c.id && row.status !== 'archived') n -= 1; }
    if (n >= c.max_events) return `${c.name} can have up to ${c.max_events} active ${c.max_events === 1 ? 'event' : 'events'}. Archive one first, or ask the platform administrator to raise the limit.`;
  }
  return '';
}
const userQ = {
  list: db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  insert: db.prepare('INSERT INTO users (name, username, password_hash, can_export, can_charts, must_change_pw, role, client_id) VALUES (@name, @username, @password_hash, @can_export, @can_charts, 1, @role, @client_id)'),
  loggedIn: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  remove: db.prepare('DELETE FROM users WHERE id = ?'),
  events: db.prepare('SELECT event_id FROM user_events WHERE user_id = ?'),
};
const userEventIds = (uid) => userQ.events.all(uid).map((r) => r.event_id);
function setUserEvents(uid, ids) {
  db.transaction(() => {
    db.prepare('DELETE FROM user_events WHERE user_id = ?').run(uid);
    const ins = db.prepare('INSERT OR IGNORE INTO user_events (user_id, event_id) VALUES (?, ?)');
    for (const id of ids) if (evQ.byId.get(id)) ins.run(uid, id);
  })();
}

const OWNER_USERNAME = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const OWNER = { role: 'owner', id: 0, name: 'Administrator', username: OWNER_USERNAME, canExport: true, canCharts: true, eventIds: null, clientId: null, clientName: '' };
// The signed-in account for a user row, or null when it (or its client) is turned off.
function authForUser(u) {
  if (!u || !u.active) return null;
  const client = u.client_id ? clientQ.byId.get(u.client_id) : null;
  if (u.client_id && (!client || !client.active)) return null;
  const manager = u.role === 'manager' && Boolean(client);
  return {
    role: manager ? 'manager' : 'client', id: u.id, name: u.name, username: u.username,
    canExport: manager || Boolean(u.can_export), canCharts: manager || Boolean(u.can_charts), mustChange: Boolean(u.must_change_pw),
    clientId: client ? client.id : null, clientName: client ? client.name : '',
    eventIds: manager ? clientQ.eventIds.all(client.id).map((r) => r.id) : userEventIds(u.id),
  };
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));
function passwordMatches(pw, stored) {
  const [salt, hash] = String(stored || DUMMY_HASH).split(':');
  const got = crypto.scryptSync(String(pw || ''), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

const SESSION_COOKIE = 'jsi_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const ownerVer = () => crypto.createHash('sha256').update(ADMIN_KEY || '').digest('hex').slice(0, 16);
const sessionSig = (uid, ver, exp) => crypto.createHmac('sha256', PASS_SECRET).update(`session:${uid}:${ver}:${exp}`).digest('base64url');

function readCookie(req, name) {
  for (const part of String(req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function getAuth(req) {
  const given = req.get('x-admin-key') || req.query.key;
  if (given) return ADMIN_KEY && secretMatches(given, ADMIN_KEY) ? OWNER : null;
  const parts = readCookie(req, SESSION_COOKIE).split('.');
  if (parts.length !== 4) return null;
  const [uid, ver, exp, sig] = parts;
  if (!(Number(exp) > Date.now()) || !secretMatches(sig, sessionSig(uid, ver, exp))) return null;
  if (uid === '0') return ADMIN_KEY && ver === ownerVer() ? OWNER : null;
  const u = userQ.byId.get(Number(uid));
  if (!u || String(u.session_ver) !== ver) return null;
  return authForUser(u);
}
const canSee = (auth, eventId) => auth.role === 'owner' || auth.eventIds.includes(Number(eventId));

function setSession(req, res, uid, ver) {
  const secure = req.secure ? '; Secure' : '';
  if (uid === null) return res.set('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  const exp = Date.now() + SESSION_MS;
  // No Max-Age: the browser drops the cookie when it closes. The admin page also signs out when its tab
  // is closed (see admin.js). The 12-hour limit inside the cookie still applies.
  res.set('Set-Cookie', `${SESSION_COOKIE}=${uid}.${ver}.${exp}.${sessionSig(uid, ver, exp)}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}

// A client still using the temporary password from the administrator must choose their own before anything else.
const mustChangeFirst = (res) => res.status(403).json({ message: 'Choose your own password first.', mustChange: true });
const requireSignedIn = (req, res, next) => {
  req.auth = getAuth(req);
  if (!req.auth) return res.status(401).json({ message: 'Sign in to continue.' });
  if (req.auth.mustChange && !req.allowTemporaryPassword) return mustChangeFirst(res);
  next();
};
const requireOwner = (req, res, next) => {
  req.auth = getAuth(req);
  if (!req.auth) return res.status(401).json({ message: 'Sign in to continue.' });
  return req.auth.role === 'owner' ? next() : res.status(403).json({ message: 'Only the platform administrator can do this.' });
};
// The platform administrator or a client administrator (who is limited to their client's events and accounts).
const isEditor = (a) => a && (a.role === 'owner' || a.role === 'manager');
const requireEditor = (req, res, next) => {
  req.auth = getAuth(req);
  if (!req.auth) return res.status(401).json({ message: 'Sign in to continue.' });
  if (req.auth.mustChange) return mustChangeFirst(res);
  return isEditor(req.auth) ? next() : res.status(403).json({ message: 'Your account can view dashboards but not change events. Ask your administrator.' });
};
// Loads :id as req.ev, for anyone allowed to see that event.
const withEvent = (req, res, next) => {
  const ev = eventById(req.params.id);
  if (!ev || !canSee(req.auth, ev.id)) return res.status(404).json({ message: 'That event was not found.' });
  req.ev = ev;
  next();
};
const publicUser = (a) => ({ name: a.name, username: a.username, role: a.role, canExport: a.canExport, canCharts: a.canCharts, mustChange: Boolean(a.mustChange), clientName: a.clientName || '' });

app.post('/api/admin/login', adminKeyLimiter, (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password ?? b.key ?? '');
  const fail = () => res.status(401).json({ message: 'The username or password is incorrect.' });
  if (!username || username === OWNER_USERNAME) {
    passwordMatches(password); // same work either way, so timing doesn't reveal usernames
    if (!ADMIN_KEY || !secretMatches(password, ADMIN_KEY)) return fail();
    setSession(req, res, 0, ownerVer());
    return res.json({ ok: true, user: publicUser(OWNER) });
  }
  const u = userQ.byUsername.get(username);
  if (!passwordMatches(password, u && u.password_hash) || !u) return fail();
  if (!u.active) return res.status(403).json({ message: 'This account is turned off. Contact your administrator.' });
  const auth = authForUser(u);
  if (!auth) return res.status(403).json({ message: 'Your organization’s access is turned off. Contact the platform administrator.' });
  userQ.loggedIn.run(u.id);
  setSession(req, res, u.id, u.session_ver);
  res.json({ ok: true, user: publicUser(auth) });
});
app.post('/api/admin/logout', (req, res) => { setSession(req, res, null); res.json({ ok: true }); });
app.get('/api/admin/session', (req, res) => {
  const a = getAuth(req);
  res.json({ signedIn: Boolean(a), user: a ? publicUser(a) : null });
});

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use a password of at least 8 characters.';
  if (pw.length > 128) return 'Keep the password under 128 characters.';
  return '';
}

app.post('/api/admin/me/password', adminKeyLimiter, (req, res, next) => { req.allowTemporaryPassword = true; next(); }, requireSignedIn, (req, res) => {
  if (req.auth.role === 'owner') return res.status(422).json({ message: 'The administrator password is the ADMIN_KEY setting on Render.' });
  const u = userQ.byId.get(req.auth.id);
  const b = req.body || {};
  if (!passwordMatches(b.current, u.password_hash)) return res.status(422).json({ message: u.must_change_pw ? 'The temporary password is incorrect.' : 'Your current password is incorrect.', field: 'current' });
  const problem = passwordProblem(b.next);
  if (problem) return res.status(422).json({ message: problem });
  if (b.next === b.current) return res.status(422).json({ message: 'Choose a password different from the current one.' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_pw = 0, session_ver = session_ver + 1 WHERE id = ?').run(hashPassword(b.next), u.id);
  setSession(req, res, u.id, u.session_ver + 1);
  bus.emit('change', { type: 'sessions' });
  res.json({ ok: true });
});

// ---- accounts: the platform administrator manages all; a client administrator only their client's
const eventNames = () => new Map(evQ.all.all().map((r) => [r.id, loadEvent(r).config.details.name]));
function userOut(u, names = eventNames(), clients = clientNames()) {
  const manager = u.role === 'manager';
  return {
    id: u.id, name: u.name, username: u.username, role: manager ? 'manager' : 'viewer',
    clientId: u.client_id || null, clientName: u.client_id ? clients.get(u.client_id) || '' : '',
    canExport: manager || Boolean(u.can_export), canCharts: manager || Boolean(u.can_charts), active: Boolean(u.active),
    createdAt: sqlTimeToIso(u.created_at), lastLoginAt: sqlTimeToIso(u.last_login_at), temporaryPassword: Boolean(u.must_change_pw),
    // client administrators see all of their client's events, so no list is kept for them
    events: manager ? [] : userEventIds(u.id).filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) })),
  };
}
const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : []);
const canManageUser = (auth, u) => Boolean(u) && (auth.role === 'owner' || (auth.role === 'manager' && u.client_id === auth.clientId));
// Events a viewer of this client may be given: the client's own events (or any event for the platform's own viewers).
function eventsProblem(auth, clientId, events) {
  if (!events.length) return 'Choose at least one event this user can view.';
  for (const id of events) {
    const row = evQ.byId.get(id);
    if (!row || !canSee(auth, id)) return 'One of the chosen events was not found.';
    if (clientId && row.client_id !== clientId) return 'Viewers can only be given events of their own client.';
  }
  return '';
}

app.get('/api/admin/users', requireEditor, (req, res) => {
  const names = eventNames(), clients = clientNames();
  const rows = userQ.list.all().filter((u) => canManageUser(req.auth, u));
  res.json(rows.map((u) => userOut(u, names, clients)));
});

app.post('/api/admin/users', requireEditor, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').replace(/\s+/g, ' ').trim();
  const username = String(b.username || '').trim().toLowerCase();
  if (name.length < 2 || name.length > 80) return res.status(422).json({ message: 'Enter a name of 2 to 80 characters.', field: 'name' });
  if (!/^[a-z0-9._@-]{3,60}$/.test(username)) return res.status(422).json({ message: 'Usernames use 3 to 60 letters, numbers, dots, dashes, underscores or @, with no spaces.', field: 'username' });
  if (username === OWNER_USERNAME) return res.status(422).json({ message: `"${OWNER_USERNAME}" is reserved for the platform administrator.`, field: 'username' });
  if (userQ.byUsername.get(username)) return res.status(409).json({ message: 'That username is already taken.', field: 'username' });
  const problem = passwordProblem(b.password);
  if (problem) return res.status(422).json({ message: problem, field: 'password' });
  const role = b.role === 'manager' ? 'manager' : 'viewer';
  let clientId = req.auth.role === 'manager' ? req.auth.clientId : (b.clientId ? Number(b.clientId) : null);
  if (clientId && !clientQ.byId.get(clientId)) return res.status(422).json({ message: 'That client was not found.', field: 'client' });
  if (role === 'manager' && !clientId) return res.status(422).json({ message: 'Choose the client this administrator belongs to.', field: 'client' });
  const events = role === 'viewer' ? idList(b.events) : [];
  if (role === 'viewer') { const p = eventsProblem(req.auth, clientId, events); if (p) return res.status(422).json({ message: p, field: 'events' }); }
  const id = userQ.insert.run({ name, username, password_hash: hashPassword(b.password), can_export: b.canExport === false ? 0 : 1, can_charts: b.canCharts ? 1 : 0, role, client_id: clientId }).lastInsertRowid;
  if (role === 'viewer') setUserEvents(id, events);
  res.status(201).json(userOut(userQ.byId.get(id)));
});

app.patch('/api/admin/users/:uid', requireEditor, (req, res) => {
  const u = userQ.byId.get(Number(req.params.uid));
  if (!canManageUser(req.auth, u)) return res.status(404).json({ message: 'That user no longer exists.' });
  const self = req.auth.role !== 'owner' && u.id === req.auth.id;
  const b = req.body || {};
  const next = { name: u.name, can_export: u.can_export, can_charts: u.can_charts, active: u.active, password_hash: u.password_hash, session_ver: u.session_ver, must_change_pw: u.must_change_pw, role: u.role };
  if (b.name !== undefined) {
    const name = String(b.name).replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 80) return res.status(422).json({ message: 'Enter a name of 2 to 80 characters.' });
    next.name = name;
  }
  if (b.role !== undefined) {
    if (self) return res.status(422).json({ message: 'You can’t change your own account type.' });
    const role = b.role === 'manager' ? 'manager' : 'viewer';
    if (role === 'manager' && !u.client_id) return res.status(422).json({ message: 'Only accounts that belong to a client can be client administrators.' });
    if (role === 'viewer' && u.role === 'manager' && b.events === undefined) return res.status(422).json({ message: 'Choose the events this viewer can see.' });
    next.role = role;
  }
  if (b.canExport !== undefined) next.can_export = b.canExport ? 1 : 0;
  if (b.canCharts !== undefined) next.can_charts = b.canCharts ? 1 : 0;
  if (b.active !== undefined) {
    if (self && !b.active) return res.status(422).json({ message: 'You can’t turn off your own account.' });
    next.active = b.active ? 1 : 0; if (!next.active) next.session_ver += 1;
  }
  if (b.password !== undefined) {
    const problem = passwordProblem(b.password);
    if (problem) return res.status(422).json({ message: problem });
    next.password_hash = hashPassword(b.password);
    next.session_ver += 1;
    next.must_change_pw = 1; // a password set by an administrator is temporary
  }
  if (b.events !== undefined && next.role === 'viewer') {
    const events = idList(b.events);
    const p = eventsProblem(req.auth, u.client_id || null, events);
    if (p) return res.status(422).json({ message: p });
    setUserEvents(u.id, events);
  }
  if (next.role === 'manager') db.prepare('DELETE FROM user_events WHERE user_id = ?').run(u.id);
  if (next.role !== u.role) next.session_ver += 1;
  db.prepare('UPDATE users SET name = @name, can_export = @can_export, can_charts = @can_charts, active = @active, password_hash = @password_hash, session_ver = @session_ver, must_change_pw = @must_change_pw, role = @role WHERE id = @id').run({ ...next, id: u.id });
  bus.emit('change', { type: 'sessions' });
  res.json(userOut(userQ.byId.get(u.id)));
});

app.delete('/api/admin/users/:uid', requireEditor, (req, res) => {
  const u = userQ.byId.get(Number(req.params.uid));
  if (!canManageUser(req.auth, u)) return res.status(404).json({ message: 'That user no longer exists.' });
  if (req.auth.role !== 'owner' && u.id === req.auth.id) return res.status(422).json({ message: 'You can’t delete your own account.' });
  db.prepare('DELETE FROM user_events WHERE user_id = ?').run(u.id);
  userQ.remove.run(u.id);
  bus.emit('change', { type: 'sessions' });
  res.json({ ok: true });
});

// ---- clients (platform administrator only)
function clientOut(c) {
  const users = clientQ.users.get(c.id);
  return {
    id: c.id, name: c.name, contact: c.contact, active: Boolean(c.active), maxEvents: c.max_events || null,
    activeEvents: clientQ.activeEvents.get(c.id).n, events: clientQ.allEvents.get(c.id).n,
    users: users.n || 0, managers: users.managers || 0, createdAt: sqlTimeToIso(c.created_at),
  };
}
const maxEventsOf = (v) => (v === null || v === '' || v === undefined ? null : Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 10000 ? Number(v) : NaN);
app.get('/api/admin/clients', requireEditor, (req, res) => {
  const list = req.auth.role === 'owner' ? clientQ.list.all() : clientQ.list.all().filter((c) => c.id === req.auth.clientId);
  res.json(list.map(clientOut));
});
app.post('/api/admin/clients', requireOwner, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 100) return res.status(422).json({ message: 'Enter a client name of 2 to 100 characters.', field: 'name' });
  if (clientQ.byName.get(name)) return res.status(409).json({ message: 'A client with that name already exists.', field: 'name' });
  const max = maxEventsOf(b.maxEvents);
  if (Number.isNaN(max)) return res.status(422).json({ message: 'Enter the event limit as a whole number, or leave it blank for no limit.', field: 'maxEvents' });
  const id = clientQ.insert.run(name, String(b.contact || '').trim().slice(0, 200), max).lastInsertRowid;
  res.status(201).json(clientOut(clientQ.byId.get(id)));
});
app.patch('/api/admin/clients/:cid', requireOwner, (req, res) => {
  const c = clientQ.byId.get(Number(req.params.cid));
  if (!c) return res.status(404).json({ message: 'That client was not found.' });
  const b = req.body || {};
  const next = { id: c.id, name: c.name, contact: c.contact, active: c.active, max_events: c.max_events };
  if (b.name !== undefined) {
    const name = String(b.name).replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 100) return res.status(422).json({ message: 'Enter a client name of 2 to 100 characters.' });
    const other = clientQ.byName.get(name);
    if (other && other.id !== c.id) return res.status(409).json({ message: 'A client with that name already exists.' });
    next.name = name;
  }
  if (b.contact !== undefined) next.contact = String(b.contact || '').trim().slice(0, 200);
  if (b.maxEvents !== undefined) {
    const max = maxEventsOf(b.maxEvents);
    if (Number.isNaN(max)) return res.status(422).json({ message: 'Enter the event limit as a whole number, or leave it blank for no limit.' });
    next.max_events = max;
  }
  if (b.active !== undefined) next.active = b.active ? 1 : 0;
  clientQ.update.run(next);
  bus.emit('change', { type: 'sessions' }); // turning a client off signs its accounts out
  res.json(clientOut(clientQ.byId.get(c.id)));
});
app.delete('/api/admin/clients/:cid', requireOwner, (req, res) => {
  const c = clientQ.byId.get(Number(req.params.cid));
  if (!c) return res.status(404).json({ message: 'That client was not found.' });
  const o = clientOut(c);
  if (o.events || o.users) return res.status(409).json({ message: 'This client still has events or accounts. Move or delete them first, or turn the client off instead.' });
  clientQ.remove.run(c.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- events (administrator)
const RESERVED = new Set(['admin', 'checkin', 'api', 'uploads', 'shared', 'shared.js', 'assets', 'static', 'login', 'logout', 'www', 'app', 'e', 'events', 'favicon', 'robots', 'health']);
for (const f of fs.readdirSync(PUBLIC_DIR)) RESERVED.add(f.toLowerCase()).add(f.toLowerCase().replace(/\.[^.]+$/, ''));
function slugProblem(slug, exceptId) {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/.test(slug)) return 'Use 3 to 50 lowercase letters, numbers and dashes for the web address (no spaces).';
  if (RESERVED.has(slug)) return `"${slug}" is reserved. Choose another web address.`;
  const other = evQ.bySlug.get(slug);
  if (other && other.id !== exceptId) return 'Another event already uses that web address.';
  return '';
}

function eventSummary(ev, auth, clients) {
  const c = q.counts.get(ev.id);
  const cname = ev.clientId ? (clients ? clients.get(ev.clientId) : (clientQ.byId.get(ev.clientId) || {}).name) || '' : '';
  return {
    clientId: ev.clientId, clientName: cname,
    id: ev.id, slug: ev.slug, status: ev.status, name: ev.config.details.name, date: ev.config.details.date,
    venue: ev.config.details.venue, logo: ev.config.branding.logo, primary: ev.config.branding.primary,
    registered: c.total, checkedIn: c.checkedIn, capacity: ev.config.details.capacity,
    isHome: getSetting('home_event') === ev.slug, createdAt: sqlTimeToIso(ev.createdAt), checkin: ev.config.checkin.enabled,
  };
}

app.get('/api/admin/events', requireSignedIn, (req, res) => {
  const clients = clientNames();
  res.json(evQ.all.all().map(loadEvent).filter((ev) => canSee(req.auth, ev.id)).map((ev) => eventSummary(ev, req.auth, clients)));
});

app.get('/api/admin/events/:id', requireSignedIn, withEvent, (req, res) => {
  const ev = req.ev;
  const base = { ...eventSummary(ev, req.auth) };
  if (isEditor(req.auth)) return res.json({ ...base, staffPin: ev.staffPin, config: ev.config });
  const c = ev.config;
  res.json({ ...base, config: { details: { name: c.details.name, date: c.details.date, venue: c.details.venue, timezone: c.details.timezone }, form: { fields: c.form.fields }, badge: c.badge, checkin: c.checkin, branding: { primary: c.branding.primary } } });
});

function copyLogo(logo) {
  if (!logo) return null;
  const src = path.join(uploadsDir, path.basename(logo));
  if (!fs.existsSync(src)) return null;
  const name = `logo-${crypto.randomBytes(8).toString('hex')}${path.extname(src)}`;
  fs.copyFileSync(src, path.join(uploadsDir, name));
  return `/uploads/${name}`;
}
const chartQ = {
  list: db.prepare('SELECT id, title, dimension, metric, chart_type AS chartType, filter FROM saved_charts WHERE event_id = ? ORDER BY id'),
  count: db.prepare('SELECT COUNT(*) AS n FROM saved_charts WHERE event_id = ?'),
  insert: db.prepare('INSERT INTO saved_charts (event_id, title, dimension, metric, chart_type, filter) VALUES (@event_id, @title, @dimension, @metric, @chart_type, @filter)'),
  remove: db.prepare('DELETE FROM saved_charts WHERE id = ? AND event_id = ?'),
};

app.post('/api/admin/events', requireEditor, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 120) return res.status(422).json({ message: 'Enter an event name of 3 to 120 characters.', field: 'name' });
  const slug = String(b.slug || slugify(name)).trim().toLowerCase();
  const problem = slugProblem(slug);
  if (problem) return res.status(422).json({ message: problem, field: 'slug' });
  // A client administrator's events always belong to their client; the platform administrator chooses (or none).
  const clientId = req.auth.role === 'manager' ? req.auth.clientId : (b.clientId ? Number(b.clientId) : null);
  if (clientId) { const p = clientLimitProblem(clientId); if (p) return res.status(422).json({ message: p, field: 'client' }); }
  const src = b.copyFrom && canSee(req.auth, Number(b.copyFrom)) ? eventById(b.copyFrom) : null;
  let config;
  if (src) {
    config = JSON.parse(JSON.stringify(src.config));
    config.details = { ...config.details, name, date: '', venue: '', capacity: null };
    config.branding.logo = copyLogo(config.branding.logo);
    config.branding.logo2 = copyLogo(config.branding.logo2);
    config.raffle = { ...config.raffle, enabled: false, pin: '' }; // a copied event gets its own raffle and PIN
  } else {
    config = EG.defaultConfig({ name });
  }
  config = EG.sanitizeConfig(config);
  const pin = String(crypto.randomInt(100000, 999999));
  const id = evQ.insert.run(slug, 'draft', pin, JSON.stringify(config)).lastInsertRowid;
  if (clientId) db.prepare('UPDATE events SET client_id = ? WHERE id = ?').run(clientId, id);
  const charts = src ? chartQ.list.all(src.id).map((c) => [c.title, c.dimension, c.metric, c.chartType, c.filter]) : defaultCharts(config);
  for (const [title, dimension, metric, chart_type, filter] of charts) chartQ.insert.run({ event_id: id, title, dimension, metric, chart_type, filter });
  if (req.auth.role === 'manager') bus.emit('change', { type: 'sessions' }); // the client's other administrators see it too
  res.status(201).json(eventSummary(eventById(id), req.auth));
});

app.put('/api/admin/events/:id', requireEditor, withEvent, (req, res) => {
  const ev = req.ev;
  const b = req.body || {};
  const slug = b.slug !== undefined ? String(b.slug).trim().toLowerCase() : ev.slug;
  if (slug !== ev.slug) { const p = slugProblem(slug, ev.id); if (p) return res.status(422).json({ message: p, field: 'slug' }); }
  const status = b.status !== undefined ? b.status : ev.status;
  if (!STATUSES.includes(status)) return res.status(422).json({ message: 'Choose a valid status.' });
  // Only the platform administrator moves an event to another client (or back to the platform's own events).
  let clientId = ev.clientId;
  if (req.auth.role === 'owner' && b.clientId !== undefined) {
    clientId = b.clientId ? Number(b.clientId) : null;
    if (clientId && !clientQ.byId.get(clientId)) return res.status(422).json({ message: 'That client was not found.' });
  }
  // Bringing an event back from the archive, or moving it to a client, counts toward the client's event limit.
  if (clientId && status !== 'archived' && (ev.status === 'archived' || clientId !== ev.clientId)) {
    const p = clientLimitProblem(clientId, clientId === ev.clientId ? ev.id : null);
    if (p) return res.status(422).json({ message: p });
  }
  const pin = b.staffPin !== undefined ? String(b.staffPin).trim() : ev.staffPin;
  if (!/^\d{4,12}$/.test(pin)) return res.status(422).json({ message: 'The staff PIN must be 4 to 12 digits.', field: 'staffPin' });
  let config = ev.config;
  if (b.config !== undefined) {
    config = EG.sanitizeConfig(b.config, ev.config);
    config.raffle = ev.config.raffle; // changed only on the Raffle tab, so an open Settings page can't undo it
    for (const k of ['logo', 'logo2']) {
      if (config.branding[k] && !fs.existsSync(path.join(uploadsDir, path.basename(config.branding[k])))) config.branding[k] = ev.config.branding[k];
    }
  }
  evQ.update.run({ id: ev.id, slug, status, staff_pin: pin, config: JSON.stringify(config) });
  if (clientId !== ev.clientId) {
    db.prepare('UPDATE events SET client_id = ? WHERE id = ?').run(clientId, ev.id);
    // viewers of another client lose access to it
    db.prepare('DELETE FROM user_events WHERE event_id = ? AND user_id IN (SELECT id FROM users WHERE client_id IS NOT NULL AND client_id IS NOT ?)').run(ev.id, clientId);
    bus.emit('change', { type: 'sessions' });
  }
  if (slug !== ev.slug && getSetting('home_event') === ev.slug) setSetting('home_event', slug);
  bus.emit('change', { type: 'config', eventId: ev.id });
  const fresh = eventById(ev.id);
  res.json({ ...eventSummary(fresh, req.auth), staffPin: fresh.staffPin, config: fresh.config });
});

app.delete('/api/admin/events/:id', requireEditor, withEvent, (req, res) => {
  const ev = req.ev;
  if (q.counts.get(ev.id).total > 0) return res.status(409).json({ message: 'This event has registrations. Archive it instead, or delete its records first on the Backup & reset tab.' });
  if (String((req.body || {}).confirm || '').trim().toLowerCase() !== ev.slug) return res.status(422).json({ message: `Type ${ev.slug} to confirm.` });
  db.transaction(() => {
    evQ.remove.run(ev.id);
    db.prepare('DELETE FROM saved_charts WHERE event_id = ?').run(ev.id);
    db.prepare('DELETE FROM raffle_draws WHERE event_id = ?').run(ev.id);
    db.prepare('DELETE FROM raffle_prizes WHERE event_id = ?').run(ev.id);
    db.prepare('DELETE FROM raffle_entries WHERE event_id = ?').run(ev.id);
    db.prepare('DELETE FROM user_events WHERE event_id = ?').run(ev.id);
    if (getSetting('home_event') === ev.slug) setSetting('home_event', '');
  })();
  res.json({ ok: true });
});

// Image upload (the event logo or the second image): PNG or JPEG up to 5 MB. Saved under a random name;
// the event uses it once settings are saved. Each image is optimized on the way in:
// - turned upright if the camera recorded it sideways
// - blank white or transparent margins are trimmed, so logos of different files line up and size evenly
// - scaled down (never up) to at most 1000 px on the longer side, keeping its proportions
// - compressed (PNG keeps transparency; JPEG photos stay JPEG)
async function optimizeImage(buf, png) {
  let img = sharp(buf, { failOn: 'none' }).rotate();
  // trim only when the corner is white or transparent, so a logo printed on a coloured box keeps its box
  const { data, info } = await sharp(buf, { failOn: 'none' }).rotate().ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  const [r, g, bl, a] = data;
  if (info.channels === 4 && (a < 16 || (r > 235 && g > 235 && bl > 235))) {
    try {
      const trimmed = await sharp(await img.toBuffer()).trim({ threshold: 18 }).toBuffer();
      img = sharp(trimmed);
    } catch { img = sharp(buf, { failOn: 'none' }).rotate(); } // a blank image has nothing to trim
  }
  img = img.resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true });
  const out = png ? await img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 95, effort: 8 }).toBuffer()
    : await img.jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  const meta = await sharp(out).metadata();
  return { out, dims: { w: meta.width, h: meta.height } };
}
app.post('/api/admin/events/:id/logo', requireEditor, withEvent, express.raw({ type: ['image/png', 'image/jpeg'], limit: '5mb' }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(422).json({ message: 'Choose a PNG or JPG image up to 5 MB.' });
  const png = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpg) return res.status(422).json({ message: 'That file isn’t a PNG or JPG image.' });
  let result;
  try { result = await optimizeImage(buf, png); } catch (err) {
    console.error('[image]', err.message);
    return res.status(422).json({ message: 'That image could not be read. Try saving it again as PNG or JPG.' });
  }
  const name = `logo-${crypto.randomBytes(8).toString('hex')}.${png ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(uploadsDir, name), result.out);
  dimsCache.set(`/uploads/${name}`, result.dims);
  res.status(201).json({ logo: `/uploads/${name}`, dims: result.dims, bytes: result.out.length, originalBytes: buf.length });
});

// Email preview and test send use the settings being edited (not yet saved).
function sampleValues(config) {
  const sample = { text: 'Sample answer', textarea: 'Sample address, Clark Freeport Zone', phone_ph: '+63 9171234567', phone: '+65 6123 4567', number: '2', date: '2026-11-12', checkbox: 'Yes', yesno: 'Yes' };
  const v = { first_name: 'Juan', last_name: 'dela Cruz', email: 'juan@example.com', designation: 'Operations Manager', company_name: 'Sample Company Inc.' };
  for (const f of config.form.fields) if (!v[f.key]) v[f.key] = f.options ? f.options[0] : sample[f.type] || 'Sample';
  return v;
}
const previewEvent = (ev, body) => ({ ...ev, config: body && body.config ? withImageDims(EG.sanitizeConfig(body.config, ev.config)) : ev.config });

app.post('/api/admin/events/:id/email-preview', requireEditor, withEvent, async (req, res) => {
  const ev = previewEvent(req.ev, req.body);
  const msg = renderPassEmail({ event: ev, values: sampleValues(ev.config), passCode: 'SAMP-LE00', uploadsDir });
  const qr = (await qrPng('SAMPLE PASS - NOT VALID')).toString('base64');
  const html = msg.html
    .replace('cid:passqr', `data:image/png;base64,${qr}`)
    .replace('cid:jupiterlogo', '/jupiter-logo.png')
    .replace(/cid:eventlogo2\b/g, ev.config.branding.logo2 || '')
    .replace(/cid:eventlogo\b/g, ev.config.branding.logo || '');
  res.json({ subject: msg.subject, html });
});

app.post('/api/admin/events/:id/email-test', testMailLimiter, requireEditor, withEvent, async (req, res) => {
  const to = String((req.body || {}).to || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(422).json({ message: 'Enter the email address to send the test to.' });
  const ev = previewEvent(req.ev, req.body);
  try {
    await sendPassEmail({ event: ev, values: { ...sampleValues(ev.config), email: to }, passCode: 'SAMP-LE00', qrPng: await qrPng('SAMPLE PASS - NOT VALID'), uploadsDir, to });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ message: `The email could not be sent: ${err.message}` });
  }
});

// Which event opens at the main address (and /checkin).
app.get('/api/admin/platform', requireEditor, (req, res) => res.json({ homeEvent: req.auth.role === 'owner' ? getSetting('home_event') : '', senderAddress: senderAddress(), smtp: Boolean(process.env.SMTP_HOST) }));
app.put('/api/admin/platform', requireOwner, (req, res) => {
  const slug = String((req.body || {}).homeEvent || '').trim().toLowerCase();
  if (slug && !evQ.bySlug.get(slug)) return res.status(422).json({ message: 'Choose one of your events.' });
  setSetting('home_event', slug);
  res.json({ homeEvent: slug });
});

// ---------------------------------------------------------------- per-event dashboard data
const fmtCache = new Map();
function tzFormats(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, {
      day: new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }),
      hm: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      stamp: new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
    });
  }
  return fmtCache.get(tz);
}
const utc = (t) => new Date(t.replace(' ', 'T') + 'Z');
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function computeStats(ev) {
  const c = ev.config;
  const tz = c.details.timezone;
  const F = tzFormats(tz);
  const localDay = (t) => F.day.format(utc(t));
  const localMinutes = (t) => { const [h, m] = F.hm.format(utc(t)).split(':').map(Number); return h * 60 + m; };
  const rows = q.all.all(ev.id);
  const arrived = rows.filter((r) => r.checked_in_at);
  const hasCompany = c.form.fields.some((f) => f.key === 'company_name' && f.enabled);
  const companies = new Map();
  if (hasCompany) {
    for (const r of rows) {
      const name = (r.company_name || '').trim() || '(blank)';
      const key = name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
      const co = companies.get(key) || { name, registered: 0, arrived: 0 };
      co.registered += 1;
      if (r.checked_in_at) co.arrived += 1;
      companies.set(key, co);
    }
  }
  const perDay = new Map();
  for (const r of rows) perDay.set(localDay(r.created_at), (perDay.get(localDay(r.created_at)) || 0) + 1);
  const registrationsByDay = [];
  if (rows.length) {
    const days = [...perDay.keys()].sort();
    for (let d = days[0]; d <= days[days.length - 1]; d = addDays(d, 1)) registrationsByDay.push({ day: d, count: perDay.get(d) || 0 });
    registrationsByDay.splice(0, Math.max(0, registrationsByDay.length - 60));
  }
  let arrivals = null;
  if (arrived.length) {
    const latest = arrived.reduce((a, b) => (a.checked_in_at > b.checked_in_at ? a : b));
    const day = localDay(latest.checked_in_at);
    const mins = arrived.filter((r) => localDay(r.checked_in_at) === day).map((r) => localMinutes(r.checked_in_at));
    const start = Math.floor(Math.min(...mins) / 15) * 15;
    const end = Math.floor(Math.max(...mins) / 15) * 15;
    const slots = [];
    for (let m = start; m <= end; m += 15) slots.push({ minutes: m, count: 0 });
    for (const m of mins) slots[(Math.floor(m / 15) * 15 - start) / 15].count += 1;
    arrivals = { day, total: mins.length, slots };
  }
  const lineKey = c.badge.line3 || c.badge.line2;
  const sub = (r) => shortValue(c, rowValues(r), lineKey);
  const activity = [
    ...rows.map((r) => ({ type: 'registered', at: r.created_at, name: r.full_name, company: sub(r) })),
    ...arrived.map((r) => ({ type: 'checked_in', at: r.checked_in_at, name: r.full_name, company: sub(r) })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 6).map((a) => ({ ...a, at: sqlTimeToIso(a.at) }));

  return {
    event: { id: ev.id, slug: ev.slug, status: ev.status, name: c.details.name, capacity: c.details.capacity, checkin: c.checkin.enabled },
    timeZone: tz,
    today: F.day.format(new Date()),
    totals: {
      registered: rows.length, checkedIn: arrived.length, notArrived: rows.length - arrived.length,
      companies: hasCompany ? companies.size : null, emailsPending: c.email.send === false ? 0 : rows.filter((r) => r.email && !r.email_sent_at).length,
      emailsOff: c.email.send === false,
    },
    registrationsByDay,
    arrivals,
    topCompanies: hasCompany ? [...companies.values()].sort((a, b) => b.registered - a.registered || a.name.localeCompare(b.name)).slice(0, 8) : null,
    activity,
    updatedAt: new Date().toISOString(),
  };
}

const ev$ = [requireSignedIn, withEvent];
const evOwner$ = [requireEditor, withEvent]; // event administration: the platform administrator or the event's client administrator

// ---------------------------------------------------------------- raffle
// Prizes are drawn in order on a projector screen (/<event>/raffle), run by an event administrator or by
// anyone with the event's raffle PIN. Winners are picked on the server with a secure random number, from
// checked-in attendees (or all registrants), each person winning once unless the organizer allows more.
// A winner who isn't in the room is marked "no-show" and left out of later draws; every draw is kept.
const raffleQ = {
  prizes: db.prepare('SELECT * FROM raffle_prizes WHERE event_id = ? ORDER BY position, id'),
  prize: db.prepare('SELECT * FROM raffle_prizes WHERE id = ? AND event_id = ?'),
  addPrize: db.prepare('INSERT INTO raffle_prizes (event_id, name, quantity, position) VALUES (?, ?, ?, (SELECT IFNULL(MAX(position), 0) + 1 FROM raffle_prizes WHERE event_id = ?))'),
  updatePrize: db.prepare('UPDATE raffle_prizes SET name = ?, quantity = ? WHERE id = ?'),
  setPosition: db.prepare('UPDATE raffle_prizes SET position = ? WHERE id = ?'),
  removePrize: db.prepare('DELETE FROM raffle_prizes WHERE id = ?'),
  draws: db.prepare(`SELECT d.id AS draw_id, d.prize_id, d.status, d.drawn_at, d.drawn_by, d.claimed_at, r.*
    FROM raffle_draws d LEFT JOIN registrations r ON r.id = d.registration_id WHERE d.event_id = ? ORDER BY d.id`),
  draw: db.prepare('SELECT * FROM raffle_draws WHERE id = ? AND event_id = ?'),
  drawsOfPrize: db.prepare('SELECT COUNT(*) AS n FROM raffle_draws WHERE prize_id = ?'),
  wonOfPrize: db.prepare("SELECT COUNT(*) AS n FROM raffle_draws WHERE prize_id = ? AND status != 'noshow'"),
  insertDraw: db.prepare('INSERT INTO raffle_draws (event_id, prize_id, registration_id, drawn_by) VALUES (?, ?, ?, ?)'),
  setStatus: db.prepare("UPDATE raffle_draws SET status = ?, claimed_at = CASE WHEN ? = 'claimed' THEN datetime('now') ELSE NULL END WHERE id = ?"),
};
// People who can still win this prize.
// Each row carries its number of entries: 1 each, or as set by staff (people with 0 are left out).
function raffleEligible(ev, prizeId) {
  const r = ev.config.raffle;
  const staff = r.entries === 'staff';
  return db.prepare(`SELECT reg.*, ${staff ? 'IFNULL(e.entries, 1)' : '1'} AS raffle_entries FROM registrations reg
    LEFT JOIN raffle_entries e ON e.registration_id = reg.id
    WHERE reg.event_id = @e ${r.pool === 'checkedIn' ? 'AND reg.checked_in_at IS NOT NULL' : ''}
    ${staff ? 'AND IFNULL(e.entries, 1) > 0' : ''}
    AND reg.id NOT IN (SELECT registration_id FROM raffle_draws WHERE event_id = @e AND (status = 'noshow' OR @once = 1 OR prize_id = @p))`)
    .all({ e: ev.id, once: r.oncePerPerson ? 1 : 0, p: prizeId || 0 });
}
// A weighted pick: someone with 3 entries is three times as likely to win as someone with 1.
function pickWeighted(pool) {
  const total = pool.reduce((s, r) => s + r.raffle_entries, 0);
  let n = crypto.randomInt(total);
  for (const r of pool) { n -= r.raffle_entries; if (n < 0) return r; }
  return pool[pool.length - 1];
}
// The name shown for a winner, and the line under it (company, or the name tag's second line).
function raffleWho(ev, row) {
  if (!row || !row.id) return { name: '(record deleted)', detail: '' };
  const c = ev.config, v = rowValues(row);
  return { name: row.full_name, detail: row.company_name || shortValue(c, v, c.badge.line3 || c.badge.line2) || '' };
}
function raffleState(ev) {
  const draws = raffleQ.draws.all(ev.id);
  const prizes = raffleQ.prizes.all(ev.id).map((p) => {
    const mine = draws.filter((d) => d.prize_id === p.id);
    const out = (d) => ({ id: d.draw_id, ...raffleWho(ev, d), status: d.status, drawnAt: sqlTimeToIso(d.drawn_at), drawnBy: d.drawn_by, claimedAt: sqlTimeToIso(d.claimed_at), passCode: d.pass_code ? pretty(d.pass_code) : '' });
    const winners = mine.filter((d) => d.status !== 'noshow').map(out);
    return { id: p.id, name: p.name, quantity: p.quantity, drawn: winners.length, left: Math.max(0, p.quantity - winners.length), winners, noShows: mine.filter((d) => d.status === 'noshow').map(out) };
  });
  const pool = raffleEligible(ev, 0);
  const r = ev.config.raffle;
  return {
    enabled: r.enabled, pool: r.pool, oncePerPerson: r.oncePerPerson, entries: r.entries, mustBePresent: r.mustBePresent,
    eligible: pool.length, totalEntries: pool.reduce((s, x) => s + x.raffle_entries, 0), prizes,
  };
}
const drawWinner = db.transaction((ev, prizeId, by) => {
  const prize = raffleQ.prize.get(prizeId, ev.id);
  if (!prize) throw Object.assign(new Error('That prize was not found.'), { status: 404 });
  if (raffleQ.wonOfPrize.get(prize.id).n >= prize.quantity) throw Object.assign(new Error(`All ${prize.quantity} of “${prize.name}” have been drawn.`), { status: 409 });
  const pool = raffleEligible(ev, prize.id);
  if (!pool.length) throw Object.assign(new Error(ev.config.raffle.pool === 'checkedIn' ? 'No one is left who can win: everyone checked in has already been drawn.' : 'No one is left who can win.'), { status: 409 });
  const pick = pickWeighted(pool);
  const id = raffleQ.insertDraw.run(ev.id, prize.id, pick.id, String(by || '').slice(0, 80)).lastInsertRowid;
  return { id, prize, pick, pool };
});
function drawResponse(ev, result) {
  // Names that flash past on the screen before the winner lands (the winner is already chosen above).
  const others = result.pool.filter((r) => r.id !== result.pick.id);
  for (let i = others.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [others[i], others[j]] = [others[j], others[i]]; }
  return {
    draw: { id: result.id, prizeId: result.prize.id, prize: result.prize.name, ...raffleWho(ev, result.pick) },
    reel: others.slice(0, 30).map((r) => raffleWho(ev, r).name),
    state: raffleState(ev),
  };
}
const raffleChanged = (ev) => bus.emit('change', { type: 'raffle', eventId: ev.id });

// ---- for event administrators (the Raffle tab)
app.get('/api/admin/events/:id/raffle', ...evOwner$, (req, res) => res.json({ ...raffleState(req.ev), pin: req.ev.config.raffle.pin, slug: req.ev.slug, checkin: req.ev.config.checkin.enabled }));
app.put('/api/admin/events/:id/raffle/settings', ...evOwner$, (req, res) => {
  const ev = req.ev, b = req.body || {};
  const r = { ...ev.config.raffle };
  if (b.enabled !== undefined) r.enabled = Boolean(b.enabled);
  if (b.pool !== undefined) r.pool = b.pool === 'registered' || !ev.config.checkin.enabled ? 'registered' : 'checkedIn';
  if (b.oncePerPerson !== undefined) r.oncePerPerson = Boolean(b.oncePerPerson);
  if (b.entries !== undefined) r.entries = b.entries === 'staff' ? 'staff' : 'one';
  if (b.mustBePresent !== undefined) r.mustBePresent = Boolean(b.mustBePresent);
  if (b.pin !== undefined) {
    const pin = String(b.pin).trim();
    if (!/^\d{4,12}$/.test(pin)) return res.status(422).json({ message: 'The raffle PIN must be 4 to 12 digits.' });
    r.pin = pin;
  }
  if (r.enabled && !r.pin) r.pin = String(crypto.randomInt(100000, 999999));
  const config = { ...ev.config, raffle: r };
  evQ.update.run({ id: ev.id, slug: ev.slug, status: ev.status, staff_pin: ev.staffPin, config: JSON.stringify(config) });
  const fresh = eventById(ev.id);
  raffleChanged(fresh);
  res.json({ ...raffleState(fresh), pin: fresh.config.raffle.pin, slug: fresh.slug, checkin: fresh.config.checkin.enabled });
});
const prizeInput = (b) => {
  const name = String(b.name || '').replace(/\s+/g, ' ').trim();
  const quantity = Number(b.quantity);
  if (name.length < 1 || name.length > 120) return { error: 'Enter the prize name (up to 120 characters).' };
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return { error: 'Enter how many of this prize, from 1 to 1000.' };
  return { name, quantity };
};
app.post('/api/admin/events/:id/raffle/prizes', ...evOwner$, (req, res) => {
  const p = prizeInput(req.body || {});
  if (p.error) return res.status(422).json({ message: p.error });
  if (raffleQ.prizes.all(req.ev.id).length >= 100) return res.status(422).json({ message: 'An event can have up to 100 prizes.' });
  raffleQ.addPrize.run(req.ev.id, p.name, p.quantity, req.ev.id);
  raffleChanged(req.ev);
  res.status(201).json(raffleState(req.ev));
});
app.patch('/api/admin/events/:id/raffle/prizes/:pid', ...evOwner$, (req, res) => {
  const prize = raffleQ.prize.get(Number(req.params.pid), req.ev.id);
  if (!prize) return res.status(404).json({ message: 'That prize was not found.' });
  const b = req.body || {};
  if (b.move) {
    const list = raffleQ.prizes.all(req.ev.id);
    const i = list.findIndex((x) => x.id === prize.id), j = i + (b.move < 0 ? -1 : 1);
    if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; db.transaction(() => list.forEach((x, k) => raffleQ.setPosition.run(k + 1, x.id)))(); }
  } else {
    const p = prizeInput({ name: b.name ?? prize.name, quantity: b.quantity ?? prize.quantity });
    if (p.error) return res.status(422).json({ message: p.error });
    if (p.quantity < raffleQ.wonOfPrize.get(prize.id).n) return res.status(422).json({ message: 'More winners have already been drawn for this prize. Mark one as a no-show first.' });
    raffleQ.updatePrize.run(p.name, p.quantity, prize.id);
  }
  raffleChanged(req.ev);
  res.json(raffleState(req.ev));
});
app.delete('/api/admin/events/:id/raffle/prizes/:pid', ...evOwner$, (req, res) => {
  const prize = raffleQ.prize.get(Number(req.params.pid), req.ev.id);
  if (!prize) return res.status(404).json({ message: 'That prize was not found.' });
  if (raffleQ.drawsOfPrize.get(prize.id).n) return res.status(409).json({ message: 'This prize has already been drawn, so it stays in the raffle record.' });
  raffleQ.removePrize.run(prize.id);
  raffleChanged(req.ev);
  res.json(raffleState(req.ev));
});
// ---- entries set by staff
const entriesQ = {
  set: db.prepare(`INSERT INTO raffle_entries (registration_id, event_id, entries, note, updated_by) VALUES (@rid, @e, @n, @note, @by)
    ON CONFLICT(registration_id) DO UPDATE SET entries = excluded.entries, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`),
  clear: db.prepare('DELETE FROM raffle_entries WHERE registration_id = ? AND event_id = ?'),
  clearAll: db.prepare('DELETE FROM raffle_entries WHERE event_id = ?'),
  adjusted: db.prepare(`SELECT reg.*, e.entries AS raffle_entries, e.note AS raffle_note, e.updated_by, e.updated_at FROM raffle_entries e
    JOIN registrations reg ON reg.id = e.registration_id WHERE e.event_id = ? ORDER BY reg.full_name COLLATE NOCASE`),
  search: db.prepare(`SELECT reg.*, IFNULL(e.entries, 1) AS raffle_entries, IFNULL(e.note, '') AS raffle_note FROM registrations reg
    LEFT JOIN raffle_entries e ON e.registration_id = reg.id
    WHERE reg.event_id = @e AND (reg.full_name LIKE @q ESCAPE '\\' OR reg.email LIKE @q ESCAPE '\\' OR reg.company_name LIKE @q ESCAPE '\\' OR reg.pass_code LIKE @code ESCAPE '\\')
    ORDER BY reg.full_name COLLATE NOCASE LIMIT 25`),
};
const entryOut = (ev, r) => ({ id: r.id, ...raffleWho(ev, r), passCode: pretty(r.pass_code), checkedIn: Boolean(r.checked_in_at), entries: r.raffle_entries, note: r.raffle_note || '' });
app.get('/api/admin/events/:id/raffle/entries', ...evOwner$, (req, res) => {
  const term = String(req.query.q || '').replace(/\s+/g, ' ').trim();
  const adjusted = entriesQ.adjusted.all(req.ev.id).map((r) => entryOut(req.ev, r));
  if (term.length < 2) return res.json({ adjusted, results: [] });
  const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const code = `%${term.toUpperCase().replace(/[\s-]/g, '').replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  res.json({ adjusted, results: entriesQ.search.all({ e: req.ev.id, q: like, code }).map((r) => entryOut(req.ev, r)) });
});
app.put('/api/admin/events/:id/raffle/entries/:rid', ...evOwner$, (req, res) => {
  const row = db.prepare('SELECT id FROM registrations WHERE id = ? AND event_id = ?').get(Number(req.params.rid), req.ev.id);
  if (!row) return res.status(404).json({ message: 'That registration was not found.' });
  const n = Number((req.body || {}).entries);
  if (!Number.isInteger(n) || n < 0 || n > 1000) return res.status(422).json({ message: 'Entries must be a whole number from 0 to 1000.' });
  const note = String((req.body || {}).note || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (n === 1 && !note) entriesQ.clear.run(row.id, req.ev.id);
  else entriesQ.set.run({ rid: row.id, e: req.ev.id, n, note, by: req.auth.name });
  raffleChanged(req.ev);
  res.json({ ok: true, state: raffleState(req.ev) });
});
app.post('/api/admin/events/:id/raffle/entries/reset', ...evOwner$, (req, res) => {
  if (String((req.body || {}).confirm || '').trim().toUpperCase() !== 'RESET') return res.status(422).json({ message: 'Type RESET to confirm.' });
  entriesQ.clearAll.run(req.ev.id);
  raffleChanged(req.ev);
  res.json({ ok: true, state: raffleState(req.ev) });
});

function setDrawStatus(ev, drawId, status) {
  const d = raffleQ.draw.get(Number(drawId), ev.id);
  if (!d) throw Object.assign(new Error('That draw was not found.'), { status: 404 });
  if (!['won', 'claimed', 'noshow'].includes(status)) throw Object.assign(new Error('Choose won, claimed or no-show.'), { status: 422 });
  if (d.status === 'noshow' && status !== 'noshow') {
    // putting a no-show back counts against the prize again
    const prize = raffleQ.prize.get(d.prize_id, ev.id);
    if (prize && raffleQ.wonOfPrize.get(prize.id).n >= prize.quantity) throw Object.assign(new Error('All of this prize have been given to others since. Add one more to the prize first.'), { status: 409 });
  }
  raffleQ.setStatus.run(status, status, d.id);
  raffleChanged(ev);
}
app.post('/api/admin/events/:id/raffle/draws/:did', ...evOwner$, (req, res) => {
  try { setDrawStatus(req.ev, req.params.did, String((req.body || {}).status || '')); }
  catch (err) { return res.status(err.status || 500).json({ message: err.message }); }
  res.json(raffleState(req.ev));
});
app.post('/api/admin/events/:id/raffle/reset', ...evOwner$, (req, res) => {
  if (String((req.body || {}).confirm || '').trim().toUpperCase() !== 'RESET') return res.status(422).json({ message: 'Type RESET to confirm.' });
  db.prepare('DELETE FROM raffle_draws WHERE event_id = ?').run(req.ev.id);
  raffleChanged(req.ev);
  res.json(raffleState(req.ev));
});

// ---- the draw screen: an event administrator who is signed in, or anyone with the raffle PIN
function raffleAccess(req, res) {
  const ev = eventBySlug(req.params.slug);
  if (!ev) { notFound(res); return null; }
  const auth = getAuth(req);
  const admin = auth && !auth.mustChange && isEditor(auth) && canSee(auth, ev.id);
  if (!admin && ev.status === 'draft') { notFound(res); return null; }
  if (!ev.config.raffle.enabled) { res.status(403).json({ message: 'The raffle is turned off for this event. Turn it on in the event’s Raffle tab.', disabled: true }); return null; }
  if (admin) { req.drawnBy = auth.name; return ev; }
  if (!ev.config.raffle.pin || !secretMatches(req.get('x-raffle-pin'), ev.config.raffle.pin)) { res.status(401).json({ message: 'That PIN is incorrect.', needPin: true }); return null; }
  req.drawnBy = 'Draw screen (PIN)';
  return ev;
}
function rafflePublicState(ev) {
  const b = ev.config.branding;
  return { event: { name: ev.config.details.name, date: ev.config.details.date, slug: ev.slug }, branding: { primary: b.primary, secondary: b.secondary, headingFont: b.headingFont, bodyFont: b.bodyFont, logo: b.logo, logo2: b.logo2 }, ...raffleState(ev) };
}
app.get('/api/e/:slug/raffle', staffPinLimiter, (req, res) => { const ev = raffleAccess(req, res); if (ev) res.json(rafflePublicState(ev)); });
app.post('/api/e/:slug/raffle/draw', staffPinLimiter, (req, res) => {
  const ev = raffleAccess(req, res);
  if (!ev) return;
  try { res.json({ ...drawResponse(ev, drawWinner(ev, Number((req.body || {}).prizeId), req.drawnBy)), event: rafflePublicState(ev).event }); raffleChanged(ev); }
  catch (err) { res.status(err.status || 500).json({ message: err.message }); }
});
app.post('/api/e/:slug/raffle/draws/:did', staffPinLimiter, (req, res) => {
  const ev = raffleAccess(req, res);
  if (!ev) return;
  const status = String((req.body || {}).status || '');
  if (!['noshow', 'claimed', 'won'].includes(status)) return res.status(422).json({ message: 'Choose claimed or no-show.' });
  try { setDrawStatus(ev, req.params.did, status); } catch (err) { return res.status(err.status || 500).json({ message: err.message }); }
  res.json(rafflePublicState(ev));
});

// QR code of the event's registration page, for organizers to put on invitations and posters.
// PNG (large, for documents and chat) or SVG (sharp at any size, for print).
app.get('/api/admin/events/:id/share-qr.:fmt', ...ev$, async (req, res, next) => {
  try {
    const url = `${req.protocol}://${req.get('host')}/${req.ev.slug}`;
    const opts = { margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#FFFFFF' } };
    const name = `${fileSlug(req.ev)}-registration-qr`;
    if (req.query.dl) res.set('Content-Disposition', `attachment; filename="${name}.${req.params.fmt}"`);
    res.set('Cache-Control', 'no-store');
    if (req.params.fmt === 'svg') return res.type('image/svg+xml').send(await QRCode.toString(url, { ...opts, type: 'svg' }));
    if (req.params.fmt === 'png') return res.type('image/png').send(await QRCode.toBuffer(url, { ...opts, type: 'png', width: 1200 }));
    res.status(404).end();
  } catch (err) { next(err); }
});

app.get('/api/admin/events/:id/stats', ...ev$, (req, res) => res.json(computeStats(req.ev)));

app.get('/api/admin/events/:id/attendees', ...ev$, (req, res) => {
  res.json(q.all.all(req.ev.id).reverse().map((r) => {
    const v = rowValues(r);
    return {
      passCode: pretty(r.pass_code), firstName: v.first_name || '', lastName: v.last_name || '', email: r.email,
      company: r.company_name || '', designation: r.designation || '', contact: r.contact_number || '',
      values: v, registeredAt: sqlTimeToIso(r.created_at), emailSent: Boolean(r.email_sent_at), checkedInAt: sqlTimeToIso(r.checked_in_at),
    };
  }));
});

// CSV in the event's own field order, with times in the event's time zone.
function buildCsv(ev, rows) {
  const c = ev.config;
  const F = tzFormats(c.details.timezone);
  const local = (t) => (t ? F.stamp.format(utc(t)).replace(',', '') : '');
  const cell = (value, guardFormula = true) => {
    let s = value == null ? '' : String(value);
    if (guardFormula && /^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const values = rows.map(rowValues);
  const fields = c.form.fields.filter((f) => f.enabled || values.some((v) => v[f.key]));
  // Addresses are split into columns: street, barangay, city/municipality, province, region, postal code.
  const cols = [];
  for (const f of fields) {
    if (f.type === 'address_ph') {
      for (const [k, label] of EG.ADDRESS_PARTS) {
        cols.push({ label: `${f.label}: ${label}`, get: (v) => { const p = v[`${f.key}__parts`]; return p ? p[k] : k === 'street' ? v[f.key] : ''; }, guard: k !== 'zip' });
      }
    } else cols.push({ label: f.label, get: (v) => v[f.key], guard: !['phone_ph', 'phone'].includes(f.type) });
  }
  const withCheckin = c.checkin.enabled;
  const withMail = c.email.send !== false;
  const header = ['Pass code', ...cols.map((x) => x.label), `Registered (${c.details.timezone})`, ...(withMail ? ['Confirmation emailed'] : []), ...(withCheckin ? [`Checked in (${c.details.timezone})`] : [])];
  const lines = [header.map((h) => cell(h)).join(',')];
  rows.forEach((r, i) => {
    lines.push([
      cell(pretty(r.pass_code)),
      ...cols.map((x) => cell(x.get(values[i]), x.guard)),
      cell(local(r.created_at)), ...(withMail ? [cell(r.email_sent_at ? 'Yes' : r.email ? 'No' : 'No email given')] : []), ...(withCheckin ? [cell(local(r.checked_in_at))] : []),
    ].join(','));
  });
  return '﻿' + lines.join('\r\n'); // BOM so Excel reads ñ and other accents correctly
}
const fileSlug = (ev) => ev.slug.replace(/[^a-z0-9-]/g, '');

// ---- Excel report: a "Registered" tab and, for events with check-in, an "Attended" tab.
// Each tab starts with a heading (report name, event, date, venue) above the table.
const REPORT_ADDRESS_LABELS = {
  street: 'Unit, Floor, Building, Street', barangay: 'Barangay', city: 'City / Municipality',
  province: 'Province', region: 'Region', zip: 'Postal Code',
};
async function buildWorkbook(ev, rows) {
  const c = ev.config;
  const F = tzFormats(c.details.timezone);
  const local = (t) => (t ? F.stamp.format(utc(t)).replace(',', '').slice(0, 16) : '');
  const values = rows.map(rowValues);
  const valueOf = new Map(rows.map((r, i) => [r, values[i]]));
  const fields = c.form.fields.filter((f) => f.enabled || values.some((v) => v[f.key]));
  const addressFields = fields.filter((f) => f.type === 'address_ph');
  // Answer columns. Addresses are split into their parts; the field name is only added when the form has more than one address.
  const cols = [];
  for (const f of fields) {
    if (f.type === 'address_ph') {
      for (const [k] of EG.ADDRESS_PARTS) {
        const label = REPORT_ADDRESS_LABELS[k];
        cols.push({ label: addressFields.length > 1 ? `${f.label}: ${label}` : label, width: k === 'street' ? 34 : k === 'zip' ? 12 : 22,
          get: (v) => { const p = v[`${f.key}__parts`]; return p ? p[k] : k === 'street' ? v[f.key] : ''; } });
      }
    } else cols.push({ label: f.label, width: f.type === 'textarea' ? 40 : f.type === 'email' ? 30 : f.type === 'checkbox' || f.type === 'yesno' ? 14 : 22, get: (v) => v[f.key] });
  }
  const withQr = c.checkin.qr, withCheckin = c.checkin.enabled, withMail = c.email.send !== false;
  const tz = EG.TIMEZONES.find(([z]) => z === c.details.timezone);
  const tzNote = tz ? tz[1] : c.details.timezone;
  const primary = (c.branding.primary || '#E00000').replace('#', 'FF');
  const onPrimary = EG.textOn(c.branding.primary || '#E00000') === '#FFFFFF' ? 'FFFFFFFF' : 'FF141414';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'EventGate';
  wb.created = new Date();

  function addSheet(name, title, list, extra, lead = []) {
    const columns = [
      { label: 'No.', width: 6, get: (r, i) => i + 1 },
      ...lead,
      ...(withQr ? [{ label: 'Pass code', width: 12, get: (r) => (r.pass_code ? pretty(r.pass_code) : '') }] : []),
      ...cols.map((x) => ({ ...x, get: (r) => (valueOf.has(r) ? x.get(valueOf.get(r)) || '' : '') })),
      ...extra,
    ];
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 7, xSplit: 0 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = columns.map((col) => ({ width: col.width || 20 }));
    const head = [
      [title, { bold: true, size: 16 }],
      [c.details.name, { bold: true, size: 13 }],
      [`Date: ${c.details.date || 'Not set'}`, { size: 11 }],
      [`Venue: ${c.details.venue || 'Not set'}`, { size: 11 }],
      [`${list.length} ${list.length === 1 ? 'person' : 'people'} · Downloaded ${local(new Date().toISOString().replace('T', ' ').slice(0, 19))} (${tzNote} time)`, { size: 10, italic: true, color: { argb: 'FF5C5C5C' } }],
    ];
    head.forEach(([text, font], i) => {
      const cell = ws.getCell(i + 1, 1);
      cell.value = text;
      cell.font = { name: 'Arial', ...font };
      ws.mergeCells(i + 1, 1, i + 1, Math.max(columns.length, 6));
      cell.alignment = { vertical: 'middle', wrapText: false };
    });
    ws.getRow(1).height = 24;
    const header = ws.getRow(7);
    columns.forEach((col, j) => {
      const cell = header.getCell(j + 1);
      cell.value = col.label;
      cell.font = { name: 'Arial', bold: true, color: { argb: onPrimary } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primary } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF141414' } } };
    });
    header.height = 30;
    list.forEach((r, i) => {
      const row = ws.getRow(8 + i);
      columns.forEach((col, j) => {
        const cell = row.getCell(j + 1);
        const v = col.get(r, i);
        cell.value = typeof v === 'number' ? v : String(v ?? '');
        cell.font = { name: 'Arial', size: 10 };
        cell.alignment = j === 0 ? { vertical: 'top', horizontal: 'center' } : { vertical: 'top', wrapText: true };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFD4D4D4' } } };
      });
    });
    if (list.length) ws.autoFilter = { from: { row: 7, column: 1 }, to: { row: 7 + list.length, column: columns.length } };
    else { ws.getCell(8, 1).value = 'No one yet.'; ws.getCell(8, 1).font = { name: 'Arial', italic: true, color: { argb: 'FF5C5C5C' } }; }
    ws.pageSetup.printTitlesRow = '7:7';
    ws.headerFooter.oddFooter = `&L${c.details.name.replace(/&/g, '&&')}&RPage &P of &N`;
  }

  addSheet('Registered', 'Registration Report', rows, [
    { label: 'Registered on', width: 17, get: (r) => local(r.created_at) },
    ...(withMail ? [{ label: 'Confirmation emailed', width: 14, get: (r) => (r.email_sent_at ? 'Yes' : r.email ? 'No' : 'No email given') }] : []),
    ...(withCheckin ? [{ label: 'Attended', width: 11, get: (r) => (r.checked_in_at ? 'Yes' : 'No') }] : []),
  ]);
  if (withCheckin) {
    const attended = rows.filter((r) => r.checked_in_at).sort((a, b) => (a.checked_in_at < b.checked_in_at ? -1 : 1));
    addSheet('Attended', 'Attendance Report', attended, [
      { label: 'Registered on', width: 17, get: (r) => local(r.created_at) },
      { label: 'Checked in at', width: 17, get: (r) => local(r.checked_in_at) },
    ]);
  }
  // Raffle winners, in the order drawn (no-shows included, marked as such), when the event held a raffle.
  const draws = raffleQ.draws.all(ev.id);
  if (draws.length) {
    const prizeName = new Map(raffleQ.prizes.all(ev.id).map((p) => [p.id, p.name]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const list = draws.map((d) => byId.get(d.id) || {});
    const STATUS = { won: 'Won', claimed: 'Prize claimed', noshow: 'No-show (redrawn)' };
    const entryOf = new Map(db.prepare('SELECT registration_id, entries FROM raffle_entries WHERE event_id = ?').all(ev.id).map((e) => [e.registration_id, e.entries]));
    addSheet('Raffle winners', 'Raffle Winners', list, [
      { label: 'Drawn at', width: 17, get: (r, i) => local(draws[i].drawn_at) },
      { label: 'Status', width: 16, get: (r, i) => STATUS[draws[i].status] || draws[i].status },
      { label: 'Claimed at', width: 17, get: (r, i) => local(draws[i].claimed_at) },
      { label: 'Drawn by', width: 18, get: (r, i) => draws[i].drawn_by },
      ...(ev.config.raffle.entries === 'staff' ? [{ label: 'Entries', width: 9, get: (r) => (r.id ? (entryOf.get(r.id) ?? 1) : '') }] : []),
    ], [{ label: 'Prize', width: 24, get: (r, i) => prizeName.get(draws[i].prize_id) || '' }]);
  }
  return wb.xlsx.writeBuffer();
}

const canDownload = (req, res, next) => {
  req.auth = getAuth(req);
  if (!req.auth) return res.status(401).send('Unauthorized');
  if (req.auth.mustChange) return res.status(403).send('Choose your own password first.');
  if (!req.auth.canExport) return res.status(403).send('Downloading the attendee list is not enabled for this account.');
  next();
};
app.get('/api/admin/events/:id/report.xlsx', adminKeyLimiter, canDownload, withEvent, async (req, res, next) => {
  try {
    const buf = await buildWorkbook(req.ev, q.all.all(req.ev.id));
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileSlug(req.ev)}-report-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    });
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

app.get('/api/admin/events/:id/registrations.csv', adminKeyLimiter, canDownload, withEvent, (req, res) => {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileSlug(req.ev)}-registrations-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(buildCsv(req.ev, q.all.all(req.ev.id)));
});
// First-version download link: the home event's list.
app.get('/api/admin/registrations.csv', (req, res) => {
  const ev = homeEvent();
  if (!ev) return res.status(404).send('No event is set for the main address.');
  res.redirect(307, `/api/admin/events/${ev.id}/registrations.csv${req.query.key ? `?key=${encodeURIComponent(req.query.key)}` : ''}`);
});

// ---- saved charts
const CHART_OPTIONS = {
  metric: ['count', 'checkedIn', 'rate', 'stacked'],
  chart_type: ['bar', 'column', 'line', 'pie'],
  filter: ['all', 'in', 'out'],
};
const BUILTIN_DIMS = ['company', 'designation', 'emailDomain', 'status', 'regDay', 'regWeekday', 'regHour', 'arrival15', 'arrivalHour'];

app.get('/api/admin/events/:id/charts', ...ev$, (req, res) => res.json(chartQ.list.all(req.ev.id)));
// Charts can be added and removed by the administrator and by client users allowed to (per user, on the Users page).
const chartEditor = (req, res, next) => (req.auth.canCharts ? next() : res.status(403).json({ message: 'Your account can view charts but not change them. Ask the event administrator.' }));
app.post('/api/admin/events/:id/charts', ...ev$, chartEditor, (req, res) => {
  const b = req.body || {};
  const c = { event_id: req.ev.id, title: String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 80), dimension: b.dimension, metric: b.metric, chart_type: b.chartType, filter: b.filter || 'all' };
  if (!BUILTIN_DIMS.includes(c.dimension) && !/^f:[a-z0-9_]{1,48}(@(region|province|city))?$/.test(String(c.dimension))) return res.status(422).json({ message: 'Choose a valid dimension.' });
  for (const [k, allowed] of Object.entries(CHART_OPTIONS)) if (!allowed.includes(c[k])) return res.status(422).json({ message: `Choose a valid ${k.replace('_', ' ')}.` });
  if (!c.title) return res.status(422).json({ message: 'Give the chart a title.' });
  if (chartQ.count.get(req.ev.id).n >= 30) return res.status(422).json({ message: 'The dashboard holds up to 30 charts. Remove one first.' });
  const id = chartQ.insert.run(c).lastInsertRowid;
  bus.emit('change', { type: 'charts', eventId: req.ev.id });
  res.status(201).json({ id });
});
app.delete('/api/admin/events/:id/charts/:cid', ...ev$, chartEditor, (req, res) => {
  chartQ.remove.run(Number(req.params.cid), req.ev.id);
  bus.emit('change', { type: 'charts', eventId: req.ev.id });
  res.json({ ok: true });
});

// ---- live updates
app.get('/api/admin/events/:id/stream', ...ev$, (req, res) => {
  const eventId = req.ev.id;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const onChange = (e) => {
    if (e.type === 'sessions') {
      const a = getAuth(req);
      if (!a || !canSee(a, eventId)) { res.write('event: signedout\ndata: {}\n\n'); return res.end(); }
      return;
    }
    if (e.eventId === eventId) res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on('change', onChange);
  req.on('close', () => { clearInterval(ping); bus.off('change', onChange); });
});

// ---------------------------------------------------------------- backups, reset and delete (per event)
// Each backup is a full copy of the database (used for Restore) plus an Excel-ready CSV of that event's records.
// Backups are made synchronously, so nothing can register between the backup and a reset that follows it.
const backupQ = {
  list: db.prepare('SELECT * FROM backups WHERE event_id = ? ORDER BY id DESC'),
  byId: db.prepare('SELECT * FROM backups WHERE id = ? AND event_id = ?'),
  insert: db.prepare('INSERT INTO backups (event_id, file, reason, created_by, registrations, checked_in) VALUES (@event_id, @file, @reason, @created_by, @registrations, @checked_in)'),
  remove: db.prepare('DELETE FROM backups WHERE id = ?'),
};
const backupFiles = (file) => ({ db: path.join(backupDir, `${file}.db`), csv: path.join(backupDir, `${file}.csv`) });

function createBackup(ev, reason, by, { skipIfEmpty = false } = {}) {
  const counts = q.counts.get(ev.id);
  if (skipIfEmpty && counts.total === 0) return null;
  const p = Object.fromEntries(tzFormats(ev.config.details.timezone).stamp.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const base = `${fileSlug(ev)}-${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
  let file = base;
  for (let n = 2; fs.existsSync(backupFiles(file).db); n++) file = `${base}_${n}`;
  const f = backupFiles(file);
  db.prepare('VACUUM INTO ?').run(f.db);
  fs.writeFileSync(f.csv, buildCsv(ev, q.all.all(ev.id)));
  const id = backupQ.insert.run({ event_id: ev.id, file, reason, created_by: by, registrations: counts.total, checked_in: counts.checkedIn }).lastInsertRowid;
  return backupQ.byId.get(id, ev.id);
}
const backupOut = (b) => b && ({
  id: b.id, name: b.file, reason: b.reason, createdBy: b.created_by, registrations: b.registrations, checkedIn: b.checked_in,
  createdAt: sqlTimeToIso(b.created_at), available: fs.existsSync(backupFiles(b.file).db),
});
const confirmed = (req, word) => String((req.body || {}).confirm || '').trim().toUpperCase() === word;

app.get('/api/admin/events/:id/backups', ...evOwner$, (req, res) => res.json(backupQ.list.all(req.ev.id).map(backupOut)));
app.post('/api/admin/events/:id/backups', ...evOwner$, (req, res) => res.status(201).json(backupOut(createBackup(req.ev, 'Manual backup', req.auth.name))));
app.get('/api/admin/events/:id/backups/:bid/csv', ...evOwner$, (req, res) => {
  const b = backupQ.byId.get(Number(req.params.bid), req.ev.id);
  if (!b || !fs.existsSync(backupFiles(b.file).csv)) return res.status(404).json({ message: 'That backup file is no longer available.' });
  res.download(backupFiles(b.file).csv, `${b.file}.csv`);
});
app.delete('/api/admin/events/:id/backups/:bid', ...evOwner$, (req, res) => {
  const b = backupQ.byId.get(Number(req.params.bid), req.ev.id);
  if (b) {
    for (const f of Object.values(backupFiles(b.file))) fs.rmSync(f, { force: true });
    backupQ.remove.run(b.id);
  }
  res.json({ ok: true });
});

app.post('/api/admin/events/:id/data/reset-checkins', ...evOwner$, (req, res) => {
  if (!confirmed(req, 'RESET')) return res.status(422).json({ message: 'Type RESET to confirm.' });
  const backup = createBackup(req.ev, 'Automatic backup before resetting check-ins', req.auth.name, { skipIfEmpty: true });
  const changed = db.prepare('UPDATE registrations SET checked_in_at = NULL WHERE event_id = ? AND checked_in_at IS NOT NULL').run(req.ev.id).changes;
  bus.emit('change', { type: 'reset', eventId: req.ev.id });
  res.json({ ok: true, changed, backup: backupOut(backup) });
});

app.post('/api/admin/events/:id/data/delete-all', ...evOwner$, (req, res) => {
  if (!confirmed(req, 'DELETE')) return res.status(422).json({ message: 'Type DELETE to confirm.' });
  const backup = createBackup(req.ev, 'Automatic backup before deleting all records', req.auth.name, { skipIfEmpty: true });
  const changed = db.prepare('DELETE FROM registrations WHERE event_id = ?').run(req.ev.id).changes;
  db.prepare('DELETE FROM raffle_draws WHERE event_id = ?').run(req.ev.id); // the winners were among those records
  db.prepare('DELETE FROM raffle_entries WHERE event_id = ?').run(req.ev.id);
  bus.emit('change', { type: 'reset', eventId: req.ev.id });
  res.json({ ok: true, changed, backup: backupOut(backup) });
});

app.post('/api/admin/events/:id/backups/:bid/restore', ...evOwner$, (req, res) => {
  if (!confirmed(req, 'RESTORE')) return res.status(422).json({ message: 'Type RESTORE to confirm.' });
  const ev = req.ev;
  const b = backupQ.byId.get(Number(req.params.bid), ev.id);
  if (!b || !fs.existsSync(backupFiles(b.file).db)) return res.status(404).json({ message: 'That backup file is no longer available.' });
  const before = createBackup(ev, `Automatic backup before restoring ${b.file}`, req.auth.name, { skipIfEmpty: true });
  db.prepare('ATTACH DATABASE ? AS restore_src').run(backupFiles(b.file).db);
  try {
    const have = new Set(db.prepare('PRAGMA restore_src.table_info(registrations)').all().map((c) => c.name));
    const cols = db.prepare('PRAGMA main.table_info(registrations)').all().map((c) => c.name).filter((c) => have.has(c) && c !== 'event_id' && c !== 'id');
    // Backups from the single-event version have no event_id: all of their rows belong to this event.
    const where = have.has('event_id') ? 'WHERE event_id = ?' : '';
    db.transaction(() => {
      db.prepare('DELETE FROM main.registrations WHERE event_id = ?').run(ev.id);
      const sql = `INSERT INTO main.registrations (event_id, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM restore_src.registrations ${where} ORDER BY id`;
      const stmt = db.prepare(sql);
      if (where) stmt.run(ev.id, ev.id); else stmt.run(ev.id);
    })();
  } catch (err) {
    console.error('[restore]', err);
    return res.status(409).json({ message: 'That backup could not be restored. Some of its passes may now belong to another event.' });
  } finally {
    db.prepare('DETACH DATABASE restore_src').run();
  }
  bus.emit('change', { type: 'reset', eventId: ev.id });
  res.json({ ok: true, restored: q.counts.get(ev.id), backup: backupOut(before) });
});

// ---------------------------------------------------------------- pages
// Philippine locations for the address field (cached by browsers for a day).
app.get('/api/ph/locations', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('application/json').send(PH.locationsJson);
});
app.get('/api/ph/barangays/:city', (req, res) => {
  const list = PH.barangaysOf(String(req.params.city));
  if (!list) return res.status(404).json({ message: 'Unknown city or municipality.' });
  res.set('Cache-Control', 'public, max-age=86400').json(list);
});
app.get('/shared.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'lib', 'shared.js')));
app.use('/uploads', express.static(uploadsDir, { maxAge: '30d', immutable: true, fallthrough: false }));
app.get(['/index.html', '/checkin.html'], (req, res) => res.redirect(301, req.path.startsWith('/checkin') ? '/checkin' : '/'));

app.get('/', (req, res) => {
  const ev = homeEvent();
  if (isPublic(ev)) return res.redirect(302, `/${ev.slug}`);
  res.sendFile(path.join(PUBLIC_DIR, 'home.html'));
});
app.get('/checkin', (req, res) => {
  const ev = homeEvent();
  if (ev) return res.redirect(302, `/${ev.slug}/checkin`);
  res.sendFile(path.join(PUBLIC_DIR, 'home.html'));
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: false }));

app.get('/:slug', (req, res, next) => {
  const slug = req.params.slug.toLowerCase();
  if (RESERVED.has(slug)) return next();
  const ev = eventBySlug(slug);
  res.status(ev ? 200 : 404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get('/:slug/raffle', (req, res, next) => {
  const slug = req.params.slug.toLowerCase();
  if (RESERVED.has(slug)) return next();
  res.status(eventBySlug(slug) ? 200 : 404).sendFile(path.join(PUBLIC_DIR, 'raffle.html'));
});
app.get('/:slug/checkin', (req, res, next) => {
  const slug = req.params.slug.toLowerCase();
  if (RESERVED.has(slug)) return next();
  res.status(eventBySlug(slug) ? 200 : 404).sendFile(path.join(PUBLIC_DIR, 'checkin.html'));
});

app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ message: 'That file is too large. Use an image up to 2 MB.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'The request could not be read.' });
  if (err.status === 404) return res.status(404).send('Not found');
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on the server. Try again.' });
});

app.listen(PORT, () => {
  const ev = homeEvent();
  console.log(`Admin:        http://localhost:${PORT}/admin`);
  if (ev) console.log(`Home event:   http://localhost:${PORT}/${ev.slug}  (check-in: /${ev.slug}/checkin)`);
});
