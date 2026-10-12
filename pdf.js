// PDF per i locali, generati sul server e mandati dal bot Telegram:
//   launchKit()      kit di lancio: QR da tavolo, adesivi da vetrina, istruzioni per il personale, testi per i social
//   monthlyReport()  report del mese: numeri, andamento, clienti da ricontattare, stima dell'incasso portato dalla tessera
// Font standard del PDF (Helvetica): niente emoji, solo testo.
const PDFDocument = require('pdfkit');

const A4 = { w: 595.28, h: 841.89 };
const M = 48; // margine
const INK = '#1d1b19', MUTED = '#6b645c', LINE = '#e6ddd0', CREAM = '#fbf6ee';

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// colore del testo leggibile sopra il colore del locale
function onBrand(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? INK : '#ffffff';
}

const newDoc = (title) => new PDFDocument({ size: 'A4', margin: M, info: { Title: title, Author: process.env.BRAND_NAME || 'F5M' } });

function logoCircle(doc, logo, x, y, r) {
  doc.save().circle(x, y, r).fill('#ffffff');
  if (logo) {
    doc.circle(x, y, r - 3).clip();
    doc.image(logo, x - r + 3, y - r + 3, { width: (r - 3) * 2, height: (r - 3) * 2 });
  }
  doc.restore();
}

// piè di pagina nel margine basso (senza margine temporaneo il testo andrebbe su una pagina nuova)
function footer(doc, text) {
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.fontSize(8).fillColor(MUTED).text(text, M, A4.h - 30, { width: A4.w - 2 * M, align: 'center', lineBreak: false });
  doc.page.margins.bottom = bottom;
}

