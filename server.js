'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./lib/db');
const { sendMail } = require('./lib/mail');
const { stripeRequest, verifyWebhook } = require('./lib/stripe');

const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const BASE_ORIGIN = new URL(BASE_URL).origin;
const STUDIO_EMAIL = process.env.STUDIO_EMAIL || 'reactorshq@gmail.com';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TERM = process.env.TERM_START || '2027-01-06';
const TERM_LABEL = 'Wednesday 6 January 2027';
const MAX_PLACES = Number(process.env.MAX_PLACES) || 20;
const POLICY_VERSION = '2026-11';
let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  if (PROD) { console.error('SESSION_SECRET must be set in production.'); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString('hex');
}
if (PROD && ADMIN_PASSWORD.length < 12) console.warn('Warning: ADMIN_PASSWORD is missing or short. The admin page is disabled until it is at least 12 characters.');

const PLANS = {
  monthly: { label: 'Monthly subscription (£95 per month)', pence: 9500 },
  term: { label: 'Full term payment (£295 for 10 weeks)', pence: 29500 }
};
const EXPERIENCE = [
  'No experience, brand new to it',
  'Some experience',
  'Experienced, developing my technique',
  'Returning after time away'
];

// ---------- helpers ----------
const now = () => new Date().toISOString();
const text = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const validEmail = (v) => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const gbp = (pence) => '£' + (pence / 100).toFixed(pence % 100 ? 2 : 0);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function json(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  if (!String(req.headers['content-type'] || '').includes('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  const raw = await readBody(req);
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

// signed cookies
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function unsign(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [body, mac] = tok.split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
const session = (req, name) => unsign(cookies(req)[name]);
function cookieHeader(name, value, ttlMs) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}${BASE_URL.startsWith('https') ? '; Secure' : ''}`;
}

// rate limiting
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(t); buckets.set(key, arr); return false;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of buckets) if (!v.some((x) => t - x < 3600000)) buckets.delete(k); }, 600000).unref();
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
}

// ---------- data ----------
const placesTaken = () => db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE term = ? AND status = 'paid'").get(TERM).n;

// ---------- emails ----------
const SIGN_OFF = '\nRE:ACTORS STUDIO\nAct. Connect. Evolve.\nTel: 07939 208234\nreactorshq@gmail.com';

async function emailBookingConfirmed(student, booking) {
  const plan = PLANS[booking.plan];
  await sendMail({
    to: student.email,
    replyTo: STUDIO_EMAIL,
    subject: 'Your place at RE:ACTORS STUDIO is confirmed',
    text: `Hello ${student.name},\n\nThank you for booking. Your place is confirmed.\n\n` +
      `Plan: ${plan.label}\nTerm starts: ${TERM_LABEL}\nTime: Wednesday evenings, 7:00 to 9:30pm\n` +
      `Place: York Street Methodist Church, 25 York Street, Broadstairs CT10 1PS\n\n` +
      `You can view your booking, and manage your payments, any time at ${BASE_URL}/account\n` +
      `Our booking, cancellation and refund policies are at ${BASE_URL}/#policy\n\n` +
      `If you have any questions, just reply to this email.\n${SIGN_OFF}`
  });
  await sendMail({
    to: STUDIO_EMAIL,
    replyTo: student.email,
    subject: `New booking: ${student.name}`,
    text: `New paid booking.\n\nName: ${student.name}\nEmail: ${student.email}\nPhone: ${student.phone || 'Not given'}\n` +
      `Experience: ${booking.experience}\nPlan: ${plan.label}\nPlaces taken for this term: ${placesTaken()} of ${MAX_PLACES}\n\nAll bookings: ${BASE_URL}/admin`
  });
}

