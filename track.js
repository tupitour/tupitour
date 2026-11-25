/* Tupi Tour contact/booking measurement. Sends only event names and page path to Google Analytics.
   No names, emails, messages or tour dates are read or sent. */
(function () {
  function send(name, extra) {
    if (typeof window.gtag !== 'function') return;
    var p = { page_path: location.pathname };
    for (var k in (extra || {})) p[k] = extra[k];
    window.gtag('event', name, p);
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href*="wa.me"]') : null;
    if (a) { send('whatsapp_click'); return; }
    var b = e.target && e.target.closest ? e.target.closest('a[data-cta="book"]') : null;
    if (b) send('book_cta_click');
  }, true);
  var wo = window.open;
  window.open = function (u) {
    try {
      if (typeof u === 'string') {
        if (u.indexOf('wa.me') > -1) send('whatsapp_click');
        else if (u.indexOf('mailto:') === 0) send('email_fallback_open');
      }
    } catch (_) {}
    return wo.apply(window, arguments);
  };
  var of = window.fetch;
  if (of) window.fetch = function (u) {
    try { if (typeof u === 'string' && u.indexOf('/.netlify/functions/create-checkout') > -1) send('begin_checkout'); } catch (_) {}
    return of.apply(window, arguments);
  };
  function patchEmailjs() {
    if (!window.emailjs || window.emailjs.__tt) return;
    var s = window.emailjs.send;
    window.emailjs.send = function () {
      var r = s.apply(window.emailjs, arguments);
      try { if (r && r.then) r.then(function () { send('inquiry_sent'); }, function () {}); } catch (_) {}
      return r;
    };
    window.emailjs.__tt = true;
  }
  window.addEventListener('load', function () { patchEmailjs(); setTimeout(patchEmailjs, 1500); });
  if (location.search.indexOf('payment=success') > -1) send('payment_return_success');
})();
