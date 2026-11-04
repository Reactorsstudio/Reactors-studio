'use strict';
// Minimal Stripe client using Stripe's HTTP API directly, so no packages are needed.
const crypto = require('node:crypto');

function encode(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => {
      if (item !== null && typeof item === 'object') encode(item, `${key}[${i}]`, out);
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
    });
    else if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

async function stripeRequest(secretKey, path, params) {
  const base = process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1';
  const res = await fetch(`${base}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: encode(params).join('&'),
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Stripe error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Verifies the Stripe-Signature header and returns the parsed event, or throws.
function verifyWebhook(rawBody, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!header || !secret) throw new Error('Missing signature or secret');
  const parts = Object.fromEntries(header.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = parts.t;
  const sigs = header.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  if (!t || !sigs.length) throw new Error('Bad signature header');
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) throw new Error('Signature timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('Signature mismatch');
  return JSON.parse(rawBody);
}

function signForTest(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

module.exports = { stripeRequest, verifyWebhook, signForTest, encode };
