/* Renewtech Antalis-bestilling. Kører på antalis.dk via bogmærke. Ingen data sendes andre steder hen. */
(function () {
"use strict";
// Antalis order-history engine: parse export, normalise units, forecast next order.
const DAY = 86400000;
const UNIT_DA = { 'Unit(s)': 'stk', 'Bundle(s)': 'bundt', 'Pallet(s)': 'palle', 'Carton(s)': 'kasse', 'Pack(s)': 'pakke', 'Reel(s)': 'rulle', 'Box(es)': 'æske', 'Set(s)': 'sæt' };
// Sales units read from antalis.dk product pages on 2026-10-01 (desc -> base units per sales unit).
const LIVE_UNITS = {
  '552762': { 'Unit(s)': 1, 'Pack(s)': 10, 'Pallet(s)': 1560 },
  '573305': { 'Unit(s)': 1, 'Pallet(s)': 24 },
  '575340': { 'Carton(s)': 1000, 'Pallet(s)': 96000, 'Unit(s)': 1 },
  '575346': { 'Carton(s)': 1000, 'Pallet(s)': 72000, 'Unit(s)': 1 },
  '588220': { 'Pack(s)': 3, 'Reel(s)': 1 },
  '693886': { 'Unit(s)': 1, 'Pallet(s)': 300, 'Bundle(s)': 25 },
  '694014': { 'Unit(s)': 1, 'Pallet(s)': 135, 'Bundle(s)': 15 },
  '694211': { 'Unit(s)': 1, 'Carton(s)': 100 }
};

function parseDate(s) {
  s = (s || '').trim();
  if (!s) return null;
  s = s.split(/\s+/).pop().replace(/\//g, '-');
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
}
function parseNum(s) { return parseFloat(String(s || '').replace(/[\s ]/g, '').replace(/\./g, '').replace(',', '.')); }

function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ';') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}

function parseExport(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.length);
  const head = splitCsvLine(lines[0]).map(h => h.trim());
  const col = name => head.indexOf(name);
  const C = { no: col('Ordrenummer'), date: col('Ordredato'), status: col('Status'), item: col('Varenummer'), desc: col('Beskrivelse'), deliv: col('Leveringsdato'), qty: col('Antal'), unit: col('Enhed') };
  if (C.no < 0 || C.item < 0 || C.qty < 0) throw new Error('Filen ligner ikke en ordrehistorik fra Antalis. Den skal have kolonnerne Ordrenummer, Varenummer og Antal.');
  const rows = []; let order = null;
  for (const l of lines.slice(1)) {
    const r = splitCsvLine(l);
    if ((r[C.no] || '').trim()) { order = { no: r[C.no].trim(), date: parseDate(r[C.date]) }; continue; }
    const item = (r[C.item] || '').trim();
    if (!order || !item || item === 'DEFAULT') continue;
    rows.push({ order: order.no, date: order.date, item, desc: (r[C.desc] || '').trim(), deliv: parseDate(r[C.deliv]), status: (r[C.status] || '').trim(), qty: parseNum(r[C.qty]), unit: (r[C.unit] || '').trim() });
  }
  return rows;
}

