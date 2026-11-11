/* ELWORK Sklad – appka na čítanie čiarových kódov */
(function () {
  'use strict';

  var APP_VERSION = '1.0.3';
  var CFG = window.SKLAD_CONFIG || {};
  var VAT = Number(CFG.VAT_PERCENT != null ? CFG.VAT_PERCENT : 5);
  var SAME_CODE_PAUSE_MS = 2000; // ten istý kód sa neopakuje, kým je pred kamerou

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    loadedAt: $('loadedAt'), reloadBtn: $('reloadBtn'), reloadLabel: $('reloadLabel'),
    camera: $('camera'), video: $('video'), camStatus: $('camStatus'), camStart: $('camStart'),
    torchBtn: $('torchBtn'), form: $('searchForm'), q: $('q'), result: $('result'),
    toast: $('toast'), version: $('appVersion'), themeColor: $('themeColor')
  };
  els.version.textContent = APP_VERSION;

  /* ---------------- Téma ---------------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('sklad-theme', t); } catch (e) {}
    document.querySelectorAll('[data-set-theme]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-set-theme') === t));
    });
    els.themeColor.setAttribute('content', t === 'dark' ? '#1a1f23' : '#ffffff');
  }
  document.querySelectorAll('[data-set-theme]').forEach(function (b) {
    b.addEventListener('click', function () { applyTheme(b.getAttribute('data-set-theme')); });
  });
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

  /* ---------------- Pomocné ---------------- */
  var money = new Intl.NumberFormat('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var qtyFmt = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 3 });
  function gross(net) { return Math.round(net * 100 * (100 + VAT) / 100) / 100; }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + d.getFullYear() + ', ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function digitsKey(s) { return String(s || '').replace(/\s/g, '').replace(/^0+(?=\d)/, ''); }
  function fold(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.className = 'toast' + (isError ? ' error' : '');
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, isError ? 5000 : 2500);
  }

  /* ---------------- Uloženie skladu v zariadení (IndexedDB) ---------------- */
  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('elwork-sklad', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function idbSet(key, val) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------------- Sklad a index ---------------- */
  var stock = null;           // { loadedAt, fileName, items: [[card,name,qty,price,ean], ...] }
  var byCard = new Map();     // karta (bez úvodných núl) -> [položky]
  var byEan = new Map();      // EAN (bez úvodných núl) -> [položky]

  function toItem(r) { return { card: r[0], name: r[1], qty: Number(r[2]) || 0, price: Number(r[3]) || 0, ean: r[4] || '' }; }
  function addTo(map, key, item) {
    if (!key) return;
    var arr = map.get(key);
    if (arr) arr.push(item); else map.set(key, [item]);
  }
  function setStock(data) {
    stock = data;
    byCard = new Map(); byEan = new Map();
    stock.list = data.items.map(toItem);
    stock.list.forEach(function (it) {
      addTo(byCard, digitsKey(it.card), it);
      String(it.ean).split(/[;,\s]+/).forEach(function (e) { addTo(byEan, digitsKey(e), it); });
    });
    els.loadedAt.textContent = fmtDate(data.loadedAt);
  }

  /* ---------------- Kód predajne (heslo uložené len v zariadení) ---------------- */
  var KEY_STORE = 'sklad-key';
  var keyDialog = $('keyDialog'), keyInput = $('keyInput'), keyMsg = $('keyMsg');
  var KEY_MSG_DEFAULT = keyMsg.textContent;
  function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function setKey(k) {
    try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch (e) {}
  }
  var keyResolve = null;
  function askKey(msg) {
    keyMsg.textContent = msg || KEY_MSG_DEFAULT;
    keyInput.value = '';
    if (keyDialog.showModal) keyDialog.showModal(); else keyDialog.setAttribute('open', '');
    setTimeout(function () { keyInput.focus(); }, 50);
    return new Promise(function (resolve) { keyResolve = resolve; });
  }
  function closeKey(val) {
    if (keyDialog.close) keyDialog.close(); else keyDialog.removeAttribute('open');
    if (keyResolve) { var r = keyResolve; keyResolve = null; r(val); }
  }
  $('keyForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = keyInput.value.trim();
    if (v) closeKey(v);
  });
  $('keyCancel').addEventListener('click', function () { closeKey(null); });
  keyDialog.addEventListener('cancel', function (e) { e.preventDefault(); closeKey(null); });
  $('changeKey').addEventListener('click', function () {
    askKey().then(function (k) { if (k) { setKey(k); reloadStock(); } });
  });

  function reloadStock() {
    if (!CFG.GAS_URL) { toast('V config.js chýba GAS_URL (adresa Apps Scriptu).', true); return; }
    var key = getKey();
    if (!key) {
      askKey().then(function (k) { if (k) { setKey(k); reloadStock(); } });
      return;
    }
    els.reloadBtn.disabled = true;
    els.reloadBtn.classList.add('loading');
    els.reloadLabel.textContent = 'Načítavam…';
    var url = CFG.GAS_URL + (CFG.GAS_URL.indexOf('?') < 0 ? '?' : '&') +
      'key=' + encodeURIComponent(key) + '&t=' + Date.now();
    var badKey = false;
    fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('Server vrátil ' + r.status); return r.json(); })
      .then(function (data) {
        if (data && !data.ok && /kľúč|API_KEY/i.test(data.error || '')) { badKey = true; throw new Error('Nesprávny kód predajne.'); }
        if (!data || !data.ok) throw new Error((data && data.error) || 'Neznáma chyba servera');
        var saved = { loadedAt: data.loadedAt || new Date().toISOString(), fileName: data.fileName,
          fileUpdated: data.fileUpdated, items: data.items };
        setStock(saved);
        renderIdle();
        toast('Sklad načítaný: ' + qtyFmt.format(data.count) + ' položiek');
        return idbSet('stock', saved).catch(function () {
          toast('Sklad sa nepodarilo uložiť do zariadenia, po zatvorení appky ho načítajte znova.', true);
        });
      })
      .catch(function (err) {
        if (badKey) return;
        if (navigator.onLine === false) {
          toast('Ste offline. Sklad sa dá načítať len s internetom.' +
            (stock ? ' Appka používa sklad z ' + fmtDate(stock.loadedAt) + '.' : ''), true);
          return;
        }
        toast('Sklad sa nepodarilo načítať: ' + (err.message || err) +
          (stock ? ' Ostáva posledný načítaný.' : ''), true);
      })
      .then(function () {
        els.reloadBtn.disabled = false;
        els.reloadBtn.classList.remove('loading');
        els.reloadLabel.textContent = 'Načítať sklad';
        if (badKey) {
          setKey('');
          askKey('Kód predajne nie je správny. Zadajte ho znova.')
            .then(function (k) { if (k) { setKey(k); reloadStock(); } });
        }
      });
  }
  els.reloadBtn.addEventListener('click', reloadStock);

  /* ---------------- Vyhľadávanie ---------------- */
  function lookup(query) {
    var q = String(query || '').trim();
    if (!q) return { items: [] };
    if (/^\d[\d\s]*$/.test(q)) {
      var key = digitsKey(q);
      var found = [];
      (byEan.get(key) || []).concat(byCard.get(key) || []).forEach(function (it) {
        if (found.indexOf(it) < 0) found.push(it);
      });
      return { items: found };
    }
    // Text: hľadanie v názve (bez diakritiky, všetky slová)
    var words = fold(q).split(/\s+/).filter(Boolean);
    var res = [];
    for (var i = 0; i < stock.list.length && res.length < 50; i++) {
      var it = stock.list[i];
      var n = it._fold || (it._fold = fold(it.name));
      if (words.every(function (w) { return n.indexOf(w) >= 0; })) res.push(it);
    }
    return { items: res, text: true };
  }

  function search(query, source) {
    if (!stock) {
      renderEmpty('Sklad ešte nie je načítaný', 'Ťuknite na „Načítať sklad“.');
      return false;
    }
    var r = lookup(query);
    if (r.items.length === 1) renderItem(r.items[0]);
    else if (r.items.length > 1) renderList(r.items, query, r.text);
    else renderEmpty('Nenájdené: ' + query, source === 'scan'
      ? 'Tento čiarový kód nie je v súbore so zásobami.'
      : 'Skontrolujte číslo skladovej karty alebo EAN.');
    return r.items.length > 0;
  }

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = els.q.value.trim();
    if (!v) return;
    search(v, 'manual');
    els.q.blur();
  });

  /* ---------------- Vykreslenie ---------------- */
  function renderItem(it) {
    var g = gross(it.price);
    var zero = it.qty <= 0 ? ' zero' : '';
    els.result.innerHTML =
      '<article class="card">' +
        '<h1>' + esc(it.name) + '</h1>' +
        '<div class="tiles tiles-phone">' +
          '<div class="tile"><span class="label">Skladová karta</span><span class="val">' + esc(it.card) + '</span></div>' +
          '<div class="tile"><span class="label">EAN</span><span class="val">' + (esc(it.ean) || '—') + '</span></div>' +
          '<div class="tile"><span class="label">Na sklade</span><span class="big' + zero + '">' + qtyFmt.format(it.qty) + ' <small>ks</small></span></div>' +
          '<div class="tile"><span class="label">Cena bez DPH</span><span class="val small">' + money.format(it.price) + ' €</span></div>' +
        '</div>' +
        '<div class="tablet-meta">' +
          '<span>Skladová karta <b>' + esc(it.card) + '</b></span>' +
          '<span>EAN <b>' + (esc(it.ean) || '—') + '</b></span>' +
          '<span>Bez DPH ' + money.format(it.price) + ' €</span>' +
        '</div>' +
        '<div class="tablet-row">' +
          '<div class="tile"><span class="label">Na sklade</span><span class="big' + zero + '">' + qtyFmt.format(it.qty) + ' <small>ks</small></span></div>' +
          '<div class="price-bar"><span class="label">Cena s DPH ' + VAT + ' %</span><span class="val">' + money.format(g) + ' €</span></div>' +
        '</div>' +
      '</article>';
    // Na mobile posunúť, aby bola vidno cena (kamera skenuje ďalej)
    var bar = els.result.querySelector('.price-bar');
    if (bar && window.innerWidth < 900) {
      var r = bar.getBoundingClientRect();
      if (r.bottom > window.innerHeight) bar.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
  }

  function renderList(items, query, isText) {
    var head = isText
      ? 'Nájdené podľa názvu „' + esc(query) + '“: ' + items.length + (items.length >= 50 ? '+' : '')
      : 'Kód ' + esc(query) + ' má ' + items.length + ' položky – vyberte:';
    var html = '<div class="list"><div class="list-head">' + head + '</div>';
    items.forEach(function (it, i) {
      html += '<button type="button" data-i="' + i + '">' +
        '<span><span class="l-name">' + esc(it.name) + '</span>' +
        '<span class="l-meta" style="display:block">Karta ' + esc(it.card) + (it.ean ? ' · EAN ' + esc(it.ean) : '') + '</span></span>' +
        '<span class="l-right">' + money.format(gross(it.price)) + ' €<small>' + qtyFmt.format(it.qty) + ' ks</small></span>' +
      '</button>';
    });
    els.result.innerHTML = html + '</div>';
    els.result.querySelectorAll('button[data-i]').forEach(function (b) {
      b.addEventListener('click', function () { renderItem(items[Number(b.getAttribute('data-i'))]); });
    });
  }

  function renderEmpty(title, text) {
    els.result.innerHTML = '<div class="empty"><strong>' + esc(title) + '</strong>' + esc(text) + '</div>';
  }
  function renderIdle() {
    if (!stock) renderEmpty('Sklad ešte nie je načítaný', 'Ťuknite na „Načítať sklad“ – stiahne sa aktuálny súbor so zásobami z Google Disku.');
    else renderEmpty('Pripravené', 'Naskenujte čiarový kód alebo zadajte číslo skladovej karty.');
  }

  /* ---------------- Spätná väzba pri naskenovaní ---------------- */
  var audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = 1800; g.gain.value = 0.06;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.08);
    } catch (e) {}
  }
  function feedback() {
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
    beep();
    els.camera.classList.add('hit');
    setTimeout(function () { els.camera.classList.remove('hit'); }, 400);
  }

  var lastCode = '', lastSeen = 0;
  function onCode(code) {
    code = String(code || '').trim();
    if (!code) return;
    var now = Date.now();
    if (code === lastCode && now - lastSeen < SAME_CODE_PAUSE_MS) { lastSeen = now; return; }
    lastCode = code; lastSeen = now;
    feedback();
    els.q.value = code;
    search(code, 'scan');
  }

  /* ---------------- Kamera a skener ---------------- */
  var FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];
  var stream = null, scanning = false, detectFn = null, torchOn = false;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });

  function setCamStatus(t) { els.camStatus.textContent = t; }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('Nepodarilo sa načítať ' + src)); };
      document.head.appendChild(s);
    });
  }

  function makeDetector() {
    if (detectFn) return Promise.resolve(detectFn);
    var native = Promise.resolve(null);
    if ('BarcodeDetector' in window) {
      native = window.BarcodeDetector.getSupportedFormats().then(function (sup) {
        var f = FORMATS.filter(function (x) { return sup.indexOf(x) >= 0; });
        if (!f.length) return null;
        var bd = new window.BarcodeDetector({ formats: f });
        return function (video) {
          return bd.detect(video).then(function (r) { return r.length ? r[0].rawValue : null; });
        };
      }).catch(function () { return null; });
    }
    return native.then(function (fn) {
      if (fn) return (detectFn = fn);
      // Záloha: knižnica ZXing (z internetu, potom uložená v zariadení)
      return loadScript('https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js').then(function () {
        var Z = window.ZXing;
        var hints = new Map();
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
          Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
          Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF, Z.BarcodeFormat.CODABAR
        ]);
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
        var reader = new Z.MultiFormatReader();
        reader.setHints(hints);
        detectFn = function (video) {
          var vw = video.videoWidth, vh = video.videoHeight;
          if (!vw || !vh) return Promise.resolve(null);
          // stredný pás obrazu – rýchlejšie a presnejšie
          var cw = Math.round(vw * 0.9), ch = Math.round(vh * 0.5);
          var scale = Math.min(1, 1000 / cw);
          canvas.width = Math.round(cw * scale); canvas.height = Math.round(ch * scale);
          ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
          try {
            var src = new Z.HTMLCanvasElementLuminanceSource(canvas);
            var res = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(src)));
            return Promise.resolve(res ? res.getText() : null);
          } catch (e) {
            return Promise.resolve(null);
          } finally {
            reader.reset();
          }
        };
        return detectFn;
      });
    });
  }

  function startCamera() {
    if (stream) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCamStatus('Kamera nie je dostupná');
      toast('Kamera funguje len cez https a v prehliadači, ktorý ju podporuje.', true);
      return Promise.resolve();
    }
    setCamStatus('Zapínam kameru…');
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    }).then(function (s) {
      stream = s;
      els.video.srcObject = s;
      return els.video.play().catch(function () {});
    }).then(function () {
      var track = stream.getVideoTracks()[0];
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      }
      els.torchBtn.hidden = !caps.torch;
      els.camera.classList.add('live');
      setCamStatus('Skenuje automaticky');
      try { localStorage.setItem('sklad-cam', '1'); } catch (e) {}
      return makeDetector();
    }).then(function () {
      if (stream && !scanning) { scanning = true; loop(); }
    }).catch(function (err) {
      stopCamera();
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      setCamStatus(denied ? 'Kamera nepovolená' : 'Kamera nedostupná');
      toast(denied ? 'Povoľte appke prístup ku kamere v nastaveniach prehliadača.' :
        'Kameru sa nepodarilo zapnúť: ' + (err && err.message || err), true);
    });
  }

  function stopCamera() {
    scanning = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; torchOn = false;
    els.video.srcObject = null;
    els.camera.classList.remove('live');
    els.torchBtn.hidden = true;
    els.torchBtn.setAttribute('aria-pressed', 'false');
    setCamStatus('Kamera vypnutá');
  }

  function loop() {
    if (!scanning) return;
    var v = els.video;
    var p = (v.readyState >= 2 && detectFn) ? detectFn(v) : Promise.resolve(null);
    p.then(function (code) { if (code) onCode(code); })
      .catch(function () {})
      .then(function () { if (scanning) setTimeout(loop, 120); });
  }

  els.camStart.addEventListener('click', startCamera);
  els.torchBtn.addEventListener('click', function () {
    if (!stream) return;
    torchOn = !torchOn;
    stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] })
      .then(function () { els.torchBtn.setAttribute('aria-pressed', String(torchOn)); })
      .catch(function () { torchOn = false; });
  });
  // Kamera sa vypne, keď appka nie je na obrazovke, a znova zapne po návrate
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (stream) { stopCamera(); resumeCam = true; } }
    else if (resumeCam) { resumeCam = false; startCamera(); }
  });
  var resumeCam = false;

  /* ---------------- Externá čítačka (USB / Bluetooth = klávesnica) ---------------- */
  var wedgeBuf = '', wedgeLast = 0;
  document.addEventListener('keydown', function (e) {
    // píše sa do poľa alebo je otvorené okno s kódom – rieši formulár
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (keyDialog.hasAttribute('open')) return;
    var now = Date.now();
    if (now - wedgeLast > 100) wedgeBuf = '';
    wedgeLast = now;
    if (e.key === 'Enter') {
      if (wedgeBuf.length >= 4) { e.preventDefault(); onCode(wedgeBuf); }
      wedgeBuf = '';
    } else if (e.key && e.key.length === 1) {
      wedgeBuf += e.key;
    }
  });

  /* ---------------- Inštalácia na plochu ---------------- */
  var installBar = $('installBar'), deferredInstall = null, installDismissed = false;
  function isInstalled() {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function showInstall() {
    if (deferredInstall && !installDismissed && !isInstalled()) installBar.hidden = false;
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();          // vlastná lišta namiesto malého okna Chromu
    deferredInstall = e;
    showInstall();
  });
  $('installBtn').addEventListener('click', function () {
    if (!deferredInstall) return;
    installBar.hidden = true;
    deferredInstall.prompt();
    deferredInstall.userChoice.then(function () { deferredInstall = null; }).catch(function () {});
  });
  $('installClose').addEventListener('click', function () {
    installDismissed = true;
    installBar.hidden = true;
  });
  window.addEventListener('appinstalled', function () {
    deferredInstall = null;
    installBar.hidden = true;
    toast('Appka je nainštalovaná – ikona ELWORK Sklad je na ploche.');
  });

  // iPhone / iPad: Apple neponúka tlačidlo Inštalovať, ukážeme návod
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var iosHintOff = false;
  try { iosHintOff = localStorage.getItem('sklad-ios-hint') === 'off'; } catch (e) {}
  if (isIOS && !isInstalled() && !iosHintOff) {
    $('installTitle').textContent = 'Pridať appku na plochu';
    $('installDesc').innerHTML = 'Ťuknite na ' +
      '<svg class="share-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Zdieľať" role="img"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>' +
      ' <b>Zdieľať</b> a potom <b>Pridať na plochu</b>.';
    $('installBtn').hidden = true;
    installBar.hidden = false;
    $('installClose').addEventListener('click', function () {
      try { localStorage.setItem('sklad-ios-hint', 'off'); } catch (e) {}
    });
  }

  /* ---------------- Štart ---------------- */
  // Požiadať Android, aby uložené dáta appky nemazal pri čistení miesta
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }
  renderIdle();
  idbGet('stock').then(function (saved) {
    if (saved && saved.items) { setStock(saved); renderIdle(); return; }
    // Prvé otvorenie: hneď vypýtať kód predajne a stiahnuť sklad
    if (navigator.onLine !== false) reloadStock();
  }).catch(function () {
    if (navigator.onLine !== false) reloadStock();
  });

  // Ak už bola kamera povolená, zapne sa sama
  var camWasOn = false;
  try { camWasOn = localStorage.getItem('sklad-cam') === '1'; } catch (e) {}
  if (camWasOn && navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'camera' }).then(function (p) {
      if (p.state === 'granted') startCamera();
    }).catch(function () {});
  }

  /* ---------------- Offline / aktualizácie (service worker) ---------------- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // Znovu načítať stránku len pri aktualizácii appky, nie pri prvej inštalácii
    var hadController = !!navigator.serviceWorker.controller;
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; }
      if (reloaded) return; reloaded = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
