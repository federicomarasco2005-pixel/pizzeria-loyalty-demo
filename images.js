// Immagini di ogni locale, generate sul server e tenute in memoria:
//   stamps/grid-<N>-<k>.png     striscia dei timbri per Google Wallet (1032x336, trasparente)
//   stamps/anim-<N>-<k>.gif     timbro appena ottenuto: l'ultimo entra girando con il "+1" (una volta sola)
//   stamps/anim-<N>-reward.gif  premio pronto: i timbri saltano uno alla volta
//   stamps/icon.png / icon-empty.png   timbro singolo per la tessera web
//   icons/icon-192.png, icon-512.png, apple-touch-icon.png   icona della tessera installata sul telefono
//   logo.png                    logo del programma (caricato dal gestore oppure generato)
// Prima erano script PowerShell da lanciare a mano (tools/); ora ogni nuovo locale ha le sue in automatico.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

// ---------- Temi del timbro ----------

const THEMES = {
  pizza: { label: 'Pizza', emoji: '🍕' },
  caffe: { label: 'Caffè', emoji: '☕' },
  burger: { label: 'Burger', emoji: '🍔' },
  gelato: { label: 'Gelato', emoji: '🍦' },
  birra: { label: 'Birra', emoji: '🍺' },
  stella: { label: 'Stella (generico)', emoji: '⭐' },
  logo: { label: 'Il logo del locale', emoji: '⭐' },
};