// ---------- stripe events ----------
async function onCheckoutCompleted(session) {
  const bookingId = Number((session.metadata && session.metadata.booking_id) || session.client_reference_id);
  if (!bookingId || session.payment_status === 'unpaid') return;
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return;
  const r = db.prepare("UPDATE bookings SET status = 'paid', paid_at = ?, stripe_session_id = ?, stripe_subscription_id = ? WHERE id = ? AND status = 'pending'")
    .run(now(), session.id, session.subscription || null, bookingId);
  if (session.customer) db.prepare('UPDATE students SET stripe_customer_id = ? WHERE id = ?').run(session.customer, booking.student_id);
  if (r.changes === 1) {
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(booking.student_id);
    await emailBookingConfirmed(student, { ...booking, status: 'paid' });
  }
}
async function onSubscriptionDeleted(sub) {
  const b = db.prepare('SELECT * FROM bookings WHERE stripe_subscription_id = ?').get(sub.id);
  if (!b || b.status === 'cancelled') return;
  db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now(), b.id);
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(b.student_id);
  await sendMail({ to: STUDIO_EMAIL, replyTo: s.email, subject: `Subscription cancelled: ${s.name}`, text: `${s.name} (${s.email}) has cancelled their monthly subscription.\n\nView bookings: ${BASE_URL}/admin` });
  await sendMail({ to: s.email, replyTo: STUDIO_EMAIL, subject: 'Your RE:ACTORS STUDIO subscription has been cancelled', text: `Hello ${s.name},\n\nThis confirms your monthly subscription has been cancelled and no further payments will be taken.\n\nIf this was a mistake, reply to this email.\n${SIGN_OFF}` });
}
async function onPaymentFailed(invoice) {
  if (!invoice.subscription) return;
  const b = db.prepare('SELECT * FROM bookings WHERE stripe_subscription_id = ?').get(invoice.subscription);
  if (!b) return;
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(b.student_id);
  await sendMail({ to: STUDIO_EMAIL, replyTo: s.email, subject: `Payment failed: ${s.name}`, text: `A monthly payment for ${s.name} (${s.email}) failed. Stripe will retry automatically, or you can contact them.\n\nView bookings: ${BASE_URL}/admin` });
}

// ---------- routes ----------
const routes = {};
const route = (method, p, fn, opts) => { routes[`${method} ${p}`] = { fn, opts: opts || {} }; };

route('GET', '/api/places', async (req, res) => {
  const taken = placesTaken();
  json(res, 200, { term: TERM, max: MAX_PLACES, left: Math.max(0, MAX_PLACES - taken) });
});

route('POST', '/api/enquiry', async (req, res) => {
  if (limited('enq:' + clientIp(req), 8, 900000)) return json(res, 429, { error: 'Too many messages. Please try again later.' });
  const b = await readJson(req);
  const name = text(b.name, 100), email = text(b.email, 254).toLowerCase(), question = text(b.question, 3000);
  if (!question) return json(res, 400, { error: 'Write your question first.' });
  if (!validEmail(email)) return json(res, 400, { error: 'Add a valid email so we can reply.' });
  db.prepare('INSERT INTO enquiries (name, email, question, created_at) VALUES (?, ?, ?, ?)').run(name, email, question, now());
  await sendMail({ to: STUDIO_EMAIL, replyTo: email, subject: `Question from ${name || email}`, text: `From: ${name || 'Not given'} (${email})\n\n${question}\n\nAll enquiries: ${BASE_URL}/admin` });
  await sendMail({ to: email, replyTo: STUDIO_EMAIL, subject: 'We have your question', text: `Hello ${name || 'there'},\n\nThank you for getting in touch. We have your question and will reply soon.\n\nYour question:\n${question}\n${SIGN_OFF}` });
  json(res, 200, { ok: true });
});

