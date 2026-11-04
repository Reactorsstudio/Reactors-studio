(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function show(id) { ['login-view', 'data-view', 'loading'].forEach(function (x) { $(x).hidden = x !== id; }); }
  async function api(url, body) {
    const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.status = res.status; throw e; }
    return data;
  }
  function fmt(iso) { return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  function el(tag, txt, cls) { var e = document.createElement(tag); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; }

  function render(d) {
    var stats = $('stats'); stats.textContent = '';
    [[d.taken + ' / ' + d.max, 'places taken'], [d.bookings.filter(function (b) { return b.status === 'paid' && b.plan === 'monthly'; }).length, 'active monthly'],
     [d.enquiries.filter(function (q) { return !q.handled; }).length, 'open questions']].forEach(function (s) {
      var x = el('div'); x.appendChild(el('b', s[0])); x.appendChild(el('span', s[1])); stats.appendChild(x);
    });

    var t = $('bookings'); t.textContent = '';
    var head = el('tr'); ['Student', 'Plan', 'Status', 'Booked', 'Experience'].forEach(function (h) { head.appendChild(el('th', h)); });
    var thead = el('thead'); thead.appendChild(head); t.appendChild(thead);
    var body = el('tbody');
    if (!d.bookings.length) { var r0 = el('tr'); var c0 = el('td', 'No bookings yet.'); c0.colSpan = 5; r0.appendChild(c0); body.appendChild(r0); }
    d.bookings.forEach(function (b) {
      var r = el('tr');
      var c1 = el('td', b.name); c1.appendChild(el('small', b.email)); if (b.phone) c1.appendChild(el('small', b.phone)); r.appendChild(c1);
      r.appendChild(el('td', b.plan_label));
      var c3 = el('td');
      var sel = el('select', null, 'small'); sel.setAttribute('aria-label', 'Status for ' + b.name);
      ['pending', 'paid', 'cancelled', 'refunded'].forEach(function (s) { var o = el('option', s); o.value = s; if (s === b.status) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () {
        api('/api/admin/booking-status', { id: b.id, status: sel.value }).then(load).catch(function (e) { $('d-err').textContent = e.message; });
      });
      c3.appendChild(sel); r.appendChild(c3);
      var c4 = el('td', fmt(b.created_at)); if (b.paid_at) c4.appendChild(el('small', 'Paid ' + fmt(b.paid_at))); r.appendChild(c4);
      r.appendChild(el('td', b.experience));
      body.appendChild(r);
    });
    t.appendChild(body);

    var q = $('enquiries'); q.textContent = '';
    if (!d.enquiries.length) q.appendChild(el('p', 'No questions yet.'));
    d.enquiries.forEach(function (e) {
      var box = el('div', null, 'enq');
      box.appendChild(el('strong', (e.name || 'No name') + (e.handled ? ' (handled)' : '')));
      box.appendChild(el('small', ' ' + e.email + ' · ' + fmt(e.created_at)));
      box.appendChild(el('pre', e.question));
      var acts = el('div', null, 'row-actions');
      var reply = el('a', 'Reply by email', 'mini'); reply.href = 'mailto:' + e.email; reply.style.textDecoration = 'none'; acts.appendChild(reply);
      var h = el('button', e.handled ? 'Mark as open' : 'Mark as handled', 'mini'); h.type = 'button';
      h.addEventListener('click', function () { api('/api/admin/enquiry-handled', { id: e.id, handled: !e.handled }).then(load); });
      acts.appendChild(h); box.appendChild(acts); q.appendChild(box);
    });
    show('data-view');
  }
  function load() { return api('/api/admin/data').then(render).catch(function (e) { if (e.status === 401) show('login-view'); else { show('data-view'); $('d-err').textContent = e.message; } }); }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('/api/admin/login', { password: $('a-pass').value }).then(function () { $('a-pass').value = ''; return load(); })
      .catch(function (e) { $('l-err').textContent = e.message; });
  });
  $('logout-btn').addEventListener('click', function () { api('/api/logout', {}).then(function () { location.reload(); }); });
  load();
})();
