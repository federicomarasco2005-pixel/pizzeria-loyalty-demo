// Utility condivise dalle pagine.
async function api(path, { method = 'GET', body, pin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (pin) headers['x-staff-pin'] = pin;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Errore di rete'), { status: res.status, data });
  return data;
}

async function applyBrand() {
  // di solito la configurazione è già nella pagina (window.CFG, messa dal server): nessuna attesa
  const cfg = window.CFG || await api('api/config');
  document.documentElement.style.setProperty('--brand', cfg.brandColor);
  document.querySelectorAll('[data-cfg]').forEach((el) => { el.textContent = cfg[el.dataset.cfg]; });
  return cfg;
}

// Disegna i timbri; quelli appena ottenuti entrano con un'animazione.
// Tessera grande: righe scelte perché i timbri vengano il più grandi possibile senza allungare troppo la tessera
// (fino a 6 come una tessera da 6, cioè 3 per riga; fino a 10 al massimo due righe: 8 → 4+4, 9 → 5+4, 10 → 5+5;
// oltre, righe centrate e alternate: 12 → 4+4+4).
// Griglia a mezze colonne: ogni timbro ne occupa due, così una riga più corta resta centrata.
function tileLayout(el, total) {
  const W = 310, H = 250; // griglia tipica su un telefono e sua altezza massima (px): servono solo a scegliere le righe
  let best = null;
  for (let r = 1; r <= (total <= 10 ? 2 : total); r++) {
    const m = Math.max(3, Math.ceil(total / r)), gap = m > 3 ? 10 : 14;
    const cell = (W - (2 * m - 1) * gap) / m + gap;
    const s = Math.min(cell, (H - (r - 1) * 14) / r);
    if (!best || s > best.s * 1.1) best = { r, m, s, cell }; // una riga in più solo se i timbri crescono davvero
  }
  const { r, m, s, cell } = best;
  const base = Math.floor(total / r), extra = total % r, big = new Set();
  if (extra === 1) big.add(Math.floor((r - 1) / 2));
  else for (let k = 0; k < extra; k++) big.add(Math.round((k * (r - 1)) / (extra - 1)));
  el.style.gridTemplateColumns = 'repeat(' + 2 * m + ', 1fr)';
  el.style.columnGap = m > 3 ? '10px' : '';
  el.style.setProperty('--tile', Math.round((s / cell) * 100) + '%'); // più stretti solo se limitati dall'altezza
  let i = 0;
  for (let row = 0; row < r; row++) {
    const k = base + (big.has(row) ? 1 : 0);
    for (let j = 0; j < k; j++, i++) el.children[i].style.gridColumn = (m - k + 2 * j + 1) + ' / span 2';
  }
}

function renderStamps(el, filled, total, { animate = true } = {}) {
  const prev = el.dataset.filled === undefined ? null : Number(el.dataset.filled);
  el.dataset.filled = filled;
  if (el.children.length !== total) {
    el.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('div');
      d.className = 'stamp';
      d.textContent = i + 1;
      el.appendChild(d);
    }
    if (el.classList.contains('tiles')) tileLayout(el, total);
  }
  [...el.children].forEach((d, i) => {
    const on = i < filled;
    const isNew = animate && prev !== null && on && i >= prev;
    d.classList.toggle('on', on);
    d.classList.remove('new', 'gone');
    if (isNew) {
      void d.offsetWidth; // riavvia l'animazione
      d.style.animationDelay = (i - prev) * 0.12 + 's';
      d.classList.add('new');
    }
  });
}

// Grande "+1" che sale al centro dello schermo.
function plusOne(text = '+1') {
  const p = document.createElement('div');
  p.className = 'plus';
  p.textContent = text;
  document.body.appendChild(p);
  setTimeout(() => p.remove(), 1200);
}

// Rimbalzo di un numero (es. il contatore dei timbri).
function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

// Coriandoli leggeri su canvas, senza librerie esterne.
function confetti(ms = 2600) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  const W = (c.width = innerWidth), H = (c.height = innerHeight);
  const colors = ['#ffcf4a', '#ffffff', '#2e7d32', '#e53935', '#ff9800'];
  const parts = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    r: Math.random() * 6 + 4, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const end = performance.now() + ms;
  (function frame(t) {
    ctx.clearRect(0, 0, W, H);
    parts.forEach((p) => {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    });
    if (t < end) requestAnimationFrame(frame); else c.remove();
  })(performance.now());
}

