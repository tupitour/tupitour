/* Tupi Tour analytics consent. Google Analytics is not loaded and sets no cookies
   until the visitor clicks Accept. The choice is kept in this browser (localStorage). */
(function () {
  var ID = 'G-R9W94NBK2M', KEY = 'tt_analytics_consent';
  var es = /^es/i.test(document.documentElement.lang || '');
  var T = es ? {
    msg: 'Usamos Google Analytics para entender cómo se usa este sitio. Solo se activa si lo aceptas.',
    yes: 'Aceptar', no: 'Rechazar', pol: 'Política de Privacidad', set: 'Ajustes de cookies', home: '/es/'
  } : {
    msg: 'We use Google Analytics to understand how this site is used. It only runs if you accept.',
    yes: 'Accept', no: 'Decline', pol: 'Privacy Policy', set: 'Cookie settings', home: '/'
  };
  var noop = function () {};
  var real = function () { window.dataLayer.push(arguments); };
  window.dataLayer = window.dataLayer || [];
  window.gtag = noop;
  var loaded = false;

  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function put(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function load() {
    if (loaded) return;
    loaded = true;
    window['ga-disable-' + ID] = false;
    window.gtag = real;
    gtag('js', new Date());
    var loc, ref;
    try {
      var k = /^(utm_(source|medium|campaign|term|content)|gclid|gbraid|wbraid|tour)$/;
      var u = new URL(location.href), s = new URLSearchParams();
      u.searchParams.forEach(function (v, n) { if (k.test(n)) s.set(n, v); });
      var q = s.toString();
      loc = u.origin + u.pathname + (q ? '?' + q : '');
      ref = document.referrer ? new URL(document.referrer).origin + '/' : '';
    } catch (e) { loc = location.origin + location.pathname; ref = ''; }
    gtag('config', ID, { page_location: loc, page_referrer: ref });
    var sc = document.createElement('script');
    sc.async = true;
    sc.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
    document.head.appendChild(sc);
  }

  function clearCookies() {
    var names = document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); })
      .filter(function (n) { return n === '_ga' || n.indexOf('_ga_') === 0 || n === '_gid' || n.indexOf('_gat') === 0; });
    var host = location.hostname.split('.');
    var domains = ['', location.hostname];
    if (host.length > 2) domains.push('.' + host.slice(-2).join('.'));
    else domains.push('.' + location.hostname);
    names.forEach(function (n) {
      domains.forEach(function (d) {
        document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  function accept() { put('granted'); load(); hide(); }
  function decline() {
    put('denied');
    window['ga-disable-' + ID] = true;
    window.gtag = noop;
    clearCookies();
    hide();
  }

  var box;
  function hide() { if (box && box.parentNode) box.parentNode.removeChild(box); box = null; }
  function privacy(e) {
    if (window.openPrivacy && document.getElementById('privacyModal')) { e.preventDefault(); window.openPrivacy(); }
  }
  function show() {
    if (box) return;
    box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Cookies');
    box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483000;background:#fff;color:#222;' +
      'border-top:1px solid #d9d9d9;box-shadow:0 -4px 16px rgba(0,0,0,.12);padding:12px 16px;' +
      'font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:center';
    var p = document.createElement('p');
    p.style.cssText = 'margin:0;flex:1 1 280px;max-width:640px';
    p.appendChild(document.createTextNode(T.msg + ' '));
    var a = document.createElement('a');
    a.href = T.home + '#privacy';
    a.textContent = T.pol;
    a.style.cssText = 'color:inherit;text-decoration:underline';
    a.addEventListener('click', privacy);
    p.appendChild(a);
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px';
    var bs = 'min-width:104px;padding:9px 16px;border:1px solid #222;border-radius:6px;background:#fff;color:#222;font:inherit;font-weight:600;cursor:pointer';
    [[T.no, decline], [T.yes, accept]].forEach(function (x) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = x[0];
      b.style.cssText = bs;
      b.addEventListener('click', x[1]);
      row.appendChild(b);
    });
    box.appendChild(p);
    box.appendChild(row);
    document.body.appendChild(box);
  }

  function footerLink() {
    var f = document.querySelector('footer');
    if (!f) return;
    var host = f.querySelector('p:last-of-type') || f;
    var a = document.createElement('a');
    a.href = '#';
    a.textContent = T.set;
    a.setAttribute('data-tt-cookie-settings', '1');
    a.style.cssText = 'margin-left:.5em';
    a.addEventListener('click', function (e) { e.preventDefault(); show(); });
    host.appendChild(document.createTextNode(' · '));
    host.appendChild(a);
  }

  if (get() === 'granted') load();
  else if (get() === 'denied') window['ga-disable-' + ID] = true;

  document.addEventListener('DOMContentLoaded', function () {
    footerLink();
    if (!get()) show();
    if (location.hash === '#privacy' && window.openPrivacy && document.getElementById('privacyModal')) window.openPrivacy();
  });
})();
