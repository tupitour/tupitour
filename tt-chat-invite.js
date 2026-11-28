/* Tupi Tour chat invite. Own static card. Botpress is NOT loaded until the visitor clicks the button.
   Closed with X: card not shown again in this browser (localStorage); a small Chat pill stays so the visitor can reopen. */
(function () {
  var INJECT = 'https://cdn.botpress.cloud/webchat/v5.0/inject.js';
  var CONFIG = 'https://files.bpcontent.cloud/2026/11/28/15/20261128155254-0LRGK51X.js';
  var KEY = 'tt_chat_invite_closed';
  var closed = false; try { closed = !!localStorage.getItem(KEY); } catch (e) {}
  var l = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
  var TX = {
    pt: ['Passeios guiados no Rio ou viagem pelo Brasil? Fale com nosso assistente.', 'Conversar', 'Assistente virtual (IA). Suas mensagens são processadas pela Botpress, em geral nos EUA. Não escreva dados sensíveis.', 'Política de Privacidade', '/#privacy', 'Fechar'],
    es: ['¿Tours guiados en Río o un viaje por Brasil? Habla con nuestro asistente.', 'Chatear', 'Asistente virtual (IA). Tus mensajes son procesados por Botpress, por lo general en EE. UU. No escribas datos sensibles.', 'Política de Privacidad', '/es/#privacy', 'Cerrar'],
    en: ['Guided tours in Rio or a trip across Brazil? Talk to our assistant.', 'Chat', 'Virtual assistant (AI). Your messages are processed by Botpress, generally in the US. Do not type sensitive data.', 'Privacy Policy', '/#privacy', 'Close']
  };
  var T = TX[l] || TX.en;
  var FONT = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  var started = false, card = null, pill = null, banner = null;
  function findBanner() {
    var out = null;
    [].slice.call(document.querySelectorAll('button')).forEach(function (b) {
      if (!/^(decline|rechazar|recusar)/i.test((b.textContent || '').trim())) return;
      var e = b; while (e && getComputedStyle(e).position !== 'fixed') e = e.parentElement;
      if (e && e.offsetHeight) out = e;
    });
    return out;
  }
  function offset() {
    var off = 16, e = findBanner();
    if (e && e.getBoundingClientRect().top < innerHeight) off = Math.max(off, innerHeight - e.getBoundingClientRect().top + 12);
    return off + 'px';
  }
  var wasOpen = false;
  function chatIsOpen() {
    var h = document.getElementById('fab-root'); var c = h && h.shadowRoot; if (!c) return false;
    return [].slice.call(c.querySelectorAll('*')).some(function (x) { var r = x.getBoundingClientRect(); return r.width > 250 && r.height > 300; });
  }
  function modalOpen() { var m = document.getElementById('privacyModal'); return !!(m && m.classList.contains('open')); }
  function place() { var mo = modalOpen(); if (card) card.style.display = mo ? 'none' : ''; if (pill) pill.style.display = mo ? 'none' : ''; var o = chatIsOpen(); if (o !== wasOpen) { wasOpen = o; chatOpenLayout(o); } if (card) card.style.bottom = offset(); if (pill) pill.style.bottom = offset(); }
  function load(src, cb, err) { var s = document.createElement('script'); s.src = src; s.charset = 'utf-8'; s.onload = cb; s.onerror = err; document.head.appendChild(s); }
  function chatOpenLayout(open) {
    var e = findBanner() || banner;
    if (open && e) { banner = e; e.setAttribute('data-tt-z', e.style.zIndex || ''); e.style.zIndex = '1'; }
    else if (!open && banner) { banner.style.zIndex = banner.getAttribute('data-tt-z') || ''; }
  }
  function start(btn) {
    if (started) { if (window.botpress && window.botpress.open) window.botpress.open(); return; }
    function fail() { if (btn) btn.disabled = false; }
    if (btn) btn.disabled = true;
    load(INJECT, function () {
      if (window.botpress && window.botpress.on) {
        window.botpress.on('webchat:initialized', function () { started = true; window.botpress.open(); if (card) card.remove(); if (pill) pill.remove(); card = pill = null; });
      }
      load(CONFIG, function () {}, fail);
    }, fail);
  }
  function showPill() {
    if (pill || started) return;
    pill = document.createElement('button'); pill.type = 'button';
    pill.setAttribute('aria-label', T[1]);
    pill.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147482000;padding:9px 16px;border:1px solid #222;border-radius:999px;background:#222;color:#fff;font:600 14px ' + FONT + ';cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.2)';
    pill.textContent = '\ud83d\udcac ' + T[1];
    pill.addEventListener('click', function () { start(pill); });
    document.body.appendChild(pill); place();
  }
  function close() { try { localStorage.setItem(KEY, '1'); } catch (e) {} if (card) card.remove(); card = null; showPill(); }
  function showCard() {
    card = document.createElement('div');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', T[0]);
    card.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147482000;width:min(300px,calc(100vw - 32px));box-sizing:border-box;background:#fff;color:#222;border:1px solid #d9d9d9;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:14px 16px;font:14px/1.4 ' + FONT;
    card.innerHTML = '<button type="button" data-x aria-label="' + T[5] + '" style="position:absolute;top:6px;right:8px;border:0;background:none;font-size:22px;line-height:1;cursor:pointer;color:#555">\u00d7</button>' +
      '<p style="margin:0 24px 8px 0;font-weight:600">' + T[0] + '</p>' +
      '<p style="margin:0 0 10px;font-size:12px;color:#555">' + T[2] + ' <a href="' + T[4] + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">' + T[3] + '</a></p>' +
      '<button type="button" data-go style="padding:9px 16px;border:1px solid #222;border-radius:8px;background:#222;color:#fff;font:inherit;font-weight:600;cursor:pointer">' + T[1] + '</button>';
    card.querySelector('a').addEventListener('click', function (e) { if (window.openPrivacy && document.getElementById('privacyModal')) { e.preventDefault(); window.openPrivacy(); place(); } });
    card.querySelector('[data-x]').addEventListener('click', close);
    card.querySelector('[data-go]').addEventListener('click', function () { start(this); });
    document.body.appendChild(card); place();
  }
  function add() { if (closed) showPill(); else showCard(); setInterval(place, 600); }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