function descFactors(desc) {
  const d = desc.toLowerCase(), f = {};
  const grab = (re, unit) => { const m = d.match(re); if (m) { const n = parseNum(m[1]); if (n > 0 && !f[unit]) f[unit] = n; } };
  grab(/bundt a ([\d.\s]+)/, 'Bundle(s)');
  grab(/palle a ([\d.\s]+)/, 'Pallet(s)');
  grab(/(?:kasse|karton) a ([\d.\s]+)/, 'Carton(s)');
  grab(/(?:pakke|pose|batch) (?:a|med) ([\d.\s]+)/, 'Pack(s)');
  return f;
}
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function buildItems(rows) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.item)) by.set(r.item, []); by.get(r.item).push(r); }
  const items = [];
  for (const [code, lines] of by) {
    lines.sort((a, b) => a.date - b.date);
    const last = lines[lines.length - 1];
    const desc = lines.map(l => l.desc).filter(Boolean).pop() || '';
    const factors = { 'Unit(s)': 1, 'Reel(s)': 1, ...descFactors(desc), ...(LIVE_UNITS[code] || {}) };
    const assumed = [];
    if (!factors['Box(es)'] && factors['Carton(s)'] && lines.some(l => l.unit === 'Box(es)')) { factors['Box(es)'] = factors['Carton(s)']; assumed.push('Box(es)'); }
    const units = [...new Set(lines.map(l => l.unit))];
    // A unit with no known size: infer it from how much was usually bought in units we do know.
    for (const u of units) {
      if (factors[u]) continue;
      const known = lines.filter(l => factors[l.unit]).map(l => l.qty * factors[l.unit]);
      const these = lines.filter(l => l.unit === u).map(l => l.qty);
      factors[u] = known.length ? Math.max(1, Math.round(median(known) / median(these))) : 1;
      if (known.length) assumed.push(u);
    }
    // One event per order date (same-day lines are summed).
    const ev = new Map();
    for (const l of lines) {
      const e = ev.get(l.date) || { date: l.date, base: 0, deliv: null, open: false };
      e.base += l.qty * factors[l.unit];
      if (l.deliv && (!e.deliv || l.deliv > e.deliv)) e.deliv = l.deliv;
      if (l.status && l.status !== 'Faktureret') e.open = true;
      ev.set(l.date, e);
    }
    const events = [...ev.values()].sort((a, b) => a.date - b.date);
    const leads = lines.filter(l => l.deliv).map(l => Math.max(0, Math.round((l.deliv - l.date) / DAY)));
    const lead = leads.length ? Math.round(median(leads)) : 2;
    const usage = [];
    for (let i = 0; i < events.length - 1; i++) {
      const days = (events[i + 1].date - events[i].date) / DAY;
      if (days > 0) usage.push(events[i].base / days);
    }
    const rate = usage.length ? median(usage) : NaN;
    const intervals = events.slice(1).map((e, i) => (e.date - events[i].date) / DAY);
    const typicalBase = median(events.slice(-4).map(e => e.base));
    const orderUnit = last.unit;
    items.push({
      code, desc, category: desc.split(',')[0] || '(ingen beskrivelse)',
      title: desc.split(',').slice(1).join(',').trim() || desc || '(ingen beskrivelse i eksporten)',
      unique: /kundeunikke/i.test(desc), lines, events, factors, assumed, lead, rate,
      every: intervals.length ? Math.round(median(intervals)) : null,
      orders: events.length, typicalBase, orderUnit, last: events[events.length - 1]
    });
  }
  return items;
}

function prevWeekday(t) { let d = new Date(t); while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d - DAY); return +d; }

function plan(items, today, opts = {}) {
  const buffer = opts.buffer ?? 3, horizon = opts.horizon ?? 7;
  for (const it of items) {
    it.plan = null;
    if (it.orders < 2 || !(it.rate > 0)) { it.state = 'single'; continue; }
    // Simulate stock: each order arrives on its delivery date, usage runs at a constant rate.
    let stock = 0, t = null;
    for (const e of [...it.events].map(e => ({ at: e.deliv || e.date + it.lead * DAY, base: e.base })).sort((a, b) => a.at - b.at)) {
      if (t !== null) stock = Math.max(0, stock - it.rate * (e.at - t) / DAY);
      stock += e.base; t = e.at;
    }
    const runout = t + (stock / it.rate) * DAY;
    const orderBy = prevWeekday(runout - (it.lead + buffer) * DAY);
    const f = it.factors[it.orderUnit] || 1;
    const qty = Math.max(1, Math.ceil(it.typicalBase / f - 1e-9));
    const daysLeft = Math.round((orderBy - today) / DAY);
    it.state = daysLeft <= 0 ? 'now' : daysLeft <= horizon ? 'soon' : 'ok';
    const open = it.events.filter(e => e.open && e.deliv && e.deliv >= today);
    it.onTheWay = open.length ? Math.max(...open.map(e => e.deliv)) : null;
    it.plan = { runout, orderBy, daysLeft, qty, unit: it.orderUnit, base: qty * f, lowData: it.orders < 3 };
  }
  return items;
}



