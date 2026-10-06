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
  const cfg = await api('api/config');
  document.documentElement.style.setProperty('--brand', cfg.brandColor);
  document.querySelectorAll('[data-cfg]').forEach((el) => { el.textContent = cfg[el.dataset.cfg]; });
  return cfg;
}

// Disegna i timbri; quelli appena ottenuti entrano con un'animazione.
function renderStamps(el, filled, total, { animate = true } = {}) {
  const prev = el.dataset.filled === undefined ? null : Number(el.dataset.filled);
  el.dataset.filled = filled;
  if (el.children.length !== total) {
    // tessera grande: colonne scelte per avere righe piene (6 → 3x2, 8 → 4x2, 10 → 5x2…)
    if (el.classList.contains('tiles')) {
      const cols = { 4: 4, 5: 5, 7: 4, 8: 4, 10: 5, 11: 4, 12: 4 }[total] || 3;
      el.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
      el.style.gap = cols > 3 ? '10px' : '';
    }
    el.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('div');
      d.className = 'stamp';
      d.textContent = i + 1;
      el.appendChild(d);
    }
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

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

// Ogni locale ha la sua memoria sul telefono (window.SHOP lo imposta il server nella pagina).
// Il primo locale legge anche le chiavi senza nome usate dalle versioni precedenti.
const SHOP = window.SHOP || { slug: '', legacy: true };
const key = (name) => (SHOP.slug ? name + ':' + SHOP.slug : name);
function load(name) {
  try { return localStorage.getItem(key(name)) || (SHOP.legacy ? localStorage.getItem(name) : '') || ''; } catch { return ''; }
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
