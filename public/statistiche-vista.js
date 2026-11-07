// Disegno delle statistiche di un locale per la pagina /statistiche (solo il proprietario di F5M).
// Solo codice: i numeri arrivano dal server soltanto a chi ha la sessione.
window.StatVista = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('it-IT'));
  const pct = (r) => (r && r.pct !== null ? r.pct + '%' : '—');
  const frac = (r) => (r && r.d ? `${r.n} su ${r.d}` : 'ancora nessuno da contare');
  const dateTime = (iso) => new Date(iso).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const tile = (value, label, small = '') => `<div class="tile"><b>${value}</b><span>${esc(label)}</span>${small ? `<small>${esc(small)}</small>` : ''}</div>`;
  // stato: ok (raggiunto), bad (sotto), warn (in attesa); sempre con icona e parola
  const status = (kind, text) => `<span class="st ${kind}" data-icon="${kind === 'good' ? '✓' : kind === 'bad' ? '✕' : '…'}">${esc(text)}</span>`;
  const versus = (r, target) => {
    if (target === null) return status('warn', 'nessuna soglia');
    if (!r || !r.d) return status('warn', 'in attesa di dati');
    return r.pct >= target ? status('good', `raggiunto (soglia ${target}%)`) : status('bad', `sotto la soglia del ${target}%`);
  };

  // Regole di forma dei grafici a linee; i colori arrivano da --series, --lc-grid e --lc-text (statistiche.html)
  if (!document.getElementById('lc-style')) {
    const st = document.createElement('style');
    st.id = 'lc-style';
    st.textContent = `
      .lc { display: grid; grid-template-columns: 34px 1fr; column-gap: 8px; color: var(--lc-text); font-size: .74rem; padding-right: 12px; }
      .lc-unit { grid-column: 1 / 3; font-size: .72rem; margin-bottom: 14px; }
      .lc-y { position: relative; }
      .lc-y span { position: absolute; right: 0; transform: translateY(50%); font-variant-numeric: tabular-nums; }
      .lc-plot { position: relative; height: 140px; border-bottom: 1px solid var(--lc-text); }
      .lc-plot.small { height: 120px; }
      .lc-plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
      .lc-plot polyline { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
      .lc-grid { position: absolute; left: 0; right: 0; border-top: 1px solid var(--lc-grid); }
      .lc-dot { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: var(--series); }
      .lc-val { position: absolute; transform: translate(-50%, -19px); font-weight: 700; font-size: .78rem; font-variant-numeric: tabular-nums; color: var(--lc-ink, inherit); white-space: nowrap; pointer-events: none; }
      .lc-val.lc-first { transform: translate(5px, -19px); }
      .lc-val.lc-last { transform: translate(-100%, -19px); }
      .lc-hit { position: absolute; top: 0; bottom: 0; }
      .lc-hit::after { content: ""; position: absolute; top: 0; bottom: 0; left: var(--at); border-left: 1px dashed var(--lc-text); opacity: 0; }
      .lc-hit:hover::after { opacity: 1; }
      .lc-x { grid-column: 2; position: relative; height: 20px; margin-top: 5px; white-space: nowrap; }
      .lc-x span { position: absolute; transform: translateX(-50%); }
      .lc-x span.lc-first { transform: none; }
      .lc-x span.lc-last { transform: translateX(-100%); }
      .lc-cap { grid-column: 2; text-align: center; font-size: .72rem; }`;
    document.head.appendChild(st);
  }

  // Scala dell'asse verticale: numeri interi e tondi (0, 5, 10, 15…), con al massimo 4 divisioni
  function yScale(max) {
    if (max <= 0) return { top: 4, step: 1 };
    const rough = Math.max(max / 4, 1);
    const pow = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= rough);
    return { top: Math.ceil(max / step) * step, step };
  }

  // Grafico a linea di una sola serie. labels: testo al passaggio del dito; axis: scritte sotto, vuote dove non servono;
  // unit: cosa si conta (asse verticale); xTitle: cosa c'è sull'asse orizzontale. Numero scritto solo su massimo e ultimo punto.
  function lines(values, labels, { axis = labels, small = false, title = '', unit = '', xTitle = '' } = {}) {
    const n = values.length;
    const max = Math.max(...values, 0);
    const { top, step } = yScale(max);
    const peak = values.indexOf(max);
    const X = (i) => (n > 1 ? (i / (n - 1)) * 100 : 50);
    const Y = (v) => 100 - (v / top) * 100;
    const ticks = [];
    for (let t = 0; t <= top; t += step) ticks.push(t);
    const grid = ticks.filter((t) => t > 0).map((t) => `<div class="lc-grid" style="top:${Y(t)}%"></div>`).join('');
    const yLabels = ticks.map((t) => `<span style="bottom:${100 - Y(t)}%">${num(t)}</span>`).join('');
    const pts = values.map((v, i) => `${X(i)},${Y(v)}`).join(' ');
    const marked = (i) => n <= 8 || i === peak || i === n - 1;
    const written = (i) => n <= 4 || (max > 0 && (i === peak || i === n - 1));
    const dots = values.map((v, i) => (marked(i) ? `<i class="lc-dot" style="left:${X(i)}%;top:${Y(v)}%"></i>` : '')).join('');
    const vals = values.map((v, i) => (written(i) ? `<b class="lc-val${i === 0 ? ' lc-first' : i === n - 1 ? ' lc-last' : ''}" style="left:${X(i)}%;top:${Y(v)}%">${num(v)}</b>` : '')).join('');
    const w = 100 / Math.max(n - 1, 1);
    // zona sensibile attorno a ogni punto, dentro il grafico; la riga tratteggiata cade sul punto
    const hits = values.map((v, i) => {
      const from = Math.max(X(i) - w / 2, 0), to = Math.min(X(i) + w / 2, 100);
      return `<div class="lc-hit" style="left:${from}%;width:${to - from}%;--at:${((X(i) - from) / (to - from)) * 100}%" data-tip="${esc(`${labels[i]}: ${v}${unit ? ` ${unit}` : ''}`)}"></div>`;
    }).join('');
    const xs = axis.map((a, i) => (a ? `<span class="${i === 0 ? 'lc-first' : i === n - 1 ? 'lc-last' : ''}" style="left:${X(i)}%">${esc(a)}</span>` : '')).join('');
    const said = values.map((v, i) => `${labels[i]}: ${v}`).join(', ');
    return `<div class="chart"><h3>${esc(title)}</h3>
      <div class="lc" role="img" aria-label="${esc(`${title}. ${said}`)}">
        ${unit ? `<div class="lc-unit">${esc(unit)}</div>` : ''}
        <div class="lc-y">${yLabels}</div>
        <div class="lc-plot${small ? ' small' : ''}">${grid}<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>${dots}${vals}${hits}</div>
        <div class="lc-x">${xs}</div>
        ${xTitle ? `<div class="lc-cap">${esc(xTitle)}</div>` : ''}
      </div></div>`;
  }

  // Le ultime 8 settimane di 7 giorni contate all'indietro da oggi; ognuna si chiama con il giorno in cui finisce
  function weekly(values, opts) {
    const dates = values.map((_, i) => new Date(Date.now() - (values.length - 1 - i) * 7 * 86400000));
    const short = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
    const n = values.length;
    // nei grafici piccoli una data sì e una no, sempre con l'ultima: otto date non ci stanno
    const axis = dates.map((d, i) => (opts.small && (n - 1 - i) % 2 ? '' : short(d)));
    return lines(values, dates.map((d) => `Settimana fino al ${short(d)}`), { axis, xTitle: 'settimana che finisce il giorno', ...opts });
  }
  const DAYS = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
  const HOURS = Array.from({ length: 24 }, (_, h) => `${h}:00`);
  const HOUR_AXIS = HOURS.map((h, i) => (i % 4 ? '' : `${i}h`));

  function pilotBox(s) {
    const p = s.pilot;
    const act = p.activated === null ? status('warn', `in corso: ${p.signups7} iscritti nei primi giorni`) : p.activated ? status('good', `sì, ${p.signups7} iscritti in 7 giorni`) : status('bad', `no, ${p.signups7} iscritti in 7 giorni (soglia 20)`);
    const weeks = p.weeks.map((w) => `<span class="wk ${w.complete ? (w.active ? 'on' : 'off') : ''}" title="${w.stamps} timbri">${w.complete ? (w.active ? '✓' : '✕') : '…'} S${w.n}</span>`).join('') || '<span class="note">nessuna settimana ancora</span>';
    return `<div class="pilot">
      <div><small>Locale attivato (20 iscritti nei primi 7 giorni)</small>${act}</div>
      <div><small>Ritorno a 7 giorni: ${pct(s.returned7)} (${frac(s.returned7)})</small>${versus(s.returned7, p.target7)}</div>
      <div><small>Ritorno a 30 giorni: ${pct(s.returned30)} (${frac(s.returned30)})</small>${versus(s.returned30, p.target30)}</div>
      <div><small>Settimane attive (15 timbri in 4 giorni diversi)</small><div class="weeks">${weeks}</div></div>
    </div>`;
  }

  // Confronto con la settimana prima: "+3" o "−2"
  const trend = (now, before) => {
    const d = now - before;
    return d === 0 ? 'come la settimana prima' : `${d > 0 ? '+' : '−'}${Math.abs(d)} rispetto alla settimana prima`;
  };
  const lastStampText = (days) => (days === null ? 'mai' : days === 0 ? 'oggi' : days === 1 ? 'ieri' : `${days} gg fa`);

  function shopBody(s) {
    const m = s.messages;
    const x = s.more;
    const share = s.top3Share;
    const warns = [];
    if (s.members && x.daysSinceStamp !== null && x.daysSinceStamp >= 14) warns.push(`Nessun timbro da ${x.daysSinceStamp} giorni: il locale sta usando la tessera?`);
    if (share !== null && share >= 40) warns.push(`I 3 clienti con più timbri ne hanno il ${share}% negli ultimi 30 giorni: controlla che non siano personale o amici.`);
    if (s.nfcNight30) warns.push(`${s.nfcNight30} timbri NFC dati di notte (22–6) negli ultimi 30 giorni: possibile link del chip copiato.`);
    if (s.rewards.backAfter.d && s.rewards.backAfter.pct < 50) warns.push(`Solo ${s.rewards.backAfter.pct}% di chi ha ritirato un premio è tornato entro 30 giorni.`);
    if (x.voids30 >= 5 && x.voids30 > s.stamps30 * 0.1) warns.push(`${x.voids30} operazioni annullate in 30 giorni, tante rispetto ai ${s.stamps30} timbri: errori in cassa o timbri di troppo?`);
    const staffRows = s.staff.map((r) => `<tr><td>${esc(r.who)}</td><td class="num">${r.stamps}</td></tr>`).join('') || '<tr><td colspan="2" class="note">Nessun timbro negli ultimi 30 giorni.</td></tr>';
    const v = x.visitBands, r = x.recency;
    return `<div class="body">
      <div style="margin-top:14px"><a class="btn ghost" href="/${encodeURIComponent(s.slug)}/admin">Entra come il locale</a></div>
      <div><h3>Pilota · giorno ${s.pilot.day}</h3>${pilotBox(s)}</div>
      <div><h3>Come stanno i clienti</h3><div class="tiles">
        ${tile(num(x.activeMembers30), 'attivi', `${s.members ? Math.round(x.activeMembers30 / s.members * 100) : 0}% degli iscritti, timbro in 30 giorni`)}
        ${tile(num(x.neverStamped), 'iscritti senza nessun timbro')}
        ${tile(num(x.nearReward), 'a 1 timbro dal premio')}
        ${tile(num(x.rewardsPending), 'premi maturati, non ritirati')}
        ${tile(pct(x.returnShare30), 'timbri di chi torna', '30 giorni, senza il primo timbro')}
        ${tile(lastStampText(x.daysSinceStamp), 'ultimo timbro')}
      </div></div>
      <div class="charts">
        ${lines([v.one, v.twoThree, v.fourSeven, v.eightPlus], ['1 visita', '2–3 visite', '4–7 visite', '8 o più visite'], { axis: ['1', '2–3', '4–7', '8+'], small: true, title: 'Clienti per numero di visite', unit: 'clienti', xTitle: 'visite fatte' })}
        ${lines([r.d30, r.d60, r.older, r.never], ['Ultima visita entro 30 giorni', 'Ultima visita tra 30 e 60 giorni fa', 'Ultima visita oltre 60 giorni fa', 'Nessuna visita'], { axis: ['<30', '30–60', '60+', 'mai'], small: true, title: 'Clienti per ultima visita', unit: 'clienti', xTitle: 'giorni dall\'ultima visita' })}
        ${weekly(s.weeklySignups, { small: true, title: 'Nuovi iscritti per settimana', unit: 'iscritti' })}
      </div>
      <div><h3>Iscritti</h3><div class="tiles">
        ${tile(num(s.members), 'iscritti')}
        ${tile(num(s.newMembers7), 'nuovi in 7 giorni', `${num(s.newMembers30)} in 30 giorni`)}
        ${tile(s.members ? Math.round(s.consent / s.members * 100) + '%' : '—', 'con consenso alle offerte', `${s.consent} clienti`)}
        ${tile(s.members ? Math.round(s.wallet / s.members * 100) + '%' : '—', 'con la tessera nel Wallet', `${s.wallet} clienti`)}
        ${tile(num(s.webPush), 'con le notifiche web', 'tessera sulla Home')}
        ${tile(num(s.fromNfc), 'iscritti dal timbro NFC')}
      </div></div>
      <div><h3>Visite</h3><div class="tiles">
        ${tile(num(s.stamps7), 'timbri in 7 giorni', `${trend(s.stamps7, x.stampsPrev7)}, in ${s.activeDays7} giorni diversi`)}
        ${tile(num(s.stamps30), 'timbri in 30 giorni', `${num(s.stamps)} in tutto`)}
        ${tile(num(s.visitsPerMember30), 'visite al mese per iscritto')}
        ${tile(s.avgGapDays === null ? '—' : s.avgGapDays + ' gg', 'tra una visita e l\'altra')}
        ${tile(num(s.regulars), 'abituali', '4+ giorni di visita in 30 giorni')}
        ${tile(num(s.dormant), 'non tornano da 30+ giorni')}
        ${tile(num(s.neverBack), 'mai tornati dopo l\'iscrizione', 'iscritti da più di 30 giorni')}
      </div></div>
      <div class="charts">
        ${weekly(s.weeklyStamps, { small: true, title: 'Timbri per settimana', unit: 'timbri' })}
        ${lines(s.weekday, DAYS, { small: true, title: 'Timbri per giorno (ultimi 60 giorni)', unit: 'timbri', xTitle: 'giorno della settimana' })}
        ${lines(s.hours, HOURS, { axis: HOUR_AXIS, small: true, title: 'Timbri per ora (ultimi 60 giorni)', unit: 'timbri', xTitle: 'ora del giorno' })}
      </div>
      <div><h3>Premi (ogni ${s.stampsForReward} timbri)</h3><div class="tiles">
        ${tile(num(s.rewards.earned), 'premi maturati')}
        ${tile(num(s.rewards.redeemed), 'premi consegnati')}
        ${tile(s.rewards.avgDaysToFirst === null ? '—' : s.rewards.avgDaysToFirst + ' gg', 'per arrivare al primo premio')}
        ${tile(pct(s.rewards.backAfter), 'tornati dopo il premio', frac(s.rewards.backAfter))}
      </div></div>
      <div><h3>Messaggi automatici (ultimi 30 giorni)</h3><div class="tiles">
        ${tile(num(m.waiting), '"Il tuo premio ti aspetta"')}
        ${tile(num(m.near), '"Ti manca 1 timbro"')}
        ${tile(num(m.review), 'richieste di recensione')}
        ${tile(num(m.inactive), '"Ci manchi"')}
        ${tile(num(m.manual), 'messaggi del locale')}
        ${tile(pct(s.missYouBack), 'tornati entro 7 giorni da "Ci manchi"', frac(s.missYouBack))}
        ${tile(num(s.delivery.push + s.delivery.web), 'arrivati con notifica', `${s.delivery.push} Wallet · ${s.delivery.web} web · ${s.delivery.textOnly} senza suono · ${s.delivery.failed} rifiutati da Google`)}
      </div></div>
      <div><h3>Soldi</h3><div class="tiles">
        ${tile(num(s.money.returnVisits30), 'visite di ritorno in 30 giorni')}
        ${s.avgTicket ? tile(num(s.money.estimate30) + ' €', 'incasso delle visite di ritorno', `scontrino medio ${s.avgTicket} €`) : tile('—', 'scontrino medio non impostato', 'bot → Modifica → Scontrino medio')}
      </div>
      <p class="note">Non tutto merito della tessera: i primi a iscriversi sono i clienti affezionati, che sarebbero tornati comunque. Per l'effetto vero servono le chiusure di cassa del locale.</p></div>
      <div><h3>Controlli</h3>
        ${warns.length ? warns.map((w) => `<div class="warnbox">⚠️ ${esc(w)}</div>`).join('') : '<p class="note">Nessun segnale strano.</p>'}
        <div class="tiles" style="margin-top:10px">
          ${tile(num(s.nfc30), 'timbri NFC in 30 giorni', `${s.nfcNight30} di notte`)}
          ${tile(share === null ? '—' : share + '%', 'timbri dei 3 clienti più assidui', 'servono almeno 20 timbri')}
          ${tile(num(x.voids30), 'operazioni annullate in 30 giorni')}
        </div>
        <table style="margin-top:10px"><thead><tr><th>Chi ha dato i timbri (30 giorni)</th><th class="num">Timbri</th></tr></thead><tbody>${staffRows}</tbody></table>
      </div>
    </div>`;
  }

  // Valore della barra al passaggio del dito o del mouse
  function watchTips() {
    let tip = document.getElementById('tip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'tip'; tip.className = 'tip'; document.body.appendChild(tip); }
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip.style.display = 'none'; return; }
      const r = t.getBoundingClientRect();
      tip.textContent = t.dataset.tip;
      tip.style.display = 'block';
      tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
      tip.style.top = Math.max(8, r.top - 34) + 'px';
    });
  }

  return { esc, num, pct, frac, dateTime, tile, weekly, shopBody, watchTips };
})();
