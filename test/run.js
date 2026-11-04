'use strict';
// End-to-end test with a fake Stripe and a fake SMTP server. Run: npm test
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3917, STRIPE_PORT = 3918, SMTP_PORT = 3919;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reactors-test-'));
Object.assign(process.env, {
  PORT: String(PORT), BASE_URL: `http://localhost:${PORT}`, DATA_DIR: dir, SESSION_SECRET: 'test-secret-test-secret-test-secret',
  ADMIN_PASSWORD: 'correct horse battery staple', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}/v1`, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false',
  SMTP_USER: 'studio@example.com', SMTP_PASS: 'pw', STUDIO_EMAIL: 'studio@example.com', MAX_PLACES: '2', TERM_START: '2027-01-06'
});
const { server } = require('../server');
const db = require('../lib/db');
const { signForTest } = require('../lib/stripe');

const mails = [];
const smtp = net.createServer((sock) => {
  let inData = false, buf = '', cur = { raw: '' };
  sock.write('220 fake\r\n');
  sock.on('data', (d) => {
    buf += d.toString();
    let i;
    while (inData ? buf.includes('\r\n.\r\n') : (i = buf.indexOf('\r\n')) >= 0) {
      if (inData) {
        const j = buf.indexOf('\r\n.\r\n'); cur.raw = buf.slice(0, j); buf = buf.slice(j + 5); inData = false;
        mails.push(parse(cur)); cur = { raw: '' }; sock.write('250 queued\r\n'); continue;
      }
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
      else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
      else if (/^[A-Za-z0-9+/=]+$/.test(line) && !cur.authed) { cur.step = (cur.step || 0) + 1; if (cur.step === 1) sock.write('334 UGFzc3dvcmQ6\r\n'); else { cur.authed = true; sock.write('235 ok\r\n'); } }
      else if (/^MAIL FROM/.test(line)) sock.write('250 ok\r\n');
      else if (/^RCPT TO:<(.+)>/.test(line)) { cur.to = line.match(/<(.+)>/)[1]; sock.write('250 ok\r\n'); }
      else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (line === 'QUIT') sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    }
  });
});
function parse(cur) {
  const [head, body] = cur.raw.split('\r\n\r\n');
  const subj = (head.match(/^Subject: =\?UTF-8\?B\?(.+)\?=/m) || [])[1];
  return { to: cur.to, subject: subj ? Buffer.from(subj, 'base64').toString() : '', text: Buffer.from((body || '').replace(/\r\n/g, ''), 'base64').toString() };
}

const stripeCalls = [];
const fakeStripe = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    stripeCalls.push({ url: req.url, auth: req.headers.authorization, params: new URLSearchParams(b) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('checkout/sessions')) res.end(JSON.stringify({ id: 'cs_test_' + stripeCalls.length, url: 'https://checkout.stripe.com/c/pay/x' }));
    else res.end(JSON.stringify({ url: 'https://billing.stripe.com/p/session/x' }));
  });
});

const base = `http://localhost:${PORT}`;
async function call(method, url, body, cookie, headers) {
  const res = await fetch(base + url, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text(), setCookie: res.headers.getSetCookie() };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

(async () => {
  await new Promise((r) => smtp.listen(SMTP_PORT, r));
  await new Promise((r) => fakeStripe.listen(STRIPE_PORT, r));
  await new Promise((r) => server.listen(PORT, r));
  const cardOf = (cs) => cs.map((c) => c.split(';')[0]).join('; ');

  await t('serves pages and blocks path traversal', async () => {
    for (const p of ['/', '/account', '/admin', '/thanks', '/site.css', '/site.js']) assert.equal((await call('GET', p)).status, 200, p);
    assert.match((await call('GET', '/')).data, /Adult Acting Classes in Broadstairs/);
    assert.equal((await call('GET', '/../server.js')).status, 404);
    assert.equal((await call('GET', '/%2e%2e/server.js')).status, 404);
    assert.equal((await call('GET', '/lib/db.js')).status, 404);
    assert.match((await call('GET', '/')).headers.get('content-security-policy'), /script-src 'self'/);
  });

  await t('rejects cross-origin posts', async () => {
    const r = await call('POST', '/api/enquiry', { email: 'a@b.co', question: 'x' }, null, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  await t('enquiry validates, stores and emails both sides', async () => {
    assert.equal((await call('POST', '/api/enquiry', { email: 'bad', question: 'hi' })).status, 400);
    assert.equal((await call('POST', '/api/enquiry', { email: 'a@b.co', question: '' })).status, 400);
    const r = await call('POST', '/api/enquiry', { name: 'Ann', email: 'ann@example.com', question: 'Is it ok for beginners?' });
    assert.equal(r.status, 200);
    await wait(300);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM enquiries').get().n, 1);
    assert.ok(mails.find((m) => m.to === 'studio@example.com' && /Question from Ann/.test(m.subject) && /beginners/.test(m.text)));
    assert.ok(mails.find((m) => m.to === 'ann@example.com' && /We have your question/.test(m.subject)));
  });

  await t('checkout validates input', async () => {
    const ok = { name: 'Ben Smith', email: 'ben@example.com', plan: 'term', agree: true };
    assert.equal((await call('POST', '/api/checkout', { ...ok, agree: false })).status, 400);
    assert.equal((await call('POST', '/api/checkout', { ...ok, plan: 'free' })).status, 400);
    assert.equal((await call('POST', '/api/checkout', { ...ok, email: 'nope' })).status, 400);
    assert.equal((await call('POST', '/api/checkout', { ...ok, name: '' })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, 0);
  });

  let monthlyBooking;
  await t('monthly checkout creates a subscription session', async () => {
    const r = await call('POST', '/api/checkout', { name: 'Ben Smith', email: 'Ben@Example.com', phone: '07000', experience: 'Some experience', plan: 'monthly', agree: true });
    assert.equal(r.status, 200); assert.match(r.data.url, /^https:\/\/checkout\.stripe\.com/);
    const c = stripeCalls.at(-1); const p = c.params;
    assert.equal(c.auth, 'Bearer sk_test_x');
    assert.equal(p.get('mode'), 'subscription');
    assert.equal(p.get('line_items[0][price_data][unit_amount]'), '9500');
    assert.equal(p.get('line_items[0][price_data][currency]'), 'gbp');
    assert.equal(p.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.equal(p.get('customer_email'), 'ben@example.com');
    monthlyBooking = db.prepare('SELECT * FROM bookings').get();
    assert.equal(monthlyBooking.status, 'pending');
    assert.equal(p.get('metadata[booking_id]'), String(monthlyBooking.id));
    assert.equal(p.get('subscription_data[metadata][booking_id]'), String(monthlyBooking.id));
    assert.equal(monthlyBooking.policy_version, '2026-11');
  });

  await t('webhook rejects bad signatures', async () => {
    const body = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } });
    assert.equal((await call('POST', '/api/stripe/webhook', null, null, {})).status, 400);
    const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': 't=1,v1=abc' }, body });
    assert.equal(r.status, 400);
    const old = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': signForTest(body, 'whsec_test', 1000) }, body });
    assert.equal(old.status, 400);
    const wrong = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': signForTest(body, 'other') }, body });
    assert.equal(wrong.status, 400);
  });

  async function webhook(event) {
    const body = JSON.stringify(event);
    const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': signForTest(body, 'whsec_test') }, body });
    return { status: r.status, data: await r.json() };
  }

  await t('paid webhook confirms the booking once and emails', async () => {
    mails.length = 0;
    const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_live_1', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1', metadata: { booking_id: String(monthlyBooking.id) } } } };
    assert.equal((await webhook(ev)).status, 200);
    await wait(300);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(monthlyBooking.id);
    assert.equal(b.status, 'paid'); assert.equal(b.stripe_subscription_id, 'sub_1');
    assert.equal(db.prepare('SELECT stripe_customer_id c FROM students').get().c, 'cus_1');
    assert.ok(mails.find((m) => m.to === 'ben@example.com' && /confirmed/.test(m.subject) && /6 January 2027/.test(m.text)));
    assert.ok(mails.find((m) => m.to === 'studio@example.com' && /New booking: Ben Smith/.test(m.subject) && /1 of 2/.test(m.text)));
    const n = mails.length;
    assert.equal((await webhook(ev)).data.duplicate, true);
    await wait(100); assert.equal(mails.length, n);
  });

  await t('unpaid sessions are ignored', async () => {
    const r = await call('POST', '/api/checkout', { name: 'Cara Jones', email: 'cara@example.com', plan: 'term', agree: true });
    assert.equal(r.status, 200);
    const p = stripeCalls.at(-1).params;
    assert.equal(p.get('mode'), 'payment'); assert.equal(p.get('line_items[0][price_data][unit_amount]'), '29500'); assert.equal(p.get('customer_creation'), 'always');
    const id = db.prepare("SELECT id FROM bookings WHERE status='pending'").get().id;
    await webhook({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'unpaid', metadata: { booking_id: String(id) } } } });
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(id).status, 'pending');
    await webhook({ id: 'evt_3', type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'paid', customer: 'cus_2', metadata: { booking_id: String(id) } } } });
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(id).status, 'paid');
  });

  await t('stops selling when the term is full', async () => {
    assert.equal((await call('GET', '/api/places')).data.left, 0);
    const r = await call('POST', '/api/checkout', { name: 'Dan Late', email: 'dan@example.com', plan: 'term', agree: true });
    assert.equal(r.status, 409);
  });

  await t('student magic-link login, account view and billing portal', async () => {
    mails.length = 0;
    const unknown = await call('POST', '/api/login', { email: 'nobody@example.com' });
    assert.equal(unknown.status, 200); await wait(150); assert.equal(mails.length, 0);
    assert.equal((await call('POST', '/api/login', { email: 'ben@example.com' })).status, 200);
    await wait(300);
    const m = mails.find((x) => x.to === 'ben@example.com' && /login link/.test(x.subject));
    const token = m.text.match(/#token=([\w-]+)/)[1];
    assert.equal((await call('POST', '/api/login/verify', { token: 'wrong' })).status, 400);
    const v = await call('POST', '/api/login/verify', { token });
    assert.equal(v.status, 200); assert.match(v.setCookie[0], /HttpOnly/);
    assert.equal((await call('POST', '/api/login/verify', { token })).status, 400); // single use
    const cookie = cardOf(v.setCookie);
    assert.equal((await call('GET', '/api/me')).status, 401);
    const me = await call('GET', '/api/me', null, cookie);
    assert.equal(me.data.student.email, 'ben@example.com'); assert.equal(me.data.bookings.length, 1); assert.equal(me.data.can_manage_billing, true);
    const portal = await call('POST', '/api/portal', {}, cookie);
    assert.match(portal.data.url, /billing\.stripe\.com/);
    assert.equal(stripeCalls.at(-1).params.get('customer'), 'cus_1');
    const forged = await call('GET', '/api/me', null, 'rs_student=' + Buffer.from('{"id":1,"exp":9999999999999}').toString('base64url') + '.abc');
    assert.equal(forged.status, 401);
  });

  await t('cancelled subscription is recorded and frees the place', async () => {
    mails.length = 0;
    await webhook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
    await wait(300);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(monthlyBooking.id).status, 'cancelled');
    assert.ok(mails.find((m) => m.to === 'studio@example.com' && /Subscription cancelled/.test(m.subject)));
    assert.equal((await call('GET', '/api/places')).data.left, 1);
  });

  await t('admin is protected and works', async () => {
    assert.equal((await call('GET', '/api/admin/data')).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
    const l = await call('POST', '/api/admin/login', { password: 'correct horse battery staple' });
    assert.equal(l.status, 200);
    const cookie = cardOf(l.setCookie);
    const d = await call('GET', '/api/admin/data', null, cookie);
    assert.equal(d.data.bookings.length, 2); assert.equal(d.data.enquiries.length, 1); assert.equal(d.data.max, 2);
    // student cookie must not grant admin
    const studentOnly = await call('GET', '/api/admin/data', null, 'rs_student=x');
    assert.equal(studentOnly.status, 401);
    db.prepare("UPDATE students SET name = '=HYPERLINK(\"http://x\")' WHERE email = 'cara@example.com'").run();
    const csv = await call('GET', '/api/admin/bookings.csv', null, cookie);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.data, /"'=HYPERLINK/); assert.doesNotMatch(csv.data, /"=HYPERLINK/);
    const id = d.data.bookings[0].id;
    assert.equal((await call('POST', '/api/admin/booking-status', { id, status: 'refunded' }, cookie)).status, 200);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(id).status, 'refunded');
    assert.equal((await call('POST', '/api/admin/booking-status', { id, status: 'hacked' }, cookie)).status, 400);
    assert.equal((await call('POST', '/api/admin/enquiry-handled', { id: 1, handled: true }, cookie)).status, 200);
    assert.equal(db.prepare('SELECT handled FROM enquiries').get().handled, 1);
  });

  console.log(`\n${passed} test groups passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
