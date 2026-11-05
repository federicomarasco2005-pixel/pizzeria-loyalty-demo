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

test('Wallet: sul fronte il nome del cliente; sotto la tessera QR, messaggio e pulsanti', async () => {
  const { loadImage } = require('@napi-rs/canvas');
  const qr = await loadImage(await images.walletQr('AS-F7D44'));
  assert.strictEqual(qr.width, 1032);
  const qc = createCanvas(qr.width, qr.height); const qg = qc.getContext('2d'); qg.drawImage(qr, 0, 0);
  assert.deepStrictEqual([...qg.getImageData(5, 5, 1, 1).data], [255, 255, 255, 255], 'fondo bianco pieno, senza ombra del riquadro di Google');

  const { classBody, objectBody, setCfg } = require('../wallet')._forTest;
  setCfg({ issuerId: '1' });
  const c = { classSuffix: 'x', pizzeriaName: 'Prova', programName: 'Tessera fedeltà Prova', rewardText: 'Pizza gratis', rewardShort: 'Pizza', stampsForReward: 6, baseUrl: 'https://x/y', stampsImageBase: 'https://x/y/stamps', imgVersion: '1', brandColor: '#112233', logoUrl: 'l', wideLogoUrl: 'w' };
  const body = classBody(c);
  assert.strictEqual(body.programName, 'Prova');
  assert.deepStrictEqual(body.imageModulesData, [], 'il vecchio logo grande va tolto dalla classe');
  const paths = body.classTemplateInfo.detailsTemplateOverride.detailsItemInfos.map((i) => i.item.firstValue.fields[0].fieldPath);
  assert.deepStrictEqual(paths.slice(0, 2), ["object.imageModulesData['qr']", 'object.messages[0]']);
  assert.strictEqual(paths[2], 'object.linksModuleData');
  assert.ok(body.classTemplateInfo.cardTemplateOverride.cardRowTemplateInfos[0].oneItem);

  const o = objectBody(c, { code: 'AS-1', name: 'Anna', token: 't', id: '1' }, { stamps: 2, rewards: 0 }, { phone: '+39 1' });
  assert.deepStrictEqual(o.textModulesData.map((t) => t.id), ['cliente', 'timbri', 'premio']);
  assert.strictEqual(o.textModulesData[0].body, 'Anna');
  assert.strictEqual(o.accountId, undefined, 'niente striscia bianca col codice sul fronte');
  assert.deepStrictEqual(o.linksModuleData.uris.map((u) => u.id), ['web', 'tel'], 'il QR è già sotto la tessera: niente pulsante');
  assert.strictEqual(o.imageModulesData[0].mainImage.sourceUri.uri, `https://x/y/qr-tessera/AS-1.png?v=${require('../wallet').LAYOUT_VERSION}`);
  assert.ok(!JSON.stringify(o.imageModulesData).includes('/card/'), 'il QR non contiene il token');
  setCfg(null);
});

test('Wallet: con un logo, l\'intestazione mostra il logo vero su targhetta bianca', async () => {
  const { loadImage } = require('@napi-rs/canvas');
  const head = await images.get({ slug: 'prova-testa', imgVersion: 1, name: 'Prova', theme: 'pizza', stampsForReward: 6, brandColor: '#112233', logo: fakeLogo() }, 'wide-logo.png');
  const img = await loadImage(head.buf);
  const c = createCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  assert.strictEqual(img.width, 1280);
  assert.strictEqual(g.getImageData(5, 5, 1, 1).data[3], 0, 'fuori dalla targhetta è trasparente');
  const mid = g.getImageData(640, 200, 1, 1).data;
  assert.ok(mid[3] === 255 && near('#' + [...mid].slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join(''), '#ad0303'), 'al centro c\'è il logo');
});
