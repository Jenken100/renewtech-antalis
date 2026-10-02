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
  { id: 'fold', name: 'Foldekasser', box: true },
  { id: 'pal', name: 'Pallekasser 80 og 100', box: true },
  { id: 'srv', name: 'Server- og specialkasser', box: true },
  { id: 'kor', name: 'Bundkortkasser', box: true },
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
  '704336': ['kor', 'Bundkort-indlæg (Korrvu)', '785×1116', 'ok'],
  '704335': ['fold', 'Foldekasse 2,5"', '513×336', 'ok'],
  '704337': ['fold', 'Foldekasse 3,5"', '260×180×40', 'ok'],
  '746306': ['fold', 'Større foldekasse', '', 'ok'],
  // Not a box, but the export has no description for it: name from the BC invoice text.
  '704389': ['tape', 'LDPE-folie', '', 'bc']
};
function classify(code, desc) {
  if (BOXES[code]) return BOXES[code][0];
  const d = desc.toLowerCase();
  if (/korrvu|korvu/.test(d)) return 'fold';
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
  C.weight = head.lastIndexOf('vægt') >= 0 ? head.lastIndexOf('vægt') : head.lastIndexOf('weight');
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
    rows.push({ order: order.no, date: order.date, ref: order.ref, user: order.user, item, desc: (r[C.desc] || '').trim(), deliv: parseDate(r[C.deliv]), status: (r[C.status] || '').trim(), qty: parseNum(r[C.qty]), unit: (r[C.unit] || '').trim(), price: C.price >= 0 ? parseNum(String(r[C.price] || '').replace(/[^\d,.\s ]/g, '')) || 0 : 0, kg: C.weight >= 0 ? parseNum(String(r[C.weight] || '').replace(/[^\d,.\s ]/g, '')) || 0 : 0 });
  }
  return rows;
}

// Every measurement Antalis puts in the description: inner and outer size, board, FEFCO type, bundle and pallet size.
function specOf(desc) {
  const d = String(desc || ''), sp = {};
  const dim = re => { const m = d.match(re); return m ? m[1].replace(/\s*x\s*/gi, '×').replace(/\s+/g, '') : ''; };
  sp.inner = dim(/indre dim:\s*([\d.,]+\s*x\s*[\d.,]+\s*x\s*[\d.,]+)/i);
  sp.outer = dim(/udvendig dim:\s*([\d.,]+\s*x\s*[\d.,]+\s*x\s*[\d.,]+)/i);
  if (!sp.inner && !sp.outer) sp.size = dim(/(\d{2,4}\s*x\s*\d{2,4}\s*x\s*\d{2,4}(?:\/\d{2,4})?)/i) || dim(/(\d{2,4}\s*x\s*\d{2,4})\s*mm/i);
  const win = d.match(/vindue\s*(\d{2,4})\s*x\s*(\d{2,4})/i); if (win) sp.window = win[1] + '×' + win[2];
  const board = d.match(/(\d)-lags,\s*([A-Z]{1,2})-flute(?:,\s*([\d.]+)\s*mm)?/i);
  if (board) sp.board = `${board[1]}-lags ${board[2].toUpperCase()}-bølge` + (board[3] ? `, ${parseFloat(board[3]).toLocaleString('da-DK')} mm` : '');
  const fefco = d.match(/FEFCO\s*(\d{4})/i); if (fefco) sp.fefco = fefco[1];
  const bundle = d.match(/bundt a (\d+)/i); if (bundle) sp.bundle = +bundle[1];
  const pallet = d.match(/palle a ([\d.]+)/i); if (pallet) sp.pallet = parseNum(pallet[1]);
  return sp;
}

// The measurements as short Danish parts, e.g. ['Indv. 440×320×250 mm', '1-lags C-bølge, 4 mm', 'FEFCO 0201', 'Bundt 25 stk', 'Palle 450 stk', '0,42 kg/stk'].
function specParts(it) {
  const sp = it.spec || {}, out = [], kg = it.kgEach;
  if (sp.outer && sp.outer !== sp.inner) out.push(`Udv. ${sp.outer} mm`);
  if (sp.inner) out.push(`Indv. ${sp.inner} mm`);
  if (!sp.inner && !sp.outer) out.push(sp.size || it.dims ? `${sp.size || it.dims} mm` : 'Mål ikke oplyst af Antalis');
  if (sp.window) out.push(`Vindue ${sp.window} mm`);
  if (sp.board) out.push(sp.board);
  if (sp.fefco) out.push(`FEFCO ${sp.fefco}`);
  if (sp.bundle) out.push(`Bundt ${sp.bundle} stk`);
  if (sp.pallet) out.push(`Palle ${sp.pallet.toLocaleString('da-DK')} stk`);
  if (kg) out.push(`${kg < 1 ? kg.toLocaleString('da-DK', { maximumFractionDigits: 3 }) : kg.toLocaleString('da-DK', { maximumFractionDigits: 2 })} kg/stk`);
  return out;
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
    // Weight per base unit from the export's line weight (median over the lines that have one).
    const kgs = lines.filter(l => l.kg > 0 && l.qty > 0 && factors[l.unit]).map(l => l.kg / (l.qty * factors[l.unit]));
    const spec = specOf(desc);
    if (factors['Pallet(s)'] && !spec.pallet && !assumed.includes('Pallet(s)')) spec.pallet = factors['Pallet(s)'];
    items.push({
      spec, kgEach: kgs.length ? median(kgs) : null,
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

if (typeof module !== 'undefined') module.exports = { parseExport, buildItems, plan, yearPlan, defaultClosed, UNIT_DA, DAY, GROUPS, BOXES, specOf, specParts };
