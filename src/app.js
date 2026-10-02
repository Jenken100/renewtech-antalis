// Renewtech Antalis-bestilling: runs on antalis.dk when the bookmark is clicked.
// Reads the live order history, works out what to order and when, and fills the cart.
const APP_VERSION = '2.1';
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
const fmtDay = t => new Date(t).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const isoWeek = t => { const d = new Date(t), day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - y) / DAY - 3 + ((y.getUTCDay() + 6) % 7)) / 7); };
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
    table { border-collapse: collapse; width: 100%; table-layout: fixed; min-width: 900px }
    .card { overflow-x: auto }
    .main th:nth-child(1) { width: 40px } .main th:nth-child(3) { width: 130px } .main th:nth-child(4) { width: 200px } .main th:nth-child(5) { width: 120px } .main th:nth-child(6) { width: 160px } .main th:nth-child(7) { width: 120px }
    .stockp table { table-layout: auto; min-width: 0 }
    .cov { max-width: 100% }
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
    .warn { background: var(--soon-bg); color: var(--soon) }
    .warn button { margin-left: 8px; border: 1px solid var(--soon); background: #fff; color: var(--soon); border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit }
    .year h4, .ordered h4 { margin: 18px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted) }
    .year ul, .ordered ul { margin: 0; padding-left: 18px } .year li, .ordered li { margin: 3px 0 } .late { color: var(--now); font-weight: 600 }
    .box-ex { color: var(--muted); font-size: 12px }
    .stockp input { width: 72px; font: 600 14px var(--mono); padding: 6px 7px; border: 1px solid var(--line); border-radius: 7px; text-align: right }
    .stockp p { margin: 8px 0 10px; color: var(--muted) }
    .save { background: var(--navy); color: #fff; border: 0; border-radius: 9px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; margin-top: 12px }
    .muted { color: var(--muted) }
    .hero, .weeks, .tabs, .note, header, footer { flex-shrink: 0 }
    .hero { display: flex; gap: 12px; align-items: stretch; padding: 14px 20px 0 }
    .leads { flex: 1; display: grid; gap: 8px; min-width: 0 }
    .lead { background: var(--card); border: 1px solid var(--line); border-left: 5px solid var(--green); border-radius: 10px; padding: 10px 14px; display: grid; gap: 2px }
    .lead .big { font-size: 18px; font-weight: 700 } .lead.now { border-left-color: var(--now); background: var(--now-bg) } .lead.now .big { color: var(--now) }
    .lead.long { border-left-color: var(--yellow); padding: 8px 14px; font-size: 13.5px }
    .minis { display: grid; gap: 8px; align-content: start }
    .mini { font: inherit; text-align: left; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; cursor: pointer; color: var(--muted); white-space: nowrap }
    .mini b { color: var(--ink); font-size: 18px; margin-right: 4px } .mini:hover { border-color: var(--green) }
    .weeks { display: flex; gap: 6px; align-items: stretch; padding: 12px 20px 2px; overflow-x: auto }
    .weeks .wl { align-self: center; color: var(--muted); font-size: 12.5px; margin-right: 4px; white-space: nowrap }
    .wk { position: relative; flex: 1; min-width: 78px; font: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 9px; padding: 6px 8px; cursor: pointer; display: grid; text-align: center; color: var(--ink) }
    .wk .wn { font-size: 11.5px; color: var(--muted); white-space: nowrap } .wk .wc { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums }
    .wk.none .wc { color: var(--line) } .wk.sel { background: #E6F7F0; border-color: var(--green) } .wk.late .wc { color: var(--now) }
    .wk .dot { position: absolute; top: 6px; right: 6px; width: 7px; height: 7px; border-radius: 50%; background: var(--now) }
    .wk:hover { border-color: var(--green-d) }
    .tabs { align-items: center; margin-top: 10px } .tabs .find { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 9px; width: 210px; margin-left: 10px; background: #fff }
    .intro { color: var(--muted); margin: 12px 0 0 }
    .empty { margin: 18px 0; padding: 18px; background: var(--card); border: 1px dashed var(--line); border-radius: 10px; color: var(--muted) } .empty b { color: var(--ink) }
    .when b { display: block; font-size: 14.5px; white-space: nowrap } .when small { color: var(--muted); font-size: 12px; white-space: nowrap }
    .when.w-now b, .when.w-now small { color: var(--now) } .when.w-soon b { color: var(--soon) }
    .use { white-space: nowrap } .use b { font-weight: 600 } .use small { display: block; color: var(--muted); font-size: 12px }
    button.i { font: italic 700 11px Georgia, serif; width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--line); background: var(--soft); color: var(--muted); cursor: pointer; vertical-align: 2px; margin-left: 4px; padding: 0 }
    button.i[aria-expanded=true] { background: var(--navy); color: #fff; border-color: var(--navy) }
    .more { margin-top: 6px; padding: 8px 10px; background: var(--soft); border-radius: 8px; font-size: 12.5px; max-width: 70ch } .more p { margin: 0 0 4px }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(255px, 1fr)); gap: 10px }
    .bx { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: grid; gap: 8px; border-top: 4px solid var(--green) }
    .bx.st-soon { border-top-color: var(--yellow) } .bx.st-now { border-top-color: var(--now) } .bx.st-idle { border-top-color: var(--line) } .bx.on { box-shadow: 0 0 0 2px var(--green) }
    .bx-h { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start } .bx-h .nm { font-size: 16px } .bx-h .when { text-align: right }
    .bx-m { color: var(--muted); font-size: 12.5px }
    .bx-f { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-top: 1px solid var(--line); padding-top: 8px }
    .bx-f .qty small { display: block } label.pick { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; font-weight: 600 }
    .bx .res { font-size: 12.5px; font-weight: 600 } .bx .res:empty { display: none }
    .cov.big { width: auto } .cov.big .track { height: 12px } .cov .fill.idle { background: var(--line) }
    @media (max-width: 760px) { .hero { flex-direction: column } .cov { width: 110px } }
  </style>
  <div class="w">
  <div class="back"></div>
  <div class="win" role="dialog" aria-label="Renewtech Antalis-bestilling">
    <header><div><b>Antalis-bestilling</b><small>Renewtech · v${APP_VERSION}</small><span class="src"></span></div><button class="x" title="Luk" aria-label="Luk">×</button></header>
    <div class="hero" hidden></div>
    <div class="note warn" hidden></div>
    <div class="weeks" hidden></div>
    <div class="tabs" hidden><button data-v="list" aria-pressed="true">Bestil nu</button><button data-v="boxes" aria-pressed="false">Kasser</button><button data-v="year" aria-pressed="false">Årsplan</button><button data-v="ordered" aria-pressed="false">Bestilt</button><button data-v="stock" aria-pressed="false">Lager</button>
      <span class="spacer"></span><label class="all"><input type="checkbox" class="showall"> Vis alle varer</label><input class="find" type="search" placeholder="Søg navn eller varenr." aria-label="Søg"></div>
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
  // When it must be ordered, said the way people say it: weekday and date, then how far away.
  // Whole calendar days from today to the day of t (plan dates can carry a time of day).
  const endDot = t => /\.$/.test(t) ? t : t + '.';
  const dayDiff = t => Math.floor((t - todayUTC) / DAY);
  const rel = n => n < 0 ? `${-n} ${-n === 1 ? 'dag' : 'dage'} for sent` : n === 0 ? 'i dag' : n === 1 ? 'i morgen' : `om ${n} dage`;
  const whenCell = it => {
    if (!it.plan) return `<div class="when"><b class="muted">Kan ikke beregnes</b><small>Kun ${it.orders} køb</small></div>`;
    if (it.inactive) return `<div class="when"><b class="muted">Ikke i brug?</b><small>Ikke købt siden ${fmtDate(it.last.date)}</small></div>`;
    const p = it.plan, cls = it.state === 'now' ? 'w-now' : it.state === 'soon' ? 'w-soon' : 'w-ok';
    const d = dayDiff(p.orderBy);
    return `<div class="when ${cls}"><b>${d <= 0 ? 'Bestil nu' : fmtDay(p.orderBy)}</b><small>${d < 0 ? rel(d) : d === 0 ? 'senest i dag' : rel(d)}</small></div>`;
  };
  const weekTxt = it => { const week = (it.rateUsed || it.rate) * 7; return week >= 10 ? fmtNum(week) : week.toFixed(1).replace('.', ','); };
  const useCell = it => it.plan ? `<div class="use"><b>${weekTxt(it)}</b> ${BASE_WORD(it)}/uge<small>lev.tid ${it.plan.lead} d</small></div>` : `<div class="use muted">–<small>lev.tid ${it.lead} d</small></div>`;
  const why = it => {
    if (!it.plan) return `Købt ${it.orders} gang: ${fmtNum(it.last.base)} ${BASE_WORD(it)} ${fmtDate(it.last.date)}. Forbruget kan først regnes efter næste køb, eller skriv det under “Lager”.`;
    const bw = BASE_WORD(it);
    const leadTxt = it.longLead ? `leveringstid op til ${it.plan.lead} dage + ${it.plan.buffer} dages buffer` : `leveringstid ${it.lead} ${it.lead === 1 ? 'dag' : 'dage'} + ${it.plan.buffer} dages buffer`;
    const trendTxt = it.trend && Math.abs(it.trend - 1) >= 0.03 ? ` Forbruget ${it.trend > 1 ? 'stiger' : 'falder'} ca. ${Math.abs(Math.round((it.trend - 1) * 100))} % om måneden.` : '';
    const s = (LS.get(STOCK_KEY) || {})[it.code];
    const base = it.counted && s ? `Lager talt ${fmtDate(s.at)}: ${String(s.pallets).replace('.', ',')} paller (${fmtNum(s.pallets * s.per)} ${bw}), nu ca. ${fmtNum(it.stockNow)} ${bw}. ` : `Sidst bestilt ${fmtDate(it.last.date)}: ${fmtNum(it.last.base)} ${bw}. `;
    const use = it.rateManual ? `I har skrevet forbruget: ${weekTxt(it)} ${bw}/uge.` : it.overbought ? `Normalt forbrug ca. ${weekTxt(it)} ${bw}/uge (der er købt ekstra for nylig).` : `I bruger ca. ${weekTxt(it)} ${bw}/uge.`;
    return `${base}${use}${trendTxt} Lageret løber tør ca. ${endDot(fmtDay(it.plan.runout))} Med ${leadTxt} skal den bestilles senest ${endDot(fmtDay(it.plan.orderBy))}`;
  };
  // How long the stock lasts (including what is on its way), against how early it must be ordered.
  const COV_MAX = 120;
  const cover = (it, big) => {
    if (!it.plan) return '<span class="cov-none">Kan ikke beregnes endnu</span>';
    const left = dayDiff(it.plan.runout), need = it.plan.lead + it.plan.buffer;
    const w = Math.max(0, Math.min(left, COV_MAX)) / COV_MAX * 100, m = Math.min(need, COV_MAX) / COV_MAX * 100;
    const cls = it.inactive ? 'idle' : it.state === 'now' ? 'now' : it.state === 'soon' ? 'soon' : '';
    const title = `Løber tør ca. ${fmtDay(it.plan.runout)} (inkl. det der er på vej). Den sorte streg: skal bestilles ${need} dage før.`;
    return `<div class="cov${big ? ' big' : ''}" title="${esc(title)}"><div class="track"><i class="fill ${cls}" style="width:${w}%"></i><b class="mark" style="left:${m}%"></b></div><div class="t"><span>${left <= 0 ? '<b>Tom nu</b>' : `<b>${left > COV_MAX ? COV_MAX + '+' : left} dage</b>`}</span><span>tør ${fmtDate(it.plan.runout)}</span></div></div>`;
  };
  // The few flags that change what you do go on the row; the rest sit under (i).
  const mainFlags = it => [
    it.longLead ? `<span class="pill now">Lang lev.tid · ${it.plan ? it.plan.lead : it.lead} d</span>` : '',
    it.onTheWay ? `<span class="pill info">På vej · ${fmtDate(it.onTheWay)}</span>` : '',
    it.sentAfter ? `<span class="pill info">Lagt i kurven ${fmtTime(it.sentAfter.at)}</span>` : '',
    it.overbought ? `<span class="pill soon" title="Købt ${fmtNum(it.overbought.recentBase)} ${BASE_WORD(it)} de sidste 60 dage mod normalt ca. ${fmtNum(it.overbought.normal)}">Købt ekstra for nylig</span>` : '',
    it.plan && it.plan.holiday ? `<span class="pill soon">Før ${esc(it.plan.holiday)}</span>` : '',
    CONF_PILL[it.conf] || ''
  ].join('');
  const moreFlags = it => [
    it.unique ? '<span class="pill uniq">Kundeunik vare</span>' : '',
    it.plan && it.plan.lowData ? `<span class="pill plain">Kun ${it.orders} køb</span>` : '',
    it.assumed.length ? '<span class="pill plain">Omregning af enhed anslået</span>' : ''
  ].join('');
  const subOf = it => [`<a href="${WS}html/catalog/resultPage?keyWord=${esc(it.code)}" target="_blank" title="Åbn varen hos Antalis">#${esc(it.code)}</a>`, it.dims ? `<span class="dim">${esc(it.dims)}</span>` : ''].filter(Boolean).join(' · ');
  const qtyHtml = it => {
    const p = pickFor(it), f = factorOf(it), u = unitOf(it);
    return `<input type="number" min="0" value="${p.qty}" aria-label="Antal"> ${esc(unitDa(u, p.qty))}<small class="q-base">${f > 1 ? `= ${fmtNum(p.qty * f)} ${BASE_WORD(it)}` : ''}</small><small class="q-kr">${it.unitPrice ? `ca. DKK ${fmtKr(p.qty * f * it.unitPrice)}` : ''}</small>`;
  };
  const cartTxt = it => { const c = cart[it.code]; return c ? `<span style="color:var(--info)">I kurven: ${c.qty} ${esc(UNIT_DA[c.unit] ? unitDa(c.unit, c.qty) : c.unit)}</span>` : ''; };
  const checkHtml = it => { const p = pickFor(it), c = cart[it.code]; return `<input type="checkbox" aria-label="Vælg ${esc(nameOf(it))}" ${p.on ? 'checked' : ''} ${c ? 'disabled title="Ligger allerede i kurven"' : ''}>`; };
  const rowHtml = it => {
    const p = pickFor(it), full = it.name && it.title && !/ingen beskrivelse/.test(it.title) ? it.title : '';
    return `<tr data-code="${esc(it.code)}" class="${p.on ? '' : 'off'}">
      <td style="width:28px">${checkHtml(it)}</td>
      <td><div class="nm">${esc(nameOf(it))} <button class="i" type="button" aria-expanded="false" title="Hvorfor?">i</button></div><div class="meta">${subOf(it)}</div>${mainFlags(it) ? `<div class="flags">${mainFlags(it)}</div>` : ''}
        <div class="more" hidden><p>${why(it)}</p>${full ? `<p class="muted">Antalis: ${esc(full.slice(0, 140))}</p>` : ''}${moreFlags(it)}</div></td>
      <td>${whenCell(it)}</td>
      <td>${cover(it)}</td>
      <td>${useCell(it)}</td>
      <td class="qty">${qtyHtml(it)}</td>
      <td class="res">${cartTxt(it)}</td></tr>`;
  };
  const cardHtml = it => {
    const p = pickFor(it), cls = 'st-' + (!it.plan || it.inactive ? 'idle' : it.state);
    return `<div class="bx ${cls}${p.on ? ' on' : ''}" data-code="${esc(it.code)}">
      <div class="bx-h"><div><div class="nm">${esc(nameOf(it))}</div><div class="meta">${subOf(it)}</div></div>${whenCell(it)}</div>
      ${cover(it, true)}
      <div class="bx-m">${it.plan ? `${weekTxt(it)} ${BASE_WORD(it)}/uge · lev.tid ${it.plan.lead} d` : `Kun ${it.orders} køb · lev.tid ${it.lead} d`}</div>
      ${mainFlags(it) ? `<div class="flags">${mainFlags(it)}</div>` : ''}
      <div class="bx-f"><label class="pick">${checkHtml(it)} Vælg</label><span class="qty">${qtyHtml(it)}</span></div>
      <div class="res">${cartTxt(it)}</div></div>`;
  };
  const groupsHtml = (list, emptyTxt, cards) => {
    if (!list.length) return `<div class="empty">${emptyTxt}</div>`;
    return GROUPS.map(g => {
      const rows = list.filter(it => it.group === g.id);
      if (!rows.length) return '';
      const due = rows.filter(it => it.plan && !it.inactive && it.state !== 'ok').length;
      const head = `<h3><i></i>${esc(g.name)}<span>${rows.length} ${rows.length === 1 ? 'vare' : 'varer'}${due ? ` · <b>${due} skal bestilles</b>` : ''}</span></h3>`;
      if (cards) return `<div class="grp box">${head}<div class="cards">${rows.map(cardHtml).join('')}</div></div>`;
      return `<div class="grp ${g.box ? 'box' : ''}">${head}
        <div class="card"><table><thead><tr><th></th><th>Vare</th><th>Bestil senest</th><th>Lageret rækker</th><th>Forbrug</th><th style="text-align:right">Antal</th><th></th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table></div></div>`;
    }).join('');
  };
  const matches = it => !query || it.code.includes(query) || (nameOf(it) + ' ' + it.title + ' ' + it.dims).toLowerCase().includes(query);

  // Weeks: this week and the next seven, Monday to Sunday. The chosen week sets how far ahead the list looks.
  const DOW = (new Date(todayUTC).getUTCDay() + 6) % 7, WEEK0 = todayUTC - DOW * DAY, WEEKS = 8;
  let weekSel = 1;
  const horizonFor = w => Math.round((WEEK0 + (w + 1) * 7 * DAY - DAY - todayUTC) / DAY);
  horizon = horizonFor(weekSel);

  const render = () => {
    plan(items, todayUTC, { horizon, stock: stockOpts(), rate: rateOpts(), closed: closedNow() });
    const live = it => it.plan && !it.inactive && !cart[it.code] && !it.sentAfter;
    const planned = items.filter(it => live(it) && (it.orders >= 3 || it.counted || it.rateManual || it.longLead)).sort((a, b) => a.plan.orderBy - b.plan.orderBy);
    const nowList = planned.filter(it => it.plan.daysLeft <= 0 && !it.onTheWay);
    const longDue = items.filter(it => live(it) && it.longLead && it.plan.daysLeft > 0 && it.plan.daysLeft <= LONG_WARN);
    const names = (g, n = 3) => g.slice(0, n).map(it => `<b>${esc(nameOf(it))}</b>`).join(', ') + (g.length > n ? ` og ${g.length - n} mere` : '');
    // The one sentence that says what to do today.
    let lead;
    if (nowList.length) lead = `<div class="lead now"><span class="big">${nowList.length} ${nowList.length === 1 ? 'vare skal' : 'varer skal'} bestilles nu</span><span>${names(nowList, 4)}</span></div>`;
    else if (planned.length) {
      const first = planned[0], same = planned.filter(it => it.plan.orderBy <= first.plan.orderBy + 3 * DAY);
      lead = `<div class="lead"><span class="big">Intet skal bestilles i dag</span><span>Næste bestilling senest <b>${fmtDay(first.plan.orderBy)}</b> (${rel(dayDiff(first.plan.orderBy))}): ${names(same)}</span></div>`;
    } else lead = `<div class="lead"><span class="big">Intet skal bestilles</span><span>Ingen varer har nok køb til en plan endnu.</span></div>`;
    if (longDue.length) lead += `<div class="lead long"><span>Lang leveringstid: ${longDue.map(it => `<b>${esc(nameOf(it))}</b> senest ${fmtDay(it.plan.orderBy)}`).join(' · ')}</span></div>`;
    const wayN = items.filter(it => it.onTheWay).length, cartN = Object.keys(cart).length;
    $('.hero').hidden = false;
    $('.hero').innerHTML = `<div class="leads">${lead}</div><div class="minis"><button class="mini" data-go="ordered"><b>${wayN}</b> på vej</button><button class="mini" data-go="ordered"><b>${cartN}</b> i kurven</button></div>`;
    // Week timeline.
    const buckets = Array.from({ length: WEEKS }, () => []);
    for (const it of planned) { const w = Math.max(0, Math.floor((it.plan.orderBy - WEEK0) / (7 * DAY))); if (w < WEEKS) buckets[w].push(it); }
    $('.weeks').hidden = false;
    $('.weeks').innerHTML = `<span class="wl">Skal bestilles i</span>` + buckets.map((b, w) => {
      const late = b.some(it => it.plan.daysLeft <= 0), lng = b.some(it => it.longLead);
      const label = w === 0 ? 'Denne uge' : w === 1 ? 'Næste uge' : 'Uge ' + isoWeek(WEEK0 + w * 7 * DAY);
      const tip = b.length ? b.map(it => nameOf(it)).join(', ') : 'Intet';
      return `<button class="wk${w <= weekSel ? ' sel' : ''}${late ? ' late' : ''}${b.length ? '' : ' none'}" data-w="${w}" title="${esc(tip)}"><span class="wn">${label}</span><span class="wc">${b.length || '–'}</span>${lng ? '<i class="dot" title="Lang leveringstid"></i>' : ''}</button>`;
    }).join('');
    U.root.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { weekSel = +b.dataset.w; horizon = horizonFor(weekSel); picks.clear(); setView('list'); });
    U.root.querySelectorAll('[data-go]').forEach(b => b.onclick = () => setView(b.dataset.go));
    $('.tabs').hidden = false;
    $('.find').hidden = !(view === 'list' || view === 'boxes');
    $('label.all').hidden = view !== 'list';
    const mainView = view === 'list' || view === 'boxes';
    $('.main').hidden = !mainView; $('.year').hidden = view !== 'year'; $('.stockp').hidden = view !== 'stock'; $('.ordered').hidden = view !== 'ordered';
    $('footer').hidden = !mainView;
    U.msg('');
    if (!mainView) return view === 'year' ? renderYear() : view === 'ordered' ? renderOrdered() : renderStock();
    const untilTxt = weekSel === 0 ? 'i denne uge' : weekSel === 1 ? 'til og med næste uge' : 'til og med uge ' + isoWeek(WEEK0 + weekSel * 7 * DAY);
    let html;
    if (view === 'boxes') {
      const list = items.filter(it => GROUP[it.group] && GROUP[it.group].box && matches(it)).sort((a, b) => (a.plan && !a.inactive ? a.plan.orderBy : Infinity) - (b.plan && !b.inactive ? b.plan.orderBy : Infinity));
      html = `<p class="intro">Alle jeres kasser. Baren viser hvor mange dage lageret rækker, inkl. det der er på vej. Når den farvede del når den sorte streg, skal kassen bestilles.</p>` + groupsHtml(list, 'Ingen kasser fundet.', true);
    } else {
      const list = items.filter(it => matches(it) && it.plan && (showAll || query || (!it.inactive && (it.plan.daysLeft <= horizon || (it.longLead && it.plan.daysLeft <= LONG_WARN))) || cart[it.code])).sort((a, b) => (a.inactive - b.inactive) || (a.plan.orderBy - b.plan.orderBy));
      const next = planned.find(it => it.plan.daysLeft > horizon);
      const empty = `<b>Intet skal bestilles ${untilTxt}.</b>` + (next ? `<br>Næste er ${esc(nameOf(next))} senest ${fmtDay(next.plan.orderBy)}. Vælg en senere uge ovenfor for at se den.` : '');
      html = (list.length && !showAll && !query ? `<p class="intro">Varer der skal bestilles ${untilTxt}. Varer med flueben er klar til kurven. Tryk på <b>i</b> for at se udregningen.</p>` : '') + groupsHtml(list, empty, false);
    }
    $('.main').innerHTML = html;
    updateSum();
  };
  const chosen = () => items.filter(it => picks.get(it.code)?.on && picks.get(it.code).qty > 0 && !cart[it.code]);
  const updateSum = () => {
    const c = chosen(), n = c.length;
    const kr = c.reduce((s, it) => s + (it.unitPrice ? picks.get(it.code).qty * factorOf(it) * it.unitPrice : 0), 0);
    $('.sum').innerHTML = n ? `<b>${n} ${n === 1 ? 'vare' : 'varer'} valgt</b>${kr ? ` · ca. DKK ${fmtKr(kr)} ekskl. moms` : ''}` : 'Ingen varer valgt';
    $('.go').disabled = !n;
  };

  $('.main').addEventListener('click', e => {
    const b = e.target.closest('button.i'); if (!b) return;
    const more = b.closest('td').querySelector('.more'), open = more.hidden;
    more.hidden = !open; b.setAttribute('aria-expanded', open);
  });
  $('.main').addEventListener('change', e => {
    const row = e.target.closest('[data-code]'); if (!row) return;
    const p = picks.get(row.dataset.code);
    if (e.target.type === 'checkbox') { p.on = e.target.checked; row.classList.toggle('off', !p.on); row.classList.toggle('on', p.on); }
    if (e.target.type === 'number') {
      p.qty = Math.max(0, Math.round(+e.target.value || 0));
      const it = items.find(i => i.code === row.dataset.code);
      if (it) {
        const f = factorOf(it);
        row.querySelector('.q-base').textContent = f > 1 ? `= ${fmtNum(p.qty * f)} ${BASE_WORD(it)}` : '';
        row.querySelector('.q-kr').textContent = it.unitPrice ? `ca. DKK ${fmtKr(p.qty * f * it.unitPrice)}` : '';
      }
    }
    updateSum();
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
    const res = it => $(`.main [data-code="${CSS.escape(it.code)}"] .res`) || { set textContent(v) {}, set innerHTML(v) {} };
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
      const box = $(`.main [data-code="${CSS.escape(it.code)}"] input[type=checkbox]`); if (box) { box.checked = false; box.disabled = true; }
      picks.get(it.code).on = false;
    }
    updateSum();
    $('.sum').innerHTML = `<b>${ok} af ${todo.length} ${todo.length === 1 ? 'vare' : 'varer'} ligger i kurven.</b> Gå til kurven for at sætte ordrereference og bestille.`;
  };

  render();
})();
