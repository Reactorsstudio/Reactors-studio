(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-copy]');
    if (!b) return;
    var orig = b.textContent;
    try {
      navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
        b.textContent = 'Copied'; setTimeout(function () { b.textContent = orig; }, 1500);
      }, function () { b.textContent = 'Select and copy'; });
    } catch (e) { b.textContent = 'Select and copy'; }
  });

  fetch('/api/places').then(function (r) { return r.json(); }).then(function (d) {
    var n = $('places-note');
    if (!n) return;
    if (d.left <= 0) n.textContent = 'This term is full. Email us to join the waiting list.';
    else if (d.left <= 5) n.textContent = 'Only ' + d.left + ' places left this term.';
  }).catch(function () {});

  $('enrol-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = $('e-err'), btn = $('e-submit');
    var name = $('e-name').value.trim(), email = $('e-email').value.trim();
    if (name.length < 2) { err.textContent = 'Enter your full name.'; $('e-name').focus(); return; }
    if (!validEmail(email)) { err.textContent = 'Enter a valid email address so we can reach you.'; $('e-email').focus(); return; }
    if (!$('e-agree').checked) { err.textContent = 'Tick the box to confirm you have read the booking and refund policy.'; $('e-agree').focus(); return; }
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Opening secure payment...';
    post('/api/checkout', {
      name: name, email: email, phone: $('e-phone').value.trim(), experience: $('e-exp').value,
      plan: document.querySelector('input[name="plan"]:checked').value, agree: true
    }).then(function (d) {
      window.location.href = d.url;
    }).catch(function (e) {
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Continue to secure payment';
    });
  });

  $('ask-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = $('q-err'), note = $('q-note');
    var text = $('q-text').value.trim(), email = $('q-email').value.trim();
    note.textContent = '';
    if (!text) { err.textContent = 'Write your question first.'; $('q-text').focus(); return; }
    if (!validEmail(email)) { err.textContent = 'Add your email so we can reply.'; $('q-email').focus(); return; }
    err.textContent = '';
    post('/api/enquiry', { name: $('q-name').value.trim(), email: email, question: text }).then(function () {
      note.className = 'note ok';
      note.textContent = 'Thank you. We have your question and will reply by email soon.';
      $('q-text').value = '';
    }).catch(function (e) { err.textContent = e.message; });
  });
})();
