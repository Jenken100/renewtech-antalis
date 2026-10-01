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
  s = s.split(/\s+/).filter(x => /\d/.test(x)).pop() || '';
  s = s.replace(/[/.]/g, '-');
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
}
function parseNum(s) { return parseFloat(String(s || '').replace(/[\s ]/g, '').replace(/\./g, '').replace(',', '.')); }

function splitCsvLine(line, sep = ';') {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}

// Column names as Antalis writes them, in Danish and English.
const COLS = {
  no: ['ordrenummer', 'ordernumber', 'ordernr', 'ordreno'],
  date: ['ordredato', 'orderdate'],
  status: ['status', 'linestatus'],
  item: ['varenummer', 'itemnumber', 'productcode', 'articlenumber', 'itemcode', 'sku'],
  desc: ['beskrivelse', 'description'],
  deliv: ['leveringsdato', 'deliverydate'],
  qty: ['antal', 'quantity', 'qty'],
  unit: ['enhed', 'unit']
};

function parseExport(text) {
  text = String(text || '').replace(/^﻿/, '');
  if (/^\s*</.test(text)) throw new Error('Antalis sendte en webside i stedet for ordrehistorikken. Log ud og ind igen på antalis.dk, og prøv igen.');
  let lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) throw new Error('Ordrehistorikken er tom.');
  const h = lines.slice(0, 10).findIndex(l => /ordre\s*nummer|order\s*(number|no)/i.test(l));
  if (h > 0) lines = lines.slice(h);
  const first = lines[0];
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[^a-zæøå0-9]/g, '');
  const head = splitCsvLine(first, sep).map(norm);
  const col = key => { for (const n of COLS[key]) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const C = {}; for (const k of Object.keys(COLS)) C[k] = col(k);
  if (C.no < 0 || C.item < 0 || C.qty < 0) {
    const peek = first.slice(0, 160).replace(/\s+/g, ' ');
    throw new Error('Ordrehistorikken kunne ikke læses (kolonnerne Ordrenummer, Varenummer og Antal blev ikke fundet). Filen starter med: “' + peek + '”');
  }
  const rows = []; let order = null;
  for (const l of lines.slice(1)) {
    const r = splitCsvLine(l, sep);
    const item = (r[C.item] || '').trim();
    // Antalis writes an order header row, then one row per line. Some exports repeat the order number on every row.
    if ((r[C.no] || '').trim()) { order = { no: r[C.no].trim(), date: parseDate(r[C.date]) || (order && order.date) }; if (!item) continue; }
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
    // Long lead times vary a lot (705389: 29 and 47 days), so plan with the slowest of the last three deliveries.
    const leadSafe = lead >= 14 ? Math.max(lead, ...leads.slice(-3)) : lead;
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
      unique: /kundeunikke/i.test(desc), lines, events, factors, assumed, lead, leadSafe, longLead: leadSafe >= 14, rate,
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
    // A usage typed in by hand (opts.rate[code], per day) beats the estimate, and lets an item bought only once be planned.
    const override = opts.rate && opts.rate[it.code] > 0 ? opts.rate[it.code] : null;
    const rate = override || it.rate;
    it.rateUsed = rate; it.rateManual = !!override;
    if ((it.orders < 2 && !override) || !(rate > 0)) { it.state = 'single'; continue; }
    // Simulate stock: each order arrives on its delivery date, usage runs at a constant rate.
    // A stock count (opts.stock[code] = { base, at }) replaces the history before the count; later arrivals are added on top.
    const count = opts.stock && opts.stock[it.code];
    const arrivals = [...it.events].map(e => ({ at: e.deliv || e.date + it.lead * DAY, base: e.base })).sort((a, b) => a.at - b.at);
    let stock = 0, t = null;
    if (count) {
      stock = count.base; t = count.at;
      for (const e of arrivals.filter(e => e.at > count.at)) { stock = Math.max(0, stock - rate * (e.at - t) / DAY) + e.base; t = e.at; }
    } else {
      for (const e of arrivals) {
        if (t !== null) stock = Math.max(0, stock - rate * (e.at - t) / DAY);
        stock += e.base; t = e.at;
      }
    }
    it.counted = count || null;
    // Stock on the shelf today: same walk, but only deliveries that have arrived.
    let s2 = count ? count.base : 0, t2 = count ? count.at : null;
    for (const e of arrivals.filter(e => e.at <= today && (!count || e.at > count.at))) {
      if (t2 !== null) s2 = Math.max(0, s2 - rate * (e.at - t2) / DAY);
      s2 += e.base; t2 = e.at;
    }
    it.stockNow = t2 === null ? 0 : Math.max(0, s2 - rate * Math.max(0, today - t2) / DAY);
    const runout = t + (stock / rate) * DAY;
    const closed = opts.closed || [];
    // Long lead time: extra buffer of 20 % of the lead time (at least the normal 3 days).
    const buf = it.longLead ? Math.max(buffer, Math.ceil(0.2 * it.leadSafe)) : buffer;
    const orderBy = latestOrder(runout - buf * DAY, it.leadSafe, closed);
    const plain = prevWeekday(runout - (it.leadSafe + buf) * DAY);
    it._closed = closed; it._buffer = buf;
    const f = it.factors[it.orderUnit] || 1;
    const qty = Math.max(1, Math.ceil(it.typicalBase / f - 1e-9));
    const daysLeft = Math.round((orderBy - today) / DAY);
    it.state = daysLeft <= 0 ? 'now' : daysLeft <= horizon ? 'soon' : 'ok';
    // Not bought for far longer than usual: probably replaced or no longer used.
    it.inactive = !count && !override && (today - it.last.date) / DAY > Math.max(60, 3 * (it.every || 0));
    const open = it.events.filter(e => e.open && e.deliv && e.deliv >= today);
    it.onTheWay = open.length ? Math.max(...open.map(e => e.deliv)) : null;
    it.plan = { runout, orderBy, daysLeft, qty, unit: it.orderUnit, base: qty * f, lowData: it.orders < 3 && !override, lead: it.leadSafe, buffer: buf, holiday: orderBy < plain ? holidayBetween(orderBy, runout, closed) : null };
  }
  return items;
}

