// Utility condivise dalle pagine.
async function api(path, { method = 'GET', body, pin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (pin) headers['x-staff-pin'] = pin;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Errore di rete'), { status: res.status });
  return data;
}

async function applyBrand() {
  const cfg = await api('/api/config');
  document.documentElement.style.setProperty('--brand', cfg.brandColor);
  document.querySelectorAll('[data-cfg]').forEach((el) => { el.textContent = cfg[el.dataset.cfg]; });
  return cfg;
}

function renderStamps(el, filled, total) {
  el.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('div');
    d.className = 'stamp' + (i < filled ? ' on' : '');
    d.textContent = '🍕';
    el.appendChild(d);
  }
}

function toast(msg, ms = 2200) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function getPin() { try { return localStorage.getItem('staffPin') || ''; } catch { return ''; } }
function setPin(p) { try { p ? localStorage.setItem('staffPin', p) : localStorage.removeItem('staffPin'); } catch {} }
