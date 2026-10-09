// Unisce i fotogrammi generati da tools/gen-stamps.ps1 in GIF animate per la tessera Google Wallet.
// Uso: node tools/make-gifs.js   ->  public/stamps/anim-<totale>-<n>.gif e anim-<totale>-reward.gif
// Le GIF si riproducono una volta sola e si fermano sull'ultimo fotogramma.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const framesDir = path.join(__dirname, '.frames');
const outDir = path.join(__dirname, '..', 'public', 'stamps');
const COLORS = 64; // le pizze hanno pochi colori piatti: 64 bastano e il file pesa meno
const manifest =JSON.parse(fs.readFileSync(path.join(framesDir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));

for (const [name, delays] of Object.entries(manifest)) {
  const files = fs.readdirSync(path.join(framesDir, name)).filter((f) => f.endsWith('.png')).sort();
  const frames = files.map((file) => PNG.sync.read(fs.readFileSync(path.join(framesDir, name, file))));
  // Un'unica tavolozza per tutti i fotogrammi: file più leggero e colori stabili (niente sfarfallio).
  const sample = Buffer.concat(frames.filter((_, i) => i % 3 === 0 || i === frames.length - 1).map((f) => f.data));
  const palette = quantize(sample, COLORS - 1);
  const TRANSPARENT = palette.length; // indice riservato: "pixel uguale al fotogramma precedente"
  palette.push([255, 0, 255]);
  const gif = GIFEncoder();
  let prev = null;
  frames.forEach(({ data, width, height }, i) => {
    const index = applyPalette(data, palette.slice(0, TRANSPARENT));
    // Dal secondo fotogramma si scrivono solo i pixel cambiati: il resto è trasparente
    // e mostra il fotogramma precedente (dispose 1 = lascia al suo posto). File molto più leggero.
    const out = prev ? index.map((v, p) => (v === prev[p] ? TRANSPARENT : v)) : index;
    const last = i === frames.length - 1;
    gif.writeFrame(out, width, height, {
      palette: i === 0 ? palette : undefined,
      // Ultimo fotogramma (pizze ferme) con la durata massima del formato GIF (~11 minuti):
      // anche se il telefono ignorasse "una volta sola", l'animazione non ripartirebbe.
      delay: last ? 655000 : delays[i],
      repeat: -1, // riproduci una volta sola: l'ultimo fotogramma (pizze ferme) resta visibile
      transparent: i > 0,
      transparentIndex: TRANSPARENT,
      dispose: 1,
    });
    prev = index;
  });
  gif.finish();
  const out = path.join(outDir, `${name}.gif`);
  fs.writeFileSync(out, gif.bytes());
  console.log(`${name}.gif  ${files.length} fotogrammi  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}