// Renewtech Antalis-bestilling: runs on antalis.dk when the bookmark is clicked.
// Reads the live order history, works out what to order and when, and fills the cart.
const APP_VERSION = '1.0';
const CTX = (typeof window.context === 'string' ? window.context : '/eshop');
const WS = CTX + '/ws/';
const BASE_WORD = it => /ruller/i.test(it.desc) ? 'ruller' : /\bark\b/i.test(it.desc) ? 'ark' : 'stk';
const DA_PLURAL = { stk: 'stk', bundt: 'bundter', palle: 'paller', kasse: 'kasser', pakke: 'pakker', rulle: 'ruller', æske: 'æsker', sæt: 'sæt' };
const unitDa = (u, n) => { const d = UNIT_DA[u] || u; return n === 1 ? d : (DA_PLURAL[d] || d); };
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
  const text = new TextDecoder('utf-8').decode(await r.arrayBuffer());
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
  </style>
  <div class="back"></div>
  <div class="win" role="dialog" aria-label="Renewtech Antalis-bestilling">
    <header><div><b>Renewtech · Antalis-bestilling</b><small>v${APP_VERSION}</small></div><button class="x" title="Luk">×</button></header>
    <div class="bar" hidden>
      <span>Vis varer der skal bestilles inden for</span>
      <div class="seg"><button data-h="7" aria-pressed="true">7 dage</button><button data-h="14" aria-pressed="false">14 dage</button><button data-h="30" aria-pressed="false">30 dage</button></div>
      <label class="all"><input type="checkbox" class="showall"> Vis alle varer</label>
    </div>
    <div class="msg">Starter…</div>
    <div class="scroll"><table hidden><thead><tr><th></th><th>Varenr.</th><th>Vare og udregning</th><th>Status</th><th>Bestil senest</th><th style="text-align:right">Antal</th><th>Kurv</th></tr></thead><tbody></tbody></table></div>
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

  let items, cart;
  try {
    U.msg('Henter jeres ordrehistorik fra Antalis (12 måneder)…');
    const rows = parseExport(await fetchHistory(365));
    items = buildItems(rows);
    U.msg('Tjekker kurven…');
    cart = await readCart();
  } catch (e) { U.msg('Kunne ikke hente data: ' + e.message, true); return; }

  let horizon = 7, showAll = false;
  const picks = new Map();
  const pickFor = it => {
    if (!picks.has(it.code)) picks.set(it.code, { on: !cart[it.code] && it.orders >= 3 && !(it.onTheWay && it.state !== 'now') && it.plan.daysLeft <= horizon, qty: it.plan.qty });
    return picks.get(it.code);
  };
  const statusPill = it => {
    const p = it.plan;
    if (it.state === 'now') return `<span class="pill now">${p.daysLeft < 0 ? 'Bestil nu · ' + -p.daysLeft + ' dage over' : 'Bestil i dag'}</span>`;
    if (it.state === 'soon') return `<span class="pill soon">Bestil inden ${fmtDate(p.orderBy)}</span>`;
    return `<span class="pill ok">OK til ${fmtDate(p.orderBy)}</span>`;
  };
  const why = it => {
    const bw = BASE_WORD(it), week = it.rate * 7;
    const lastQty = it.last.base, f = it.factors[it.plan.unit] || 1;
    return `Bruger ca. ${week >= 10 ? fmtNum(week) : week.toFixed(1).replace('.', ',')} ${bw}/uge · sidst bestilt ${fmtDate(it.last.date)} (${fmtNum(lastQty)} ${bw}) · lev.tid ${it.lead} d · løber tør ca. ${fmtDate(it.plan.runout)}` + (f > 1 ? '' : '');
  };

  const render = () => {
    plan(items, todayUTC, { horizon });
    const list = items.filter(it => it.plan && (showAll || it.plan.daysLeft <= horizon || cart[it.code])).sort((a, b) => a.plan.orderBy - b.plan.orderBy);
    $('.bar').hidden = false;
    $('table').hidden = !list.length;
    $('footer').hidden = !list.length;
    U.msg(list.length ? '' : `Intet skal bestilles inden for ${horizon} dage.`);
    $('tbody').innerHTML = list.map(it => {
      const p = pickFor(it), f = it.factors[it.plan.unit] || 1, c = cart[it.code];
      const flags = [
        it.unique ? '<span class="pill uniq">Kundeunik</span>' : '',
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

  $('tbody').addEventListener('change', e => {
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

  $('.go').onclick = async () => {
    const todo = chosen(); if (!todo.length) return;
    $('.go').disabled = true;
    cart = await readCart();
    const res = it => $(`tr[data-code="${CSS.escape(it.code)}"] td.res`);
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
      if (c) { ok++; cell.innerHTML = `<span style="color:#2f6b3a">✓ I kurven: ${c.qty} ${esc(UNIT_DA[c.unit] ? unitDa(c.unit, c.qty) : c.unit)}</span>`; }
      else cell.innerHTML = '<span style="color:#b3261e">✗ Kom ikke i kurven</span>';
      const box = $(`tr[data-code="${CSS.escape(it.code)}"] input[type=checkbox]`); if (box) { box.checked = false; box.disabled = true; }
      picks.get(it.code).on = false;
    }
    updateSum();
    $('.sum').innerHTML = `<b>${ok} af ${todo.length} varer ligger i kurven.</b> Gå til kurven for at sætte ordrereference og bestille.`;
  };

  render();
})();

})();
