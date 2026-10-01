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
    // A stock count (opts.stock[code] = { base, at }) replaces the history before the count; later arrivals are added on top.
    const count = opts.stock && opts.stock[it.code];
    const arrivals = [...it.events].map(e => ({ at: e.deliv || e.date + it.lead * DAY, base: e.base })).sort((a, b) => a.at - b.at);
    let stock = 0, t = null;
    if (count) {
      stock = count.base; t = count.at;
      for (const e of arrivals.filter(e => e.at > count.at)) { stock = Math.max(0, stock - it.rate * (e.at - t) / DAY) + e.base; t = e.at; }
    } else {
      for (const e of arrivals) {
        if (t !== null) stock = Math.max(0, stock - it.rate * (e.at - t) / DAY);
        stock += e.base; t = e.at;
      }
    }
    it.counted = count || null;
    // Stock on the shelf today: same walk, but only deliveries that have arrived.
    let s2 = count ? count.base : 0, t2 = count ? count.at : null;
    for (const e of arrivals.filter(e => e.at <= today && (!count || e.at > count.at))) {
      if (t2 !== null) s2 = Math.max(0, s2 - it.rate * (e.at - t2) / DAY);
      s2 += e.base; t2 = e.at;
    }
    it.stockNow = t2 === null ? 0 : Math.max(0, s2 - it.rate * Math.max(0, today - t2) / DAY);
    const runout = t + (stock / it.rate) * DAY;
    const closed = opts.closed || [];
    const orderBy = latestOrder(runout - buffer * DAY, it.lead, closed);
    const plain = prevWeekday(runout - (it.lead + buffer) * DAY);
    it._closed = closed; it._buffer = buffer;
    const f = it.factors[it.orderUnit] || 1;
    const qty = Math.max(1, Math.ceil(it.typicalBase / f - 1e-9));
    const daysLeft = Math.round((orderBy - today) / DAY);
    it.state = daysLeft <= 0 ? 'now' : daysLeft <= horizon ? 'soon' : 'ok';
    // Not bought for far longer than usual: probably replaced or no longer used.
    it.inactive = (today - it.last.date) / DAY > Math.max(60, 3 * (it.every || 0));
    const open = it.events.filter(e => e.open && e.deliv && e.deliv >= today);
    it.onTheWay = open.length ? Math.max(...open.map(e => e.deliv)) : null;
    it.plan = { runout, orderBy, daysLeft, qty, unit: it.orderUnit, base: qty * f, lowData: it.orders < 3, holiday: orderBy < plain ? holidayBetween(orderBy, runout, closed) : null };
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
  if (!it.plan || it.inactive || !(it.rate > 0)) return [];
  const closed = it._closed || [], buffer = it._buffer ?? 3;
  const out = [], cover = Math.max(7, it.plan.base / it.rate) * DAY;
  let runout = it.plan.runout, at = it.plan.orderBy;
  for (let i = 0; at < today + days * DAY && i < 60; i++) {
    const plain = prevWeekday(runout - (it.lead + buffer) * DAY);
    const o = { at: Math.max(at, today), qty: it.plan.qty, unit: it.plan.unit, late: at < today, holiday: at < plain ? holidayBetween(at, runout, closed) : null };
    const prev = out[out.length - 1];
    if (prev && prev.at === o.at) { prev.qty += o.qty; prev.holiday = prev.holiday || o.holiday; } else out.push(o);
    runout += cover;
    at = latestOrder(runout - buffer * DAY, it.lead, closed);
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

if (typeof module !== 'undefined') module.exports = { parseExport, buildItems, plan, yearPlan, defaultClosed, UNIT_DA, DAY };
