// Renewtech Antalis-bestilling: runs on antalis.dk when the bookmark is clicked.
// Reads the live order history, works out what to order and when, and fills the cart.
const APP_VERSION = '1.12';
const CTX = (typeof window.context === 'string' ? window.context : '/eshop');
const WS = CTX + '/ws/';
const DA_PLURAL = { stk: 'stk', bundt: 'bundter', palle: 'paller', kasse: 'kasser', pakke: 'pakker', rulle: 'ruller', æske: 'æsker', sæt: 'sæt' };
const unitDa = (u, n) => { const d = UNIT_DA[u] || u; return n === 1 ? d : (DA_PLURAL[d] || d); };
// What one base unit is called: pieces, reels or sheets, or the sales unit itself when its size is unknown.
const BASE_WORD = it => /ruller/i.test(it.desc) ? 'ruller' : /\bark\b/i.test(it.desc) ? 'ark'
  : (it.factors[it.orderUnit] === 1 && it.orderUnit !== 'Unit(s)') ? unitDa(it.orderUnit, 2) : 'stk';
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};
const HIST_KEY = 'renewtechAntalisHistorik', SENT_KEY = 'renewtechAntalisSendt', STOCK_KEY = 'renewtechAntalisLager', FERIE_KEY = 'renewtechAntalisFerie';
const closedNow = () => defaultClosed(todayUTC);
// Stock counts: { code: { pallets, per, at } } in this browser; the engine wants base units.
const rateOpts = () => { const s = LS.get(STOCK_KEY) || {}, o = {}; for (const [k, v] of Object.entries(s)) if (v && v.perWeek > 0) o[k] = v.perWeek / 7; return o; };
const LONG_WARN = 21; // days ahead that long-lead items are always shown
const stockOpts = () => { const s = LS.get(STOCK_KEY) || {}, o = {}; for (const [k, v] of Object.entries(s)) if (v && v.pallets >= 0 && v.per > 0) o[k] = { base: v.pallets * v.per, at: v.at }; return o; };
const fmtTime = t => new Date(t).toLocaleString('da-DK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = t => new Date(t).toLocaleDateString('da-DK', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtNum = n => Math.round(n).toLocaleString('da-DK');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ddmmyyyy = t => { const d = new Date(t); return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear(); };
const todayUTC = (() => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); })();
const parseHtml = t => new DOMParser().parseFromString(t, 'text/html');

async function fetchHistory(days) {
  const body = {
    orderId: null, from: ddmmyyyy(todayUTC - days * DAY), to: ddmmyyyy(todayUTC),
    userFullName: '', orderNumber: '', reference: '', skuCode: '', zipCode: '', orderType: '', invoiceNumber: '', paymentType: '',
    allStatus: true, allChannels: true,
    statusTab: ['On_going_02_BKTR', 'On_going_01', 'On_going_02', 'Partially_shipped_03', 'Shipped_04', 'Completed_05', 'Cancelled_06'],
    channelTab: ['Mi2_OrderChannelOnline', 'Mi2_OrderChannelOffline', 'Mi2_OrderChannelEDI'],
    fileType: 'CSV', attribute: 'ORDERDATE', order: 'DESC'
  };
  const r = await fetch(WS + 'html/secure/myaccount/orderhistory/exportOrdersHistory', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/octet-stream' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Antalis svarede ' + r.status + ' på ordrehistorikken.');
  // Antalis keeps the shop session longer than the "Min konto" session; then the export redirects to the login page.
  if (r.redirected && /\/sso\/login/.test(r.url)) { const e = new Error('login'); e.login = true; throw e; }
  const text = new TextDecoder('utf-8').decode(await r.arrayBuffer());
  if (/^\s*</.test(text)) { const e = new Error('login'); e.login = true; throw e; }
  if (!text.trim()) throw new Error('Antalis sendte en tom ordrehistorik.');
  return text;
}

async function readCart() {
  const d = parseHtml(await (await fetch(WS + 'html/cart/cartSummary', { credentials: 'include' })).text());
  const cart = {};
  d.querySelectorAll('[id^="eshop-product-card_"]').forEach(c => {
    const code = (c.querySelector('[name$=".prodcode"]') || {}).value;
    const q = c.querySelector('[id^="product_quantity_"]'), s = c.querySelector('select[id^="product_unit_"]');
    if (code) cart[code] = { qty: q ? +q.value : 0, unit: s && s.selectedOptions[0] ? s.selectedOptions[0].text.trim() : '' };
  });
  return cart;
}

async function productUnits(code) {
  const d = parseHtml(await (await fetch(WS + 'html/catalog/resultPage?keyWord=' + encodeURIComponent(code), { credentials: 'include' })).text());
  const card = d.querySelector('[data-salesunits][productid="' + code + '"]');
  return card ? Object.values(JSON.parse(card.getAttribute('data-salesunits'))) : null;
}