const circle = (g, x, y, r, color) => { g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
const ellipse = (g, x, y, rx, ry, color, rot = 0) => { g.fillStyle = color; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill(); };
function roundRect(g, x, y, w, h, r, color) {
  g.fillStyle = color; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill();
}

// Ogni funzione disegna il timbro "pieno" nel quadrato (0,0)-(d,d).
const DRAW = {
  pizza(g, d) {
    const c = d / 2;
    circle(g, c, c, d / 2, '#b8772c');            // bordo
    circle(g, c, c, d * 0.47, '#e0a04a');         // cornicione
    circle(g, c, c, d * 0.37, '#ffd76e');         // mozzarella
    for (const [x, y, r] of [[-0.12, -0.2, 0.07], [0.2, 0.05, 0.06], [-0.05, 0.22, 0.05]]) circle(g, c + x * d, c + y * d, r * d, '#ffe9a8');
    for (const [x, y] of [[-0.18, -0.12], [0.14, -0.2], [0.03, 0.03], [-0.2, 0.15], [0.2, 0.18], [0, -0.32], [-0.31, -0.02]]) {
      circle(g, c + x * d, c + y * d, d * 0.075, '#c62828');
    }
    for (const [x, y] of [[0.1, -0.06], [-0.08, 0.1], [0.16, 0.32]]) ellipse(g, c + x * d, c + y * d, d * 0.063, d * 0.036, '#2e7d32');
  },
  caffe(g, d) {
    // tazzina vista dall'alto, sul piattino, con il cuore di latte
    const c = d / 2;
    circle(g, c, c, d / 2, '#d9d2c3');
    circle(g, c, c, d * 0.47, '#f6f2ea');
    roundRect(g, c + d * 0.26, c - d * 0.07, d * 0.22, d * 0.14, d * 0.07, '#d9d2c3');
    roundRect(g, c + d * 0.27, c - d * 0.055, d * 0.19, d * 0.11, d * 0.055, '#ffffff');
    circle(g, c, c, d * 0.35, '#d9d2c3');
    circle(g, c, c, d * 0.335, '#ffffff');
    circle(g, c, c, d * 0.27, '#5a3216');
    circle(g, c, c, d * 0.235, '#a8693a');
    g.fillStyle = '#f6e6d0';
    g.beginPath();
    const s = d * 0.13, hy = c - s * 0.35;
    g.moveTo(c, hy + s * 1.15);
    g.bezierCurveTo(c - s * 1.3, hy + s * 0.2, c - s * 0.7, hy - s * 0.75, c, hy - s * 0.05);
    g.bezierCurveTo(c + s * 0.7, hy - s * 0.75, c + s * 1.3, hy + s * 0.2, c, hy + s * 1.15);
    g.fill();
  },
  burger(g, d) {
    const x0 = d * 0.08, w = d * 0.84;
    roundRect(g, x0 + d * 0.02, d * 0.72, w - d * 0.04, d * 0.15, d * 0.07, '#d9924a');  // pane sotto
    roundRect(g, x0, d * 0.57, w, d * 0.16, d * 0.08, '#6b3a1e');                         // carne
    g.fillStyle = '#ffc83d';                                                              // formaggio con le gocce
    g.beginPath();
    g.moveTo(x0 + d * 0.02, d * 0.53); g.lineTo(x0 + w - d * 0.02, d * 0.53); g.lineTo(x0 + w - d * 0.02, d * 0.59);
    g.lineTo(x0 + w * 0.72, d * 0.59); g.lineTo(x0 + w * 0.64, d * 0.68); g.lineTo(x0 + w * 0.56, d * 0.59);
    g.lineTo(x0 + w * 0.3, d * 0.59); g.lineTo(x0 + w * 0.22, d * 0.66); g.lineTo(x0 + w * 0.14, d * 0.59);
    g.lineTo(x0 + d * 0.02, d * 0.59); g.closePath(); g.fill();
    g.fillStyle = '#4caf50';                                                              // insalata ondulata
    g.beginPath(); g.moveTo(x0, d * 0.5);
    for (let i = 0; i <= 8; i++) g.quadraticCurveTo(x0 + (i - 0.5) * w / 8, d * (i % 2 ? 0.58 : 0.46), x0 + i * w / 8, d * 0.52);
    g.lineTo(x0 + w, d * 0.47); g.lineTo(x0, d * 0.47); g.closePath(); g.fill();
    roundRect(g, x0 + d * 0.03, d * 0.43, w - d * 0.06, d * 0.07, d * 0.03, '#e53935');   // pomodoro
    g.fillStyle = '#e8a24f';                                                              // pane sopra
    g.beginPath(); g.moveTo(x0, d * 0.45); g.ellipse(d / 2, d * 0.45, w / 2, d * 0.33, 0, Math.PI, 0); g.closePath(); g.fill();
    for (const [x, y, r] of [[0.33, 0.24, 0.3], [0.5, 0.19, -0.2], [0.66, 0.25, 0.5], [0.42, 0.33, -0.6], [0.6, 0.35, 0.1], [0.24, 0.36, -0.3], [0.76, 0.37, 0.4]]) {
      ellipse(g, x * d, y * d, d * 0.03, d * 0.016, '#fff3d6', r);
    }
  },
  gelato(g, d) {
    g.fillStyle = '#dca35a';                                                              // cono
    g.beginPath(); g.moveTo(d * 0.29, d * 0.5); g.lineTo(d * 0.71, d * 0.5); g.lineTo(d * 0.5, d * 0.97); g.closePath(); g.fill();
    g.save(); g.clip();
    g.strokeStyle = '#b97f37'; g.lineWidth = d * 0.025;
    for (let i = -3; i <= 3; i++) {
      g.beginPath(); g.moveTo(d * (0.5 + i * 0.1) - d * 0.3, d * 0.45); g.lineTo(d * (0.5 + i * 0.1) + d * 0.3, d * 1.0); g.stroke();
      g.beginPath(); g.moveTo(d * (0.5 + i * 0.1) + d * 0.3, d * 0.45); g.lineTo(d * (0.5 + i * 0.1) - d * 0.3, d * 1.0); g.stroke();
    }
    g.restore();
    circle(g, d * 0.5, d * 0.45, d * 0.23, '#f8ebcb');                                    // vaniglia
    for (const x of [0.33, 0.45, 0.57, 0.68]) circle(g, d * x, d * 0.53, d * 0.06, '#f8ebcb');
    circle(g, d * 0.5, d * 0.27, d * 0.19, '#ff8fb0');                                    // fragola
    for (const x of [0.37, 0.5, 0.63]) circle(g, d * x, d * 0.36, d * 0.055, '#ff8fb0');
    g.strokeStyle = '#5d4037'; g.lineWidth = d * 0.02;                                    // ciliegina
    g.beginPath(); g.moveTo(d * 0.53, d * 0.08); g.quadraticCurveTo(d * 0.6, d * 0.0, d * 0.66, d * 0.02); g.stroke();
    circle(g, d * 0.52, d * 0.11, d * 0.055, '#d62839');
  },
  birra(g, d) {
    g.strokeStyle = '#e8a317'; g.lineWidth = d * 0.07;                                    // manico
    g.beginPath(); g.roundRect(d * 0.6, d * 0.4, d * 0.24, d * 0.36, d * 0.1); g.stroke();
    roundRect(g, d * 0.16, d * 0.28, d * 0.52, d * 0.66, d * 0.07, '#f5b82e');            // boccale
    roundRect(g, d * 0.22, d * 0.34, d * 0.08, d * 0.54, d * 0.04, '#ffd968');            // riflesso
    for (const [x, y, r] of [[0.42, 0.7, 0.025], [0.54, 0.55, 0.02], [0.47, 0.82, 0.018], [0.58, 0.76, 0.022]]) circle(g, x * d, y * d, r * d, '#ffe9a6');
    roundRect(g, d * 0.14, d * 0.2, d * 0.56, d * 0.12, d * 0.05, '#fffaf0');             // schiuma
    for (const [x, y, r] of [[0.2, 0.2, 0.09], [0.33, 0.15, 0.11], [0.48, 0.14, 0.1], [0.61, 0.18, 0.09], [0.67, 0.27, 0.06], [0.42, 0.33, 0.05]]) {
      circle(g, x * d, y * d, r * d, '#fffaf0');
    }
  },
  stella(g, d) {
    const c = d / 2;
    circle(g, c, c, d / 2, '#e8a800');
    circle(g, c, c, d * 0.45, '#ffcf3f');
    g.fillStyle = '#fff7d9';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? d * 0.15 : d * 0.33, a = -Math.PI / 2 + i * Math.PI / 5;
      g.lineTo(c + Math.cos(a) * r, c + d * 0.02 + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
  },
};

// Il logo del locale come timbro: dentro un cerchio bianco
function drawLogoStamp(logoImg) {
  return (g, d) => {
    circle(g, d / 2, d / 2, d / 2, '#ffffff');
    g.save();
    g.beginPath(); g.arc(d / 2, d / 2, d * 0.47, 0, Math.PI * 2); g.clip();
    drawContain(g, logoImg, d * 0.08, d * 0.08, d * 0.84, d * 0.84);
    g.restore();
  };
}

function drawContain(g, img, x, y, w, h) {
  const s = Math.min(w / img.width, h / img.height);
  g.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s);
}

// Versione "spenta" del timbro (timbri ancora da ottenere): stessa forma, toni di grigio scuro.
function darken(canvas) {
  const g = canvas.getContext('2d');
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const p = img.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = 30 + ((0.3 * p[i] + 0.59 * p[i + 1] + 0.11 * p[i + 2]) / 255) * 42;
    p[i] = p[i + 1] = p[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

// Timbro pronto da incollare: disegnato più grande del necessario (resta nitido quando "salta")
// e con una leggera ombra sotto.
function stampSprite(draw, d, dark) {
  const pad = Math.ceil(d * 0.12);
  const raw = createCanvas(d, d);
  draw(raw.getContext('2d'), d);
  if (dark) darken(raw);
  const out = createCanvas(d + 2 * pad, d + 2 * pad);
  const g = out.getContext('2d');
  g.shadowColor = dark ? 'rgba(0,0,0,0.16)' : 'rgba(0,0,0,0.28)';
  g.shadowOffsetX = d * 0.02; g.shadowOffsetY = d * 0.05; g.shadowBlur = d * 0.03;
  g.drawImage(raw, pad, pad);
  return { canvas: out, pad };
}

// ---------- Disposizione dei timbri nella striscia ----------
const W = 1032, H = 336;
function layout(total) {
  const rows = total > 8 ? 2 : 1;
  const cols = Math.ceil(total / rows);
  const padX = 34, padY = rows === 1 ? 70 : 22, gap = 20;
  const d = Math.floor(Math.min((W - 2 * padX - gap * (cols - 1)) / cols, (H - 2 * padY - gap * (rows - 1)) / rows));
  const x0 = (W - (cols * d + (cols - 1) * gap)) / 2;
  const y0 = (H - (rows * d + (rows - 1) * gap)) / 2;
  return { d, slot: (i) => [x0 + (i % cols) * (d + gap), y0 + Math.floor(i / cols) * (d + gap)] };
}

function placeStamp(g, sprite, d, x, y, scale = 1, angle = 0) {
  const big = sprite.canvas.width;
  g.save();
  g.translate(x + d / 2, y + d / 2);
  g.rotate((angle * Math.PI) / 180);
  g.scale(scale, scale);
  g.drawImage(sprite.canvas, -big / 2, -big / 2);
  g.restore();
}

// "+1" disegnato come forma (nessun font richiesto sul server): dorato con bordo scuro
function drawPlusOne(g, cx, cy, s, alpha) {
  const p = new (require('@napi-rs/canvas').Path2D)();
  const t = s * 0.22, x0 = cx - s * 0.55;
  p.rect(x0, cy - t / 2, s * 0.56, t);                   // braccio orizzontale del +
  p.rect(x0 + s * 0.28 - t / 2, cy - s * 0.28, t, s * 0.56);
  const bx = x0 + s * 0.74, bw = s * 0.25, top = cy - s / 2;
  p.rect(bx, top, bw, s);                                 // asta dell'1
  p.moveTo(bx + 1, top); p.lineTo(bx - s * 0.2, top + s * 0.2); p.lineTo(bx - s * 0.12, top + s * 0.32); p.lineTo(bx + 1, top + s * 0.2); p.closePath();
  g.save();
  g.globalAlpha = Math.max(0, alpha);
  g.lineJoin = 'round'; g.lineWidth = s * 0.16; g.strokeStyle = 'rgb(90,12,8)';
  g.stroke(p);
  g.fillStyle = '#ffcf4a';
  g.fill(p);
  g.restore();
}

// ---------- GIF ----------
function encodeGif(frames, delays) {
  const sample = [];
  frames.forEach((f, i) => { if (i % 3 === 0 || i === frames.length - 1) sample.push(f); });
  const merged = new Uint8Array(sample.reduce((n, f) => n + f.length, 0));
  let off = 0; for (const f of sample) { merged.set(f, off); off += f.length; }
  const palette = quantize(merged, 63);
  const TRANSPARENT = palette.length; // indice riservato: "pixel uguale al fotogramma precedente"
  const full = [...palette, [255, 0, 255]];
  const gif = GIFEncoder();
  let prev = null;
  frames.forEach((data, i) => {
    const index = applyPalette(data, palette);
    // Dal secondo fotogramma si scrivono solo i pixel cambiati: file molto più leggero.
    const out = prev ? index.map((v, p) => (v === prev[p] ? TRANSPARENT : v)) : index;
    const last = i === frames.length - 1;
    gif.writeFrame(out, W, H, {
      palette: i === 0 ? full : undefined,
      // Ultimo fotogramma (timbri fermi) con la durata massima del formato (~11 minuti)
      delay: last ? 655000 : delays[i],
      repeat: -1, // una volta sola
      transparent: i > 0, transparentIndex: TRANSPARENT, dispose: 1,
    });
    prev = index;
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

const frameData = (canvas) => new Uint8Array(canvas.getContext('2d').getImageData(0, 0, W, H).data.buffer);

// ---------- Generatore per un locale ----------
// shop: { slug, theme, stampsForReward, brandColor, logo (base64 PNG) | logoFile, imgVersion }
const cache = new Map(); // `${slug}|${versione}|${file}` -> { buf, type }
const LIMIT = 400;

async function themeFor(shop) {
  const logo = await logoImage(shop);
  if (shop.theme === 'logo' && logo) return drawLogoStamp(logo);
  return DRAW[shop.theme] || DRAW.stella;
}

async function logoImage(shop) {
  if (shop.logo) return loadImage(Buffer.from(shop.logo, 'base64'));
  if (shop.logoFile) return loadImage(shop.logoFile);
  return null;
}

async function render(shop, file) {
  const N = shop.stampsForReward;
  const draw = await themeFor(shop);
  let m;
  if ((m = file.match(/^stamps\/grid-(\d+)-(\d+)\.png$/)) && +m[1] === N && +m[2] <= N) {
    const { d, slot } = layout(N);
    const on = stampSprite(draw, d, false), off = stampSprite(draw, d, true);
    const c = createCanvas(W, H); const g = c.getContext('2d');
    for (let i = 0; i < N; i++) placeStamp(g, i < +m[2] ? on : off, d, ...slot(i));
    return png(c);
  }
  if ((m = file.match(/^stamps\/anim-(\d+)-(\d+|reward)\.gif$/)) && +m[1] === N && (m[2] === 'reward' || (+m[2] >= 1 && +m[2] <= N))) {
    return { buf: m[2] === 'reward' ? rewardGif(shop, draw) : stampGif(shop, draw, +m[2]), type: 'image/gif' };
  }
  if (file === 'stamps/icon.png' || file === 'stamps/icon-empty.png') {
    const s = stampSprite(draw, 232, file.includes('empty'));
    const c = createCanvas(256, 256);
    c.getContext('2d').drawImage(s.canvas, 128 - s.canvas.width / 2, 128 - s.canvas.height / 2);
    return png(c);
  }
  if ((m = file.match(/^icons\/(icon-192|icon-512|apple-touch-icon)\.png$/))) {
    const size = { 'icon-192': 192, 'icon-512': 512, 'apple-touch-icon': 180 }[m[1]];
    const c = createCanvas(size, size); const g = c.getContext('2d');
    g.fillStyle = shop.brandColor; g.fillRect(0, 0, size, size);
    // al 62%: resta nella "zona sicura" anche quando Android ritaglia l'icona a cerchio
    const d = Math.round(size * 0.62), s = stampSprite(draw, d, false);
    g.drawImage(s.canvas, (size - s.canvas.width) / 2, (size - s.canvas.height) / 2);
    return png(c);
  }
  if (file === 'logo.png') {
    const logo = await logoImage(shop);
    if (logo && shop.logoFile) return png(toCanvas(logo));
    const c = createCanvas(660, 660); const g = c.getContext('2d');
    if (logo) {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 660, 660);
      drawContain(g, logo, 66, 66, 528, 528);
    } else {
      // nessun logo caricato: il timbro del locale su sfondo del colore della tessera
      g.fillStyle = shop.brandColor; g.fillRect(0, 0, 660, 660);
      const s = stampSprite(DRAW[shop.theme] || DRAW.stella, 400, false);
      g.drawImage(s.canvas, 330 - s.canvas.width / 2, 330 - s.canvas.height / 2);
    }
    return png(c);
  }
  return null;
}

function toCanvas(img) {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

const png = (canvas) => ({ buf: canvas.toBuffer('image/png'), type: 'image/png' });

// Timbro n appena ottenuto: entra girando, anello dorato, scintille e "+1" che sale e svanisce
function stampGif(shop, draw, n) {
  const N = shop.stampsForReward;
  const { d, slot } = layout(N);
  const on = stampSprite(draw, d, false), off = stampSprite(draw, d, true);
  const frames = [], delays = [], FR = 22, POP = 12;
  const c = createCanvas(W, H); const g = c.getContext('2d');
  const k = n - 1; const [sx, sy] = slot(k); const cx = sx + d / 2, cy = sy + d / 2;
  for (let f = 0; f < FR; f++) {
    const t = Math.min(1, f / POP);
    g.fillStyle = shop.brandColor; g.fillRect(0, 0, W, H);
    for (let i = 0; i < N; i++) placeStamp(g, i < k ? on : off, d, ...slot(i));
    const u = t - 1, scale = 1 + 2.70158 * u ** 3 + 1.70158 * u ** 2; // easeOutBack
    if (t > 0) placeStamp(g, on, d, sx, sy, Math.max(0.05, scale), -200 * (1 - t) ** 2);
    if (t >= 0.35 && f <= POP) {
      const q = (t - 0.35) / 0.65, alpha = 1 - q;
      const r = d * (0.52 + 0.4 * q);
      g.strokeStyle = `rgba(255,207,74,${alpha})`; g.lineWidth = d * 0.06 * (1 - q) + 2;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      for (let s = 0; s < 8; s++) {
        const a = s * Math.PI / 4 + 0.3, dist = d * (0.55 + 0.45 * q), sr = d * 0.05 * (1 - q) + 2;
        circle(g, cx + Math.cos(a) * dist, cy + Math.sin(a) * dist, sr, `rgba(255,255,255,${alpha})`);
      }
    }
    const pf = f - 5;
    if (pf >= 0 && f < FR - 1) {
      const pq = pf / (FR - 7);
      const pop = pq < 0.2 ? 0.6 + 2.5 * pq : pq < 0.35 ? 1.1 - (pq - 0.2) * 0.66 : 1;
      const alpha = pq < 0.7 ? 1 : 1 - (pq - 0.7) / 0.3;
      drawPlusOne(g, cx + d * 0.32, cy - d * 0.3 - pq * d * 0.42, d * 0.42 * pop, alpha);
    }
    frames.push(frameData(c));
    delays.push(f === 0 ? 400 : f === FR - 1 ? 2400 : 50);
  }
  return encodeGif(frames, delays);
}

// Premio pronto: tutti i timbri pieni, uno alla volta fa un saltello
function rewardGif(shop, draw) {
  const N = shop.stampsForReward;
  const { d, slot } = layout(N);
  const on = stampSprite(draw, d, false);
  const frames = [], delays = [];
  const c = createCanvas(W, H); const g = c.getContext('2d');
  for (let i = 0; i < N; i++) {
    for (const s of [1.1, 1.16, 1.08, 1.0]) {
      g.fillStyle = shop.brandColor; g.fillRect(0, 0, W, H);
      for (let j = 0; j < N; j++) if (j !== i) placeStamp(g, on, d, ...slot(j));
      placeStamp(g, on, d, ...slot(i), s, (s - 1) * 60);
      frames.push(frameData(c));
      delays.push(i === N - 1 && s === 1 ? 1400 : 60);
    }
  }
  return encodeGif(frames, delays);
}

// ---------- GIF in un thread separato ----------
// Una GIF richiede centinaia di millisecondi di calcolo (secondi sul server gratuito): fatta nel thread
// principale bloccherebbe il server proprio mentre la tessera web aspetta il timbro.
let worker = null, seq = 0;
const waiting = new Map(); // id -> { resolve, reject }
function renderInWorker(shop, file) {
  if (!worker) {
    worker = new Worker(__filename, { workerData: { imagesWorker: true } });
    worker.on('message', ({ id, buf, type, error }) => {
      const w = waiting.get(id);
      waiting.delete(id);
      if (!waiting.size) worker.unref(); // nessun lavoro in corso: non tiene vivo il processo
      if (w) error ? w.reject(new Error(error)) : w.resolve(buf ? { buf: Buffer.from(buf), type } : null);
    });
    worker.on('error', (err) => {
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
      worker = null;
    });
  }
  worker.ref();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, shop, file });
  });
}
if (!isMainThread && workerData && workerData.imagesWorker) {
  parentPort.on('message', async ({ id, shop, file }) => {
    try {
      const r = await render(shop, file);
      parentPort.postMessage({ id, buf: r && r.buf, type: r && r.type });
    } catch (err) {
      parentPort.postMessage({ id, error: err.message });
    }
  });
}

// Immagine di un locale (generata la prima volta, poi dalla memoria). null se il file non esiste.
const pending = new Map();
async function get(shop, file) {
  const key = `${shop.slug}|${shop.imgVersion || 1}|${file}`;
  if (cache.has(key)) return cache.get(key);
  if (!pending.has(key)) {
    pending.set(key, (file.endsWith('.gif') ? renderInWorker(shop, file) : render(shop, file)).then((r) => {
      pending.delete(key);
      if (r) {
        if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
        cache.set(key, r);
      }
      return r;
    }, (err) => { pending.delete(key); throw err; }));
  }
  return pending.get(key);
}

// Anteprima per il bot: striscia con qualche timbro sul colore della tessera, sotto il logo.
async function preview(shop, filled = Math.ceil(shop.stampsForReward / 2)) {
  const draw = await themeFor(shop);
  const N = shop.stampsForReward;
  const { d, slot } = layout(N);
  const on = stampSprite(draw, d, false), off = stampSprite(draw, d, true);
  const top = 200;
  const c = createCanvas(W, H + top + 30); const g = c.getContext('2d');
  g.fillStyle = shop.brandColor; g.fillRect(0, 0, c.width, c.height);
  const logo = await get(shop, 'logo.png');
  const img = await loadImage(logo.buf);
  g.save(); g.beginPath(); g.arc(W / 2, 110, 80, 0, Math.PI * 2); g.clip(); g.drawImage(img, W / 2 - 80, 30, 160, 160); g.restore();
  g.translate(0, top);
  for (let i = 0; i < N; i++) placeStamp(g, i < filled ? on : off, d, ...slot(i));
  return c.toBuffer('image/png');
}

// Logo inviato dal gestore (foto o file): quadrato 660x660 su fondo bianco, pronto per Google Wallet.
async function prepareLogo(buffer) {
  const img = await loadImage(buffer);
  const c = createCanvas(660, 660); const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 660, 660);
  drawContain(g, img, 40, 40, 580, 580);
  return c.toBuffer('image/png').toString('base64');
}

// Prepara in anticipo le immagini che Google scaricherà (così risponde subito).
// gifs: anche le animazioni del Wallet, così al momento del timbro sono già pronte.
async function warm(shop, { gifs = false } = {}) {
  const N = shop.stampsForReward;
  const files = ['logo.png', 'stamps/icon.png', 'stamps/icon-empty.png'];
  for (let k = 0; k <= N; k++) files.push(`stamps/grid-${N}-${k}.png`);
  for (const f of files) await get(shop, f);
  if (gifs) {
    const anims = [`stamps/anim-${N}-reward.gif`];
    for (let k = 1; k <= N; k++) anims.push(`stamps/anim-${N}-${k}.gif`);
    for (const f of anims) await get(shop, f);
  }
}

module.exports = { THEMES, get, preview, prepareLogo, warm };