function vibrate(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} }

function toast(msg, ms = 2200) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// Email con un errore di battitura nel dominio ("gmial.com", "gmail.con", "libero.ti"): propone quella giusta.
// Il server controlla poi che il dominio esista (controllo-email.js); qui solo i domini più usati in Italia.
const EMAIL_DOMAINS = ['gmail.com', 'hotmail.com', 'hotmail.it', 'libero.it', 'yahoo.com', 'yahoo.it', 'outlook.com', 'outlook.it',
  'icloud.com', 'me.com', 'live.com', 'live.it', 'msn.com', 'alice.it', 'tiscali.it', 'virgilio.it', 'tim.it', 'email.it',
  'fastwebnet.it', 'inwind.it', 'tin.it', 'aruba.it', 'protonmail.com', 'proton.me', 'gmx.com', 'googlemail.com'];
function emailHint(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1);
  if (!domain || EMAIL_DOMAINS.includes(domain)) return null;
  const dist = (a, b) => { // differenza tra due parole: lettere da cambiare, aggiungere, togliere o scambiare
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  };
  let best = null, bestD = 3;
  for (const ok of EMAIL_DOMAINS) { const x = dist(domain, ok); if (x < bestD) { best = ok; bestD = x; } }
  return best ? email.slice(0, at + 1) + best : null;
}
// Collega il suggerimento a un campo email: compare sotto il campo quando lo si lascia. Restituisce una funzione
// da chiamare prima dell'invio: false = c'è un suggerimento a cui il cliente non ha ancora risposto.
function attachEmailHint(input) {
  const en = document.documentElement.lang === 'en';
  const box = document.createElement('p');
  box.className = 'email-hint hidden';
  input.insertAdjacentElement('afterend', box);
  let accepted = '';
  const check = () => {
    const s = emailHint(input.value);
    if (!s || input.value.trim().toLowerCase() === accepted) { box.classList.add('hidden'); return true; }
    // già mostrato: non ridisegnarlo (il tocco su "Sì, correggi" toglie prima il fuoco al campo)
    if (box.dataset.s === s && !box.classList.contains('hidden')) return false;
    box.dataset.s = s;
    box.innerHTML = '';
    const q = document.createElement('span');
    q.append(en ? 'Did you mean ' : 'Intendevi ');
    const b = document.createElement('strong'); b.textContent = s; q.append(b, '?');
    const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'hint-yes';
    yes.textContent = en ? 'Yes, fix it' : 'Sì, correggi';
    yes.onclick = () => { input.value = s; box.classList.add('hidden'); };
    const no = document.createElement('button'); no.type = 'button'; no.className = 'hint-no';
    no.textContent = en ? "No, it's right" : 'No, è giusta';
    no.onclick = () => { accepted = input.value.trim().toLowerCase(); box.classList.add('hidden'); };
    box.append(q, yes, no);
    box.classList.remove('hidden');
    return false;
  };
  input.addEventListener('blur', check);
  input.addEventListener('input', () => box.classList.add('hidden'));
  return check;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

// Ogni locale ha la sua memoria sul telefono (window.SHOP lo imposta il server nella pagina).
// Il primo locale legge anche le chiavi senza nome usate dalle versioni precedenti.
const SHOP = window.SHOP || { slug: '', legacy: true };
const key = (name) => (SHOP.slug ? name + ':' + SHOP.slug : name);
function load(name) {
  try {
    // anche le chiavi degli indirizzi precedenti del locale (se è stato rinominato)
    for (const s of [SHOP.slug, ...(SHOP.aliases || [])]) {
      const v = s ? localStorage.getItem(name + ':' + s) : null;
      if (v) return v;
    }
    return (!SHOP.slug || SHOP.legacy ? localStorage.getItem(name) : '') || '';
  } catch { return ''; }
}
function store(name, value) {
  try { value ? localStorage.setItem(key(name), value) : localStorage.removeItem(key(name)); } catch {}
}

// Tessera del cliente ricordata su questo telefono (serve al timbro con NFC)
function getCardToken() { return load('cardToken'); }
function setCardToken(t) { if (t) store('cardToken', t); }

function getPin() { return load('staffPin'); }
function setPin(p) {
  store('staffPin', p);
  if (!p && SHOP.legacy) { try { localStorage.removeItem('staffPin'); } catch {} }
}