route('POST', '/api/checkout', async (req, res) => {
  if (limited('chk:' + clientIp(req), 12, 900000)) return json(res, 429, { error: 'Too many attempts. Please try again later.' });
  if (!STRIPE_KEY) return json(res, 503, { error: 'Online payment is not switched on yet. Please call 07939 208234.' });
  const b = await readJson(req);
  const name = text(b.name, 100), email = text(b.email, 254).toLowerCase(), phone = text(b.phone, 30);
  const experience = EXPERIENCE.includes(b.experience) ? b.experience : EXPERIENCE[0];
  const plan = PLANS[b.plan];
  if (name.length < 2) return json(res, 400, { error: 'Enter your full name.' });
  if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email address.' });
  if (!plan) return json(res, 400, { error: 'Choose a payment option.' });
  if (b.agree !== true) return json(res, 400, { error: 'Tick the box to confirm you have read the booking and refund policy.' });
  if (placesTaken() >= MAX_PLACES) return json(res, 409, { error: 'Sorry, this term is full. Email us to join the waiting list.' });

  const existing = db.prepare('SELECT * FROM students WHERE email = ?').get(email);
  let studentId;
  if (existing) {
    db.prepare('UPDATE students SET name = ?, phone = ? WHERE id = ?').run(name, phone || null, existing.id);
    studentId = existing.id;
  } else {
    studentId = Number(db.prepare('INSERT INTO students (email, name, phone, created_at) VALUES (?, ?, ?, ?)').run(email, name, phone || null, now()).lastInsertRowid);
  }
  const bookingId = Number(db.prepare('INSERT INTO bookings (student_id, term, plan, amount_pence, experience, status, agreed_at, policy_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(studentId, TERM, b.plan, plan.pence, experience, 'pending', now(), POLICY_VERSION, now()).lastInsertRowid);

  const monthly = b.plan === 'monthly';
  const params = {
    mode: monthly ? 'subscription' : 'payment',
    client_reference_id: String(bookingId),
    metadata: { booking_id: String(bookingId) },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'gbp',
        unit_amount: plan.pence,
        product_data: { name: monthly ? 'RE:ACTORS STUDIO monthly subscription' : `RE:ACTORS STUDIO 10 week term, starts ${TERM_LABEL}` },
        ...(monthly ? { recurring: { interval: 'month' } } : {})
      }
    }],
    success_url: `${BASE_URL}/thanks`,
    cancel_url: `${BASE_URL}/#enrol`,
    billing_address_collection: 'auto',
    custom_text: { submit: { message: 'By paying you agree to the RE:ACTORS STUDIO booking, cancellation and refund policy.' } }
  };
  if (existing && existing.stripe_customer_id) params.customer = existing.stripe_customer_id;
  else {
    params.customer_email = email;
    if (!monthly) params.customer_creation = 'always';
  }
  if (monthly) params.subscription_data = { metadata: { booking_id: String(bookingId) } };
  try {
    const s = await stripeRequest(STRIPE_KEY, 'checkout/sessions', params);
    db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').run(s.id, bookingId);
    json(res, 200, { url: s.url });
  } catch (e) {
    console.error('Stripe checkout failed:', e.message);
    json(res, 502, { error: 'We could not start the payment. Please try again, or call 07939 208234.' });
  }
});

route('POST', '/api/stripe/webhook', async (req, res) => {
  const raw = await readBody(req, 1048576);
  let event;
  try { event = verifyWebhook(raw, req.headers['stripe-signature'], WEBHOOK_SECRET); }
  catch (e) { console.warn('Webhook rejected:', e.message); return json(res, 400, { error: 'Bad signature' }); }
  const seen = db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id);
  if (seen) return json(res, 200, { ok: true, duplicate: true });
  try {
    const obj = event.data && event.data.object;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') await onCheckoutCompleted(obj);
    else if (event.type === 'customer.subscription.deleted') await onSubscriptionDeleted(obj);
    else if (event.type === 'invoice.payment_failed') await onPaymentFailed(obj);
    db.prepare('INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?, ?)').run(event.id, now());
  } catch (e) {
    console.error('Webhook handler failed:', e);
    return json(res, 500, { error: 'Handler failed' });
  }
  json(res, 200, { ok: true });
}, { raw: true });