// Holidays: periods { name, from, to } (UTC days) when the supplier neither produces nor delivers.
// Lead time is counted in open days only, so an order placed before a holiday must go in earlier.
const isClosed = (t, closed) => closed.some(c => t >= c.from && t <= c.to);
function deliveryFrom(day, lead, closed) {
  let d = day, n = 0;
  while (n < lead) { d += DAY; if (!isClosed(d, closed)) n++; }
  while (isClosed(d, closed)) d += DAY;
  return d;
}
function latestOrder(needBy, lead, closed) {
  let d = prevWeekday(needBy - lead * DAY);
  if (!closed.length) return d;
  for (let i = 0; i < 400; i++) {
    if (!isClosed(d, closed) && deliveryFrom(d, lead, closed) <= needBy) break;
    d = prevWeekday(d - DAY);
  }
  return d;
}
function holidayBetween(a, b, closed) { const c = closed.find(c => c.to >= a && c.from <= b); return c ? c.name : null; }

// Future order dates for one item over the next `days`: first the order-by date, then one typical order each time the previous one is used up.
function yearPlan(it, today, days = 365) {
  const rate = it.rateUsed || it.rate;
  if (!it.plan || it.inactive || !(rate > 0)) return [];
  const closed = it._closed || [], buffer = it._buffer ?? 3;
  const out = [], cover = Math.max(7, it.plan.base / rate) * DAY;
  let runout = it.plan.runout, at = it.plan.orderBy;
  for (let i = 0; at < today + days * DAY && i < 60; i++) {
    const plain = prevWeekday(runout - (it.leadSafe + buffer) * DAY);
    const o = { at: Math.max(at, today), qty: it.plan.qty, unit: it.plan.unit, late: at < today, holiday: at < plain ? holidayBetween(at, runout, closed) : null };
    const prev = out[out.length - 1];
    if (prev && prev.at === o.at) { prev.qty += o.qty; prev.holiday = prev.holiday || o.holiday; } else out.push(o);
    runout += cover;
    at = latestOrder(runout - buffer * DAY, it.leadSafe, closed);
  }
  return out;
}

// Easter Sunday (Gregorian, anonymous algorithm) as a UTC day.
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}

