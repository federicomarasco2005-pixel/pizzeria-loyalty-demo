// Email dell'iscrizione: suggerimento per gli errori di battitura (pagina) e controllo del dominio (server).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const controlloEmail = require('../controllo-email');

test('pagina: "Intendevi …?" per i domini scritti male, niente per quelli giusti', () => {
  const box = { window: {}, document: {} };
  vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'common.js'), 'utf8')}\nthis.emailHint = emailHint;`, box);
  const { emailHint } = box;
  assert.strictEqual(emailHint('mario@gmial.com'), 'mario@gmail.com');
  assert.strictEqual(emailHint('Mario@Gmail.con '), 'mario@gmail.com');
  assert.strictEqual(emailHint('anna@libero.ti'), 'anna@libero.it');
  assert.strictEqual(emailHint('anna@hotmial.it'), 'anna@hotmail.it');
  assert.strictEqual(emailHint('luca@yaho.it'), 'luca@yahoo.it');
  for (const ok of ['mario@gmail.com', 'anna@hotmail.it', 'anna@hotmail.com', 'info@pizzeria-rossi.it', 'luca@unitn.it', 'senza-chiocciola']) {
    assert.strictEqual(emailHint(ok), null, ok);
  }
});

test('server: dominio che non riceve posta = errore; DNS che non risponde = si lascia passare', async () => {
  controlloEmail.setLookup(async (d) => ({ 'gmail.com': true, 'gmail.con': false }[d] ?? null));
  assert.strictEqual(await controlloEmail.problem('mario@gmail.com'), null);
  assert.match(await controlloEmail.problem('mario@gmail.con'), /"gmail\.con" non esiste/);
  assert.strictEqual(await controlloEmail.problem('mario@dominio-lento.it'), null);
  controlloEmail.setLookup(async () => { throw new Error('rete giù'); });
  assert.strictEqual(await controlloEmail.problem('mario@altro.it'), null);
});