// student accounts
route('POST', '/api/login', async (req, res) => {
  if (limited('login:' + clientIp(req), 6, 900000)) return json(res, 429, { error: 'Too many attempts. Please try again later.' });
  const b = await readJson(req);
  const email = text(b.email, 254).toLowerCase();
  if (!validEmail(email)) return json(res, 400, { error: 'Enter the email address you booked with.' });
  if (limited('loginmail:' + email, 3, 900000)) return json(res, 200, { ok: true });
  const s = db.prepare('SELECT * FROM students WHERE email = ?').get(email);
  if (s) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO login_tokens (hash, student_id, expires_at) VALUES (?, ?, ?)').run(sha(token), s.id, Date.now() + 20 * 60000);
    await sendMail({ to: s.email, replyTo: STUDIO_EMAIL, subject: 'Your RE:ACTORS STUDIO login link', text: `Hello ${s.name},\n\nUse this link to see your booking. It works once and expires in 20 minutes:\n\n${BASE_URL}/account#token=${token}\n\nIf you did not ask for this, you can ignore this email.\n${SIGN_OFF}` });
  }
  json(res, 200, { ok: true }); // same answer whether or not the email is known
});

route('POST', '/api/login/verify', async (req, res) => {
  if (limited('verify:' + clientIp(req), 20, 900000)) return json(res, 429, { error: 'Too many attempts.' });
  const b = await readJson(req);
  const token = text(b.token, 200);
  const row = token ? db.prepare('SELECT * FROM login_tokens WHERE hash = ?').get(sha(token)) : null;
  if (!row || row.used || row.expires_at < Date.now()) return json(res, 400, { error: 'That link has expired. Request a new one.' });
  db.prepare('UPDATE login_tokens SET used = 1 WHERE hash = ?').run(row.hash);
  const ttl = 14 * 86400000;
  json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('rs_student', sign({ id: row.student_id, exp: Date.now() + ttl }), ttl) });
});

route('POST', '/api/logout', async (req, res) => {
  json(res, 200, { ok: true }, { 'Set-Cookie': [cookieHeader('rs_student', '', 0), cookieHeader('rs_admin', '', 0)] });
});