// ---------- Kit di lancio ----------
// d: { name, programName, rewardText, stampsForReward, brandColor, links: { signup, staff, nfc }, logo (PNG), qr (PNG), brand }
async function launchKit(d) {
  const doc = newDoc(`Kit di lancio - ${d.name}`);
  const brand = d.brandColor, fg = onBrand(brand);
  const W = A4.w - 2 * M;
  const short = d.links.signup.replace(/^https?:\/\//, '').replace(/\/$/, '');

  // 1. QR da tavolo
  doc.rect(0, 0, A4.w, 230).fill(brand);
  logoCircle(doc, d.logo, A4.w / 2, 82, 46);
  doc.fillColor(fg).font('Helvetica-Bold').fontSize(26).text(d.name, M, 142, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(13).text(d.programName, M, 178, { width: W, align: 'center' });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(30).text('La tua tessera fedeltà', M, 262, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(16).fillColor(MUTED)
    .text(`Ogni ${d.stampsForReward} visite: ${d.rewardText.toLowerCase()}`, M, 302, { width: W, align: 'center' });
  const qs = 270;
  doc.roundedRect((A4.w - qs) / 2 - 14, 340, qs + 28, qs + 28, 18).lineWidth(3).stroke(brand);
  doc.image(d.qr, (A4.w - qs) / 2, 354, { width: qs, height: qs });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text('Inquadra il QR con la fotocamera', M, 660, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(13).fillColor(MUTED)
    .text('Ti iscrivi in 20 secondi. Niente app da scaricare: la tessera va nel telefono e raccoglie i timbri da sola.', M + 40, 686, { width: W - 80, align: 'center' });
  doc.fontSize(11).fillColor(brand).text(short, M, 740, { width: W, align: 'center' });
  footer(doc, 'Stampa in A4 e metti il foglio sul tavolo o vicino alla cassa (va bene anche dentro un portamenù).');

  // 2. Adesivi da vetrina e cassa (2 per pagina)
  doc.addPage();
  for (let i = 0; i < 2; i++) {
    const y = M + i * 370, h = 340;
    doc.roundedRect(M, y, W, h, 22).fill(brand);
    logoCircle(doc, d.logo, M + 64, y + 66, 36);
    doc.fillColor(fg).font('Helvetica-Bold').fontSize(24).text('Qui c\'è la tessera', M + 118, y + 40, { width: W - 140 });
    doc.text('fedeltà digitale', M + 118, y + 70, { width: W - 140 });
    doc.font('Helvetica').fontSize(14).text(`Ogni ${d.stampsForReward} visite: ${d.rewardText.toLowerCase()}`, M + 30, y + 130, { width: W - 250 });
    doc.fontSize(12).text('Inquadra il QR o chiedi in cassa. Niente app da scaricare.', M + 30, y + 190, { width: W - 250 });
    doc.roundedRect(M + W - 200, y + 120, 170, 170, 12).fill('#ffffff');
    doc.image(d.qr, M + W - 190, y + 130, { width: 150, height: 150 });
    doc.fillColor(fg).fontSize(10).text(short, M + 30, y + h - 34, { width: W - 60 });
  }
  footer(doc, 'Ritaglia lungo i bordi: un adesivo per la vetrina e uno per la cassa.');

  // 3. Istruzioni per il personale
  doc.addPage();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text('Istruzioni per il personale', M, M);
  doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(`${d.name} - da tenere vicino alla cassa`, M, M + 30);
  const steps = [
    ['Apri la Cassa sul telefono o tablet del locale', `${d.links.staff}\nSalvala sulla schermata Home (menu del browser > "Aggiungi a schermata Home"): si apre come un'app.`],
    ['Entra con il PIN', 'Il PIN te lo dà il titolare. Ognuno può avere il suo: nello storico si vede chi ha dato ogni timbro.'],
    ['Dare un timbro', 'Inquadra il QR sulla tessera del cliente, oppure cerca il suo nome o il codice (es. PZ-AB12C), poi tocca "+1 timbro". Un timbro per visita.'],
    ['Con il timbro NFC', 'Il cliente avvicina il telefono al timbro (o tu lo avvicini al suo): il punto arriva da solo e in Cassa compare l\'avviso.'],
    ['Consegnare il premio', 'Quando la tessera mostra "Premio da ritirare", consegna il premio e tocca "Consegna premio".'],
    ['Hai sbagliato?', 'Tocca "Annulla ultima": l\'ultima operazione viene annullata e resta traccia nello storico.'],
    ['Cliente nuovo', 'Fagli inquadrare il QR del tavolo: si iscrive in 20 secondi. Poi gli dai il primo timbro.'],
    ['Il cliente ha cambiato telefono', 'Basta il codice della tessera e l\'email usata all\'iscrizione: dalla pagina di iscrizione sceglie "Ho già la tessera".'],
  ];
  let y = M + 64;
  steps.forEach(([title, body], i) => {
    doc.circle(M + 14, y + 10, 14).fill(brand);
    doc.fillColor(fg).font('Helvetica-Bold').fontSize(12).text(String(i + 1), M, y + 3, { width: 28, align: 'center' });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(title, M + 40, y, { width: W - 40 });
    doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(body, M + 40, doc.y + 2, { width: W - 40 });
    y = doc.y + 16;
  });
  footer(doc, 'Problemi con la Cassa? Scrivi al servizio clienti indicato dal titolare.');

  // 4. Testi pronti per far conoscere la tessera
  doc.addPage();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text('Fallo sapere ai clienti', M, M);
  doc.font('Helvetica').fontSize(11).fillColor(MUTED).text('Testi pronti da copiare su Instagram, Facebook, WhatsApp e sul profilo Google del locale.', M, M + 30);
  const posts = [
    ['Post Instagram / Facebook',
      `Da oggi da ${d.name} c'è la tessera fedeltà digitale!\nOgni ${d.stampsForReward} visite: ${d.rewardText.toLowerCase()}.\nNiente app e niente tessere di carta: inquadra il QR sul tavolo o iscriviti qui ${d.links.signup}\nLa tessera va nel telefono e i timbri arrivano da soli.`],
    ['Messaggio WhatsApp ai clienti abituali',
      `Ciao! Da ${d.name} abbiamo la nuova tessera fedeltà: ogni ${d.stampsForReward} visite ${d.rewardText.toLowerCase()}. Ti iscrivi in 20 secondi da qui: ${d.links.signup}`],
    ['Aggiornamento sul profilo Google',
      `Novità: la tessera fedeltà digitale di ${d.name}. Ogni ${d.stampsForReward} visite ${d.rewardText.toLowerCase()}. Iscriviti dal QR in sala o da ${short}`],
    ['Cosa dire in cassa (10 secondi)',
      `"Hai la nostra tessera fedeltà? Inquadra questo QR: ti iscrivi in un attimo e oggi hai già il primo timbro. Ogni ${d.stampsForReward} visite ${d.rewardText.toLowerCase()}."`],
  ];
  y = M + 66;
  for (const [title, body] of posts) {
    doc.font('Helvetica').fontSize(11);
    const h = doc.heightOfString(body, { width: W - 32 }) + 44;
    doc.roundedRect(M, y, W, h, 12).fill(CREAM).roundedRect(M, y, W, h, 12).lineWidth(1).stroke(LINE);
    doc.fillColor(brand).font('Helvetica-Bold').fontSize(12).text(title, M + 16, y + 14, { width: W - 32 });
    doc.fillColor(INK).font('Helvetica').fontSize(11).text(body, M + 16, y + 34, { width: W - 32 });
    y += h + 14;
  }
  if (d.links.nfc) {
    doc.fillColor(MUTED).fontSize(9).text(`Indirizzo da scrivere nel timbro NFC: ${d.links.nfc}`, M, y + 4, { width: W });
  }
  footer(doc, `${d.brand} - tessere fedeltà digitali`);
  return toBuffer(doc);
}

// ---------- Report mensile ----------
// d: { name, brandColor, logo, monthLabel, kpi: {...}, prev: {...}, weeks: [{ label, stamps }], tips: [string], brand, avgTicket }
async function monthlyReport(d) {
  const doc = newDoc(`Report ${d.monthLabel} - ${d.name}`);
  const brand = d.brandColor, fg = onBrand(brand);
  const W = A4.w - 2 * M;
  doc.rect(0, 0, A4.w, 130).fill(brand);
  logoCircle(doc, d.logo, M + 36, 66, 36);
  doc.fillColor(fg).font('Helvetica-Bold').fontSize(22).text(d.name, M + 90, 40, { width: W - 90 });
  doc.font('Helvetica').fontSize(13).text(`Tessera fedeltà - report di ${d.monthLabel}`, M + 90, 72, { width: W - 90 });

  const k = d.kpi, p = d.prev;
  const delta = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}% sul mese prima` : (a ? 'primo mese' : ''));
  const tiles = [
    ['Visite con timbro', k.stamps, delta(k.stamps, p.stamps)],
    ['Clienti passati', k.visitors, delta(k.visitors, p.visitors)],
    ['Nuovi iscritti', k.newMembers, delta(k.newMembers, p.newMembers)],
    ['Clienti tornati', k.returning, k.visitors ? `${Math.round((k.returning / k.visitors) * 100)}% dei clienti passati` : ''],
    ['Premi consegnati', k.redeemed, ''],
    ['Iscritti in totale', k.members, `${k.consent} accettano le offerte`],
  ];
  const tw = (W - 24) / 3, th = 92;
  tiles.forEach(([label, value, note], i) => {
    const x = M + (i % 3) * (tw + 12), y = 156 + Math.floor(i / 3) * (th + 12);
    doc.roundedRect(x, y, tw, th, 12).fill(CREAM).roundedRect(x, y, tw, th, 12).lineWidth(1).stroke(LINE);
    doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(label, x + 14, y + 12, { width: tw - 28 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(28).text(String(value), x + 14, y + 30, { width: tw - 28 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(note, x + 14, y + 68, { width: tw - 28 });
  });

  let y = 156 + 2 * (th + 12) + 14;
  if (d.avgTicket) {
    const euro = Math.round(k.returningVisits * d.avgTicket);
    doc.roundedRect(M, y, W, 64, 12).fill(brand);
    doc.fillColor(fg).font('Helvetica').fontSize(11)
      .text(`Incasso stimato dalle visite dei clienti tornati (${k.returningVisits} visite x ${d.avgTicket} euro di scontrino medio)`, M + 16, y + 12, { width: W - 32 });
    doc.font('Helvetica-Bold').fontSize(22).text(`circa ${euro.toLocaleString('it-IT')} euro`, M + 16, y + 30, { width: W - 32 });
    y += 82;
  }

  // andamento: timbri per settimana
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('Timbri settimana per settimana', M, y);
  y += 44; // spazio per il numero sopra la barra più alta
  const ch = 120, max = Math.max(1, ...d.weeks.map((w) => w.stamps));
  const bw = Math.min(70, (W - 20) / d.weeks.length - 14);
  d.weeks.forEach((w, i) => {
    const x = M + 10 + i * (bw + 14);
    const h = Math.max(2, (w.stamps / max) * ch);
    doc.roundedRect(x, y + ch - h, bw, h, 4).fill(brand);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(String(w.stamps), x, y + ch - h - 14, { width: bw, align: 'center' });
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(w.label, x - 6, y + ch + 6, { width: bw + 12, align: 'center' });
  });
  y += ch + 34;

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('Cosa fare questo mese', M, y);
  y += 22;
  for (const tip of d.tips) {
    doc.circle(M + 5, y + 6, 3).fill(brand);
    doc.fillColor(INK).font('Helvetica').fontSize(11).text(tip, M + 16, y, { width: W - 16 });
    y = doc.y + 8;
  }
  footer(doc, `${d.brand} - tessere fedeltà digitali`);
  return toBuffer(doc);
}

module.exports = { launchKit, monthlyReport };