function ui() {
  const host = document.createElement('div');
  host.id = 'renewtech-antalis';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial }
    [hidden] { display: none !important }
    .back { position: fixed; inset: 0; background: rgba(20, 22, 24, .45) }
    .win { position: fixed; top: 3vh; left: 50%; transform: translateX(-50%); width: min(1080px, 96vw); max-height: 94vh; display: flex; flex-direction: column; background: #fff; color: #1e2124; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.35); font: 14px/1.45 "Segoe UI", system-ui, sans-serif; overflow: hidden }
    header { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #e3e1da }
    header b { font-size: 17px } header small { color: #636a70; font-weight: 400; margin-left: 6px }
    .x { border: 0; background: none; font-size: 22px; cursor: pointer; color: #636a70; line-height: 1 }
    .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 18px; background: #f5f4f1; border-bottom: 1px solid #e3e1da }
    .msg { padding: 10px 18px; color: #636a70 }
    .msg.err { color: #b3261e; font-weight: 600 }
    .seg { display: inline-flex; border: 1px solid #d9d7d0; border-radius: 8px; overflow: hidden }
    .seg button { border: 0; background: #fff; padding: 6px 11px; cursor: pointer; font: inherit }
    .seg button[aria-pressed=true] { background: #1e2124; color: #fff }
    .scroll { overflow: auto; flex: 1 }
    table { border-collapse: collapse; width: 100% }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ecebe6; vertical-align: top }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #636a70; position: sticky; top: 0; background: #fff }
    td.code { font-family: Consolas, monospace; font-weight: 600; white-space: nowrap }
    td.code a { color: inherit }
    .why { display: block; color: #636a70; font-size: 12px; margin-top: 2px }
    .pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 99px; white-space: nowrap; margin: 0 4px 2px 0 }
    .now { background: #fbe3e1; color: #b3261e } .soon { background: #fbefd6; color: #8a5a00 } .ok { background: #e1f0e3; color: #2f6b3a }
    .info { background: #e1ebf6; color: #2d5b8a } .plain { background: #ecebe6; color: #636a70 } .uniq { background: #f1e6d7; color: #9a6a35 }
    .qty { white-space: nowrap; text-align: right }
    .qty input { width: 70px; font: 600 14px Consolas, monospace; padding: 5px 7px; border: 1px solid #d9d7d0; border-radius: 6px; text-align: right }
    .qty small { display: block; color: #636a70 }
    td.res { white-space: nowrap; font-weight: 600 }
    tr.off td:not(:first-child) { opacity: .5 }
    input[type=checkbox] { width: 18px; height: 18px; accent-color: #9a6a35 }
    footer { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 14px 18px; border-top: 1px solid #e3e1da; background: #f5f4f1 }
    .go { background: #9a6a35; color: #fff; border: 0; border-radius: 8px; padding: 12px 20px; font-family: inherit; font-size: 15px; font-weight: 600; cursor: pointer }
    .go[disabled] { opacity: .5; cursor: default }
    a.cart { color: #9a6a35; font-weight: 600 }
    label.all { display: inline-flex; gap: 6px; align-items: center; cursor: pointer }
    .spacer { flex: 1 }
    .next { padding: 10px 18px; background: #e1ebf6; color: #1e3a5a; border-bottom: 1px solid #c9d8ea }
    .next span { color: #2d5b8a }
    .long { padding: 10px 18px; background: #fbe3e1; color: #8c1d18; border-bottom: 1px solid #f1c4c0 }
    .year { padding: 6px 18px 14px } .year h4 { margin: 14px 0 4px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #636a70 }
    .year ul { margin: 0; padding-left: 18px } .year li { margin: 2px 0 } .year .late { color: #b3261e; font-weight: 600 }
    .stockp { padding: 10px 18px 14px } .stockp input { width: 70px; font: 600 14px Consolas, monospace; padding: 5px 7px; border: 1px solid #d9d7d0; border-radius: 6px; text-align: right }
    .stockp p { margin: 0 0 10px; color: #636a70 }
    .ordered { padding: 6px 18px 14px } .ordered h4 { margin: 14px 0 4px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #636a70 } .ordered ul { margin: 0; padding-left: 18px } .ordered .late { color: #b3261e; font-weight: 600 }
    .save { background: #1e2124; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; margin-top: 12px }
    .warn { padding: 10px 18px; background: #fbefd6; color: #8a5a00; border-bottom: 1px solid #ecdcb4 }
    .warn button { margin-left: 8px; border: 1px solid #8a5a00; background: #fff; color: #8a5a00; border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit }
  </style>
  <div class="back"></div>
  <div class="win" role="dialog" aria-label="Renewtech Antalis-bestilling">
    <header><div><b>Renewtech · Antalis-bestilling</b><small>v${APP_VERSION}</small></div><button class="x" title="Luk">×</button></header>
    <div class="bar" hidden>
      <span>Vis varer der skal bestilles inden for</span>
      <div class="seg"><button data-h="7" aria-pressed="true">7 dage</button><button data-h="14" aria-pressed="false">14 dage</button><button data-h="30" aria-pressed="false">30 dage</button></div>
      <label class="all"><input type="checkbox" class="showall"> Vis alle varer</label>
      <span class="spacer"></span>
      <div class="seg views"><button data-v="list" aria-pressed="true">Bestil nu</button><button data-v="year" aria-pressed="false">Årsplan</button><button data-v="ordered" aria-pressed="false">Bestilt</button><button data-v="stock" aria-pressed="false">Lager</button></div>
    </div>
    <div class="next" hidden></div>
    <div class="long" hidden></div>
    <div class="warn" hidden></div>
    <div class="msg">Starter…</div>
    <div class="scroll year" hidden></div>
    <div class="scroll stockp" hidden></div>
    <div class="scroll ordered" hidden></div>
    <div class="scroll main"><table hidden><thead><tr><th></th><th>Varenr.</th><th>Vare og udregning</th><th>Status</th><th>Bestil senest</th><th style="text-align:right">Antal</th><th>Kurv</th></tr></thead><tbody></tbody></table></div>
    <footer hidden><button class="go">Læg valgte i kurven</button><a class="cart" href="${CTX}/ws/html/cart/cartSummary">Gå til kurven</a><span class="sum"></span></footer>
  </div>`;
  document.body.appendChild(host);
  const $ = s => root.querySelector(s);
  const close = () => host.remove();
  $('.x').onclick = close; $('.back').onclick = close;
  return { root, $, msg: (t, err) => { const m = $('.msg'); m.hidden = !t; m.textContent = t || ''; m.className = 'msg' + (err ? ' err' : ''); } };
}

(async function main() {
  if (!/antalis\.dk$/.test(location.hostname)) { alert('Åbn antalis.dk, log ind, og tryk så på bogmærket igen.'); return; }
  document.getElementById('renewtech-antalis')?.remove();
  const U = ui(), $ = U.$;
  if (!document.querySelector('.header__login-name')) { U.msg('Du er ikke logget ind. Log ind på antalis.dk, og tryk på bogmærket igen.', true); return; }

  let items, cart, allRows = [], histAt = Date.now(), fromCache = false;
  const relogin = () => { location.href = CTX + '/ws/html/secure/myaccount/orderhistory/newOrderHistory'; };
  try {
    U.msg('Henter jeres ordrehistorik fra Antalis (12 måneder)…');
    let text;
    try {
      text = await fetchHistory(365);
      parseExport(text);
      LS.set(HIST_KEY, { at: histAt, csv: text });
    } catch (e) {
      // "Min konto" has logged out: fall back to the last history this browser fetched.
      const cached = LS.get(HIST_KEY);
      if (!e.login || !cached || !cached.csv) throw e;
      text = cached.csv; histAt = cached.at; fromCache = true;
    }
    const rows = parseExport(text);
    allRows = rows;
    // Items this tool put in the cart after the history was fetched count as ordered, so they are not suggested twice.
    const sent = LS.get(SENT_KEY) || {};
    for (const [code, s] of Object.entries(sent)) {
      if (s.at > histAt) rows.push({ order: 'Renewtech-kurv', date: Date.UTC(new Date(s.at).getFullYear(), new Date(s.at).getMonth(), new Date(s.at).getDate()), item: code, desc: s.desc || '', deliv: null, status: 'Lagt i kurven', qty: s.qty, unit: s.unit, sent: true });
    }
    items = buildItems(rows);
    for (const it of items) { const s = sent[it.code]; it.sentAfter = s && s.at > histAt ? s : null; }
    U.msg('Tjekker kurven…');
    cart = await readCart();
  } catch (e) {
    if (e.login) {
      U.msg('');
      const m = $('.msg'); m.hidden = false; m.className = 'msg err';
      m.innerHTML = 'Antalis vil have dig til at logge ind igen, før ordrehistorikken kan hentes. Sæt flueben i “Forbliv logget ind”. <br><br><button class="go relogin">Log ind igen</button> <span style="color:#636a70;font-weight:400">Tryk så på bogmærket igen bagefter. Herefter husker bogmærket ordrehistorikken, så du ikke skal logge ind hver gang.</span>';
      $('.relogin').onclick = relogin;
      return;
    }
    U.msg('Kunne ikke hente data: ' + e.message, true); return;
  }
  if (fromCache) {
    const w = $('.warn'); w.hidden = false;
    w.innerHTML = `Bygger på ordrehistorikken hentet <b>${fmtTime(histAt)}</b>, fordi “Min konto” har logget dig ud. Bestillinger lavet efter det uden om bogmærket kan mangle. Varer i kurven og varer bogmærket selv har lagt i kurven, er regnet med. <button class="relogin2">Log ind og hent ny</button>`;
    $('.relogin2').onclick = relogin;
  }

  let horizon = 7, showAll = false;
  const picks = new Map();
  const pickFor = it => {
    if (!picks.has(it.code)) picks.set(it.code, { on: !cart[it.code] && !it.inactive && !it.overbought && (it.orders >= 3 || it.counted || it.rateManual) && !(it.onTheWay && it.state !== 'now') && (it.plan.daysLeft <= horizon || (it.longLead && it.plan.daysLeft <= 14)), qty: it.plan.qty });
    return picks.get(it.code);
  };
  const statusPill = it => {
    const p = it.plan;
    if (it.inactive) return `<span class="pill plain">Ikke købt siden ${fmtDate(it.last.date)}</span>`;
    if (it.state === 'now') return `<span class="pill now">${p.daysLeft < 0 ? 'Bestil nu · ' + -p.daysLeft + ' dage over' : 'Bestil i dag'}</span>`;
    if (it.state === 'soon') return `<span class="pill soon">Bestil inden ${fmtDate(p.orderBy)}</span>`;
    return `<span class="pill ok">OK til ${fmtDate(p.orderBy)}</span>`;
  };
  const why = it => {
    const bw = BASE_WORD(it), week = (it.rateUsed || it.rate) * 7;
    const leadTxt = it.longLead ? `lev.tid op til ${it.plan.lead} d + ${it.plan.buffer} d buffer` : `lev.tid ${it.lead} d`;
    const trendTxt = it.trend && Math.abs(it.trend - 1) >= 0.03 ? ` (udvikling ${it.trend > 1 ? '+' : ''}${Math.round((it.trend - 1) * 100)} %/md)` : '';
    const useTxt = it.rateManual ? 'bruger (indtastet)' : it.overbought ? 'normalt forbrug ca.' : 'bruger ca.';
    const lastQty = it.last.base, f = it.factors[it.plan.unit] || 1;
    const s = (LS.get(STOCK_KEY) || {})[it.code];
    if (it.counted && s) return `Lager talt ${fmtDate(s.at)}: ${String(s.pallets).replace('.', ',')} paller (${fmtNum(s.pallets * s.per)} ${bw}) · nu ca. ${fmtNum(it.stockNow)} ${bw} · ${useTxt} ${week >= 10 ? fmtNum(week) : week.toFixed(1).replace('.', ',')} ${bw}/uge${trendTxt} · ${leadTxt} · løber tør ca. ${fmtDate(it.plan.runout)}`;
    return `${useTxt[0].toUpperCase() + useTxt.slice(1)} ${week >= 10 ? fmtNum(week) : week.toFixed(1).replace('.', ',')} ${bw}/uge${trendTxt} · sidst bestilt ${fmtDate(it.last.date)} (${fmtNum(lastQty)} ${bw}) · ${leadTxt} · løber tør ca. ${fmtDate(it.plan.runout)}` + (f > 1 ? '' : '');
  };

  const render = () => {
    plan(items, todayUTC, { horizon, stock: stockOpts(), rate: rateOpts(), closed: closedNow() });
    // Long lead time: always warn three weeks ahead, whatever the chosen period.
    const longDue = items.filter(it => it.plan && it.longLead && !it.inactive && !cart[it.code] && !it.sentAfter && it.plan.daysLeft <= LONG_WARN).sort((a, b) => a.plan.orderBy - b.plan.orderBy);
    $('.long').hidden = !longDue.length;
    $('.long').innerHTML = longDue.length ? '<b>Lang leveringstid · bestil i god tid:</b> ' + longDue.map(it => `${esc(it.code)} ${esc(it.title.split(',')[0].slice(0, 30))} (${it.plan.lead} d) ${it.plan.daysLeft <= 0 ? '<b>nu</b>' : 'senest <b>' + fmtDate(it.plan.orderBy) + '</b>'}`).join(' · ') : '';
    // When is the next order? Group items whose order-by dates fall within 3 days of the earliest.
    const due = items.filter(it => it.plan && !it.inactive && !cart[it.code] && !it.sentAfter && (it.orders >= 3 || it.counted || it.rateManual || it.longLead)).sort((a, b) => a.plan.orderBy - b.plan.orderBy);
    if (due.length) {
      const d0 = due[0].plan.orderBy, g1 = due.filter(it => it.plan.orderBy <= d0 + 3 * DAY);
      const rest = due.filter(it => it.plan.orderBy > d0 + 3 * DAY), d1 = rest.length ? rest[0].plan.orderBy : null, g2 = d1 ? rest.filter(it => it.plan.orderBy <= d1 + 3 * DAY) : [];
      const names = g => g.slice(0, 4).map(it => esc(it.code + ' ' + it.title.split(',')[0].slice(0, 28))).join(', ') + (g.length > 4 ? ` og ${g.length - 4} mere` : '');
      const when = t => t <= todayUTC ? '<b>nu</b>' : `senest <b>${fmtDate(t)}</b>`;
      $('.next').hidden = false;
      $('.next').innerHTML = `Næste bestilling: ${when(d0)} · ${names(g1)}` + (d1 ? `<br><span>Derefter: ${when(d1)} · ${names(g2)}</span>` : '');
    } else $('.next').hidden = true;
    $('.bar').hidden = false;
    $('.main').hidden = view !== 'list'; $('.year').hidden = view !== 'year'; $('.stockp').hidden = view !== 'stock'; $('.ordered').hidden = view !== 'ordered';
    if (view !== 'list') { $('footer').hidden = true; $('.msg').hidden = true; return view === 'year' ? renderYear() : view === 'ordered' ? renderOrdered() : renderStock(); }
    const list = items.filter(it => it.plan && (showAll || (!it.inactive && (it.plan.daysLeft <= horizon || (it.longLead && it.plan.daysLeft <= LONG_WARN))) || cart[it.code])).sort((a, b) => (a.inactive - b.inactive) || (a.plan.orderBy - b.plan.orderBy));
    $('.bar').hidden = false;
    $('.main table').hidden = !list.length;
    $('footer').hidden = !list.length;
    const next = items.filter(it => it.plan && !it.inactive && it.plan.daysLeft > horizon).sort((a, b) => a.plan.orderBy - b.plan.orderBy)[0];
    U.msg(list.length ? '' : `Intet skal bestilles inden for ${horizon} dage.` + (next ? ` Næste er ${next.code} (${next.title.slice(0, 40)}) senest ${fmtDate(next.plan.orderBy)}.` : ''));
    $('.main tbody').innerHTML = list.map(it => {
      const p = pickFor(it), f = it.factors[it.plan.unit] || 1, c = cart[it.code];
      const flags = [
        it.unique ? '<span class="pill uniq">Kundeunik</span>' : '',
        it.longLead ? `<span class="pill now">Lang leveringstid · ${it.plan.lead} d</span>` : '',
        it.overbought ? `<span class="pill soon" title="Købt ${fmtNum(it.overbought.recentBase)} ${BASE_WORD(it)} de sidste 60 dage mod normalt ca. ${fmtNum(it.overbought.normal)}">Købt meget for nylig · tæl lageret</span>` : '',
        it.plan.holiday ? `<span class="pill soon">Bestil før ${esc(it.plan.holiday)}</span>` : '',
        it.sentAfter ? `<span class="pill info">Lagt i kurven af bogmærket ${fmtTime(it.sentAfter.at)} · regnet som bestilt</span>` : '',
        it.onTheWay ? `<span class="pill info">På vej · lev. ${fmtDate(it.onTheWay)}</span>` : '',
        it.plan.lowData ? `<span class="pill plain">Kun ${it.orders} køb</span>` : '',
        it.assumed.length ? '<span class="pill plain">Omregning anslået</span>' : ''
      ].join('');
      return `<tr data-code="${esc(it.code)}" class="${p.on ? '' : 'off'}">
        <td><input type="checkbox" ${p.on ? 'checked' : ''} ${c ? 'disabled title="Ligger allerede i kurven"' : ''}></td>
        <td class="code"><a href="${WS}html/catalog/resultPage?keyWord=${esc(it.code)}" target="_blank">${esc(it.code)}</a></td>
        <td>${esc(it.title.slice(0, 90))}<span class="why">${why(it)}</span>${flags}</td>
        <td>${statusPill(it)}</td>
        <td style="white-space:nowrap">${fmtDate(it.plan.orderBy)}</td>
        <td class="qty"><input type="number" min="0" value="${p.qty}"> ${esc(unitDa(it.plan.unit, p.qty))}${f > 1 ? `<small>= ${fmtNum(p.qty * f)} ${BASE_WORD(it)}</small>` : ''}</td>
        <td class="res">${c ? `<span style="color:#2d5b8a">I kurven: ${c.qty} ${esc(UNIT_DA[c.unit] ? unitDa(c.unit, c.qty) : c.unit)}</span>` : ''}</td></tr>`;
    }).join('');
    updateSum();
  };
  const chosen = () => items.filter(it => it.plan && picks.get(it.code)?.on && picks.get(it.code).qty > 0 && !cart[it.code]);
  const updateSum = () => { const n = chosen().length; $('.sum').textContent = n ? n + ' varer valgt' : 'Ingen varer valgt'; $('.go').disabled = !n; };

  $('.main tbody').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-code]'); if (!tr) return;
    const p = picks.get(tr.dataset.code);
    if (e.target.type === 'checkbox') { p.on = e.target.checked; tr.classList.toggle('off', !p.on); }
    if (e.target.type === 'number') p.qty = Math.max(0, Math.round(+e.target.value || 0));
    updateSum();
  });
  U.root.querySelectorAll('[data-h]').forEach(b => b.onclick = () => {
    horizon = +b.dataset.h; U.root.querySelectorAll('[data-h]').forEach(x => x.setAttribute('aria-pressed', x === b));
    picks.clear(); render();
  });
  $('.showall').onchange = e => { showAll = e.target.checked; render(); };

  let view = 'list';
  const setView = v => { view = v; U.root.querySelectorAll('[data-v]').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === v)); render(); };
  U.root.querySelectorAll('[data-v]').forEach(b => b.onclick = () => setView(b.dataset.v));

  // Year view: expected orders over the next 12 months, grouped by month.
  function renderYear() {
    const ev = [];
    for (const it of items) for (const o of yearPlan(it, todayUTC)) ev.push(Object.assign({ it }, o));
    ev.sort((a, b) => a.at - b.at);
    const byMonth = new Map();
    for (const e of ev) { const d = new Date(e.at), k = d.getUTCFullYear() * 12 + d.getUTCMonth(); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(e); }
    const month = k => new Date(Date.UTC(Math.floor(k / 12), k % 12, 1)).toLocaleDateString('da-DK', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    // Holidays are worked out automatically every year: Christmas, summer weeks 29-31 and the Danish public holidays.
    const periods = closedNow().filter(c => c.to >= todayUTC && !c.day).map(c => `${c.name} ${fmtDate(c.from)} – ${fmtDate(c.to)} ${new Date(c.to).getUTCFullYear()}`).join(' · ');
    const ferieHtml = `<div class="ferie" style="margin:10px 0;padding:10px 12px;border:1px solid #ecdcb4;background:#fbf6ea;border-radius:8px">
      <b>Ferie og helligdage er regnet med automatisk:</b> ${esc(periods)} · plus helligdage (nytår, påske, Kristi himmelfart, pinse, grundlovsdag).<br>
      <span style="color:#636a70">Leveringstid tælles kun i åbne dage. Bestillinger der ellers ville ramme en lukning, flyttes frem og mærkes “før jul” / “før sommerferien”. Datoerne følger kalenderen år for år, så der skal ikke indstilles noget.</span></div>`;
    $('.year').innerHTML = ferieHtml + (!ev.length ? '<p>Ingen varer med nok køb til en årsplan.</p>'
      : '<p style="color:#636a70;margin:8px 0">Forventede bestillinger de næste 12 måneder med det typiske antal. Datoerne flytter sig, når I bestiller, eller når forbruget ændrer sig. Indtast lager under “Lager” for jeres egne kasser.</p>')
      + (!ev.length ? '' : '')
      + [...byMonth].map(([k, list]) => {
        const per = new Map();
        for (const e of list) { if (!per.has(e.it.code)) per.set(e.it.code, []); per.get(e.it.code).push(e); }
        const rows = [...per.values()].sort((a, b) => a[0].at - b[0].at).map(es => {
          const e = es[0], it = e.it, late = es.some(x => x.late);
          const days = es.map(x => x.late ? 'nu' : new Date(x.at).getUTCDate() + '.').join(', ');
          const sameQty = es.every(x => x.qty === e.qty), hol = es.find(x => x.holiday);
          const qtyTxt = sameQty ? `${es.length > 1 ? es.length + ' × ' : ''}${e.qty} ${esc(unitDa(e.unit, e.qty))}` : es.map(x => x.qty).join(' + ') + ' ' + esc(unitDa(e.unit, 2));
          return `<li class="${late ? 'late' : ''}"><b>${qtyTxt}</b> · ${esc(it.code)} ${esc(it.title.slice(0, 60))} <span style="color:#636a70">(${days})</span>${hol ? ` <span class="pill soon">før ${esc(hol.holiday)}</span>` : ''}${it.plan.lowData ? ' <span class="pill plain">få køb</span>' : ''}${it.counted ? ' <span class="pill info">lager talt</span>' : ''}${it.unique ? ' <span class="pill uniq">kundeunik</span>' : ''}</li>`;
        }).join('');
        return `<h4>${month(k)} · ${list.length} bestillinger af ${per.size} varer</h4><ul>${rows}</ul>`;
      }).join('');
  }


  // Ordered view: the cart now, what is on its way from Antalis, and what was ordered in the last 14 days.
  function renderOrdered() {
    const name = code => { const it = items.find(i => i.code === code); return it ? it.title.slice(0, 70) : ''; };
    const qtyTxt = (q, u) => `${fmtNum(q)} ${esc(UNIT_DA[u] ? unitDa(u, q) : u)}`;
    const real = allRows.filter(r => !r.sent);
    const openAll = real.filter(r => r.status && r.status !== 'Faktureret');
    const stale = openAll.filter(r => r.deliv && r.deliv < todayUTC - 14 * DAY);
    const open = openAll.filter(r => !stale.includes(r));
    const recent = real.filter(r => r.status === 'Faktureret' && r.date >= todayUTC - 14 * DAY);
    const byOrder = rows => {
      const m = new Map();
      for (const r of rows) { if (!m.has(r.order)) m.set(r.order, []); m.get(r.order).push(r); }
      return [...m.values()];
    };
    const orderHtml = (lines, showDeliv) => {
      const o = lines[0];
      const head = `<b>#${esc(o.order)}</b> · bestilt ${fmtDate(o.date)}${o.ref ? ' · ref. ' + esc(o.ref) : ''}${o.user ? ' · ' + esc(o.user) : ''}`;
      const li = lines.map(r => {
        const late = showDeliv && r.deliv && r.deliv < todayUTC;
        const when = !showDeliv ? (r.deliv ? 'leveret ' + fmtDate(r.deliv) : '') : r.deliv ? (late ? `<span class="late">forventet ${fmtDate(r.deliv)} (overskredet)</span>` : `forventet <b>${fmtDate(r.deliv)}</b> (om ${Math.max(0, Math.round((r.deliv - todayUTC) / DAY))} d)`) : 'leveringsdato ikke oplyst';
        return `<li><b>${qtyTxt(r.qty, r.unit)}</b> · ${esc(r.item)} ${esc(name(r.item))} · <span style="color:#636a70">${esc(r.status)}</span> · ${when}</li>`;
      }).join('');
      return `<div style="margin:8px 0">${head}<ul>${li}</ul></div>`;
    };
    const cartList = Object.entries(cart);
    const openOrders = byOrder(open).sort((a, b) => Math.min(...a.map(r => r.deliv || Infinity)) - Math.min(...b.map(r => r.deliv || Infinity)));
    const recentOrders = byOrder(recent).sort((a, b) => b[0].date - a[0].date);
    $('.ordered').innerHTML = `
      <h4>I kurven nu · ${cartList.length} varer</h4>
      ${cartList.length ? '<ul>' + cartList.map(([code, c]) => { const it = items.find(i => i.code === code); return `<li><b>${qtyTxt(c.qty, c.unit)}</b> · ${esc(code)} ${esc(name(code))}${it && it.overbought ? ' <span class="pill soon">Købt meget for nylig: overvej at fjerne den fra kurven, eller tæl lageret først</span>' : ''}</li>`; }).join('') + `</ul><p style="color:#636a70;margin:4px 0 0">Ikke bestilt endnu. <a class="cart" href="${CTX}/ws/html/cart/cartSummary">Gå til kurven</a> for at bestille.</p>` : '<p style="color:#636a70">Kurven er tom.</p>'}
      <h4>På vej fra Antalis · ${open.length} linjer i ${openOrders.length} ordrer</h4>
      ${openOrders.length ? openOrders.map(l => orderHtml(l, true)).join('') : '<p style="color:#636a70">Intet på vej.</p>'}
      ${stale.length ? `<details style="margin:8px 0"><summary style="cursor:pointer;color:#636a70">${stale.length} gamle linjer står stadig som “${esc(stale[0].status)}” hos Antalis, men leveringsdatoen er mere end 14 dage gammel. De regnes som leveret.</summary>${byOrder(stale).map(l => orderHtml(l, false)).join('')}</details>` : ''}
      ${(() => {
        const ob = items.filter(it => it.overbought).sort((a, b) => b.overbought.x - a.overbought.x);
        if (!ob.length) return '';
        return `<h4>Købt mere end normalt · ${ob.length} varer (sidste 60 dage)</h4>
          <p style="color:#636a70;margin:0 0 4px">Planen regner med jeres normale forbrug fra før for disse varer, og foreslår dem ikke, før det ekstra er brugt. Tæl lageret under “Lager”, hvis I vil have det helt præcist.</p>
          <ul>${ob.map(it => `<li><b>${it.overbought.x.toFixed(1).replace('.', ',')} ×</b> normalt · ${esc(it.code)} ${esc(it.title.slice(0, 60))}: ${fmtNum(it.overbought.recentBase)} ${BASE_WORD(it)} mod normalt ca. ${fmtNum(it.overbought.normal)}${cart[it.code] ? ' <span class="pill soon">ligger også i kurven</span>' : ''}</li>`).join('')}</ul>`;
      })()}
      <h4>Leveret de sidste 14 dage · ${recentOrders.length} ordrer</h4>
      ${recentOrders.length ? recentOrders.map(l => orderHtml(l, false)).join('') : '<p style="color:#636a70">Ingen.</p>'}
      <p style="color:#636a70;margin-top:12px">Bygger på ordrehistorikken hentet ${fmtTime(histAt)}${fromCache ? ' (gemt kopi, fordi “Min konto” har logget dig ud)' : ''}.</p>`;
  }

  // Stock view: pallets on the shelf for your own boxes; the plan then counts from this instead of guessing.
  // Renewtech's own boxes: 250 per pallet (confirmed 01-10-2026). Other items: Antalis' pallet size when known.
  const defPer = it => (it.unique || !it.desc) ? 250 : (!it.assumed.includes('Pallet(s)') && it.factors['Pallet(s)']) || Math.round(it.typicalBase) || 250;
  function renderStock() {
    const s = LS.get(STOCK_KEY) || {};
    const list = items.filter(it => it.unique || !it.desc || s[it.code] || it.plan || it.overbought).sort((a, b) => ((b.unique || !b.desc) - (a.unique || !a.desc)) || (!!b.overbought - !!a.overbought) || (a.title || '').localeCompare(b.title || '', 'da'));
    $('.stockp').innerHTML = `<input class="q" type="search" placeholder="Søg varenr. eller navn" style="width:260px;text-align:left;margin-bottom:8px"><p>Skriv hvor mange paller der står på lageret nu. Planen regner så fra jeres optælling i stedet for at gætte, og trækker forbruget fra dag for dag. Ret “Stk pr. palle”, hvis tallet ikke passer. Hvert tal gemmes med det samme i denne browser.</p>
      <table><thead><tr><th>Varenr.</th><th>Vare</th><th style="text-align:right">Paller nu</th><th style="text-align:right">Stk pr. palle</th><th style="text-align:right">Forbrug stk/uge</th><th>Sidst talt</th></tr></thead><tbody>${list.map(it => {
        const v = s[it.code] || {};
        return `<tr data-code="${esc(it.code)}"><td class="code">${esc(it.code)}</td><td>${esc(it.title.slice(0, 70))}${it.orders < 2 ? '<span class="why">Kun købt én gang i perioden: forbruget kan ikke regnes endnu</span>' : ''}</td>
          <td class="qty"><input class="pal" type="number" min="0" step="0.5" value="${v.pallets ?? ''}"></td>
          <td class="qty"><input class="per" type="number" min="1" value="${v.per || defPer(it)}"></td>
          <td class="qty"><input class="pw" type="number" min="0" step="1" value="${v.perWeek || ''}" placeholder="${it.rate > 0 ? Math.round(it.rate * 7) : '?'}" title="Lad stå tomt for at bruge planens eget tal (grå)"></td>
          <td>${v.at ? fmtDate(v.at) : ''}</td></tr>`;
      }).join('')}</tbody></table><div style="display:flex;gap:12px;align-items:center"><button class="save">Færdig · vis planen</button><span class="saved" style="color:#2f6b3a;font-weight:600"></span></div>`;
    // Every field saves the moment it changes, so nothing is lost if the window is closed.
    const saveRow = tr => {
      const s2 = LS.get(STOCK_KEY) || {};
      const code = tr.dataset.code, palRaw = tr.querySelector('.pal').value, per = +tr.querySelector('.per').value, pw = +tr.querySelector('.pw').value || 0;
      const old = s2[code];
      if (palRaw === '' && !pw) delete s2[code];
      else {
        const pallets = +String(palRaw).replace(',', '.');
        s2[code] = palRaw === '' ? { perWeek: pw, at: Date.now() } : { pallets, per: per > 0 ? per : 250, perWeek: pw, at: old && old.pallets === pallets && old.per === per ? old.at : Date.now() };
      }
      const ok = LS.set(STOCK_KEY, s2);
      const msg = $('.stockp .saved');
      msg.style.color = ok ? '#2f6b3a' : '#b3261e';
      msg.textContent = ok ? `Gemt ✓ ${code}` : 'Kunne ikke gemme i browseren. Tjek at antalis.dk må gemme data (cookies og webstedsdata).';
      const last = tr.querySelector('td:last-child'); if (ok && s2[code]) last.textContent = fmtDate(s2[code].at);
    };
    $('.stockp .q').addEventListener('input', ev => { const q = ev.target.value.trim().toLowerCase(); $('.stockp').querySelectorAll('tr[data-code]').forEach(tr => { tr.hidden = !!q && !tr.textContent.toLowerCase().includes(q) && !tr.dataset.code.includes(q); }); });
    $('.stockp').querySelectorAll('tr[data-code] input').forEach(inp => { inp.addEventListener('change', () => saveRow(inp.closest('tr'))); inp.addEventListener('input', () => saveRow(inp.closest('tr'))); });
    $('.stockp .save').onclick = () => { $('.stockp').querySelectorAll('tr[data-code]').forEach(saveRow); picks.clear(); setView('list'); };
  }

  $('.go').onclick = async () => {
    const todo = chosen(); if (!todo.length) return;
    $('.go').disabled = true;
    cart = await readCart();
    const res = it => $(`.main tr[data-code="${CSS.escape(it.code)}"] td.res`);
    for (const it of todo) {
      const cell = res(it);
      if (cart[it.code]) { cell.innerHTML = '<span style="color:#2d5b8a">Lå allerede i kurven</span>'; continue; }
      cell.textContent = 'Lægger i kurven…';
      const p = picks.get(it.code), need = Math.round(p.qty * (it.factors[it.plan.unit] || 1));
      try {
        const units = await productUnits(it.code);
        const body = { prodcode: it.code, defaultQty: p.qty };
        if (units) {
          let u = units.find(x => x.desc === it.plan.unit), q = p.qty;
          if (!u) { u = units.filter(x => x.baseUnitQty <= need).sort((a, b) => b.baseUnitQty - a.baseUnitQty)[0] || units.sort((a, b) => a.baseUnitQty - b.baseUnitQty)[0]; q = Math.ceil(need / u.baseUnitQty); }
          const step = parseFloat(u.step) || 1;
          body.defaultQty = Math.max(parseFloat(u.minOrderQty) || 1, Math.ceil(q / step - 1e-9) * step);
          body.units = { defaultUnit: u.id };
        }
        const r = await fetch(WS + 'catalog/addToCart/addToCart?hasSelectedProducts=false', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify([body]) });
        cell.textContent = r.ok ? 'Sendt…' : 'Fejl ' + r.status;
      } catch (e) { cell.textContent = 'Fejl: ' + e.message; }
      await sleep(400);
    }
    cart = await readCart();
    let ok = 0;
    for (const it of todo) {
      const c = cart[it.code], cell = res(it);
      if (c) {
        ok++; cell.innerHTML = `<span style="color:#2f6b3a">✓ I kurven: ${c.qty} ${esc(UNIT_DA[c.unit] ? unitDa(c.unit, c.qty) : c.unit)}</span>`;
        const sent = LS.get(SENT_KEY) || {}, p = picks.get(it.code);
        sent[it.code] = { at: Date.now(), qty: p.qty, unit: it.plan.unit, desc: it.desc };
        for (const k of Object.keys(sent)) if (Date.now() - sent[k].at > 90 * DAY) delete sent[k];
        LS.set(SENT_KEY, sent);
      }
      else cell.innerHTML = '<span style="color:#b3261e">✗ Kom ikke i kurven</span>';
      const box = $(`.main tr[data-code="${CSS.escape(it.code)}"] input[type=checkbox]`); if (box) { box.checked = false; box.disabled = true; }
      picks.get(it.code).on = false;
    }
    updateSum();
    $('.sum').innerHTML = `<b>${ok} af ${todo.length} varer ligger i kurven.</b> Gå til kurven for at sætte ordrereference og bestille.`;
  };

  render();
})();
