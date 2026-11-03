'use strict';
// Minimal SMTP sender (no packages needed). Works with Gmail on port 465 and most providers.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

class Conn {
  constructor(sock) { this.setSock(sock); }
  setSock(sock) {
    this.sock = sock; this.buf = ''; this.pending = null; this.err = null; this.closed = false;
    sock.on('data', (d) => { this.buf += d.toString('utf8'); this.flush(); });
    sock.on('error', (e) => { this.err = e; this.flush(); });
    sock.on('close', () => { this.closed = true; this.flush(); });
    sock.setTimeout(20000, () => sock.destroy(new Error('SMTP timeout')));
  }
  flush() {
    if (!this.pending) return;
    const p = this.pending;
    if (this.err) { this.pending = null; return p.reject(this.err); }
    let rest = this.buf, idx; const lines = [];
    while ((idx = rest.indexOf('\r\n')) >= 0) {
      const line = rest.slice(0, idx); rest = rest.slice(idx + 2); lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        this.buf = rest; this.pending = null;
        return p.resolve({ code: Number(line.slice(0, 3)), text: lines.join('\n') });
      }
    }
    if (this.closed) { this.pending = null; p.reject(new Error('SMTP connection closed')); }
  }
  reply() { return new Promise((resolve, reject) => { this.pending = { resolve, reject }; this.flush(); }); }
  async cmd(line, okFirstDigits) {
    this.sock.write(line + '\r\n');
    const r = await this.reply();
    if (!okFirstDigits.includes(String(r.code)[0])) throw new Error(`SMTP ${r.code}: ${r.text.slice(0, 120)}`);
    return r;
  }
}

function buildMessage({ from, to, subject, text, replyTo }) {
  const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];
  const headers = [
    `From: ${clean(from)}`,
    `To: ${clean(to)}`,
    replyTo ? `Reply-To: ${clean(replyTo)}` : null,
    `Subject: =?UTF-8?B?${b64(clean(subject))}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${fromAddr.split('@')[1] || 'localhost'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64'
  ].filter(Boolean);
  const body = b64(text).replace(/(.{76})/g, '$1\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

async function smtpSend(cfg, msg) {
  const secure = cfg.secure;
  const sock = await new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s))
      : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once('error', reject);
  });
  const c = new Conn(sock);
  try {
    let r = await c.reply();
    if (r.code !== 220) throw new Error(`SMTP greeting ${r.code}`);
    r = await c.cmd('EHLO reactors-studio', '2');
    if (!secure && /STARTTLS/i.test(r.text)) {
      await c.cmd('STARTTLS', '2');
      c.sock.removeAllListeners('data'); c.sock.removeAllListeners('error'); c.sock.removeAllListeners('close');
      const t = await new Promise((resolve, reject) => {
        const x = tls.connect({ socket: c.sock, servername: cfg.host }, () => resolve(x));
        x.once('error', reject);
      });
      c.setSock(t);
      r = await c.cmd('EHLO reactors-studio', '2');
    }
    if (cfg.user) {
      await c.cmd('AUTH LOGIN', '3');
      await c.cmd(b64(cfg.user), '3');
      await c.cmd(b64(cfg.pass), '2');
    }
    const fromAddr = (msg.from.match(/<([^>]+)>/) || [null, msg.from])[1];
    await c.cmd(`MAIL FROM:<${clean(fromAddr)}>`, '2');
    await c.cmd(`RCPT TO:<${clean(msg.to)}>`, '2');
    await c.cmd('DATA', '3');
    c.sock.write(buildMessage(msg) + '\r\n.\r\n');
    const done = await c.reply();
    if (String(done.code)[0] !== '2') throw new Error(`SMTP ${done.code}`);
    try { c.sock.write('QUIT\r\n'); } catch { /* ignore */ }
  } finally {
    c.sock.destroy();
  }
}

function config() {
  const host = process.env.SMTP_HOST;
  if (!host || !process.env.SMTP_USER) return null;
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== 'false' : port === 465;
  return { host, port, secure, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' };
}

async function sendMail({ to, subject, text, replyTo }) {
  const cfg = config();
  if (!cfg) { console.log('[email not configured] would send:', clean(subject), '->', clean(to)); return false; }
  const from = process.env.MAIL_FROM || `RE:ACTORS STUDIO <${cfg.user}>`;
  try {
    await smtpSend(cfg, { from, to, subject, text, replyTo });
    return true;
  } catch (e) {
    console.error('Email failed:', e.message);
    return false;
  }
}

module.exports = { sendMail, buildMessage };