// Default holidays: Christmas 22 Dec - 2 Jan and summer weeks 29-31, for this year and the next.
function defaultClosed(today, cfg = {}) {
  const y0 = new Date(today).getUTCFullYear(), out = [];
  const jul = cfg.jul || { fromDay: 22, toDay: 2 }, som = cfg.sommer || { fromWeek: 29, toWeek: 31 };
  const monday = (y, w) => { const j4 = Date.UTC(y, 0, 4), dow = (new Date(j4).getUTCDay() + 6) % 7; return j4 - dow * DAY + (w - 1) * 7 * DAY; };
  for (const y of [y0 - 1, y0, y0 + 1]) {
    out.push({ name: 'jul', from: Date.UTC(y, 11, jul.fromDay), to: Date.UTC(y + 1, 0, jul.toDay) });
    if (som.fromWeek && som.toWeek) out.push({ name: 'sommerferien', from: monday(y, som.fromWeek), to: monday(y, som.toWeek) + 6 * DAY });
    // Danish public holidays: no production or delivery (Renewtech keeps working, so usage is not paused).
    const e = easter(y);
    for (const [name, t] of [['nytår', Date.UTC(y, 0, 1)], ['påske', e - 3 * DAY], ['påske', e - 2 * DAY], ['påske', e + DAY],
      ['Kristi himmelfart', e + 39 * DAY], ['pinse', e + 50 * DAY], ['grundlovsdag', Date.UTC(y, 5, 5)]]) out.push({ name, from: t, to: t, day: true });
  }
  return out.filter(c => c.to >= today - 30 * DAY);
}



