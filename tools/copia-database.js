// Copia TUTTI i dati da un database Postgres a un altro (es. Render → Neon) e verifica che siano identici.
// Il database di partenza viene solo letto, mai modificato. La destinazione deve essere vuota.
//
// Uso (le due stringhe di collegamento si incollano solo nel proprio terminale, non vanno salvate da nessuna parte):
//   PowerShell:  $env:SORGENTE="postgres://..."; $env:DESTINAZIONE="postgres://..."; node tools/copia-database.js
//
// Esito: per ogni tabella il numero di righe copiate e "IDENTICO" se il contenuto coincide riga per riga.
const crypto = require('crypto');

// Stesse tabelle di db.js. Le righe si copiano nell'ordine originale (seq): il nuovo database
// assegna i suoi numeri di sequenza nello stesso ordine.
const TABLES = [
  { name: 'kv', select: 'SELECT k, v FROM kv ORDER BY k', insert: 'INSERT INTO kv (k, v) VALUES ($1, $2)', values: (r) => [r.k, JSON.stringify(r.v)] },
  { name: 'customers', select: 'SELECT store, id, data FROM customers ORDER BY seq', insert: 'INSERT INTO customers (store, id, data) VALUES ($1, $2, $3)', values: (r) => [r.store, r.id, JSON.stringify(r.data)] },
  { name: 'events', select: 'SELECT store, id, customer_id, at, data FROM events ORDER BY seq', insert: 'INSERT INTO events (store, id, customer_id, at, data) VALUES ($1, $2, $3, $4, $5)', values: (r) => [r.store, r.id, r.customer_id, r.at, JSON.stringify(r.data)] },
  { name: 'campaigns', select: 'SELECT store, id, data FROM campaigns ORDER BY seq', insert: 'INSERT INTO campaigns (store, id, data) VALUES ($1, $2, $3)', values: (r) => [r.store, r.id, JSON.stringify(r.data)] },
  { name: 'notifications', select: 'SELECT store, customer_id, at, data FROM notifications ORDER BY at, customer_id', insert: 'INSERT INTO notifications (store, customer_id, at, data) VALUES ($1, $2, $3, $4)', values: (r) => [r.store, r.customer_id, r.at, JSON.stringify(r.data)] },
];

// Impronta del contenuto di una tabella (stesso ordine, stessi valori → stessa impronta)
const fingerprint = (rows, t) => crypto.createHash('sha256')
  .update(JSON.stringify(rows.map((r) => t.values(r).map((v) => (v instanceof Date ? v.toISOString() : v)))))
  .digest('hex');

// src, dst: due Pool di pg. Restituisce [{ table, rows, identical }]
async function copy(src, dst, log = console.log, { createSchema = true } = {}) {
  // tabelle sulla destinazione (stesso schema del server)
  const db = require('../db');
  await db.init({ pool: dst, skipSchema: !createSchema });

  for (const t of TABLES) {
    const { rows } = await dst.query(`SELECT COUNT(*)::int AS n FROM ${t.name}`);
    if (rows[0].n > 0) throw new Error(`la destinazione non è vuota (${t.name}: ${rows[0].n} righe): copia annullata, nulla è stato modificato`);
  }

  const data = {};
  for (const t of TABLES) data[t.name] = (await src.query(t.select)).rows;

  const client = await dst.connect();
  try {
    await client.query('BEGIN');
    for (const t of TABLES) for (const r of data[t.name]) await client.query(t.insert, t.values(r));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`copia interrotta, la destinazione è rimasta vuota: ${err.message}`);
  } finally {
    client.release();
  }

  const report = [];
  for (const t of TABLES) {
    const copied = (await dst.query(t.select)).rows;
    const identical = copied.length === data[t.name].length && fingerprint(copied, t) === fingerprint(data[t.name], t);
    report.push({ table: t.name, rows: copied.length, identical });
    log(`${t.name.padEnd(14)} ${String(copied.length).padStart(6)} righe  ${identical ? 'IDENTICO' : '*** DIVERSO ***'}`);
  }
  return report;
}

module.exports = { copy };

if (require.main === module) {
  const { Pool } = require('pg');
  const { SORGENTE, DESTINAZIONE } = process.env;
  if (!SORGENTE || !DESTINAZIONE) {
    console.error('Imposta SORGENTE e DESTINAZIONE (le stringhe di collegamento dei due database).');
    process.exit(1);
  }
  if (SORGENTE === DESTINAZIONE) {
    console.error('SORGENTE e DESTINAZIONE sono uguali: niente da fare.');
    process.exit(1);
  }
  const ssl = { rejectUnauthorized: false };
  const src = new Pool({ connectionString: SORGENTE, ssl });
  const dst = new Pool({ connectionString: DESTINAZIONE, ssl });
  copy(src, dst)
    .then((report) => {
      const ok = report.every((r) => r.identical);
      console.log(ok ? '\nCOPIA COMPLETA E VERIFICATA: tutti i dati sono identici.' : '\nATTENZIONE: alcuni dati sono diversi. NON cambiare DATABASE_URL.');
      process.exitCode = ok ? 0 : 2;
    })
    .catch((err) => { console.error(`\nERRORE: ${err.message}`); process.exitCode = 1; })
    .finally(() => Promise.all([src.end(), dst.end()]));
}
