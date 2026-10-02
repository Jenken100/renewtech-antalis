/* Renewtech Antalis-bestilling. Kører på antalis.dk via bogmærke. Ingen data sendes andre steder hen. */
(function () {
"use strict";
// Antalis order-history engine: parse export, normalise units, forecast next order.
const DAY = 86400000;
const GROWTH_MIN = 0.95, GROWTH_MAX = 1.05; // steady growth only: at most ±5 % a month
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
  '694211': { 'Unit(s)': 1, 'Carton(s)': 100 },
  // Customer-unique items bought per pallet: pieces per pallet worked out from the price per piece (2026-10-02).
  '704335': { 'Unit(s)': 1, 'Pallet(s)': 2400 },
  '704337': { 'Unit(s)': 1, 'Pallet(s)': 1020 },
  '704256': { 'Unit(s)': 1, 'Pallet(s)': 500 },
  '704307': { 'Unit(s)': 1, 'Pallet(s)': 125 }
};

// The warehouse's own names for the boxes (Kasseoversigt 2026-10-02). conf: 'ok' confirmed, 'vol' named from the inner volume,
// 'bc' size taken from the Business Central invoice text, 'guess' not confirmed, 'unk' size unknown.
const GROUPS = [
  { id: 'std', name: 'Standardkasser', box: true },
  { id: 'pal', name: 'Pallekasser 80 og 100', box: true },
  { id: 'srv', name: 'Server- og specialkasser', box: true },
  { id: 'kor', name: 'Bundkort og Korrvu', box: true },
  { id: 'fyld', name: 'Fyld og beskyttelse' },
  { id: 'tape', name: 'Tape, film og bånd' },
  { id: 'pose', name: 'Poser og følgesedler' },
  { id: 'drift', name: 'Kontor, kantine og rengøring' }
];
const BOXES = {
  '693960': ['std', '8L', '284×185×165', 'vol'],
  '693794': ['std', '12L', '300×200×200', 'vol'],
  '693820': ['std', '18L', '310×230×250', 'vol'],
  '693890': ['std', '25L', '450×350×160', 'vol'],
  '693859': ['std', '25L lang', '540×290×160', 'vol'],
  '693880': ['std', '35L', '440×320×250', 'vol'],
  '693861': ['std', '37L', '605×290×210', 'vol'],
  '693886': ['std', '50L', '460×336×325', 'vol'],
  '694014': ['std', '82L', '585×385×364', 'vol'],
  '704299': ['pal', '80 pallekasse bund', '753×553×160', 'ok'],
  '705389': ['pal', '80 pallekasse top lille', '772×586×164', 'ok'],
  '705388': ['pal', '80 pallekasse top mellem', '772×586×243', 'ok'],
  '750195': ['pal', '80 pallekasse top stor', '772×586×323', 'ok'],
  '734203': ['pal', '100 pallekasse bund', '953×553×160', 'bc'],
  '704304': ['pal', '100 pallekasse top lille', '972×586×164', 'ok'],
  '729150': ['pal', '100 pallekasse top (mellem?)', '', 'guess'],
  '704307': ['srv', '60×60×48', '600×600×480', 'ok'],
  '704256': ['srv', 'Railkit-kasse?', '900×350×100', 'guess'],
  '704258': ['srv', 'Server-/specialkasse', '700×355×200/155', 'ok'],
  '750193': ['srv', 'Kasse 10', '1141×1085×100', 'ok'],
  '704314': ['srv', '100 serverkasse?', '1010×640×190', 'guess'],
  '704316': ['srv', '80 serverkasse?', '820×640×190', 'guess'],
  '740051': ['srv', 'Ukendt kasse A', '', 'unk'],
  '740053': ['srv', 'Ukendt kasse B', '', 'unk'],
  '740055': ['srv', 'Ukendt kasse C', '', 'unk'],
  '704302': ['kor', 'Bundkortkasse', '675×576×152', 'ok'],
  '704336': ['kor', 'Bundkort-indlæg (Korrvu)', '785×1116, vindue 510×590', 'ok'],
  '704335': ['kor', 'Korrvu 513×336', '513×336', 'guess'],
  '704337': ['kor', 'Korrvu alt-i-en', 'kt18294U', 'guess'],
  '746306': ['kor', 'Større foldekasse (Korrvu)', 'vindue 265×326', 'ok'],
  // Not a box, but the export has no description for it: name from the BC invoice text.
  '704389': ['tape', 'LDPE-folie', '', 'bc']
};
function classify(code, desc) {
  if (BOXES[code]) return BOXES[code][0];
  const d = desc.toLowerCase();
  if (/korrvu|korvu/.test(d)) return 'kor';
  if (/bølgepapkasse/.test(d)) return /kundeunikke/.test(d) ? 'srv' : 'std';
  if (/sæbe|toilet|håndklæde|servie?t/.test(d)) return 'drift';
  if (/boblefolie|padpak|instapak|skum|kantbeskyt|kant og hjørne|støddæmp|bølgepapark|paprør|stratocell|hjørne/.test(d)) return 'fyld';
  if (/tape|film|strapbånd|pet-bånd|hæfteklammer/.test(d)) return 'tape';
  if (/pose|følgeseddel/.test(d) && !/affald|spandepose/.test(d)) return 'pose';
  return 'drift';
}

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
  unit: ['enhed', 'unit'],
  ref: ['minordrereference', 'myorderreference', 'ordrereference'],
  user: ['brugernavn', 'username'],
  price: ['pris', 'price']
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
    if ((r[C.no] || '').trim()) { order = { no: r[C.no].trim(), date: parseDate(r[C.date]) || (order && order.date), ref: (r[C.ref] || '').trim(), user: (r[C.user] || '').trim() }; if (!item) continue; }
    if (!order || !item || item === 'DEFAULT') continue;
    rows.push({ order: order.no, date: order.date, ref: order.ref, user: order.user, item, desc: (r[C.desc] || '').trim(), deliv: parseDate(r[C.deliv]), status: (r[C.status] || '').trim(), qty: parseNum(r[C.qty]), unit: (r[C.unit] || '').trim(), price: C.price >= 0 ? parseNum(String(r[C.price] || '').replace(/[^\d,.\s ]/g, '')) || 0 : 0 });
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
      if (l.status && l.status !== 'Faktureret' && !(l.deliv && l.deliv < Date.now() - 14 * DAY)) e.open = true;
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
    // Last known price per base unit (the export's Pris is the line total), for the estimate of the cart.
    const priced = lines.filter(l => l.price > 0 && l.qty > 0 && factors[l.unit]);
    const lp = priced[priced.length - 1];
    const box = BOXES[code];
    items.push({
      group: classify(code, desc), name: box ? box[1] : '', dims: box ? box[2] : '', conf: box ? box[3] : '',
      unitPrice: lp ? lp.price / (lp.qty * factors[lp.unit]) : null,
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
    const count = opts.stock && opts.stock[it.code];
    // Overbought: more bought in the last 60 days than 1.8 x the pace from before. Then the burst is not real usage,
    // so plan with the earlier pace (unless a stock count or a typed usage says otherwise).
    const older = it.events.filter(e => e.date < today - 60 * DAY), recentBase = it.events.filter(e => e.date >= today - 60 * DAY).reduce((s, e) => s + e.base, 0);
    const olderSpan = older.length ? (today - 60 * DAY - older[0].date) / DAY : 0;
    const baseRate = olderSpan >= 60 ? older.reduce((s, e) => s + e.base, 0) / olderSpan : NaN;
    // Natural growth: compare 300-180 days ago with 180-60 days ago, as growth per month, kept within a steady -5 % / +5 % (about +80 % a year at most).
    // The expected pace today is the later window carried forward three months at that growth.
    const sumIn = (a, b) => it.events.filter(e => e.date >= today - a * DAY && e.date < today - b * DAY).reduce((s, e) => s + e.base, 0);
    const w1 = sumIn(300, 180) / 120, w2 = sumIn(180, 60) / 120;
    const monthly = w1 > 0 && w2 > 0 ? Math.min(GROWTH_MAX, Math.max(GROWTH_MIN, Math.pow(w2 / w1, 30 / 120))) : 1;
    const expected = w2 > 0 ? w2 * Math.pow(monthly, 3) : baseRate;
    it.trend = w1 > 0 && w2 > 0 ? monthly : null;
    // One ordinary order inside the window is not overbuying, so compare with the larger of 60 days' pace and a normal order.
    const normalOrder = older.length ? median(older.map(e => e.base)) : 0;
    const normal60 = Math.max(expected * 60, normalOrder);
    it.overbought = !count && !override && expected > 0 && recentBase > 1.8 * normal60 ? { recentBase, normal: Math.round(normal60), x: recentBase / normal60 } : null;
    const rate = override || (it.overbought ? Math.min(it.rate, expected) : it.rate);
    it.rateUsed = rate; it.rateManual = !!override;
    if ((it.orders < 2 && !override) || !(rate > 0)) { it.state = 'single'; continue; }
    // Simulate stock: each order arrives on its delivery date, usage runs at a constant rate.
    // A stock count (opts.stock[code] = { base, at }) replaces the history before the count; later arrivals are added on top.
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
const APP_VERSION = '2.0';
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
const fmtKr = n => n.toLocaleString('da-DK', { maximumFractionDigits: 0 });
const fmtKr2 = n => n.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The name people use on the floor: the warehouse name for our boxes, otherwise the start of Antalis' description.
const nameOf = it => {
  if (it.name) return it.name;
  const parts = (it.title || '').split(','); let s = parts[0].trim();
  for (let i = 1; i < parts.length && s.length < 26; i++) s += ',' + parts[i];
  return s.length > 60 ? s.slice(0, 58) + '…' : s;
};
const GROUP = Object.fromEntries(GROUPS.map(g => [g.id, g]));
const CONF_PILL = { vol: '', ok: '', bc: '<span class="pill plain" title="Antalis viser ingen beskrivelse. Størrelsen står på fakturaen i Business Central.">Størrelse fra BC</span>', guess: '<span class="pill soon">Navn ikke bekræftet</span>', unk: '<span class="pill now">Ukendt størrelse</span>' };
// Maven Pro (Renewtech's typeface) from Google Fonts. antalis.dk has no CSP; the fallback is Segoe UI.
function loadFont() {
  if (document.getElementById('rt-font')) return;
  const l = document.createElement('link'); l.id = 'rt-font'; l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Maven+Pro:wght@400;500;600;700&display=swap';
  document.head.appendChild(l);
}

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
  loadFont();
  const host = document.createElement('div');
  host.id = 'renewtech-antalis';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial }
    [hidden] { display: none !important }
    * { box-sizing: border-box }
    .w { --navy: #0B192A; --green: #1DBF84; --green-d: #12895E; --yellow: #FED060; --ink: #0B192A; --muted: #5B6875; --line: #E1E6EA; --soft: #F3F6F8; --card: #fff;
      --now: #B3261E; --now-bg: #FCE6E4; --soon: #8A5A00; --soon-bg: #FFF1CC; --ok: #12895E; --ok-bg: #E1F5EC; --info: #1F5B99; --info-bg: #E4EEF9;
      --f: "Maven Pro", "Segoe UI", system-ui, sans-serif; --mono: Consolas, "Cascadia Mono", monospace }
    .back { position: fixed; inset: 0; background: rgba(11, 25, 42, .55) }
    .win { position: fixed; top: 2.5vh; left: 50%; transform: translateX(-50%); width: min(1180px, 97vw); max-height: 95vh; display: flex; flex-direction: column; background: var(--soft); color: var(--ink); border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.4); font: 14px/1.45 var(--f); overflow: hidden }
    header { position: relative; display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 20px; background: var(--navy); color: #fff; overflow: hidden }
    header::after { content: ""; position: absolute; right: 120px; top: -20px; width: 120px; height: 120px; background: var(--green); transform: skewX(-28deg); opacity: .9 }
    header::before { content: ""; position: absolute; right: 78px; bottom: -40px; width: 40px; height: 80px; background: var(--yellow); transform: skewX(-28deg) }
    header > * { position: relative; z-index: 1 }
    header b { font-size: 18px; font-weight: 700; letter-spacing: .01em } header small { color: #A9B6C3; font-weight: 500; margin-left: 8px }
    header .src { display: block; color: #A9B6C3; font-size: 12px; margin-top: 2px }
    .x { border: 0; background: rgba(255,255,255,.12); color: #fff; font-size: 20px; width: 34px; height: 34px; border-radius: 8px; cursor: pointer; line-height: 1 }
    .x:hover { background: rgba(255,255,255,.22) }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; padding: 14px 20px 4px }
    .stat { text-align: left; border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 10px 12px; cursor: pointer; font: inherit; color: inherit; border-left: 4px solid var(--line) }
    .stat:hover { border-color: var(--green) } .stat .n { display: block; font-size: 24px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums } .stat .l { color: var(--muted); font-size: 12.5px }
    .stat.s-now { border-left-color: var(--now) } .stat.s-now .n { color: var(--now) }
    .stat.s-soon { border-left-color: var(--yellow) } .stat.s-long { border-left-color: var(--now) } .stat.s-way { border-left-color: var(--info) } .stat.s-cart { border-left-color: var(--green) }
    .stat.zero .n { color: var(--muted) !important }
    .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 20px }
    .msg { padding: 12px 20px; color: var(--muted) }
    .msg.err { color: var(--now); font-weight: 600 }
    .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: var(--card) }
    .seg button { border: 0; background: none; padding: 7px 12px; cursor: pointer; font: inherit; font-weight: 500; color: var(--ink) }
    .seg button + button { border-left: 1px solid var(--line) }
    .seg button[aria-pressed=true] { background: var(--navy); color: #fff }
    .tabs { display: flex; gap: 2px; padding: 0 20px; border-bottom: 1px solid var(--line) }
    .tabs button { border: 0; background: none; font: inherit; font-weight: 600; color: var(--muted); padding: 10px 14px 9px; cursor: pointer; border-bottom: 3px solid transparent }
    .tabs button[aria-pressed=true] { color: var(--ink); border-bottom-color: var(--green) }
    .tabs button:hover { color: var(--ink) }
    button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--green); outline-offset: 2px }
    .scroll { overflow: auto; flex: 1; padding: 6px 20px 16px }
    .grp { margin: 14px 0 0 } .grp h3 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 6px; font-size: 15px; font-weight: 700 }
    .grp h3 span { color: var(--muted); font-weight: 500; font-size: 12.5px }
    .grp h3 i { width: 10px; height: 10px; border-radius: 3px; background: var(--green); display: inline-block; align-self: center }
    .grp.box h3 i { background: var(--navy) }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden }
    table { border-collapse: collapse; width: 100% }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle }
    tbody tr:last-child td { border-bottom: 0 }
    th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; background: var(--soft) }
    .nm { font-weight: 600; font-size: 14.5px }
    .meta { color: var(--muted); font-size: 12px; margin-top: 1px } .meta a { color: inherit; font-family: var(--mono); font-weight: 600 } .meta .dim { font-family: var(--mono) }
    .why { display: block; color: var(--muted); font-size: 12px; margin-top: 3px; max-width: 62ch }
    .flags { margin-top: 4px }
    .pill { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 99px; white-space: nowrap; margin: 0 4px 3px 0 }
    .now { background: var(--now-bg); color: var(--now) } .soon { background: var(--soon-bg); color: var(--soon) } .ok { background: var(--ok-bg); color: var(--ok) }
    .info { background: var(--info-bg); color: var(--info) } .plain { background: var(--soft); color: var(--muted) } .uniq { background: #EAE3F5; color: #5B3A8C }
    .cov { width: 170px } .cov .track { position: relative; height: 8px; border-radius: 99px; background: var(--soft); border: 1px solid var(--line); overflow: visible }
    .cov .fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 99px; background: var(--green) }
    .cov .fill.soon { background: var(--yellow) } .cov .fill.now { background: var(--now) }
    .cov .mark { position: absolute; top: -4px; width: 2px; height: 14px; background: var(--navy); border-radius: 1px }
    .cov .t { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--muted); margin-top: 4px; font-variant-numeric: tabular-nums } .cov .t b { color: var(--ink); font-weight: 600 }
    .cov-none { color: var(--muted); font-size: 12px }
    .qty { white-space: nowrap; text-align: right }
    .qty input { width: 72px; font: 600 14px var(--mono); padding: 6px 7px; border: 1px solid var(--line); border-radius: 7px; text-align: right; color: var(--ink); background: #fff }
    .qty small { display: block; color: var(--muted); font-size: 11.5px }
    td.res { white-space: nowrap; font-weight: 600; font-size: 13px }
    tr.off td:not(:first-child) { opacity: .55 }
    input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--green-d) }
    footer { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--card) }
    .go { background: var(--green); color: var(--navy); border: 0; border-radius: 9px; padding: 12px 22px; font-family: inherit; font-size: 15px; font-weight: 700; cursor: pointer }
    .go:hover { background: #19ad77 } .go[disabled] { opacity: .45; cursor: default }
    a.cart { color: var(--navy); font-weight: 600 }
    .sum { color: var(--muted) } .sum b { color: var(--ink) }
    label.all { display: inline-flex; gap: 6px; align-items: center; cursor: pointer }
    .spacer { flex: 1 }
    .note { margin: 10px 20px 0; padding: 10px 14px; border-radius: 10px; font-size: 13.5px }
    .next { background: var(--info-bg); color: #13355C } .next span { color: var(--info) }
    .long { background: var(--now-bg); color: #7A1A14 }
    .warn { background: var(--soon-bg); color: var(--soon) }
    .warn button { margin-left: 8px; border: 1px solid var(--soon); background: #fff; color: var(--soon); border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit }
    .year h4, .ordered h4 { margin: 18px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted) }
    .year ul, .ordered ul { margin: 0; padding-left: 18px } .year li, .ordered li { margin: 3px 0 } .late { color: var(--now); font-weight: 600 }
    .box-ex { color: var(--muted); font-size: 12px }
    .stockp input { width: 72px; font: 600 14px var(--mono); padding: 6px 7px; border: 1px solid var(--line); border-radius: 7px; text-align: right }
    .stockp p { margin: 8px 0 10px; color: var(--muted) }
    .save { background: var(--navy); color: #fff; border: 0; border-radius: 9px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; margin-top: 12px }
    .muted { color: var(--muted) }
    @media (max-width: 760px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)) } .cov { width: 110px } }
  </style>
  <div class="w">
  <div class="back"></div>
  <div class="win" role="dialog" aria-label="Renewtech Antalis-bestilling">
    <header><div><b>Antalis-bestilling</b><small>Renewtech · v${APP_VERSION}</small><span class="src"></span></div><button class="x" title="Luk" aria-label="Luk">×</button></header>
    <div class="stats" hidden></div>
    <div class="note next" hidden></div>
    <div class="note long" hidden></div>
    <div class="note warn" hidden></div>
    <div class="bar" hidden>
      <span class="hz" style="display:inline-flex;gap:10px;align-items:center;flex-wrap:wrap"><span>Bestil inden for</span>
      <div class="seg"><button data-h="7" aria-pressed="true">7 dage</button><button data-h="14" aria-pressed="false">14 dage</button><button data-h="30" aria-pressed="false">30 dage</button></div>
      <label class="all"><input type="checkbox" class="showall"> Vis alle varer</label></span>
      <span class="spacer"></span>
      <input class="find" type="search" placeholder="Søg navn eller varenr." aria-label="Søg" style="font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:9px;width:210px">
    </div>
    <div class="tabs" hidden><button data-v="list" aria-pressed="true">Bestil nu</button><button data-v="boxes" aria-pressed="false">Kasser</button><button data-v="year" aria-pressed="false">Årsplan</button><button data-v="ordered" aria-pressed="false">Bestilt</button><button data-v="stock" aria-pressed="false">Lager</button></div>
    <div class="msg">Starter…</div>
    <div class="scroll year" hidden></div>
    <div class="scroll stockp" hidden></div>
    <div class="scroll ordered" hidden></div>
    <div class="scroll main" hidden></div>
    <footer hidden><button class="go">Læg valgte i kurven</button><span class="sum"></span><span class="spacer"></span><a class="cart" href="${CTX}/ws/html/cart/cartSummary">Gå til kurven →</a></footer>
  </div></div>`;
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
      if (s.at > histAt) rows.push({ order: 'Renewtech-kurv', date: Date.UTC(new Date(s.at).getFullYear(), new Date(s.at).getMonth(), new Date(s.at).getDate()), item: code, desc: s.desc || '', deliv: null, status: 'Lagt i kurven', qty: s.qty, unit: s.unit, sent: true, price: 0 });
    }
    items = buildItems(rows);
    for (const it of items) { const s = sent[it.code]; it.sentAfter = s && s.at > histAt ? s : null; }
    U.msg('Tjekker kurven…');
    cart = await readCart();
  } catch (e) {
    if (e.login) {
      U.msg('');
      const m = $('.msg'); m.hidden = false; m.className = 'msg err';
      m.innerHTML = 'Antalis vil have dig til at logge ind igen, før ordrehistorikken kan hentes. Sæt flueben i “Forbliv logget ind”. <br><br><button class="go relogin">Log ind igen</button> <span class="muted" style="font-weight:400">Tryk så på bogmærket igen bagefter. Herefter husker bogmærket ordrehistorikken, så du ikke skal logge ind hver gang.</span>';
      $('.relogin').onclick = relogin;
      return;
    }
    U.msg('Kunne ikke hente data: ' + e.message, true); return;
  }
  $('header .src').textContent = `Ordrehistorik hentet ${fmtTime(histAt)}${fromCache ? ' (gemt kopi)' : ''} · ${items.length} varer`;
  if (fromCache) {
    const w = $('.warn'); w.hidden = false;
    w.innerHTML = `Bygger på ordrehistorikken hentet <b>${fmtTime(histAt)}</b>, fordi “Min konto” har logget dig ud. Bestillinger lavet efter det uden om bogmærket kan mangle. Varer i kurven og varer bogmærket selv har lagt i kurven, er regnet med. <button class="relogin2">Log ind og hent ny</button>`;
    $('.relogin2').onclick = relogin;
  }

  let horizon = 7, showAll = false, view = 'list', query = '';
  const picks = new Map();
  // Order quantity and unit: the plan's, or for an item that cannot be planned yet, one typical order.
  const unitOf = it => it.plan ? it.plan.unit : it.orderUnit;
  const factorOf = it => it.factors[unitOf(it)] || 1;
  const pickFor = it => {
    if (!picks.has(it.code)) {
      const due = it.plan && (it.plan.daysLeft <= horizon || (it.longLead && it.plan.daysLeft <= 14));
      const on = !!it.plan && !cart[it.code] && !it.inactive && !it.overbought && (it.orders >= 3 || it.counted || it.rateManual) && !(it.onTheWay && it.state !== 'now') && due;
      picks.set(it.code, { on, qty: it.plan ? it.plan.qty : Math.max(1, Math.ceil(it.typicalBase / factorOf(it) - 1e-9)) });
    }
    return picks.get(it.code);
  };
  const statusPill = it => {
    const p = it.plan;
    if (!p) return `<span class="pill plain">Kun ${it.orders} køb</span>`;
    if (it.inactive) return `<span class="pill plain">Ikke købt siden ${fmtDate(it.last.date)}</span>`;
    if (it.state === 'now') return `<span class="pill now">${p.daysLeft < 0 ? 'Bestil nu · ' + -p.daysLeft + ' dage over' : 'Bestil i dag'}</span>`;
    if (it.state === 'soon') return `<span class="pill soon">Bestil senest ${fmtDate(p.orderBy)}</span>`;
    return `<span class="pill ok">OK · bestil ${fmtDate(p.orderBy)}</span>`;
  };
  const weekTxt = it => { const week = (it.rateUsed || it.rate) * 7; return week >= 10 ? fmtNum(week) : week.toFixed(1).replace('.', ','); };
  const why = it => {
    if (!it.plan) return `Købt ${it.orders} gang: ${fmtNum(it.last.base)} ${BASE_WORD(it)} ${fmtDate(it.last.date)}. Forbruget kan først regnes efter næste køb, eller skriv det under “Lager”.`;
    const bw = BASE_WORD(it);
    const leadTxt = it.longLead ? `lev.tid op til ${it.plan.lead} d + ${it.plan.buffer} d buffer` : `lev.tid ${it.lead} d`;
    const trendTxt = it.trend && Math.abs(it.trend - 1) >= 0.03 ? ` (udvikling ${it.trend > 1 ? '+' : ''}${Math.round((it.trend - 1) * 100)} %/md)` : '';
    const useTxt = it.rateManual ? 'bruger (indtastet)' : it.overbought ? 'normalt forbrug ca.' : 'bruger ca.';
    const s = (LS.get(STOCK_KEY) || {})[it.code];
    if (it.counted && s) return `Lager talt ${fmtDate(s.at)}: ${String(s.pallets).replace('.', ',')} paller (${fmtNum(s.pallets * s.per)} ${bw}) · nu ca. ${fmtNum(it.stockNow)} ${bw} · ${useTxt} ${weekTxt(it)} ${bw}/uge${trendTxt} · ${leadTxt}`;
    return `${useTxt[0].toUpperCase() + useTxt.slice(1)} ${weekTxt(it)} ${bw}/uge${trendTxt} · sidst ${fmtDate(it.last.date)} (${fmtNum(it.last.base)} ${bw}) · ${leadTxt}`;
  };
  // How long the stock lasts (including what is on its way), against how early it must be ordered.
  const COV_MAX = 120;
  const cover = it => {
    if (!it.plan) return '<span class="cov-none">Kan ikke beregnes endnu</span>';
    const left = Math.round((it.plan.runout - todayUTC) / DAY), need = it.plan.lead + it.plan.buffer;
    const w = Math.max(0, Math.min(left, COV_MAX)) / COV_MAX * 100, m = Math.min(need, COV_MAX) / COV_MAX * 100;
    const cls = it.inactive ? '' : it.state === 'now' ? 'now' : it.state === 'soon' ? 'soon' : '';
    const title = `Løber tør ca. ${fmtDate(it.plan.runout)} (inkl. det der er på vej). Skal bestilles ${need} dage før: lev.tid ${it.plan.lead} d + ${it.plan.buffer} d buffer.`;
    return `<div class="cov" title="${esc(title)}"><div class="track"><i class="fill ${cls}" style="width:${w}%"></i><b class="mark" style="left:${m}%"></b></div><div class="t"><span>${left <= 0 ? '<b>Tom nu</b>' : `<b>${left > COV_MAX ? COV_MAX + '+' : left} dage</b>`}</span><span>tør ${fmtDate(it.plan.runout)}</span></div></div>`;
  };
  const flagsOf = it => [
    CONF_PILL[it.conf] || '',
    it.unique && !it.name ? '<span class="pill uniq">Kundeunik</span>' : '',
    it.longLead ? `<span class="pill now">Lang lev.tid · ${it.plan ? it.plan.lead : it.lead} d</span>` : '',
    it.overbought ? `<span class="pill soon" title="Købt ${fmtNum(it.overbought.recentBase)} ${BASE_WORD(it)} de sidste 60 dage mod normalt ca. ${fmtNum(it.overbought.normal)}">Købt meget for nylig · tæl lageret</span>` : '',
    it.plan && it.plan.holiday ? `<span class="pill soon">Bestil før ${esc(it.plan.holiday)}</span>` : '',
    it.sentAfter ? `<span class="pill info">Lagt i kurven af bogmærket ${fmtTime(it.sentAfter.at)}</span>` : '',
    it.onTheWay ? `<span class="pill info">På vej · lev. ${fmtDate(it.onTheWay)}</span>` : '',
    it.plan && it.plan.lowData ? `<span class="pill plain">Kun ${it.orders} køb</span>` : '',
    it.assumed.length ? '<span class="pill plain">Omregning anslået</span>' : ''
  ].join('');
  const rowHtml = it => {
    const p = pickFor(it), f = factorOf(it), c = cart[it.code], u = unitOf(it);
    const price = it.unitPrice ? `<small>ca. DKK ${fmtKr(p.qty * f * it.unitPrice)}</small>` : '';
    const sub = [`<a href="${WS}html/catalog/resultPage?keyWord=${esc(it.code)}" target="_blank">${esc(it.code)}</a>`, it.dims ? `<span class="dim">${esc(it.dims)}</span>` : '', it.name && it.title && !/ingen beskrivelse/.test(it.title) ? esc(it.title.slice(0, 60)) : ''].filter(Boolean).join(' · ');
    return `<tr data-code="${esc(it.code)}" class="${p.on ? '' : 'off'}">
      <td style="width:28px"><input type="checkbox" aria-label="Vælg ${esc(nameOf(it))}" ${p.on ? 'checked' : ''} ${c ? 'disabled title="Ligger allerede i kurven"' : ''}></td>
      <td><div class="nm">${esc(nameOf(it))}</div><div class="meta">${sub}</div><span class="why">${why(it)}</span><div class="flags">${flagsOf(it)}</div></td>
      <td>${cover(it)}</td>
      <td style="white-space:nowrap">${statusPill(it)}</td>
      <td class="qty"><input type="number" min="0" value="${p.qty}" aria-label="Antal"> ${esc(unitDa(u, p.qty))}${f > 1 ? `<small>= ${fmtNum(p.qty * f)} ${BASE_WORD(it)}</small>` : ''}${price}</td>
      <td class="res">${c ? `<span style="color:var(--info)">I kurven: ${c.qty} ${esc(UNIT_DA[c.unit] ? unitDa(c.unit, c.qty) : c.unit)}</span>` : ''}</td></tr>`;
  };
  const groupsHtml = (list, emptyTxt) => {
    if (!list.length) return `<p class="muted" style="margin:16px 0">${emptyTxt}</p>`;
    return GROUPS.map(g => {
      const rows = list.filter(it => it.group === g.id);
      if (!rows.length) return '';
      const due = rows.filter(it => it.plan && !it.inactive && it.state !== 'ok').length;
      return `<div class="grp ${g.box ? 'box' : ''}"><h3><i></i>${esc(g.name)}<span>${rows.length} varer${due ? ' · ' + due + ' skal bestilles' : ''}</span></h3>
        <div class="card"><table><thead><tr><th></th><th>Vare</th><th>Lageret rækker</th><th>Status</th><th style="text-align:right">Antal</th><th>Kurv</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table></div></div>`;
    }).join('');
  };
  const matches = it => !query || it.code.includes(query) || (nameOf(it) + ' ' + it.title + ' ' + it.dims).toLowerCase().includes(query);

  const render = () => {
    plan(items, todayUTC, { horizon, stock: stockOpts(), rate: rateOpts(), closed: closedNow() });
    const live = it => it.plan && !it.inactive && !cart[it.code] && !it.sentAfter;
    // Long lead time: always warn three weeks ahead, whatever the chosen period.
    const longDue = items.filter(it => live(it) && it.longLead && it.plan.daysLeft <= LONG_WARN).sort((a, b) => a.plan.orderBy - b.plan.orderBy);
    const nowN = items.filter(it => live(it) && it.state === 'now' && !it.onTheWay).length;
    const soonN = items.filter(it => live(it) && it.plan.daysLeft > 0 && it.plan.daysLeft <= horizon).length;
    const wayN = items.filter(it => it.onTheWay).length, cartN = Object.keys(cart).length;
    const stat = (cls, n, l, go) => `<button class="stat ${cls}${n ? '' : ' zero'}" data-go="${go}"><span class="n">${n}</span><span class="l">${l}</span></button>`;
    $('.stats').hidden = false;
    $('.stats').innerHTML = stat('s-now', nowN, 'Bestil nu', 'list') + stat('s-soon', soonN, `Bestil inden for ${horizon} dage`, 'list')
      + stat('s-long', longDue.length, 'Lang lev.tid inden for 3 uger', 'list') + stat('s-way', wayN, 'Varer på vej', 'ordered') + stat('s-cart', cartN, 'Varer i kurven', 'ordered');
    U.root.querySelectorAll('[data-go]').forEach(b => b.onclick = () => setView(b.dataset.go));
    $('.long').hidden = !longDue.length;
    $('.long').innerHTML = longDue.length ? '<b>Lang leveringstid · bestil i god tid:</b> ' + longDue.map(it => `${esc(nameOf(it))} <span class="muted">#${esc(it.code)}</span> (${it.plan.lead} d) ${it.plan.daysLeft <= 0 ? '<b>nu</b>' : 'senest <b>' + fmtDate(it.plan.orderBy) + '</b>'}`).join(' · ') : '';
    // When is the next order? Group items whose order-by dates fall within 3 days of the earliest.
    const due = items.filter(it => live(it) && (it.orders >= 3 || it.counted || it.rateManual || it.longLead)).sort((a, b) => a.plan.orderBy - b.plan.orderBy);
    if (due.length) {
      const d0 = due[0].plan.orderBy, g1 = due.filter(it => it.plan.orderBy <= d0 + 3 * DAY);
      const rest = due.filter(it => it.plan.orderBy > d0 + 3 * DAY), d1 = rest.length ? rest[0].plan.orderBy : null, g2 = d1 ? rest.filter(it => it.plan.orderBy <= d1 + 3 * DAY) : [];
      const names = g => g.slice(0, 4).map(it => esc(nameOf(it))).join(', ') + (g.length > 4 ? ` og ${g.length - 4} mere` : '');
      const when = t => t <= todayUTC ? '<b>nu</b>' : `senest <b>${fmtDate(t)}</b>`;
      $('.next').hidden = false;
      $('.next').innerHTML = `<b>Næste bestilling</b> ${when(d0)}: ${names(g1)}` + (d1 ? `<br><span>Derefter ${when(d1)}: ${names(g2)}</span>` : '');
    } else $('.next').hidden = true;
    $('.bar').hidden = false; $('.tabs').hidden = false;
    $('.hz').style.visibility = view === 'list' ? '' : 'hidden';
    $('.find').hidden = !(view === 'list' || view === 'boxes');
    const mainView = view === 'list' || view === 'boxes';
    $('.main').hidden = !mainView; $('.year').hidden = view !== 'year'; $('.stockp').hidden = view !== 'stock'; $('.ordered').hidden = view !== 'ordered';
    $('footer').hidden = !mainView;
    U.msg('');
    if (!mainView) return view === 'year' ? renderYear() : view === 'ordered' ? renderOrdered() : renderStock();
    let list, empty;
    if (view === 'boxes') {
      list = items.filter(it => GROUP[it.group] && GROUP[it.group].box && matches(it)).sort((a, b) => (a.plan ? a.plan.orderBy : Infinity) - (b.plan ? b.plan.orderBy : Infinity));
      empty = 'Ingen kasser fundet.';
    } else {
      list = items.filter(it => matches(it) && it.plan && (showAll || query || (!it.inactive && (it.plan.daysLeft <= horizon || (it.longLead && it.plan.daysLeft <= LONG_WARN))) || cart[it.code])).sort((a, b) => (a.inactive - b.inactive) || (a.plan.orderBy - b.plan.orderBy));
      const next = items.filter(it => it.plan && !it.inactive && it.plan.daysLeft > horizon).sort((a, b) => a.plan.orderBy - b.plan.orderBy)[0];
      empty = `Intet skal bestilles inden for ${horizon} dage.` + (next ? ` Næste er ${esc(nameOf(next))} senest ${fmtDate(next.plan.orderBy)}.` : '');
    }
    const intro = view === 'boxes' ? `<p class="muted" style="margin:10px 0 0">Alle kassetyper I køber, sorteret efter hvornår de skal bestilles. Baren viser hvor mange dage lageret rækker (inkl. det der er på vej). Stregen er hvor tidligt der skal bestilles på grund af leveringstiden.</p>` : '';
    $('.main').innerHTML = intro + groupsHtml(list, empty);
    updateSum();
  };
  const chosen = () => items.filter(it => picks.get(it.code)?.on && picks.get(it.code).qty > 0 && !cart[it.code]);
  const updateSum = () => {
    const c = chosen(), n = c.length;
    const kr = c.reduce((s, it) => s + (it.unitPrice ? picks.get(it.code).qty * factorOf(it) * it.unitPrice : 0), 0);
    $('.sum').innerHTML = n ? `<b>${n} ${n === 1 ? 'vare' : 'varer'} valgt</b>${kr ? ` · ca. DKK ${fmtKr(kr)} ekskl. moms (seneste pris)` : ''}` : 'Ingen varer valgt';
    $('.go').disabled = !n;
  };

  $('.main').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-code]'); if (!tr) return;
    const p = picks.get(tr.dataset.code);
    if (e.target.type === 'checkbox') { p.on = e.target.checked; tr.classList.toggle('off', !p.on); }
    if (e.target.type === 'number') {
      p.qty = Math.max(0, Math.round(+e.target.value || 0));
      const it = items.find(i => i.code === tr.dataset.code), sm = tr.querySelectorAll('.qty small');
      if (it) { const f = factorOf(it); let i = 0; if (f > 1) sm[i++].textContent = `= ${fmtNum(p.qty * f)} ${BASE_WORD(it)}`; if (it.unitPrice && sm[i]) sm[i].textContent = `ca. DKK ${fmtKr(p.qty * f * it.unitPrice)}`; }
    }
    updateSum();
  });
  U.root.querySelectorAll('[data-h]').forEach(b => b.onclick = () => {
    horizon = +b.dataset.h; U.root.querySelectorAll('[data-h]').forEach(x => x.setAttribute('aria-pressed', x === b));
    picks.clear(); render();
  });
  $('.showall').onchange = e => { showAll = e.target.checked; render(); };
  $('.find').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); render(); $('.find').focus(); });

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
    const ferieHtml = `<div class="note warn" style="margin:10px 0">
      <b>Ferie og helligdage er regnet med automatisk:</b> ${esc(periods)} · plus helligdage (nytår, påske, Kristi himmelfart, pinse, grundlovsdag).<br>
      <span class="muted">Leveringstid tælles kun i åbne dage. Bestillinger der ellers ville ramme en lukning, flyttes frem og mærkes “før jul” / “før sommerferien”.</span></div>`;
    $('.year').innerHTML = ferieHtml + (!ev.length ? '<p>Ingen varer med nok køb til en årsplan.</p>'
      : '<p class="muted" style="margin:8px 0">Forventede bestillinger de næste 12 måneder med det typiske antal. Datoerne flytter sig, når I bestiller, eller når forbruget ændrer sig.</p>')
      + [...byMonth].map(([k, list]) => {
        const per = new Map();
        for (const e of list) { if (!per.has(e.it.code)) per.set(e.it.code, []); per.get(e.it.code).push(e); }
        const rows = [...per.values()].sort((a, b) => a[0].at - b[0].at).map(es => {
          const e = es[0], it = e.it, late = es.some(x => x.late);
          const days = es.map(x => x.late ? 'nu' : new Date(x.at).getUTCDate() + '.').join(', ');
          const sameQty = es.every(x => x.qty === e.qty), hol = es.find(x => x.holiday);
          const qtyTxt = sameQty ? `${es.length > 1 ? es.length + ' × ' : ''}${e.qty} ${esc(unitDa(e.unit, e.qty))}` : es.map(x => x.qty).join(' + ') + ' ' + esc(unitDa(e.unit, 2));
          return `<li class="${late ? 'late' : ''}"><b>${qtyTxt}</b> · ${esc(nameOf(it))} <span class="muted">#${esc(it.code)} (${days})</span>${hol ? ` <span class="pill soon">før ${esc(hol.holiday)}</span>` : ''}${it.plan.lowData ? ' <span class="pill plain">få køb</span>' : ''}${it.counted ? ' <span class="pill info">lager talt</span>' : ''}${it.longLead ? ' <span class="pill now">lang lev.tid</span>' : ''}</li>`;
        }).join('');
        return `<h4>${month(k)} · ${list.length} bestillinger af ${per.size} varer</h4><ul>${rows}</ul>`;
      }).join('');
  }

  // Ordered view: the cart now, what is on its way from Antalis, and what was ordered in the last 14 days.
  function renderOrdered() {
    const name = code => { const it = items.find(i => i.code === code); return it ? nameOf(it) : ''; };
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
        return `<li><b>${qtyTxt(r.qty, r.unit)}</b> · ${esc(name(r.item))} <span class="muted">#${esc(r.item)} · ${esc(r.status)}</span> · ${when}</li>`;
      }).join('');
      return `<div class="card" style="margin:8px 0;padding:10px 14px">${head}<ul>${li}</ul></div>`;
    };
    const cartList = Object.entries(cart);
    const openOrders = byOrder(open).sort((a, b) => Math.min(...a.map(r => r.deliv || Infinity)) - Math.min(...b.map(r => r.deliv || Infinity)));
    const recentOrders = byOrder(recent).sort((a, b) => b[0].date - a[0].date);
    $('.ordered').innerHTML = `
      <h4>I kurven nu · ${cartList.length} varer</h4>
      ${cartList.length ? '<div class="card" style="padding:10px 14px"><ul>' + cartList.map(([code, c]) => { const it = items.find(i => i.code === code); return `<li><b>${qtyTxt(c.qty, c.unit)}</b> · ${esc(name(code))} <span class="muted">#${esc(code)}</span>${it && it.overbought ? ' <span class="pill soon">Købt meget for nylig: overvej at fjerne den, eller tæl lageret først</span>' : ''}</li>`; }).join('') + `</ul><p class="muted" style="margin:6px 0 0">Ikke bestilt endnu. <a class="cart" href="${CTX}/ws/html/cart/cartSummary">Gå til kurven</a> for at bestille.</p></div>` : '<p class="muted">Kurven er tom.</p>'}
      <h4>På vej fra Antalis · ${open.length} linjer i ${openOrders.length} ordrer</h4>
      ${openOrders.length ? openOrders.map(l => orderHtml(l, true)).join('') : '<p class="muted">Intet på vej.</p>'}
      ${stale.length ? `<details style="margin:8px 0"><summary class="muted" style="cursor:pointer">${stale.length} gamle linjer står stadig som “${esc(stale[0].status)}” hos Antalis, men leveringsdatoen er mere end 14 dage gammel. De regnes som leveret.</summary>${byOrder(stale).map(l => orderHtml(l, false)).join('')}</details>` : ''}
      ${(() => {
        const ob = items.filter(it => it.overbought).sort((a, b) => b.overbought.x - a.overbought.x);
        if (!ob.length) return '';
        return `<h4>Købt mere end normalt · ${ob.length} varer (sidste 60 dage)</h4>
          <p class="muted" style="margin:0 0 4px">Planen regner med jeres normale forbrug fra før for disse varer, og foreslår dem ikke, før det ekstra er brugt. Tæl lageret under “Lager”, hvis I vil have det helt præcist.</p>
          <div class="card" style="padding:10px 14px"><ul>${ob.map(it => `<li><b>${it.overbought.x.toFixed(1).replace('.', ',')} ×</b> normalt · ${esc(nameOf(it))} <span class="muted">#${esc(it.code)}</span>: ${fmtNum(it.overbought.recentBase)} ${BASE_WORD(it)} mod normalt ca. ${fmtNum(it.overbought.normal)}${cart[it.code] ? ' <span class="pill soon">ligger også i kurven</span>' : ''}</li>`).join('')}</ul></div>`;
      })()}
      <h4>Leveret de sidste 14 dage · ${recentOrders.length} ordrer</h4>
      ${recentOrders.length ? recentOrders.map(l => orderHtml(l, false)).join('') : '<p class="muted">Ingen.</p>'}
      <p class="muted" style="margin-top:12px">Bygger på ordrehistorikken hentet ${fmtTime(histAt)}${fromCache ? ' (gemt kopi, fordi “Min konto” har logget dig ud)' : ''}.</p>`;
  }

  // Stock view: pallets on the shelf for your own boxes; the plan then counts from this instead of guessing.
  // Renewtech's own boxes: 250 per pallet (confirmed 01-10-2026). Other items: Antalis' pallet size when known.
  const defPer = it => (it.factors['Pallet(s)'] && !it.assumed.includes('Pallet(s)')) ? it.factors['Pallet(s)'] : (it.unique || !it.desc) ? 250 : Math.round(it.typicalBase) || 250;
  function renderStock() {
    const s = LS.get(STOCK_KEY) || {};
    const list = items.filter(it => GROUP[it.group]?.box || it.unique || !it.desc || s[it.code] || it.plan || it.overbought);
    const section = g => {
      const rows = list.filter(it => it.group === g.id).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'da', { numeric: true }));
      if (!rows.length) return '';
      return `<div class="grp ${g.box ? 'box' : ''}"><h3><i></i>${esc(g.name)}<span>${rows.length} varer</span></h3><div class="card"><table><thead><tr><th>Vare</th><th style="text-align:right">Paller nu</th><th style="text-align:right">Stk pr. palle</th><th style="text-align:right">Forbrug stk/uge</th><th>Sidst talt</th></tr></thead><tbody>${rows.map(it => {
        const v = s[it.code] || {};
        return `<tr data-code="${esc(it.code)}"><td><div class="nm">${esc(nameOf(it))}</div><div class="meta"><span class="dim">#${esc(it.code)}</span>${it.dims ? ' · <span class="dim">' + esc(it.dims) + '</span>' : ''}</div>${it.orders < 2 ? '<span class="why">Kun købt én gang i perioden: skriv forbruget, så kan den planlægges</span>' : ''}</td>
          <td class="qty"><input class="pal" type="number" min="0" step="0.5" value="${v.pallets ?? ''}" aria-label="Paller nu"></td>
          <td class="qty"><input class="per" type="number" min="1" value="${v.per || defPer(it)}" aria-label="Stk pr. palle"></td>
          <td class="qty"><input class="pw" type="number" min="0" step="1" value="${v.perWeek || ''}" placeholder="${it.rate > 0 ? Math.round(it.rate * 7) : '?'}" title="Lad stå tomt for at bruge planens eget tal (grå)" aria-label="Forbrug pr. uge"></td>
          <td>${v.at ? fmtDate(v.at) : ''}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
    };
    $('.stockp').innerHTML = `<p>Skriv hvor mange paller der står på lageret nu. Planen regner så fra jeres optælling i stedet for at gætte, og trækker forbruget fra dag for dag. Ret “Stk pr. palle”, hvis tallet ikke passer. Hvert tal gemmes med det samme i denne browser.</p>
      <input class="q" type="search" placeholder="Søg navn eller varenr." style="width:260px;text-align:left;font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:9px">
      ${GROUPS.map(section).join('')}
      <div style="display:flex;gap:12px;align-items:center"><button class="save">Færdig · vis planen</button><span class="saved" style="color:var(--ok);font-weight:600"></span></div>`;
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
      msg.style.color = ok ? 'var(--ok)' : 'var(--now)';
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
    const res = it => $(`.main tr[data-code="${CSS.escape(it.code)}"] td.res`) || { set textContent(v) {}, set innerHTML(v) {} };
    for (const it of todo) {
      const cell = res(it);
      if (cart[it.code]) { cell.innerHTML = '<span style="color:var(--info)">Lå allerede i kurven</span>'; continue; }
      cell.textContent = 'Lægger i kurven…';
      const p = picks.get(it.code), u0 = unitOf(it), need = Math.round(p.qty * factorOf(it));
      try {
        const units = await productUnits(it.code);
        const body = { prodcode: it.code, defaultQty: p.qty };
        if (units) {
          let u = units.find(x => x.desc === u0), q = p.qty;
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
        ok++; cell.innerHTML = `<span style="color:var(--ok)">✓ I kurven: ${c.qty} ${esc(UNIT_DA[c.unit] ? unitDa(c.unit, c.qty) : c.unit)}</span>`;
        const sent = LS.get(SENT_KEY) || {}, p = picks.get(it.code);
        sent[it.code] = { at: Date.now(), qty: p.qty, unit: unitOf(it), desc: it.desc };
        for (const k of Object.keys(sent)) if (Date.now() - sent[k].at > 90 * DAY) delete sent[k];
        LS.set(SENT_KEY, sent);
      }
      else cell.innerHTML = '<span style="color:var(--now)">✗ Kom ikke i kurven</span>';
      const box = $(`.main tr[data-code="${CSS.escape(it.code)}"] input[type=checkbox]`); if (box) { box.checked = false; box.disabled = true; }
      picks.get(it.code).on = false;
    }
    updateSum();
    $('.sum').innerHTML = `<b>${ok} af ${todo.length} ${todo.length === 1 ? 'vare' : 'varer'} ligger i kurven.</b> Gå til kurven for at sætte ordrereference og bestille.`;
  };

  render();
})();

})();
