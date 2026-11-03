(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function show(id) { ['login-view', 'account-view', 'loading'].forEach(function (x) { $(x).hidden = x !== id; }); }
  async function api(url, body) {
    const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.status = res.status; throw e; }
    return data;
  }
  function fmt(iso) { return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''; }
  var STATUS = { paid: 'Confirmed', cancelled: 'Cancelled', refunded: 'Refunded' };

  function render(me) {
    $('hello').textContent = 'Hello, ' + me.student.name.split(' ')[0];
    var box = $('bookings'); box.textContent = '';
    if (!me.bookings.length) {
      var p = document.createElement('p'); p.textContent = 'You have no confirmed bookings yet.'; box.appendChild(p);
    }
    me.bookings.forEach(function (b) {
      var d = document.createElement('div'); d.className = 'panel';
      var h = document.createElement('h3'); h.textContent = b.plan_label; d.appendChild(h);
      var pill = document.createElement('span'); pill.className = 'pill ' + b.status; pill.textContent = STATUS[b.status] || b.status; d.appendChild(pill);
      var dl = document.createElement('dl'); dl.className = 'summary';
      [['Term starts', 'Wednesday 6 January 2027'], ['Time', 'Wednesday evenings, 7:00 to 9:30pm'], ['Place', 'York Street Methodist Church, 25 York Street, Broadstairs CT10 1PS'],
        [b.status === 'cancelled' ? 'Cancelled' : 'Booked', fmt(b.status === 'cancelled' ? b.cancelled_at : (b.paid_at || b.created_at))]].forEach(function (r) {
        var dt = document.createElement('dt'); dt.textContent = r[0];
        var dd = document.createElement('dd'); dd.textContent = r[1];
        dl.appendChild(dt); dl.appendChild(dd);
      });
      d.appendChild(dl); box.appendChild(d);
    });
    $('portal-btn').hidden = !me.can_manage_billing;
    show('account-view');
  }

  async function init() {
    var m = location.hash.match(/^#token=([\w-]+)/);
    if (m) {
      history.replaceState(null, '', location.pathname);
      try { await api('/api/login/verify', { token: m[1] }); }
      catch (e) { show('login-view'); $('l-err').textContent = e.message; return; }
    }
    try { render(await api('/api/me')); }
    catch (e) { show('login-view'); }
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var email = $('l-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('l-err').textContent = 'Enter the email address you booked with.'; return; }
    $('l-err').textContent = '';
    $('l-btn').disabled = true;
    api('/api/login', { email: email }).then(function () {
      $('l-ok').textContent = 'If that email has a booking, a login link is on its way. It works once and expires in 20 minutes.';
    }).catch(function (e) { $('l-err').textContent = e.message; }).finally(function () { $('l-btn').disabled = false; });
  });
  $('portal-btn').addEventListener('click', function () {
    $('a-err').textContent = '';
    api('/api/portal', {}).then(function (d) { window.location.href = d.url; }).catch(function (e) { $('a-err').textContent = e.message; });
  });
  $('logout-btn').addEventListener('click', function () {
    api('/api/logout', {}).then(function () { location.reload(); });
  });
  init();
})();
