// Dashboard del locale: colori presi dal logo (images.palette) e niente funzioni che coprono quelle di common.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const images = require('../images');

// Logo finto: fondo bianco, scritta grigio scuro, macchia rossa grande e una verde più piccola
function fakeLogo() {
  const c = createCanvas(400, 400); const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 400, 400);
  g.fillStyle = '#323232'; g.fillRect(20, 300, 360, 40);
  g.fillStyle = '#ad0303'; g.fillRect(150, 80, 120, 200);
  g.fillStyle = '#457550'; g.fillRect(40, 40, 60, 40);
  return c.toBuffer('image/png').toString('base64');
}

const near = (hex, target) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(hex), b = p(target);
  return a.every((v, i) => Math.abs(v - b[i]) < 24);
};

test('colori dal logo: rosso come accento, verde come secondo colore, grigio scuro come inchiostro', async () => {
  const pal = await images.palette({ slug: 'prova-colori', imgVersion: 1, logo: fakeLogo() });
  assert.ok(near(pal.accent, '#ad0303'), pal.accent);
  assert.ok(near(pal.second, '#457550'), pal.second);
  assert.ok(near(pal.ink, '#323232'), pal.ink);
  assert.strictEqual(await images.palette({ slug: 'senza-logo', imgVersion: 1 }), null);
});

test('pagine del locale: stile comune, colori del locale e nessuna load() che copre quella di common.js', () => {
  for (const name of ['admin', 'staff', 'poster']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');
    assert.ok(!/function\s+load\s*\(/.test(html), `${name}: una funzione load() nella pagina fa perdere il PIN salvato`);
    assert.ok(html.includes('href="/locale.css"'), `${name}: manca /locale.css`);
    assert.ok(html.includes('applyShopColors'), `${name}: mancano i colori del locale`);
    assert.ok(!html.includes('/f5m.css'), `${name}: usa ancora il vecchio stile scuro`);
  }
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'public', 'common.js'), 'utf8').includes('window.PALETTE'));
});