// Renewtech Antalis-bestilling: runs on antalis.dk when the bookmark is clicked.
// Reads the live order history, works out what to order and when, and fills the cart.
const APP_VERSION = '1.9';
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
const closedNow = () => defaultClosed(todayUTC, LS.get(FERIE_KEY) || {});
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
      <div class="seg views"><button data-v="list" aria-pressed="true">Bestil nu</button><button data-v="year" aria-pressed="false">Årsplan</button><button data-v="stock" aria-pressed="false">Lager</button></div>
    </div>
    <div class="next" hidden></div>
    <div class="long" hidden></div>
    <div class="warn" hidden></div>
    <div class="msg">Starter…</div>
    <div class="scroll year" hidden></div>
    <div class="scroll stockp" hidden></div>
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

  let items, cart, histAt = Date.now(), fromCache = false;
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
    if (!picks.has(it.code)) picks.set(it.code, { on: !cart[it.code] && !it.inactive && (it.orders >= 3 || it.counted || it.rateManual) && !(it.onTheWay && it.state !== 'now') && (it.plan.daysLeft <= horizon || (it.longLead && it.plan.daysLeft <= 14)), qty: it.plan.qty });
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
    const useTxt = it.rateManual ? 'bruger (indtastet)' : 'bruger ca.';
    const lastQty = it.last.base, f = it.factors[it.plan.unit] || 1;
    const s = (LS.get(STOCK_KEY) || {})[it.code];
    if (it.counted && s) return `Lager talt ${fmtDate(s.at)}: ${String(s.pallets).replace('.', ',')} paller (${fmtNum(s.pallets * s.per)} ${bw}) · nu ca. ${fmtNum(it.stockNow)} ${bw} · ${useTxt} ${week >= 10 ? fmtNum(week) : week.toFixed(1).replace('.', ',')} ${bw}/uge · ${leadTxt} · løber tør ca. ${fmtDate(it.plan.runout)}`;
    return `${useTxt[0].toUpperCase() + useTxt.slice(1)} ${week >= 10 ? fmtNum(week) : week.toFixed(1).replace('.', ',')} ${bw}/uge · sidst bestilt ${fmtDate(it.last.date)} (${fmtNum(lastQty)} ${bw}) · ${leadTxt} · løber tør ca. ${fmtDate(it.plan.runout)}` + (f > 1 ? '' : '');
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
    $('.main').hidden = view !== 'list'; $('.year').hidden = view !== 'year'; $('.stockp').hidden = view !== 'stock';
    if (view !== 'list') { $('footer').hidden = true; $('.msg').hidden = true; return view === 'year' ? renderYear() : renderStock(); }
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
    const fc = Object.assign({ jul: { fromDay: 22, toDay: 2 }, sommer: { fromWeek: 29, toWeek: 31 } }, LS.get(FERIE_KEY) || {});
    const periods = closedNow().filter(c => c.to >= todayUTC && !c.day).map(c => `${c.name} ${fmtDate(c.from)} – ${fmtDate(c.to)} ${new Date(c.to).getUTCFullYear()}`).join(' · ');
    const ferieHtml = `<div class="ferie" style="margin:10px 0;padding:10px 12px;border:1px solid #ecdcb4;background:#fbf6ea;border-radius:8px">
      <b>Lukkeperioder</b> <span style="color:#636a70">(leverandøren producerer og leverer ikke)</span>: ${esc(periods)} · plus helligdage (påske, Kristi himmelfart, pinse, grundlovsdag, nytår)<br>
      <span style="color:#636a70">Jul fra</span> <input class="jf" type="number" min="1" max="31" value="${fc.jul.fromDay}" style="width:52px"> dec. <span style="color:#636a70">til</span> <input class="jt" type="number" min="1" max="31" value="${fc.jul.toDay}" style="width:52px"> jan. ·
      <span style="color:#636a70">Sommerferie uge</span> <input class="sf" type="number" min="1" max="53" value="${fc.sommer.fromWeek}" style="width:52px"> <span style="color:#636a70">til</span> <input class="st" type="number" min="1" max="53" value="${fc.sommer.toWeek}" style="width:52px">
      <button class="saveferie" style="margin-left:6px;border:1px solid #8a5a00;background:#fff;color:#8a5a00;border-radius:6px;padding:3px 9px;cursor:pointer">Gem</button>
      <br><span style="color:#636a70">Leveringstid tælles kun i åbne dage. Bestillinger der ellers ville ramme lukningen, flyttes frem og mærkes “før jul” / “før sommerferien”.</span></div>`;
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
    $('.saveferie').onclick = () => {
      const v = c => Math.round(+$('.ferie ' + c).value) || 0;
      LS.set(FERIE_KEY, { jul: { fromDay: v('.jf') || 22, toDay: v('.jt') || 2 }, sommer: { fromWeek: v('.sf'), toWeek: v('.st') } });
      picks.clear(); render();
    };
  }

  // Stock view: pallets on the shelf for your own boxes; the plan then counts from this instead of guessing.
  // Renewtech's own boxes: 250 per pallet (confirmed 01-10-2026). Other items: Antalis' pallet size when known.
  const defPer = it => (it.unique || !it.desc) ? 250 : (!it.assumed.includes('Pallet(s)') && it.factors['Pallet(s)']) || Math.round(it.typicalBase) || 250;
  function renderStock() {
    const s = LS.get(STOCK_KEY) || {};
    const list = items.filter(it => it.unique || !it.desc || s[it.code]).sort((a, b) => (a.title || '').localeCompare(b.title || '', 'da'));
    $('.stockp').innerHTML = `<p>Skriv hvor mange paller der står på lageret nu. Planen regner så fra jeres optælling i stedet for at gætte, og trækker forbruget fra dag for dag. Ret “Stk pr. palle”, hvis tallet ikke passer. Tallene gemmes i denne browser.</p>
      <table><thead><tr><th>Varenr.</th><th>Vare</th><th style="text-align:right">Paller nu</th><th style="text-align:right">Stk pr. palle</th><th style="text-align:right">Forbrug stk/uge</th><th>Sidst talt</th></tr></thead><tbody>${list.map(it => {
        const v = s[it.code] || {};
        return `<tr data-code="${esc(it.code)}"><td class="code">${esc(it.code)}</td><td>${esc(it.title.slice(0, 70))}${it.orders < 2 ? '<span class="why">Kun købt én gang i perioden: forbruget kan ikke regnes endnu</span>' : ''}</td>
          <td class="qty"><input class="pal" type="number" min="0" step="0.5" value="${v.pallets ?? ''}"></td>
          <td class="qty"><input class="per" type="number" min="1" value="${v.per || defPer(it)}"></td>
          <td class="qty"><input class="pw" type="number" min="0" step="1" value="${v.perWeek || ''}" placeholder="${it.rate > 0 ? Math.round(it.rate * 7) : '?'}" title="Lad stå tomt for at bruge planens eget tal (grå)"></td>
          <td>${v.at ? fmtDate(v.at) : ''}</td></tr>`;
      }).join('')}</tbody></table><button class="save">Gem lager og regn igen</button>`;
    $('.stockp .save').onclick = () => {
      const s2 = LS.get(STOCK_KEY) || {};
      $('.stockp').querySelectorAll('tr[data-code]').forEach(tr => {
        const code = tr.dataset.code, palRaw = tr.querySelector('.pal').value, per = +tr.querySelector('.per').value, pw = +tr.querySelector('.pw').value || 0;
        if (palRaw === '' && !pw) { delete s2[code]; return; }
        const pallets = +String(palRaw).replace(',', '.'), old = s2[code];
        s2[code] = palRaw === '' ? { perWeek: pw, at: Date.now() } : { pallets, per: per > 0 ? per : 250, perWeek: pw, at: old && old.pallets === pallets && old.per === per ? old.at : Date.now() };
      });
      LS.set(STOCK_KEY, s2);
      picks.clear(); setView('list');
    };
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

})();