function studentFrom(req) {
  const s = session(req, 'rs_student');
  return s ? db.prepare('SELECT * FROM students WHERE id = ?').get(s.id) : null;
}
route('GET', '/api/me', async (req, res) => {
  const s = studentFrom(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const bookings = db.prepare('SELECT id, term, plan, status, created_at, paid_at, cancelled_at FROM bookings WHERE student_id = ? AND status != ? ORDER BY id DESC').all(s.id, 'pending')
    .map((b) => ({ ...b, plan_label: PLANS[b.plan] ? PLANS[b.plan].label : b.plan }));
  json(res, 200, { student: { name: s.name, email: s.email }, bookings, can_manage_billing: Boolean(s.stripe_customer_id && STRIPE_KEY) });
});
route('POST', '/api/portal', async (req, res) => {
  const s = studentFrom(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  if (!s.stripe_customer_id || !STRIPE_KEY) return json(res, 400, { error: 'No payment account found. Please contact us.' });
  try {
    const p = await stripeRequest(STRIPE_KEY, 'billing_portal/sessions', { customer: s.stripe_customer_id, return_url: `${BASE_URL}/account` });
    json(res, 200, { url: p.url });
  } catch (e) {
    console.error('Portal failed:', e.message);
    json(res, 502, { error: 'We could not open payment management. Please contact us and we will help.' });
  }
});

// admin
function adminOk(req) { return Boolean(session(req, 'rs_admin')); }
route('POST', '/api/admin/login', async (req, res) => {
  if (limited('adm:' + clientIp(req), 8, 900000)) return json(res, 429, { error: 'Too many attempts. Please try again later.' });
  const b = await readJson(req);
  if (ADMIN_PASSWORD.length < 12) return json(res, 503, { error: 'Admin is not set up. Set ADMIN_PASSWORD (12+ characters).' });
  const a = crypto.createHash('sha256').update(String(b.password || '')).digest();
  const c = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, c)) return json(res, 401, { error: 'Wrong password.' });
  const ttl = 12 * 3600000;
  json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('rs_admin', sign({ admin: true, exp: Date.now() + ttl }), ttl) });
});
function adminRows() {
  return db.prepare(`SELECT b.id, b.term, b.plan, b.amount_pence, b.experience, b.status, b.created_at, b.paid_at, b.cancelled_at, b.agreed_at, b.policy_version,
      s.name, s.email, s.phone FROM bookings b JOIN students s ON s.id = b.student_id ORDER BY b.id DESC`).all()
    .map((r) => ({ ...r, plan_label: PLANS[r.plan] ? PLANS[r.plan].label : r.plan }));
}
route('GET', '/api/admin/data', async (req, res) => {
  if (!adminOk(req)) return json(res, 401, { error: 'Not signed in' });
  json(res, 200, {
    term: TERM, max: MAX_PLACES, taken: placesTaken(),
    bookings: adminRows(),
    enquiries: db.prepare('SELECT * FROM enquiries ORDER BY id DESC LIMIT 500').all()
  });
});
route('POST', '/api/admin/booking-status', async (req, res) => {
  if (!adminOk(req)) return json(res, 401, { error: 'Not signed in' });
  const b = await readJson(req);
  if (!['paid', 'pending', 'cancelled', 'refunded'].includes(b.status)) return json(res, 400, { error: 'Bad status' });
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(b.status, Number(b.id));
  json(res, 200, { ok: true });
});
route('POST', '/api/admin/enquiry-handled', async (req, res) => {
  if (!adminOk(req)) return json(res, 401, { error: 'Not signed in' });
  const b = await readJson(req);
  db.prepare('UPDATE enquiries SET handled = ? WHERE id = ?').run(b.handled ? 1 : 0, Number(b.id));
  json(res, 200, { ok: true });
});
route('GET', '/api/admin/bookings.csv', async (req, res) => {
  if (!adminOk(req)) return json(res, 401, { error: 'Not signed in' });
  const cell = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formulas
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const cols = ['id', 'name', 'email', 'phone', 'plan_label', 'status', 'experience', 'term', 'created_at', 'paid_at', 'cancelled_at', 'agreed_at', 'policy_version'];
  const csv = [cols.join(',')].concat(adminRows().map((r) => cols.map((c) => cell(r[c])).join(','))).join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="reactors-bookings.csv"', 'Cache-Control': 'no-store' });
  res.end(csv);
});

// ---------- static files ----------
const PUBLIC = path.join(__dirname, 'public');
const PAGES = { '/': 'index.html', '/account': 'account.html', '/admin': 'admin.html', '/thanks': 'thanks.html' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp' };
function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  const ext = path.extname(file).toLowerCase();
  if (!file.startsWith(PUBLIC + path.sep) || !TYPES[ext]) return false;
  let data;
  try { data = fs.readFileSync(file); } catch { return false; }
  res.writeHead(200, { 'Content-Type': TYPES[ext], 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  ...(BASE_URL.startsWith('https') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {})
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, BASE_URL);
    const r = routes[`${req.method} ${url.pathname}`];
    if (r) {
      if (req.method !== 'GET' && !r.opts.raw) {
        const o = req.headers.origin;
        if (o && o !== BASE_ORIGIN) return json(res, 403, { error: 'Bad origin' });
      }
      return await r.fn(req, res);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`RE:ACTORS STUDIO running at ${BASE_URL} (port ${PORT})`));
}
module.exports = { server };
