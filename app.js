/* Budget Foyer — appli de suivi de budget partagée, hors ligne d'abord.
   Données locales : IndexedDB. Synchro : Supabase (table "records"). */
'use strict';

/* =========================================================
   1. Outils
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2));
const svg = (name, extra = '') => {
  const p = (typeof UI_ICONS !== 'undefined' && UI_ICONS[name]) || ICONS[name] || ICONS['circle-help'];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
};
const icBubble = (icon, color, cls = '') => `<span class="ic ${cls}" style="background:${esc(color || '#777')}">${svg(icon)}</span>`;
function toast(msg, ms = 2200) {
  $$('.toast').forEach(x => x.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

/* ---- Dates (chaînes AAAA-MM-JJ, heure locale) ---- */
const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dparse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => dstr(new Date());
const addDays = (s, n) => { const d = dparse(s); d.setDate(d.getDate() + n); return dstr(d); };
function addMonthsAnchored(s, n, anchorDay) {
  const d = dparse(s); const day = anchorDay || d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last)); return dstr(t);
}
function addPeriod(s, freq, every, anchor) {
  every = Math.max(1, every | 0 || 1);
  if (freq === 'day') return addDays(s, every);
  if (freq === 'week') return addDays(s, 7 * every);
  if (freq === 'year') return addMonthsAnchored(s, 12 * every, anchor);
  return addMonthsAnchored(s, every, anchor);
}
const FMT_DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const FMT_DAYY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const FMT_MONTH = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
const FMT_MSHORT = new Intl.DateTimeFormat('fr-FR', { month: 'short' });
const FMT_SHORT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const FMT_NUM = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/* ---- Montants ---- */
const CURRENCIES = {
  MGA: { sym: 'Ar', dec: 0, name: 'Ariary' }, EUR: { sym: '€', dec: 2, name: 'Euro' },
  USD: { sym: '$', dec: 2, name: 'Dollar US' }, MUR: { sym: 'Rs', dec: 2, name: 'Roupie mauricienne' },
  SCR: { sym: 'SR', dec: 2, name: 'Roupie seychelloise' }, ZAR: { sym: 'R', dec: 2, name: 'Rand' },
  KMF: { sym: 'FC', dec: 0, name: 'Franc comorien' }, CNY: { sym: '¥', dec: 2, name: 'Yuan' },
};
const curInfo = c => CURRENCIES[c] || { sym: c, dec: 2, name: c };
const nfCache = {};
const NF2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRate = (v, sign) => (sign && v > 0 ? '+' : '') + NF2.format(v) + ' Ar';
function fmt(v, cur, opts = {}) {
  if (v == null || isNaN(v)) return '—';
  if (S.meta.hide && !opts.force) return '•••• ' + curInfo(cur).sym;
  const ci = curInfo(cur); const k = ci.dec;
  const nf = nfCache[k] || (nfCache[k] = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: k, maximumFractionDigits: k }));
  return (opts.sign && v > 0 ? '+' : '') + nf.format(v) + ' ' + ci.sym;
}
/* Saisie de montant avec calcul simple : "12000+3500", "2,5*4" */
function evalAmount(str) {
  const s = String(str || '').replace(/\s| | /g, '').replace(/,/g, '.').replace(/[×x]/g, '*').replace(/÷/g, '/');
  if (!s) return null;
  if (!/^[0-9.+\-*/()]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i], eat = c => (s[i] === c ? (i++, true) : false);
  function num() {
    if (eat('(')) { const v = expr(); if (!eat(')')) throw 0; return v; }
    if (eat('-')) return -num();
    const m = /^[0-9]*\.?[0-9]+|^[0-9]+\.?/.exec(s.slice(i)); if (!m) throw 0; i += m[0].length; return parseFloat(m[0]);
  }
  function term() { let v = num(); for (;;) { if (eat('*')) v *= num(); else if (eat('/')) { const d = num(); if (!d) throw 0; v /= d; } else return v; } }
  function expr() { let v = term(); for (;;) { if (eat('+')) v += term(); else if (eat('-')) v -= term(); else return v; } }
  try { const v = expr(); if (i !== s.length || !isFinite(v)) return null; return Math.round(v * 100) / 100; } catch { return null; }
}

/* =========================================================
   2. Stockage local (IndexedDB)
   ========================================================= */
const IDB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('budget-foyer', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('records', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
      r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode) { return this.db.transaction(store, mode).objectStore(store); },
  all(store) { return new Promise((res, rej) => { const q = this.tx(store, 'readonly').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  allMeta() {
    return new Promise((res, rej) => {
      const out = {}; const q = this.tx('meta', 'readonly').openCursor();
      q.onsuccess = () => { const c = q.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); }; q.onerror = () => rej(q.error);
    });
  },
  putMany(store, items) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, 'readwrite'); const os = t.objectStore(store);
      items.forEach(it => os.put(it)); t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  },
  setMeta(k, v) { return new Promise(res => { const t = this.db.transaction('meta', 'readwrite'); t.objectStore('meta').put(v, k); t.oncomplete = res; }); },
  clear(store) { return new Promise(res => { const t = this.db.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = res; }); },
};

/* État global */
const S = {
  records: new Map(),       // id -> {id, kind, data, deleted, updated_at}
  outbox: new Set(),        // ids à envoyer
  meta: {},                 // réglages locaux de ce téléphone
  members: [],              // [{user_id, display_name}]
  tab: 'budget',
  period: { mode: 'month', anchor: todayStr(), from: null, to: null },
  budgetType: 'expense',
  opsFilter: 'all', opsSearch: '',
  chart: { gran: 'month', type: 'expense', sel: null },
  hooks: new Set(), _unread: new Map(), _ccount: {},
};
const setMeta = (k, v) => { S.meta[k] = v; return IDB.setMeta(k, v); };

function all(kind) {
  const out = [];
  for (const r of S.records.values()) if (r.kind === kind && !r.deleted) out.push({ ...r.data, id: r.id });
  return out;
}
const get = id => { const r = S.records.get(id); return r && !r.deleted ? { ...r.data, id } : null; };

let persistQ = [], persistT = null;
function persist(rec) {
  persistQ.push(rec);
  clearTimeout(persistT);
  persistT = setTimeout(async () => {
    const items = persistQ; persistQ = [];
    await IDB.putMany('records', items);
    await setMeta('outbox', [...S.outbox]);
  }, 30);
}
function put(kind, id, data, { silent = false } = {}) {
  id = id || uid();
  const clean = { ...data }; delete clean.id;
  const rec = { id, kind, data: clean, deleted: false, updated_at: new Date().toISOString() };
  S.records.set(id, rec); S.outbox.add(id); persist(rec);
  if (kind === 'fx') fxVer++;
  if (!silent) { scheduleSync(); render(); }
  return id;
}
function del(id) {
  const r = S.records.get(id); if (!r) return;
  const rec = { ...r, deleted: true, updated_at: new Date().toISOString() };
  S.records.set(id, rec); S.outbox.add(id); persist(rec); scheduleSync(); render();
}

/* =========================================================
   3. Données par défaut
   ========================================================= */
const PALETTE = ['#16a34a', '#22c55e', '#0d9488', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899',
  '#ef4444', '#f97316', '#eab308', '#ca8a04', '#84cc16', '#0ea5e9', '#64748b', '#a16207'];
function seed() {
  const cats = [
    ['Courses', 'shopping-basket', '#16a34a'], ['Restaurant', 'utensils', '#ca8a04'], ['Bières', 'beer', '#ca8a04'],
    ['Transport', 'bike', '#ef4444'], ['Sport', 'dumbbell', '#ca8a04'], ['Sorties', 'martini', '#ca8a04'],
    ['Odette', 'smile', '#d946ef'], ['Internet', 'wifi', '#ef4444'], ['Loyer', 'house', '#16a34a'],
    ['Gaz', 'flame', '#16a34a'], ['Famille', 'users', '#d946ef'], ['Santé', 'heart-pulse', '#ef4444'],
    ['Jirama', 'plug', '#16a34a'], ['Beauté', 'sparkles', '#d946ef'], ['Cadeaux', 'gift', '#d946ef'],
    ['Frais bancaires', 'receipt', '#ef4444'], ['Femme de ménage', 'spray-can', '#16a34a'], ['Matériel', 'briefcase', '#16a34a'],
    ['Don', 'hand-heart', '#d946ef'], ['Shopping', 'tag', '#d946ef'], ['Épargne', 'piggy-bank', '#3b82f6'], ['Autre', 'circle-help', '#64748b'],
  ];
  cats.forEach(([name, icon, color], i) => put('category', null, { name, icon, color, kind: 'expense', order: i }, { silent: true }));
  [['Salaire', 'hand-coins', '#3b82f6'], ['Autre revenu', 'coins', '#0d9488']]
    .forEach(([name, icon, color], i) => put('category', null, { name, icon, color, kind: 'income', order: i }, { silent: true }));
  const accs = [['Principal', 'MGA', 'banknote', '#16a34a'], ['Épargne Odette', 'MGA', 'piggy-bank', '#ec4899'],
    ['Épargne couple', 'MGA', 'piggy-bank', '#3b82f6'], ['Euros', 'EUR', 'euro', '#3b82f6']];
  accs.forEach(([name, currency, icon, color], i) => put('account', null, { name, currency, icon, color, initial: 0, inTotal: true, order: i }, { silent: true }));
  put('settings', 'settings', { base: 'MGA', rates: {} }, { silent: true });
}
const settings = () => get('settings') || { base: 'MGA', rates: {} };
const accounts = () => all('account').filter(a => !a.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
const categories = kind => all('category').filter(c => !kind || c.kind === kind).sort((a, b) => a.name.localeCompare(b.name, 'fr'));

/* Conversion vers la devise de référence (taux : 1 devise = x devise de référence) */
/* ---------------------------------------------------------
   Taux de change journaliers BFM (cours MID, ariary pour 1 devise)
   Source : API Frankfurter, fournisseur « bfm ». Stockés dans des
   enregistrements partagés « fx_<DEVISE>_<AAAA-MM> » ; le montant en
   devise des opérations n'est jamais modifié.
   --------------------------------------------------------- */
let fxVer = 0; const fxCache = {};
function fxSeries(cur) {
  const c = fxCache[cur]; if (c && c.ver === fxVer) return c;
  const days = {};
  for (const r of S.records.values()) if (r.kind === 'fx' && !r.deleted && r.data.cur === cur) Object.assign(days, r.data.days || {});
  const dates = Object.keys(days).sort(); const out = { ver: fxVer, dates, vals: dates.map(d => days[d]) };
  fxCache[cur] = out; return out;
}
/* Taux applicable à une date : celui du jour, sinon le dernier publié avant (week-ends, jours fériés) */
function fxOn(cur, date) {
  const st = settings(); if (st.base !== 'MGA' || st.autoFx === false) return null;
  const s = fxSeries(cur); if (!s.dates.length) return null;
  if (!date) { const i = s.dates.length - 1; return { rate: s.vals[i], date: s.dates[i], src: 'BFM' }; }
  let lo = 0, hi = s.dates.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= date) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return null; // date antérieure à l'historique disponible → taux manuel
  return { rate: s.vals[k], date: s.dates[k], src: 'BFM' };
}
/* Taux utilisé pour convertir : taux personnalisé de l'opération > BFM du jour > taux manuel */
function rateFor(cur, date, override) {
  const st = settings();
  if (!cur || cur === st.base) return { rate: 1, src: 'base' };
  if (Number(override) > 0) return { rate: Number(override), src: 'perso' };
  const f = fxOn(cur, date); if (f) return f;
  const r = Number(st.rates?.[cur]); return r > 0 ? { rate: r, src: 'manuel' } : null;
}
function toBase(v, cur, date, override) {
  const r = rateFor(cur, date, override); return r ? v * r.rate : null;
}
let fxBusy = false;
async function updateFx(force = false) {
  const st = settings();
  if (fxBusy || st.base !== 'MGA' || st.autoFx === false || !navigator.onLine) return;
  const curs = [...new Set(all('account').map(a => a.currency))].filter(c => c !== 'MGA');
  if (!curs.length) return;
  if (!force && S.meta.fxCheckedAt && Date.now() - new Date(S.meta.fxCheckedAt).getTime() < 3 * 3600e3) return;
  fxBusy = true;
  try {
    // point de départ : dernier taux connu (moins 7 jours) ou plus ancienne opération dans ces devises
    const accCur = {}; all('account').forEach(a => accCur[a.id] = a.currency);
    let from = null;
    for (const c of curs) {
      const sr = fxSeries(c); let f;
      if (sr.dates.length) f = addDays(sr.dates[sr.dates.length - 1], -7);
      else { const ds = txs().filter(t => accCur[t.account] === c || accCur[t.toAccount] === c).map(t => t.date).sort(); f = addDays(ds[0] || todayStr(), -10); if (f > addDays(todayStr(), -30)) f = addDays(todayStr(), -30); }
      if (!from || f < from) from = f;
    }
    const url = `https://api.frankfurter.dev/v2/rates?base=MGA&quotes=${curs.join(',')}&providers=bfm&from=${from}&to=${todayStr()}`;
    const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json(); if (!Array.isArray(rows)) throw new Error('réponse inattendue');
    const byRec = {};
    for (const r of rows) {
      if (!r || !r.quote || !(r.rate > 0) || r.quote === 'MGA') continue;
      const cur = r.quote.toUpperCase(); const val = Math.round((1 / r.rate) * 100) / 100; // ariary pour 1 unité
      const id = `fx_${cur}_${r.date.slice(0, 7)}`; (byRec[id] = byRec[id] || { cur, month: r.date.slice(0, 7), days: {} }).days[r.date] = val;
    }
    let n = 0;
    for (const [id, d] of Object.entries(byRec)) {
      const old = get(id); const days = { ...(old?.days || {}), ...d.days };
      if (!old || JSON.stringify(old.days) !== JSON.stringify(days)) { put('fx', id, { cur: d.cur, month: d.month, days }, { silent: true }); n++; }
    }
    await setMeta('fxCheckedAt', new Date().toISOString()); await setMeta('fxError', null);
    if (n) { scheduleSync(); render(); }
  } catch (e) { console.warn('Taux BFM', e); await setMeta('fxError', (e.message || String(e)) + ' — ' + new Date().toLocaleString('fr-FR')); }
  finally { fxBusy = false; }
}

/* =========================================================
   4. Calculs
   ========================================================= */
function txs() { return all('tx'); }
function accountBalance(a) {
  let b = Number(a.initial) || 0;
  for (const t of txs()) {
    const amt = Number(t.amount) || 0;
    if (t.type === 'expense' && t.account === a.id) b -= amt;
    else if (t.type === 'income' && t.account === a.id) b += amt;
    else if (t.type === 'transfer') {
      if (t.account === a.id) b -= amt;
      if (t.toAccount === a.id) b += (t.toAmount != null && t.toAmount !== '' ? Number(t.toAmount) : amt);
    }
  }
  return b;
}
function totalBalance() {
  let tot = 0, missing = false;
  for (const a of accounts()) { if (a.inTotal === false) continue; const v = toBase(accountBalance(a), a.currency); if (v == null) missing = true; else tot += v; }
  return { tot, missing };
}
function periodRange(p = S.period) {
  const a = dparse(p.anchor);
  if (p.mode === 'day') return [p.anchor, p.anchor];
  if (p.mode === 'week') { const wd = (a.getDay() + 6) % 7; const s = addDays(p.anchor, -wd); return [s, addDays(s, 6)]; }
  if (p.mode === 'month') return [dstr(new Date(a.getFullYear(), a.getMonth(), 1)), dstr(new Date(a.getFullYear(), a.getMonth() + 1, 0))];
  if (p.mode === 'year') return [`${a.getFullYear()}-01-01`, `${a.getFullYear()}-12-31`];
  return [p.from || p.anchor, p.to || p.anchor];
}
function periodLabel(p = S.period) {
  const [f, t] = periodRange(p);
  if (p.mode === 'day') return FMT_DAYY.format(dparse(f));
  if (p.mode === 'week') return `${FMT_SHORT.format(dparse(f))} – ${FMT_SHORT.format(dparse(t))} ${t.slice(0, 4)}`;
  if (p.mode === 'month') return FMT_MONTH.format(dparse(f));
  if (p.mode === 'year') return f.slice(0, 4);
  return `${FMT_NUM.format(dparse(f))} – ${FMT_NUM.format(dparse(t))}`;
}
function shiftPeriod(dir) {
  const p = S.period;
  if (p.mode === 'day') p.anchor = addDays(p.anchor, dir);
  else if (p.mode === 'week') p.anchor = addDays(p.anchor, 7 * dir);
  else if (p.mode === 'month') p.anchor = addMonthsAnchored(p.anchor, dir, 1);
  else if (p.mode === 'year') p.anchor = addMonthsAnchored(p.anchor, 12 * dir, 1);
  else { const [f, t] = periodRange(); const len = (dparse(t) - dparse(f)) / 864e5 + 1; p.from = addDays(f, dir * len); p.to = addDays(t, dir * len); }
  render();
}
/* Contexte d'affichage : compte sélectionné ou total (converti) */
function viewCtx() {
  const sel = S.meta.account || 'total';
  const acc = sel !== 'total' ? get(sel) : null;
  if (acc) return { acc, cur: acc.currency, match: t => t.account === acc.id || t.toAccount === acc.id, conv: (v) => v };
  const st = settings(); const inc = new Set(accounts().filter(a => a.inTotal !== false).map(a => a.id));
  const curOf = {}; all('account').forEach(a => curOf[a.id] = a.currency);
  return { acc: null, cur: st.base, match: t => inc.has(t.account), conv: (v, t) => toBase(v, curOf[t.account], t.date, t.fxRate) };
}
/* Dépense d'une catégorie sur une plage, tous comptes, convertie en devise de référence */
function catSpent(catId, from, to) {
  const curOf = {}; all('account').forEach(a => curOf[a.id] = a.currency); let s = 0;
  const evOut = new Set(all('event').filter(e => !e.inLimits).map(e => e.id)); // dépenses de voyage : hors plafonds mensuels (sauf choix contraire)
  for (const t of txs()) if (t.type === 'expense' && t.category === catId && t.date >= from && t.date <= to && !(t.event && evOut.has(t.event))) s += toBase(Number(t.amount) || 0, curOf[t.account], t.date, t.fxRate) || 0;
  return s;
}
const monthRange = d => { const a = dparse(d); return [dstr(new Date(a.getFullYear(), a.getMonth(), 1)), dstr(new Date(a.getFullYear(), a.getMonth() + 1, 0))]; };
function limitInfo(spent, limit, range) {
  const r = spent / limit; const st = r > 1 ? 'over' : r >= 0.8 ? 'warn' : 'ok';
  const today = todayStr(); let perDay = null;
  if (range && today >= range[0] && today <= range[1]) { const left = (dparse(range[1]) - dparse(today)) / 864e5 + 1; perDay = Math.max(0, limit - spent) / left; }
  return { r, st, left: limit - spent, perDay };
}
function limitBar(spent, limit, range) {
  const li = limitInfo(spent, limit, range); const base = settings().base;
  const col = { ok: 'var(--acc)', warn: '#f6c445', over: 'var(--red)' }[li.st];
  const txt = li.st === 'over' ? `Dépassé de ${fmt(-li.left, base)}` : `Reste ${fmt(li.left, base)}${li.perDay != null ? ` · ${fmt(li.perDay, base)}/j` : ''}`;
  return `<div class="lim"><i style="width:${Math.min(100, li.r * 100)}%;background:${col}"></i></div><div class="s" style="color:${li.st === 'ok' ? 'var(--mut)' : col}">${txt}</div>`;
}
/* Événements / voyages */
const events = () => all('event').sort((a, b) => (b.start || '').localeCompare(a.start || ''));
const activeEvent = () => (S.meta.activeEvent && get(S.meta.activeEvent)) || null;
function eventTotals(evId) {
  const curOf = {}; all('account').forEach(a => curOf[a.id] = a.currency);
  const list = txs().filter(t => t.event === evId && t.type !== 'transfer'); let exp = 0, inc = 0;
  list.forEach(t => { const v = toBase(Number(t.amount) || 0, curOf[t.account], t.date, t.fxRate) || 0; if (t.type === 'expense') exp += v; else inc += v; });
  return { list, exp, inc };
}
/* Commentaires (discussion sur une opération) */
const commentsOf = txId => all('comment').filter(c => c.tx === txId).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
function unreadComments() {
  const seen = S.meta.seen || {}; const me = S.meta.userId; const out = new Map();
  if (!me) return out;
  for (const c of all('comment')) { if (!c.by || c.by === me || !get(c.tx)) continue; if ((c.at || '') > (seen[c.tx] || '')) out.set(c.tx, (out.get(c.tx) || 0) + 1); }
  return out;
}
function memberName(by) { if (!by) return 'Moi'; if (by === S.meta.userId) return S.meta.myName || 'Moi'; return (S.members.find(x => x.user_id === by)?.display_name || '?'); }
function periodTxs(range = periodRange()) {
  const ctx = viewCtx(); const [f, t] = range;
  return txs().filter(x => x.date >= f && x.date <= t && ctx.match(x));
}
function byCategory(list, type) {
  const ctx = viewCtx(); const map = new Map(); let total = 0, missing = 0;
  for (const t of list) {
    if (t.type !== type) continue;
    const v = ctx.conv(Number(t.amount) || 0, t); if (v == null) { missing++; continue; }
    const k = t.category || '_none'; map.set(k, (map.get(k) || 0) + v); total += v;
  }
  const rows = [...map.entries()].map(([id, v]) => {
    const c = get(id) || { name: 'Sans catégorie', icon: 'circle-help', color: '#64748b' };
    return { id, name: c.name, icon: c.icon, color: c.color, v };
  }).sort((a, b) => b.v - a.v);
  return { rows, total, missing };
}

/* Paiements réguliers : génère les opérations échues (id déterministe = pas de doublon entre téléphones) */
function runRecurring() {
  const today = todayStr(); let n = 0;
  for (const r of all('recurring')) {
    if (!r.active || !r.next) continue;
    let d = r.next, guard = 0;
    while (d <= today && guard++ < 500) {
      if (r.end && d > r.end) break;
      const id = 'r_' + r.id + '_' + d;
      if (!S.records.has(id)) {
        put('tx', id, { type: r.type, amount: r.amount, account: r.account, toAccount: r.toAccount || null, toAmount: r.toAmount ?? null,
          category: r.category || null, date: d, note: r.note || r.name || '', by: S.meta.userId || null, recurring: r.id }, { silent: true });
        n++;
      }
      d = addPeriod(d, r.freq, r.every, r.anchor);
    }
    if (d !== r.next) put('recurring', r.id, { ...r, next: d, active: r.end && d > r.end ? false : r.active }, { silent: true });
  }
  if (n) { toast(`${n} paiement(s) régulier(s) ajouté(s)`); scheduleSync(); }
}

/* =========================================================
   5. Synchronisation Supabase
   ========================================================= */
let sb = null, syncing = false, syncTimer = null, syncState = 'off', syncErr = '';
function setSync(st, err = '') {
  syncState = st; syncErr = err;
  const d = $('#syncdot'); if (d) { d.className = 'syncdot ' + st; d.title = { ok: 'Synchronisé', busy: 'Synchronisation…', err: 'Erreur : ' + err, off: 'Mode local (pas de synchro)' }[st] || ''; }
}
function initSupabase() {
  const c = S.meta.config;
  if (!c?.url || !c?.key || typeof supabase === 'undefined') { sb = null; return; }
  try { sb = supabase.createClient(c.url.trim(), c.key.trim(), { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'bf-auth' } }); }
  catch (e) { sb = null; toast('Configuration Supabase invalide'); }
}
async function currentUser() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data?.session?.user || null;
}
async function loadMembership() {
  const u = await currentUser(); if (!u) return null;
  if (S.meta.userId !== u.id) await setMeta('userId', u.id);
  const { data, error } = await sb.from('members').select('household_id, display_name, households(id,name,join_code)').eq('user_id', u.id).limit(1);
  if (error) throw error;
  if (!data?.length) return null;
  const hh = { id: data[0].household_id, name: data[0].households?.name, join_code: data[0].households?.join_code };
  await setMeta('household', hh);
  return hh;
}
function scheduleSync(delay = 800) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, delay); }
async function sync() {
  if (!sb || !S.meta.household) { setSync('off'); return; }
  if (!navigator.onLine) { setSync('err', 'hors ligne'); return; }
  if (syncing) { scheduleSync(1500); return; }
  syncing = true; setSync('busy');
  const hid = S.meta.household.id;
  try {
    const u = await currentUser(); if (!u) throw new Error('non connecté');
    // 1) Envoi
    const ids = [...S.outbox].filter(id => { if (S.records.has(id)) return true; S.outbox.delete(id); return false; });
    const snap = new Map(ids.map(id => [id, S.records.get(id).updated_at]));
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400).map(id => { const r = S.records.get(id); return { id, household_id: hid, kind: r.kind, data: r.data, deleted: !!r.deleted }; });
      const { error } = await sb.from('records').upsert(chunk);
      if (error) throw error;
      chunk.forEach(c => { if (S.records.get(c.id)?.updated_at === snap.get(c.id)) S.outbox.delete(c.id); });
    }
    await setMeta('outbox', [...S.outbox]);
    // 2) Réception
    let cursor = S.meta.lastPull ? new Date(new Date(S.meta.lastPull).getTime() - 120000).toISOString() : '1970-01-01T00:00:00Z';
    let maxSeen = S.meta.lastPull || null, changed = 0;
    for (let page = 0; page < 200; page++) {
      const { data, error } = await sb.from('records').select('id,kind,data,deleted,updated_at')
        .eq('household_id', hid).gt('updated_at', cursor).order('updated_at', { ascending: true }).limit(1000);
      if (error) throw error;
      const toSave = [];
      for (const row of data) {
        if (S.outbox.has(row.id)) continue;
        const cur = S.records.get(row.id);
        if (cur && cur.updated_at === row.updated_at && cur.deleted === row.deleted) continue;
        const rec = { id: row.id, kind: row.kind, data: row.data || {}, deleted: row.deleted, updated_at: row.updated_at };
        S.records.set(row.id, rec); toSave.push(rec); changed++; if (row.kind === 'fx') fxVer++;
      }
      if (toSave.length) await IDB.putMany('records', toSave);
      if (data.length) { cursor = data[data.length - 1].updated_at; if (!maxSeen || cursor > maxSeen) maxSeen = cursor; }
      if (data.length < 1000) break;
    }
    if (maxSeen) await setMeta('lastPull', maxSeen);
    // 3) Membres (pour afficher qui a saisi quoi)
    const m = await sb.from('members').select('user_id, display_name').eq('household_id', hid);
    if (!m.error) { S.members = m.data; await setMeta('members', m.data); }
    await setMeta('lastSync', new Date().toISOString());
    setSync('ok');
    if (changed) { runRecurring(); render(); }
  } catch (e) {
    console.warn(e); setSync('err', e.message || String(e));
  } finally { syncing = false; }
  if (S.outbox.size) scheduleSync(5000);
}

/* =========================================================
   6. Feuilles (fenêtres du bas) avec gestion du bouton retour Android
   ========================================================= */
const sheetStack = [];
const USE_HISTORY = window.self === window.top; // dans une page intégrée (aperçu), pas d'historique
function openSheet(title, bodyHtml, onMount) {
  const host = $('#sheets');
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const sh = document.createElement('div'); sh.className = 'sheet';
  sh.innerHTML = `<div class="grab"></div><div class="shd"><h3>${esc(title)}</h3><button class="iconbtn" data-close>${svg('x')}</button></div><div class="sbody">${bodyHtml}</div>`;
  host.append(scrim, sh);
  const entry = { sh, scrim, closed: false };
  sheetStack.push(entry);
  if (USE_HISTORY) history.pushState({ sheet: sheetStack.length }, '');
  requestAnimationFrame(() => { scrim.classList.add('show'); sh.classList.add('show'); });
  scrim.onclick = () => closeSheet(); $('[data-close]', sh).onclick = () => closeSheet();
  if (onMount) onMount(sh, entry);
  return sh;
}
function removeTop() {
  const e = sheetStack.pop(); if (!e) return;
  e.sh.classList.remove('show'); e.scrim.classList.remove('show');
  setTimeout(() => { e.sh.remove(); e.scrim.remove(); }, 230);
}
let popWaiters = [];
function closeSheet() {
  return new Promise(res => { if (!sheetStack.length) return res(); if (!USE_HISTORY) { removeTop(); return res(); } popWaiters.push(res); history.back(); });
}
function closeAllSheets() {
  return new Promise(res => { const n = sheetStack.length; if (!n) return res(); if (!USE_HISTORY) { while (sheetStack.length) removeTop(); return res(); } popWaiters.push(res); history.go(-n); });
}
window.addEventListener('popstate', () => {
  const depth = history.state?.sheet || 0;
  while (sheetStack.length > depth) removeTop();
  const w = popWaiters; popWaiters = []; w.forEach(f => f());
});
function confirmSheet(msg, okLabel, onOk, danger = true) {
  openSheet('Confirmer', `<p>${esc(msg)}</p><div class="btns"><button class="btn sec" data-no>Annuler</button><button class="btn ${danger ? 'danger' : ''}" data-ok>${esc(okLabel)}</button></div>`,
    sh => { $('[data-no]', sh).onclick = closeSheet; $('[data-ok]', sh).onclick = async () => { await closeSheet(); onOk(); }; });
}

/* =========================================================
   7. Rendu des écrans
   ========================================================= */
function renderHeader() {
  const sel = S.meta.account || 'total'; const acc = sel !== 'total' ? get(sel) : null;
  $('#hAcctIc').innerHTML = acc ? icBubble(acc.icon, acc.color, 'sm') : icBubble('wallet', '#2f6b52', 'sm');
  $('#hAcctName').textContent = acc ? acc.name : 'Total';
  if (acc) { $('#hBalance').textContent = fmt(accountBalance(acc), acc.currency); $('#hBalanceSub').textContent = ''; }
  else { const { tot, missing } = totalBalance(); $('#hBalance').textContent = fmt(tot, settings().base); $('#hBalanceSub').textContent = missing ? 'taux manquant' : ''; }
  $('#eyeBtn').innerHTML = svg(S.meta.hide ? 'eye-off' : 'eye');
}
function periodBar() {
  const modes = [['day', 'Jour'], ['week', 'Semaine'], ['month', 'Mois'], ['year', 'Année'], ['custom', 'Période']];
  return `<div class="seg">${modes.map(([k, l]) => `<button data-pmode="${k}" class="${S.period.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  <div class="pnav"><button class="iconbtn" data-act="prev">${svg('chevron-left')}</button>
  <button class="lbl" data-act="pickPeriod">${esc(periodLabel())}</button>
  <button class="iconbtn" data-act="next">${svg('chevron-right')}</button></div>`;
}
function donut(rows, total) {
  const R = 80, C = 2 * Math.PI * R; let off = 0; const gap = rows.length > 1 ? 1.5 : 0;
  const segs = total > 0 ? rows.map(r => {
    const len = (r.v / total) * C; const s = `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${esc(r.color)}" stroke-width="34"
      stroke-dasharray="${Math.max(0, len - gap)} ${C}" stroke-dashoffset="${-off}" data-cat="${esc(r.id)}" style="cursor:pointer"/>`;
    off += len; return s;
  }).join('') : `<circle r="${R}" cx="100" cy="100" fill="none" stroke="#33392f" stroke-width="34"/>`;
  return `<svg viewBox="0 0 200 200"><g transform="rotate(-90 100 100)">${segs}</g>
    <circle r="56" cx="100" cy="100" fill="none" stroke="#4a5245" stroke-width="1.5" stroke-dasharray="5 5"/></svg>`;
}
function renderBudget() {
  const ctx = viewCtx(); const list = periodTxs(); const type = S.budgetType;
  const { rows, total, missing } = byCategory(list, type);
  const inc = byCategory(list, 'income').total, exp = byCategory(list, 'expense').total;
  // Plafonds : vue Total, dépenses, par mois ou par année
  const showLim = type === 'expense' && !ctx.acc && (S.period.mode === 'month' || S.period.mode === 'year');
  const factor = S.period.mode === 'year' ? 12 : 1; const range = periodRange();
  let limSummary = '';
  if (showLim) {
    categories('expense').filter(c => Number(c.limit) > 0 && !rows.some(r => r.id === c.id))
      .forEach(c => rows.push({ id: c.id, name: c.name, icon: c.icon, color: c.color, v: 0 }));
    let over = 0, warn = 0;
    rows.forEach(r => { const c = get(r.id); if (c && Number(c.limit) > 0) { const st = limitInfo(catSpent(c.id, range[0], range[1]), c.limit * factor).st; if (st === 'over') over++; else if (st === 'warn') warn++; } });
    if (over || warn) limSummary = `<div class="note ${over ? 'warn' : ''}">${svg('gauge', 'style="width:16px;height:16px;display:inline;vertical-align:-3px"')} Plafonds : ${over ? over + ' dépassé(s)' : ''}${over && warn ? ', ' : ''}${warn ? warn + ' à plus de 80 %' : ''}</div>`;
  }
  const limHtml = r => { if (!showLim) return ''; const c = get(r.id); if (!c || !(Number(c.limit) > 0)) return ''; return limitBar(catSpent(c.id, range[0], range[1]), c.limit * factor, range); };
  return `<div class="card">
    <div class="seg big ${type === 'expense' ? 'exp' : 'inc'}"><button data-btype="expense" class="${type === 'expense' ? 'on' : ''}">Dépenses</button><button data-btype="income" class="${type === 'income' ? 'on' : ''}">Revenus</button></div>
    <div style="margin-top:10px">${periodBar()}</div>
    <div class="donutwrap">${donut(rows, total)}<div class="dcenter"><div><b>${fmt(total, ctx.cur)}</b><span>${type === 'expense' ? 'dépensé' : 'reçu'}</span></div></div></div>
    <div class="net"><div>Revenus<b class="amt pos">${fmt(inc, ctx.cur)}</b></div><div>Dépenses<b>${fmt(exp, ctx.cur)}</b></div><div>Solde<b class="${inc - exp >= 0 ? 'amt pos' : ''}">${fmt(inc - exp, ctx.cur, { sign: true })}</b></div></div>
    ${missing ? `<div class="note warn">${missing} opération(s) ignorée(s) : taux de change manquant (Plus › Devises).</div>` : ''}
    ${limSummary}
  </div>
  <div class="list">${rows.length ? rows.map(r => `<button class="row" data-catdetail="${esc(r.id)}">${icBubble(r.icon, r.color)}
    <div class="main"><div class="t">${esc(r.name)}</div>${limHtml(r)}</div><span class="pct">${total ? Math.round(r.v / total * 100) : 0} %</span><span class="amt">${fmt(r.v, ctx.cur)}</span></button>`).join('')
    : `<div class="empty">Aucune ${type === 'expense' ? 'dépense' : 'recette'} sur cette période.<br>Appuie sur <b>+</b> pour en ajouter.</div>`}</div>`;
}
function memberTag(by) {
  if (!by || S.members.length < 2) return '';
  const m = S.members.find(x => x.user_id === by); const n = (m?.display_name || '?').trim();
  return `<span class="who">${esc(n.slice(0, 2))}</span>`;
}
function txRow(t, ctx = viewCtx()) {
  const c = get(t.category); const a = get(t.account); const a2 = get(t.toAccount);
  let ic, title, sub, cls, amt;
  if (t.type === 'transfer') {
    ic = icBubble('arrow-left-right', '#64748b'); title = t.note || 'Virement'; sub = `${a?.name || '?'} → ${a2?.name || '?'}`; cls = 'tr';
    const out = ctx.acc && t.account === ctx.acc.id; const inn = ctx.acc && t.toAccount === ctx.acc.id;
    amt = inn && !out ? fmt(t.toAmount != null && t.toAmount !== '' ? Number(t.toAmount) : Number(t.amount), ctx.acc.currency, { sign: true })
      : fmt(out ? -Number(t.amount) : Number(t.amount), a?.currency);
  } else {
    ic = c ? icBubble(c.icon, c.color) : icBubble('circle-help', '#64748b');
    const eq = a && a.currency !== settings().base ? toBase(Number(t.amount), a.currency, t.date, t.fxRate) : null;
    title = c?.name || 'Sans catégorie'; sub = [t.note, (!ctx.acc && a) ? a.name : '', eq != null ? '≈ ' + fmt(eq, settings().base) : '', get(t.event) ? '✈ ' + get(t.event).name : ''].filter(Boolean).join(' · ');
    cls = t.type === 'income' ? 'pos' : 'neg';
    amt = fmt(t.type === 'income' ? Number(t.amount) : -Number(t.amount), a?.currency, { sign: true });
  }
  const nc = (S._ccount || {})[t.id] || 0; const un = (S._unread && S._unread.get(t.id)) || 0;
  const cb = nc ? `<span class="who cmt ${un ? 'new' : ''}">${svg('message-circle', 'style="width:12px;height:12px;display:inline;vertical-align:-2px"')} ${nc}</span>` : '';
  return `<button class="row" data-tx="${esc(t.id)}">${ic}<div class="main"><div class="t">${esc(title)}${t.recurring ? ' ' + '<span class="who">↻</span>' : ''}${memberTag(t.by)}${cb}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div><span class="amt ${cls}">${amt}</span></button>`;
}
function txList(list) {
  if (!list.length) return `<div class="empty">Aucune opération.</div>`;
  list.sort((a, b) => b.date.localeCompare(a.date) || (b.created || '').localeCompare(a.created || ''));
  const ctx = viewCtx(); let html = '', cur = null, buf = [];
  const flush = () => {
    if (!cur) return;
    let net = 0, ok = true;
    for (const t of buf) { if (t.type === 'transfer') continue; const v = ctx.conv(Number(t.amount), t); if (v == null) { ok = false; continue; } net += t.type === 'income' ? v : -v; }
    html += `<div class="dayhdr"><span>${esc(FMT_DAY.format(dparse(cur)))}${cur.slice(0, 4) !== todayStr().slice(0, 4) ? ' ' + cur.slice(0, 4) : ''}</span><span>${buf.some(t => t.type !== 'transfer') ? fmt(net, ctx.cur, { sign: true }) + (ok ? '' : ' *') : ''}</span></div>` + buf.map(t => txRow(t, ctx)).join('');
  };
  for (const t of list) { if (t.date !== cur) { flush(); cur = t.date; buf = []; } buf.push(t); }
  flush(); return html;
}
function renderOps() {
  const f = S.opsFilter; const q = S.opsSearch.trim().toLowerCase();
  let list = periodTxs();
  if (f === 'comments') list = txs().filter(t => S._ccount[t.id]).filter(t => viewCtx().match(t));
  else if (f !== 'all') list = list.filter(t => t.type === f);
  if (q) list = list.filter(t => {
    const c = get(t.category), a = get(t.account), e = get(t.event);
    return [t.note, c?.name, a?.name, e?.name, String(t.amount), ...commentsOf(t.id).map(x => x.text)].some(x => x && String(x).toLowerCase().includes(q));
  });
  const nUn = S._unread.size;
  const chips = [['all', 'Tout'], ['expense', 'Dépenses'], ['income', 'Revenus'], ['transfer', 'Virements'], ['comments', `Discussions${nUn ? ' (' + nUn + ' non lue' + (nUn > 1 ? 's' : '') + ')' : ''}`]];
  return `<div class="card">${periodBar()}
    <input class="search" type="search" placeholder="Rechercher (note, catégorie, montant…)" value="${esc(S.opsSearch)}" data-search>
    <div class="chips" style="margin-top:10px">${chips.map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-opsf="${k}">${l}</button>`).join('')}</div></div>
    ${f === 'comments' ? '<div class="note">Toutes les opérations commentées, quelle que soit la période.</div>' : ''}
    <div class="list" style="gap:6px">${txList(list)}</div>`;
}
function renderCharts() {
  const ch = S.chart; const ctx = viewCtx(); const anchor = dparse(S.period.anchor);
  const buckets = [];
  if (ch.gran === 'month') {
    for (let i = 11; i >= 0; i--) { const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
      buckets.push({ key: dstr(d).slice(0, 7), label: ['jan', 'fév', 'mar', 'avr', 'mai', 'jun', 'jul', 'aoû', 'sep', 'oct', 'nov', 'déc'][d.getMonth()], from: dstr(d), to: dstr(new Date(d.getFullYear(), d.getMonth() + 1, 0)), title: FMT_MONTH.format(d) }); }
  } else {
    for (let i = 5; i >= 0; i--) { const y = anchor.getFullYear() - i; buckets.push({ key: '' + y, label: '' + y, from: `${y}-01-01`, to: `${y}-12-31`, title: '' + y }); }
  }
  const data = buckets.map(b => {
    const list = periodTxs([b.from, b.to]);
    const e = byCategory(list, 'expense'), i = byCategory(list, 'income');
    return { ...b, exp: e, inc: i, net: i.total - e.total };
  });
  let max = 0;
  data.forEach(d => { max = Math.max(max, ch.type === 'net' ? Math.abs(d.net) : (ch.type === 'expense' ? d.exp.total : d.inc.total)); });
  max = max || 1;
  const selKey = ch.sel && data.some(d => d.key === ch.sel) ? ch.sel : data[data.length - 1].key;
  const bars = data.map(d => {
    let inner = '';
    if (ch.type === 'net') {
      const h = Math.abs(d.net) / max * 100;
      inner = `<div class="bar ${d.key === selKey ? 'on' : ''}" style="height:${h}%"><i style="height:100%;background:${d.net >= 0 ? '#22c55e' : '#ef4444'}"></i></div>`;
    } else {
      const src = ch.type === 'expense' ? d.exp : d.inc; const h = src.total / max * 100;
      inner = `<div class="bar ${d.key === selKey ? 'on' : ''}" style="height:${h}%">${src.rows.map(r => `<i style="height:${r.v / (src.total || 1) * 100}%;background:${esc(r.color)}"></i>`).join('')}</div>`;
    }
    return `<div class="barcol" data-bar="${d.key}">${inner}</div>`;
  }).join('');
  const sd = data.find(d => d.key === selKey);
  const vals = data.map(d => ch.type === 'net' ? d.net : (ch.type === 'expense' ? d.exp.total : d.inc.total));
  const nonZero = vals.filter(v => v !== 0); const avg = nonZero.length ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length : 0;
  let detail = '';
  if (ch.type === 'net') {
    detail = `<div class="row"><div class="main"><div class="t">Revenus</div></div><span class="amt pos">${fmt(sd.inc.total, ctx.cur)}</span></div>
      <div class="row"><div class="main"><div class="t">Dépenses</div></div><span class="amt">${fmt(sd.exp.total, ctx.cur)}</span></div>
      <div class="row"><div class="main"><div class="t">Solde</div></div><span class="amt ${sd.net >= 0 ? 'pos' : ''}">${fmt(sd.net, ctx.cur, { sign: true })}</span></div>`;
  } else {
    const src = ch.type === 'expense' ? sd.exp : sd.inc;
    detail = src.rows.length ? src.rows.map(r => `<div class="row">${icBubble(r.icon, r.color, 'sm')}<div class="main"><div class="t">${esc(r.name)}</div></div><span class="pct">${Math.round(r.v / src.total * 100)} %</span><span class="amt">${fmt(r.v, ctx.cur)}</span></div>`).join('') : `<div class="empty">Rien sur cette période.</div>`;
  }
  return `<div class="card">
    <div class="seg"><button data-cgran="year" class="${ch.gran === 'year' ? 'on' : ''}">Par année</button><button data-cgran="month" class="${ch.gran === 'month' ? 'on' : ''}">Par mois</button></div>
    <div class="chips" style="margin:12px 0 8px">${[['expense', 'Dépenses'], ['income', 'Revenus'], ['net', 'Solde']].map(([k, l]) => `<button class="chip ${ch.type === k ? 'on' : ''}" data-ctype="${k}">${l}</button>`).join('')}</div>
    <div class="bars">${bars}</div>
    <div class="blbls">${data.map(d => `<span>${esc(d.label)}</span>`).join('')}</div>
    <div class="net" style="margin-top:12px"><div>Moyenne ${ch.gran === 'month' ? 'mensuelle' : 'annuelle'}<b>${fmt(avg, ctx.cur, { sign: ch.type === 'net' })}</b></div></div>
  </div>
  <div class="h2" style="text-transform:none;font-size:15px;color:var(--txt)">${esc(sd.title)} — ${fmt(ch.type === 'net' ? sd.net : (ch.type === 'expense' ? sd.exp.total : sd.inc.total), ctx.cur, { sign: ch.type === 'net' })}</div>
  <div class="list" style="margin-top:4px">${detail}</div>`;
}
function renderMore() {
  const items = [
    ['accounts', 'wallet', 'Comptes', `${accounts().length} compte(s)`],
    ['categories', 'tags', 'Catégories', `${categories().length} catégorie(s)`],
    ['recurring', 'repeat', 'Paiements réguliers', `${all('recurring').filter(r => r.active).length} actif(s)`],
    ['currencies', 'coins', 'Devises et taux de change', (() => { const f = fxOn('EUR'); return f ? `1 € = ${fmtRate(f.rate)} (BFM ${FMT_SHORT.format(dparse(f.date))})` : `Référence : ${settings().base}`; })()],
    ['importexport', 'file-spreadsheet', 'Import / Export', 'CSV, sauvegarde'],
    ['syncsetup', S.meta.household ? 'cloud' : 'cloud-off', 'Synchronisation à deux', S.meta.household ? `Foyer « ${S.meta.household.name || ''} »` : 'Mode local — à configurer'],
    ['events', 'plane', 'Voyages et événements', activeEvent() ? `Mode voyage actif : ${activeEvent().name}` : `${events().length} événement(s)`],
    ['limits', 'gauge', 'Plafonds par catégorie', `${categories('expense').filter(c => Number(c.limit) > 0).length} plafond(s) mensuel(s)`],
    ['about', 'info', 'À propos', 'Budget Foyer'],
  ];
  return `<div class="list" style="margin-top:0">${items.map(([k, i, t, s]) => `<button class="row" data-more="${k}">${icBubble(i, '#2f6b52')}<div class="main"><div class="t">${t}</div><div class="s">${esc(s)}</div></div>${svg('chevron-right', 'style="color:var(--dim);width:20px"')}</button>`).join('')}</div>`;
}
function render() {
  S._unread = unreadComments(); S._ccount = {};
  all('comment').forEach(c => S._ccount[c.tx] = (S._ccount[c.tx] || 0) + 1);
  renderHeader();
  const v = $('#view');
  const y = window.scrollY;
  const ev = activeEvent();
  const banner = ev ? `<button class="banner" data-act="openEvent">${svg('plane')}<span><b>Mode voyage : ${esc(ev.name)}</b><br><small>Les nouvelles saisies de ce téléphone y sont rattachées · ${fmt(eventTotals(ev.id).exp, settings().base)}</small></span></button>` : '';
  v.innerHTML = banner + (S.tab === 'budget' ? renderBudget() : S.tab === 'ops' ? renderOps() : S.tab === 'charts' ? renderCharts() : renderMore());
  const bd = $('#opsBadge'); if (bd) { bd.textContent = S._unread.size || ''; bd.classList.toggle('hidden', !S._unread.size); }
  S.hooks.forEach(h => { if (h() === false) S.hooks.delete(h); });
  $$('nav [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  window.scrollTo(0, y);
  if (S.refreshSheet) S.refreshSheet();
}

/* =========================================================
   8. Saisie / modification d'une opération
   ========================================================= */
function usageOrder(kind) {
  const since = addDays(todayStr(), -120); const cnt = {};
  txs().forEach(t => { if (t.date >= since && t.category) cnt[t.category] = (cnt[t.category] || 0) + 1; });
  return categories(kind).sort((a, b) => (cnt[b.id] || 0) - (cnt[a.id] || 0) || (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name, 'fr'));
}
function txForm(existing, preset = {}) {
  const isNew = !existing;
  const aev = activeEvent();
  const lastAcc = aev?.account && get(aev.account) ? aev.account : S.meta.lastAccount && get(S.meta.lastAccount) ? S.meta.lastAccount : (S.meta.account !== 'total' && get(S.meta.account) ? S.meta.account : accounts()[0]?.id);
  const f = existing ? { ...existing } : { type: preset.type || 'expense', amount: '', account: lastAcc, toAccount: null, toAmount: null, category: null, date: todayStr(), note: '', repeat: '', event: aev?.id || null };
  const title = isNew ? 'Nouvelle opération' : 'Modifier l’opération';
  openSheet(title, '<div data-f></div>', (sh) => {
    const box = $('[data-f]', sh);
    const draw = () => {
      const accs = accounts(); const acc = get(f.account); const acc2 = get(f.toAccount);
      const cats = f.type === 'transfer' ? [] : usageOrder(f.type);
      const diffCur = f.type === 'transfer' && acc && acc2 && acc.currency !== acc2.currency;
      const y = addDays(todayStr(), -1);
      box.innerHTML = `
        <div class="seg big ${f.type === 'expense' ? 'exp' : f.type === 'income' ? 'inc' : ''}">
          <button data-ty="expense" class="${f.type === 'expense' ? 'on' : ''}">Dépense</button><button data-ty="income" class="${f.type === 'income' ? 'on' : ''}">Revenu</button><button data-ty="transfer" class="${f.type === 'transfer' ? 'on' : ''}">Virement</button></div>
        <div class="field"><input class="amountin" data-amount inputmode="decimal" placeholder="0" value="${esc(f.amount)}" autocomplete="off"><div class="calcprev" data-calc></div><div class="fxline" data-fx></div></div>
        ${f.type === 'transfer' ? `
          <div class="field"><label>Depuis</label><div class="chips">${accs.map(a => `<button class="chip ${f.account === a.id ? 'on' : ''}" data-acc="${a.id}">${esc(a.name)}</button>`).join('')}</div></div>
          <div class="field"><label>Vers</label><div class="chips">${accs.map(a => `<button class="chip ${f.toAccount === a.id ? 'on' : ''}" data-acc2="${a.id}">${esc(a.name)}</button>`).join('')}</div></div>
          ${diffCur ? `<div class="field"><label>Montant reçu en ${esc(acc2.currency)}</label><input data-toamount inputmode="decimal" value="${esc(f.toAmount ?? '')}" placeholder="${esc(suggestTo(f, acc, acc2))}"></div>` : ''}
        ` : `
          <div class="field"><label>Catégorie</label><div class="catgrid">${cats.map(c => `<button data-cat="${c.id}" class="${f.category === c.id ? 'on' : ''}">${icBubble(c.icon, c.color)}<span>${esc(c.name)}</span></button>`).join('')}
            <button data-newcat>${icBubble('plus', '#3a4136')}<span>Nouvelle</span></button></div></div>
          <div class="field"><label>Compte</label><div class="chips">${accs.map(a => `<button class="chip ${f.account === a.id ? 'on' : ''}" data-acc="${a.id}">${esc(a.name)} <small>${esc(curInfo(a.currency).sym)}</small></button>`).join('')}</div></div>
        `}
        <div class="field"><label>Date</label><div class="chips">
          <button class="chip ${f.date === todayStr() ? 'on' : ''}" data-d="${todayStr()}">Aujourd’hui</button>
          <button class="chip ${f.date === y ? 'on' : ''}" data-d="${y}">Hier</button>
          <input type="date" data-date value="${esc(f.date)}" style="width:auto;padding:7px 10px;border-radius:999px"></div></div>
        <div class="field"><input data-note placeholder="Commentaire (facultatif)" value="${esc(f.note || '')}"></div>
        ${f.type !== 'transfer' && (events().length || f.event) ? `<div class="field"><label>Voyage / événement</label><div class="chips"><button class="chip ${!f.event ? 'on' : ''}" data-ev="">Aucun</button>${events().filter(e => e.id === f.event || e.id === aev?.id || !e.end || e.end >= addDays(todayStr(), -60)).slice(0, 8).map(e => `<button class="chip ${f.event === e.id ? 'on' : ''}" data-ev="${e.id}">✈ ${esc(e.name)}</button>`).join('')}</div></div>` : ''}
        ${isNew ? `<div class="field"><label>Répéter</label><div class="chips">${[['', 'Non'], ['week', 'Chaque semaine'], ['month', 'Chaque mois'], ['year', 'Chaque année']].map(([k, l]) => `<button class="chip ${f.repeat === k ? 'on' : ''}" data-rep="${k}">${l}</button>`).join('')}</div></div>` : ''}
        ${existing?.recurring ? `<div class="note">Généré par un paiement régulier.</div>` : ''}
        <button class="btn sticky" data-save style="margin-top:14px">${isNew ? 'Ajouter' : 'Enregistrer'}</button>
        ${isNew ? '' : `<div class="btns"><button class="btn sec" data-dup>Dupliquer</button><button class="btn danger" data-del>Supprimer</button></div>
        <div class="h2">Discussion</div><div data-cmts></div>
        <div class="cmtin"><input data-cmt placeholder="Écrire un message…" enterkeyhint="send"><button class="iconbtn" data-send>${svg('send')}</button></div>`}`;
      const am = $('[data-amount]', box);
      const upd = () => { f.amount = am.value; const v = evalAmount(am.value); $('[data-calc]', box).textContent = /[+\-*/x×]/.test(am.value.replace(/^-/, '')) && v != null ? '= ' + fmt(v, acc?.currency || 'MGA', { force: true }) : ''; };
      const updFx = () => {
        const el = $('[data-fx]', box); if (!el) return;
        const base = settings().base; const cur = acc?.currency;
        if (!cur || cur === base || f.type === 'transfer') { el.innerHTML = ''; return; }
        const r = rateFor(cur, f.date, f.fxRate); const v = evalAmount(f.amount);
        const src = !r ? 'aucun taux disponible' : r.src === 'perso' ? 'taux personnalisé' : r.src === 'BFM' ? `BFM du ${FMT_NUM.format(dparse(r.date))}` : 'taux manuel';
        el.innerHTML = `${r && v ? '≈ <b>' + esc(fmt(v * r.rate, base, { force: true })) + '</b> · ' : ''}${r ? '1 ' + esc(curInfo(cur).sym) + ' = ' + esc(fmt(r.rate, base, { force: true }).replace(/ Ar$/, '')) + ' Ar · ' : ''}${esc(src)}
          <button data-fxedit>${f.fxRate ? 'modifier' : 'taux réel ?'}</button>
          ${f._fxOpen ? `<div class="fxedit"><input data-fxrate inputmode="decimal" placeholder="Taux réellement appliqué (Ar pour 1 ${esc(cur)})" value="${esc(f.fxRate || '')}">${f.fxRate ? '<button data-fxclear>BFM</button>' : ''}</div>` : ''}`;
        $('[data-fxedit]', el).onclick = () => { f._fxOpen = !f._fxOpen; updFx(); if (f._fxOpen) $('[data-fxrate]', el)?.focus(); };
        const fi = $('[data-fxrate]', el); if (fi) fi.oninput = () => { const x = evalAmount(fi.value); f.fxRate = x > 0 ? x : null; const pos = fi.selectionStart; updFx(); const n = $('[data-fxrate]', el); n.focus(); n.setSelectionRange(pos, pos); };
        const fc = $('[data-fxclear]', el); if (fc) fc.onclick = () => { f.fxRate = null; f._fxOpen = false; updFx(); };
      };
      am.oninput = () => { upd(); updFx(); }; upd(); updFx();
      if (isNew && !f._focused) { f._focused = true; setTimeout(() => am.focus(), 250); }
      $$('[data-ty]', box).forEach(b => b.onclick = () => { f.type = b.dataset.ty; f.category = null; if (f.type === 'transfer' && !f.toAccount) f.toAccount = accs.find(a => a.id !== f.account)?.id; draw(); });
      $$('[data-cat]', box).forEach(b => b.onclick = () => { f.category = b.dataset.cat; $$('[data-cat]', box).forEach(x => x.classList.toggle('on', x === b)); am.blur(); });
      const nc = $('[data-newcat]', box); if (nc) nc.onclick = () => catForm(null, f.type, id => { f.category = id; draw(); });
      $$('[data-acc]', box).forEach(b => b.onclick = () => { f.account = b.dataset.acc; draw(); });
      $$('[data-acc2]', box).forEach(b => b.onclick = () => { f.toAccount = b.dataset.acc2; draw(); });
      $$('[data-d]', box).forEach(b => b.onclick = () => { f.date = b.dataset.d; draw(); });
      $$('[data-rep]', box).forEach(b => b.onclick = () => { f.repeat = b.dataset.rep; draw(); });
      $('[data-date]', box).onchange = e => { if (e.target.value) { f.date = e.target.value; draw(); } };
      $('[data-note]', box).oninput = e => f.note = e.target.value;
      $$('[data-ev]', box).forEach(b => b.onclick = () => { f.event = b.dataset.ev || null; $$('[data-ev]', box).forEach(x => x.classList.toggle('on', x === b)); });
      if (!isNew) {
        const ci = $('[data-cmt]', box);
        const send = () => { const text = ci.value.trim(); if (!text) return; put('comment', null, { tx: existing.id, text, by: S.meta.userId || null, at: new Date().toISOString() }, { silent: true }); ci.value = ''; scheduleSync(300); render(); };
        $('[data-send]', box).onclick = send; ci.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
        drawComments();
      }
      const ta = $('[data-toamount]', box); if (ta) ta.oninput = e => f.toAmount = e.target.value;
      $('[data-save]', box).onclick = save;
      const dl = $('[data-del]', box); if (dl) dl.onclick = () => confirmSheet('Supprimer cette opération ?', 'Supprimer', () => { del(existing.id); closeAllSheets(); toast('Opération supprimée'); });
      const dp = $('[data-dup]', box); if (dp) dp.onclick = async () => { dupFrom = { ...f, date: todayStr() }; ['id', 'recurring', '_focused', 'by', 'created'].forEach(k => delete dupFrom[k]); await closeSheet(); txForm(null); };
      am.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); am.blur(); } };
    };
    function drawComments() {
      const host = $('[data-cmts]', box); if (!host || !document.body.contains(host)) return false;
      const list = commentsOf(existing.id);
      host.innerHTML = list.length ? list.map(c => { const mine = !c.by || c.by === S.meta.userId;
        return `<div class="cmt-msg ${mine ? 'me' : ''}"><div class="cmt-h">${esc(memberName(c.by))} · ${esc(new Date(c.at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${mine ? ` <button data-cdel="${c.id}" aria-label="Supprimer">×</button>` : ''}</div><div>${esc(c.text)}</div></div>`; }).join('')
        : '<div class="s" style="color:var(--dim);font-size:13.5px;padding:2px 4px">Aucun message. Une question sur cette dépense ? Écris-la ici.</div>';
      $$('[data-cdel]', host).forEach(b => b.onclick = () => del(b.dataset.cdel));
      const last = list.length ? list[list.length - 1].at : null;
      if (last && (S.meta.seen?.[existing.id] || '') < last) { setMeta('seen', { ...(S.meta.seen || {}), [existing.id]: last }); setTimeout(render, 0); }
      return true;
    }
    if (!isNew) S.hooks.add(drawComments);
    function save() {
      const amount = evalAmount(f.amount);
      if (amount == null || amount <= 0) { toast('Montant invalide'); return; }
      if (!f.account) { toast('Choisis un compte'); return; }
      if (f.type !== 'transfer' && !f.category) { toast('Choisis une catégorie'); return; }
      if (f.type === 'transfer') {
        if (!f.toAccount || f.toAccount === f.account) { toast('Choisis deux comptes différents'); return; }
      }
      const acc = get(f.account), acc2 = get(f.toAccount);
      let toAmount = null;
      if (f.type === 'transfer' && acc && acc2 && acc.currency !== acc2.currency) {
        toAmount = f.toAmount !== '' && f.toAmount != null ? evalAmount(f.toAmount) : Number(suggestTo(f, acc, acc2, amount)) || null;
        if (toAmount == null) { toast('Indique le montant reçu'); return; }
      }
      const data = { type: f.type, amount, account: f.account, toAccount: f.type === 'transfer' ? f.toAccount : null, toAmount,
        category: f.type === 'transfer' ? null : f.category, date: f.date, note: (f.note || '').trim(),
        by: existing?.by ?? S.meta.userId ?? null, created: existing?.created || new Date().toISOString(), recurring: existing?.recurring || null,
        event: f.type === 'transfer' ? null : (f.event || null), fxRate: f.type !== 'transfer' && f.fxRate > 0 ? f.fxRate : null };
      setMeta('lastAccount', f.account);
      // Alerte plafond : passage de 80 % ou 100 % sur le mois de l'opération
      let alertMsg = '';
      const cat = get(data.category);
      if (isNew && f.repeat) {
        const rid = uid();
        put('recurring', rid, { ...data, name: data.note || (get(data.category)?.name || 'Virement'), freq: f.repeat, every: 1, anchor: Number(f.date.slice(8)), next: f.date, active: true, end: null }, { silent: true });
        runRecurring();
      } else put('tx', existing?.id, data, { silent: true });
      if (data.type === 'expense' && cat && Number(cat.limit) > 0) {
        const mr = monthRange(data.date); const after = catSpent(cat.id, mr[0], mr[1]); const L = Number(cat.limit);
        if (after > L) alertMsg = `⚠ ${cat.name} : plafond du mois dépassé (${Math.round(after / L * 100)} %)`;
        else if (after >= 0.8 * L) alertMsg = `${cat.name} : ${Math.round(after / L * 100)} % du plafond du mois`;
      }
      scheduleSync(); render(); closeSheet(); toast(alertMsg || (isNew ? 'Opération ajoutée' : 'Modifiée'), alertMsg ? 4000 : 2200);
    }
    if (dupFrom && isNew) { Object.assign(f, dupFrom, { repeat: '' }); dupFrom = null; }
    draw();
  });
}
let dupFrom = null;
function suggestTo(f, acc, acc2, amount) {
  const a = amount ?? evalAmount(f.amount); if (a == null) return '';
  const b = toBase(a, acc.currency, f.date, f.fxRate); if (b == null) return '';
  const r = acc2.currency === settings().base ? 1 : rateFor(acc2.currency, f.date)?.rate;
  if (!r) return ''; const v = b / r; return String(Math.round(v * (curInfo(acc2.currency).dec ? 100 : 1)) / (curInfo(acc2.currency).dec ? 100 : 1));
}

/* =========================================================
   9. Catégories, comptes, paiements réguliers, devises
   ========================================================= */
function iconPicker(sel) { return `<div class="iconpick">${Object.keys(ICONS).map(k => `<button data-icon="${k}" class="${k === sel ? 'on' : ''}">${svg(k)}</button>`).join('')}</div>`; }
function colorPicker(sel) { return `<div class="colorpick">${PALETTE.map(c => `<button data-color="${c}" class="${c === sel ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div>`; }
function bindPickers(box, f, redraw) {
  $$('[data-icon]', box).forEach(b => b.onclick = () => { f.icon = b.dataset.icon; $$('[data-icon]', box).forEach(x => x.classList.toggle('on', x === b)); redraw && redraw(); });
  $$('[data-color]', box).forEach(b => b.onclick = () => { f.color = b.dataset.color; $$('[data-color]', box).forEach(x => x.classList.toggle('on', x === b)); redraw && redraw(); });
}
function catForm(existing, kind = 'expense', onDone) {
  const f = existing ? { ...existing } : { name: '', icon: 'tag', color: PALETTE[3], kind };
  openSheet(existing ? 'Modifier la catégorie' : 'Nouvelle catégorie', `
    <div style="display:flex;justify-content:center;margin:6px 0" data-prev></div>
    <div class="field"><input data-name placeholder="Nom de la catégorie" value="${esc(f.name)}"></div>
    <div class="field"><div class="seg"><button data-k="expense" class="${f.kind === 'expense' ? 'on' : ''}">Dépense</button><button data-k="income" class="${f.kind === 'income' ? 'on' : ''}">Revenu</button></div></div>
    <div class="field" data-limwrap ${f.kind === 'income' ? 'style="display:none"' : ''}><label>Plafond mensuel (${esc(settings().base)}, facultatif)</label><input data-limit inputmode="decimal" placeholder="ex. 600000" value="${esc(f.limit || '')}"></div>
    <div class="field"><label>Couleur</label>${colorPicker(f.color)}</div>
    <div class="field"><label>Icône</label>${iconPicker(f.icon)}</div>
    <button class="btn" data-save>${existing ? 'Enregistrer' : 'Créer'}</button>
    ${existing ? '<button class="btn danger" data-del>Supprimer</button>' : ''}`, sh => {
    const prev = () => $('[data-prev]', sh).innerHTML = `<span class="ic" style="width:64px;height:64px;background:${esc(f.color)}">${svg(f.icon, 'style="width:32px;height:32px"')}</span>`;
    prev(); bindPickers(sh, f, prev);
    $$('[data-k]', sh).forEach(b => b.onclick = () => { f.kind = b.dataset.k; $$('[data-k]', sh).forEach(x => x.classList.toggle('on', x === b)); $('[data-limwrap]', sh).style.display = f.kind === 'income' ? 'none' : ''; });
    $('[data-save]', sh).onclick = () => {
      f.name = $('[data-name]', sh).value.trim(); if (!f.name) { toast('Donne un nom'); return; }
      const lv = evalAmount($('[data-limit]', sh).value); f.limit = f.kind === 'expense' && lv > 0 ? lv : null;
      const id = put('category', existing?.id, f); closeSheet().then(() => onDone && onDone(id));
    };
    const d = $('[data-del]', sh); if (d) d.onclick = () => {
      const n = txs().filter(t => t.category === existing.id).length;
      confirmSheet(n ? `${n} opération(s) utilisent cette catégorie : elles apparaîtront « Sans catégorie ». Supprimer quand même ?` : 'Supprimer cette catégorie ?', 'Supprimer', () => { del(existing.id); closeSheet(); });
    };
    if (!existing) setTimeout(() => $('[data-name]', sh).focus(), 250);
  });
}
function listSheet(title, build, onMount) {
  openSheet(title, '<div data-l></div>', (sh, entry) => {
    const draw = () => { $('[data-l]', sh).innerHTML = build(); onMount(sh); };
    draw(); const prev = S.refreshSheet;
    S.refreshSheet = () => {
      if (!document.body.contains(sh)) { S.refreshSheet = prev; return; }
      const ae = document.activeElement; if (ae && sh.contains(ae) && ae.matches('input,select,textarea')) return;
      draw();
    };
  });
}
function categoriesSheet() {
  let kind = 'expense';
  listSheet('Catégories', () => `<div class="seg"><button data-k="expense" class="${kind === 'expense' ? 'on' : ''}">Dépenses</button><button data-k="income" class="${kind === 'income' ? 'on' : ''}">Revenus</button></div>
    <div class="list">${categories(kind).map(c => `<button class="row" data-c="${c.id}">${icBubble(c.icon, c.color)}<div class="main"><div class="t">${esc(c.name)}</div></div></button>`).join('')}</div>
    <button class="btn" style="margin-top:14px" data-add>Ajouter une catégorie</button>`, sh => {
    $$('[data-k]', sh).forEach(b => b.onclick = () => { kind = b.dataset.k; S.refreshSheet(); });
    $$('[data-c]', sh).forEach(b => b.onclick = () => catForm(get(b.dataset.c)));
    $('[data-add]', sh).onclick = () => catForm(null, kind);
  });
}
function accForm(existing) {
  const f = existing ? { ...existing } : { name: '', currency: settings().base, icon: 'wallet', color: PALETTE[0], initial: 0, inTotal: true, order: accounts().length };
  openSheet(existing ? 'Modifier le compte' : 'Nouveau compte', `
    <div class="field"><input data-name placeholder="Nom (ex. Courant, Épargne, Terrain…)" value="${esc(f.name)}"></div>
    <div class="two"><div class="field"><label>Devise</label><select data-cur>${Object.entries(CURRENCIES).map(([k, v]) => `<option value="${k}" ${k === f.currency ? 'selected' : ''}>${k} (${v.sym})</option>`).join('')}</select></div>
    <div class="field"><label>Solde de départ</label><input data-init inputmode="decimal" value="${esc(f.initial ?? 0)}"></div></div>
    <div class="line"><span>Inclure dans le total</span><label class="toggle"><input type="checkbox" data-intotal ${f.inTotal !== false ? 'checked' : ''}><span></span></label></div>
    <div class="field"><label>Couleur</label>${colorPicker(f.color)}</div>
    <div class="field"><label>Icône</label>${iconPicker(f.icon)}</div>
    <button class="btn" data-save>${existing ? 'Enregistrer' : 'Créer'}</button>
    ${existing ? '<button class="btn danger" data-del>Supprimer</button>' : ''}`, sh => {
    bindPickers(sh, f);
    $('[data-save]', sh).onclick = () => {
      f.name = $('[data-name]', sh).value.trim(); if (!f.name) { toast('Donne un nom'); return; }
      f.currency = $('[data-cur]', sh).value; f.initial = evalAmount($('[data-init]', sh).value) ?? 0; f.inTotal = $('[data-intotal]', sh).checked;
      put('account', existing?.id, f); closeSheet();
    };
    const d = $('[data-del]', sh); if (d) d.onclick = () => {
      const n = txs().filter(t => t.account === existing.id || t.toAccount === existing.id).length;
      if (n) confirmSheet(`${n} opération(s) sont liées à ce compte. Il sera archivé (masqué) pour conserver l’historique.`, 'Archiver', () => { put('account', existing.id, { ...existing, archived: true }); if (S.meta.account === existing.id) setMeta('account', 'total'); closeSheet(); render(); });
      else confirmSheet('Supprimer ce compte ?', 'Supprimer', () => { del(existing.id); if (S.meta.account === existing.id) setMeta('account', 'total'); closeSheet(); render(); });
    };
  });
}
function accountsSheet(pickMode = false) {
  listSheet(pickMode ? 'Sélectionner un compte' : 'Comptes', () => {
    const { tot, missing } = totalBalance(); const sel = S.meta.account || 'total';
    return `<div class="line"><span>Masquer les soldes</span><label class="toggle"><input type="checkbox" data-hide ${S.meta.hide ? 'checked' : ''}><span></span></label></div>
    <div class="list">
      <button class="row" data-a="total" ${sel === 'total' ? 'style="outline:2px solid var(--acc)"' : ''}>${icBubble('wallet', '#2f6b52')}<div class="main"><div class="t">Total</div><div class="s">${missing ? 'taux de change manquant' : 'tous les comptes inclus'}</div></div><span class="amt">${fmt(tot, settings().base)}</span></button>
      ${accounts().map(a => { const b = accountBalance(a); const conv = a.currency !== settings().base ? toBase(b, a.currency) : null;
        return `<button class="row" data-a="${a.id}" ${sel === a.id ? 'style="outline:2px solid var(--acc)"' : ''}>${icBubble(a.icon, a.color)}<div class="main"><div class="t">${esc(a.name)}</div><div class="s">${conv != null ? '≈ ' + fmt(conv, settings().base) : (a.inTotal === false ? 'hors total' : esc(curInfo(a.currency).name))}</div></div><span class="amt">${fmt(b, a.currency)}</span></button>`; }).join('')}
    </div>
    <div class="btns"><button class="btn sec" data-add>Nouveau compte</button>${pickMode ? '<button class="btn sec" data-manage>Modifier</button>' : ''}</div>
    ${archivedCount() ? `<div class="note">${archivedCount()} compte(s) archivé(s). <button data-unarch style="color:var(--acc);font-weight:600">Restaurer</button></div>` : ''}`;
  }, sh => {
    $('[data-hide]', sh).onchange = e => { setMeta('hide', e.target.checked); render(); };
    $$('[data-a]', sh).forEach(b => b.onclick = () => {
      if (pickMode || b.dataset.a === 'total') { setMeta('account', b.dataset.a); render(); if (pickMode) closeSheet(); }
      else accForm(get(b.dataset.a));
    });
    $('[data-add]', sh).onclick = () => accForm(null);
    const m = $('[data-manage]', sh); if (m) m.onclick = () => closeSheet().then(() => accountsSheet(false));
    const u = $('[data-unarch]', sh); if (u) u.onclick = () => { all('account').filter(a => a.archived).forEach(a => put('account', a.id, { ...a, archived: false }, { silent: true })); scheduleSync(); render(); };
  });
}
const archivedCount = () => all('account').filter(a => a.archived).length;
const FREQ = { day: 'jour(s)', week: 'semaine(s)', month: 'mois', year: 'an(s)' };
function recurringSheet() {
  listSheet('Paiements réguliers', () => {
    const list = all('recurring').sort((a, b) => (b.active - a.active) || (a.next || '').localeCompare(b.next || ''));
    return `<div class="note">Les opérations sont créées automatiquement à leur date, sur les deux téléphones, sans doublon.</div>
    <div class="list">${list.length ? list.map(r => { const a = get(r.account); const c = get(r.category);
      return `<div class="row">${r.type === 'transfer' ? icBubble('arrow-left-right', '#64748b') : icBubble(c?.icon || 'repeat', c?.color || '#64748b')}
        <button class="main" style="text-align:left" data-r="${r.id}"><div class="t">${esc(r.name || c?.name || 'Paiement')}</div>
        <div class="s">${fmt(Number(r.amount), a?.currency)} · tous les ${r.every > 1 ? r.every + ' ' : ''}${FREQ[r.freq]}</div>
        <div class="s">${r.active ? 'Prochain : ' + esc(FMT_DAYY.format(dparse(r.next))) : 'En pause'}</div></button>
        <label class="toggle"><input type="checkbox" data-ract="${r.id}" ${r.active ? 'checked' : ''}><span></span></label></div>`; }).join('') : '<div class="empty">Aucun paiement régulier.</div>'}</div>
    <button class="btn" style="margin-top:14px" data-add>Ajouter un paiement régulier</button>`;
  }, sh => {
    $$('[data-ract]', sh).forEach(i => i.onchange = () => { const r = get(i.dataset.ract); put('recurring', r.id, { ...r, active: i.checked, next: i.checked && r.next < todayStr() ? todayStr() : r.next }); if (i.checked) runRecurring(); });
    $$('[data-r]', sh).forEach(b => b.onclick = () => recForm(get(b.dataset.r)));
    $('[data-add]', sh).onclick = () => recForm(null);
  });
}
function recForm(existing) {
  const f = existing ? { ...existing } : { name: '', type: 'expense', amount: '', account: accounts()[0]?.id, toAccount: null, category: null, freq: 'month', every: 1, next: todayStr(), end: '', active: true, note: '' };
  openSheet(existing ? 'Modifier le paiement régulier' : 'Nouveau paiement régulier', '<div data-f></div>', sh => {
    const box = $('[data-f]', sh);
    const draw = () => {
      const accs = accounts();
      box.innerHTML = `<div class="field"><input data-name placeholder="Nom (ex. Loyer, Salaire…)" value="${esc(f.name)}"></div>
        <div class="seg"><button data-ty="expense" class="${f.type === 'expense' ? 'on' : ''}">Dépense</button><button data-ty="income" class="${f.type === 'income' ? 'on' : ''}">Revenu</button><button data-ty="transfer" class="${f.type === 'transfer' ? 'on' : ''}">Virement</button></div>
        <div class="field"><label>Montant</label><input data-amount inputmode="decimal" value="${esc(f.amount)}"></div>
        <div class="field"><label>${f.type === 'transfer' ? 'Depuis' : 'Compte'}</label><select data-acc>${accs.map(a => `<option value="${a.id}" ${a.id === f.account ? 'selected' : ''}>${esc(a.name)} (${a.currency})</option>`).join('')}</select></div>
        ${f.type === 'transfer' ? `<div class="field"><label>Vers</label><select data-acc2><option value="">—</option>${accs.map(a => `<option value="${a.id}" ${a.id === f.toAccount ? 'selected' : ''}>${esc(a.name)} (${a.currency})</option>`).join('')}</select></div>`
          : `<div class="field"><label>Catégorie</label><select data-cat><option value="">—</option>${categories(f.type).map(c => `<option value="${c.id}" ${c.id === f.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`}
        <div class="two"><div class="field"><label>Tous les</label><input data-every type="number" min="1" value="${esc(f.every || 1)}"></div>
          <div class="field"><label>&nbsp;</label><select data-freq>${Object.entries(FREQ).map(([k, l]) => `<option value="${k}" ${k === f.freq ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <div class="two"><div class="field"><label>Prochaine échéance</label><input type="date" data-next value="${esc(f.next)}"></div>
          <div class="field"><label>Fin (facultatif)</label><input type="date" data-end value="${esc(f.end || '')}"></div></div>
        <button class="btn" data-save>Enregistrer</button>${existing ? '<button class="btn danger" data-del>Supprimer</button>' : ''}`;
      const read = () => { f.name = $('[data-name]', box).value; f.amount = $('[data-amount]', box).value; f.account = $('[data-acc]', box).value;
        const a2 = $('[data-acc2]', box); if (a2) f.toAccount = a2.value || null; const c = $('[data-cat]', box); if (c) f.category = c.value || null;
        f.every = Number($('[data-every]', box).value) || 1; f.freq = $('[data-freq]', box).value; f.next = $('[data-next]', box).value; f.end = $('[data-end]', box).value || null; };
      $$('[data-ty]', box).forEach(b => b.onclick = () => { read(); f.type = b.dataset.ty; f.category = null; draw(); });
      $('[data-save]', box).onclick = () => {
        read(); const amount = evalAmount(f.amount);
        if (!amount || amount <= 0) return toast('Montant invalide');
        if (!f.next) return toast('Date manquante');
        if (f.type === 'transfer' && (!f.toAccount || f.toAccount === f.account)) return toast('Choisis deux comptes différents');
        if (f.type !== 'transfer' && !f.category) return toast('Choisis une catégorie');
        const anchorChanged = !existing || existing.next !== f.next;
        put('recurring', existing?.id, { ...f, amount, note: f.name, anchor: anchorChanged ? Number(f.next.slice(8)) : (f.anchor || Number(f.next.slice(8))) }, { silent: true });
        runRecurring(); scheduleSync(); render(); closeSheet();
      };
      const d = $('[data-del]', box); if (d) d.onclick = () => confirmSheet('Supprimer ce paiement régulier ? Les opérations déjà créées sont conservées.', 'Supprimer', () => { del(existing.id); closeSheet(); });
    };
    draw();
  });
}
function fxSpark(cur, n = 30) {
  const sr = fxSeries(cur); const vals = sr.vals.slice(-n); if (vals.length < 2) return '';
  const mn = Math.min(...vals), mx = Math.max(...vals), W = 320, H = 70, pad = 4;
  const pts = vals.map((v, i) => `${(pad + i * (W - 2 * pad) / (vals.length - 1)).toFixed(1)},${(H - pad - (mx === mn ? 0.5 : (v - mn) / (mx - mn)) * (H - 2 * pad)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:70px;margin:6px 0"><polyline points="${pts}" fill="none" stroke="var(--acc)" stroke-width="2" stroke-linejoin="round"/></svg>
    <div class="s" style="display:flex;justify-content:space-between;color:var(--mut);font-size:12px"><span>${esc(FMT_SHORT.format(dparse(sr.dates[sr.dates.length - vals.length])))}</span><span>min ${fmtRate(mn)} · max ${fmtRate(mx)}</span><span>${esc(FMT_SHORT.format(dparse(sr.dates[sr.dates.length - 1])))}</span></div>`;
}
const pctTxt = (a, b) => { const p = (a - b) / b * 100; return `<span style="color:${p > 0 ? 'var(--red)' : p < 0 ? 'var(--green)' : 'var(--mut)'}">${p > 0 ? '▲ +' : p < 0 ? '▼ ' : ''}${p.toFixed(2).replace('.', ',')} %</span>`; };
function fxBlock(cur) {
  const sr = fxSeries(cur); const n = sr.dates.length;
  if (!n) return `<div class="note">Pas encore de cours BFM pour ${esc(cur)}.</div>`;
  const last = sr.vals[n - 1], prev = n > 1 ? sr.vals[n - 2] : null;
  const rows = []; for (let i = n - 1; i >= Math.max(0, n - 10); i--) rows.push(`<tr><td>${esc(FMT_DAYY.format(dparse(sr.dates[i])))}</td><td style="text-align:right">${fmtRate(sr.vals[i])}</td><td style="text-align:right">${i > 0 ? pctTxt(sr.vals[i], sr.vals[i - 1]) : ''}</td></tr>`);
  return `<div class="card" style="margin:8px 0"><div style="display:flex;justify-content:space-between;align-items:baseline"><b>1 ${esc(curInfo(cur).sym)} = ${fmtRate(last)}</b><span class="s" style="color:var(--mut);font-size:13px">BFM du ${esc(FMT_NUM.format(dparse(sr.dates[n - 1])))}</span></div>
    ${prev ? `<div style="font-size:14px;margin-top:2px">Variation vs ${esc(FMT_SHORT.format(dparse(sr.dates[n - 2])))} : ${pctTxt(last, prev)} (${fmtRate(last - prev, true)})</div>` : ''}
    ${fxSpark(cur)}
    <div class="scrollx"><table class="prev" style="margin-top:6px"><tr><th>Date</th><th style="text-align:right">Cours</th><th style="text-align:right">Variation</th></tr>${rows.join('')}</table></div></div>`;
}
function currenciesSheet() {
  listSheet('Devises et taux', () => {
    const st = settings(); const used = new Set(accounts().map(a => a.currency)); Object.keys(st.rates || {}).forEach(c => used.add(c)); used.delete(st.base);
    const auto = st.base === 'MGA' && st.autoFx !== false;
    return `<div class="field"><label>Devise de référence (pour le total)</label><select data-base>${Object.entries(CURRENCIES).map(([k, v]) => `<option value="${k}" ${k === st.base ? 'selected' : ''}>${k} — ${v.name}</option>`).join('')}</select></div>
    ${st.base === 'MGA' ? `<div class="line"><span>Cours BFM journalier automatique</span><label class="toggle"><input type="checkbox" data-auto ${auto ? 'checked' : ''}><span></span></label></div>` : ''}
    ${auto ? `<div class="note">Chaque opération en devise est convertie en ariary au <b>cours MID publié par la BFM le jour de l’opération</b> (dernier cours connu pour les week-ends et jours fériés). Le montant en devise n’est jamais modifié. Un taux réellement payé peut être saisi sur une opération (« taux réel ? »).</div>
      ${[...used].map(c => `<div class="h2">${esc(c)} — ${esc(curInfo(c).name)}</div>${fxBlock(c)}`).join('')}
      <div class="note">${S.meta.fxCheckedAt ? 'Dernière vérification : ' + esc(new Date(S.meta.fxCheckedAt).toLocaleString('fr-FR')) : 'Pas encore vérifié'}${S.meta.fxError ? `<br><span style="color:#ffd27a">Échec de la dernière mise à jour : ${esc(S.meta.fxError)}</span>` : ''}<br>Source : cours MID de la Banky Foiben’i Madagasikara, via l’API publique Frankfurter.</div>
      <button class="btn sec" data-fxnow>Mettre à jour les cours maintenant</button>
      <div class="h2">Taux de secours (si aucun cours BFM n’est disponible)</div>` : '<div class="h2">Taux de conversion</div>'}
    ${[...used].map(c => `<div class="field"><label>1 ${c} = … ${st.base}</label><input inputmode="decimal" data-rate="${c}" value="${esc(st.rates?.[c] ?? '')}" placeholder="ex. 5000"></div>`).join('') || '<div class="note">Tous tes comptes sont dans la devise de référence.</div>'}
    <button class="btn" data-save>Enregistrer</button>`;
  }, sh => {
    $('[data-save]', sh).onclick = () => {
      const st = settings(); const base = $('[data-base]', sh).value; const rates = { ...(st.rates || {}) };
      $$('[data-rate]', sh).forEach(i => { const v = evalAmount(i.value); if (v > 0) rates[i.dataset.rate] = v; else delete rates[i.dataset.rate]; });
      if (base !== st.base) { delete rates[base]; }
      put('settings', 'settings', { ...st, base, rates }); toast('Enregistré');
    };
    const au = $('[data-auto]', sh); if (au) au.onchange = () => { put('settings', 'settings', { ...settings(), autoFx: au.checked }); if (au.checked) updateFx(true).then(render); };
    const fn = $('[data-fxnow]', sh); if (fn) fn.onclick = async () => { fn.textContent = 'Mise à jour…'; await updateFx(true); render(); toast(S.meta.fxError ? 'Échec : ' + S.meta.fxError : 'Cours BFM à jour'); };
    $('[data-base]', sh).onchange = () => toast('Pense à revoir les taux après avoir changé la référence');
  });
}

/* =========================================================
   10. Import / Export
   ========================================================= */
function download(name, text, type = 'text/csv') {
  const b = new Blob([text], { type: type + ';charset=utf-8' }); const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function csvCell(v) { const s = String(v ?? ''); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportCSV() {
  const rows = [['Date', 'Type', 'Montant', 'Devise', 'Compte', 'Vers compte', 'Montant reçu', 'Catégorie', 'Commentaire', 'Saisi par', 'Événement', 'Taux (Ar)', 'Source taux', 'Contre-valeur (Ar)']];
  txs().sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
    const a = get(t.account), a2 = get(t.toAccount), c = get(t.category), m = S.members.find(x => x.user_id === t.by);
    rows.push([t.date, { expense: 'Dépense', income: 'Revenu', transfer: 'Virement' }[t.type], String(t.amount).replace('.', ','), a?.currency || '', a?.name || '', a2?.name || '', t.toAmount ?? '', c?.name || '', t.note || '', m?.display_name || '', get(t.event)?.name || '',
      ...(() => { const r = a && a.currency !== settings().base ? rateFor(a.currency, t.date, t.fxRate) : null; return r ? [String(r.rate).replace('.', ','), r.src === 'BFM' ? 'BFM ' + r.date : r.src, String(Math.round(Number(t.amount) * r.rate)).replace('.', ',')] : ['', '', '']; })()]);
  });
  download(`budget-${todayStr()}.csv`, '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n'));
}
function exportJSON() {
  const recs = [...S.records.values()].filter(r => !r.deleted).map(({ id, kind, data }) => ({ id, kind, data }));
  download(`budget-sauvegarde-${todayStr()}.json`, JSON.stringify({ app: 'budget-foyer', v: 1, date: new Date().toISOString(), records: recs }), 'application/json');
}
function parseCSV(text) {
  const first = text.split(/\r?\n/).slice(0, 5).join('\n');
  const delim = [';', ',', '\t'].map(d => [d, (first.match(new RegExp(d === '\t' ? '\t' : '\\' + d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows.map(r => r.map(c => c.trim()));
}
function parseNum(s) {
  let t = String(s || '').replace(/[^\d,.\-−]/g, '').replace('−', '-'); if (!t) return null;
  const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
  if (lc > -1 && ld > -1) { t = lc > ld ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''); }
  else if (lc > -1) { t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.'); }
  else if (ld > -1 && /^-?\d{1,3}(\.\d{3}){2,}$/.test(t)) t = t.replace(/\./g, '');
  const v = parseFloat(t); return isNaN(v) ? null : v;
}
function parseDateFlex(s, order) {
  s = String(s || '').trim(); let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) {
    let [, a, b, y] = m; if (y.length === 2) y = '20' + y;
    const [d, mo] = order === 'mdy' ? [b, a] : [a, b];
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null; return `${y}-${pad(mo)}-${pad(d)}`;
  }
  const t = Date.parse(s); return isNaN(t) ? null : dstr(new Date(t));
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
function guessCol(headers, words) { const i = headers.findIndex(h => words.some(w => norm(h).includes(w))); return i; }
function importSheet() {
  openSheet('Import / Export', `
    <div class="h2">Exporter</div>
    <button class="btn sec" data-ecsv>Exporter les opérations (CSV / Excel)</button>
    <button class="btn sec" data-ejson>Sauvegarde complète (JSON)</button>
    <div class="h2">Importer</div>
    <div class="note">Import CSV depuis ton ancienne appli : tu choisis quelle colonne correspond à quoi. Un même fichier importé deux fois ne crée pas de doublons.</div>
    <label class="btn" style="position:relative">Importer un fichier CSV<input type="file" accept=".csv,text/csv,text/plain" data-fcsv style="position:absolute;inset:0;opacity:0"></label>
    <label class="btn sec" style="position:relative;margin-top:10px">Restaurer une sauvegarde JSON<input type="file" accept=".json,application/json" data-fjson style="position:absolute;inset:0;opacity:0"></label>`, sh => {
    $('[data-ecsv]', sh).onclick = exportCSV; $('[data-ejson]', sh).onclick = exportJSON;
    $('[data-fcsv]', sh).onchange = async e => { const file = e.target.files[0]; if (!file) return; const text = await readText(file); csvWizard(parseCSV(text), file.name); };
    $('[data-fjson]', sh).onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      try { const j = JSON.parse(await readText(file)); if (j.app !== 'budget-foyer') throw 0;
        confirmSheet(`Restaurer ${j.records.length} éléments (sauvegarde du ${FMT_NUM.format(new Date(j.date))}) ? Les éléments existants avec le même identifiant seront remplacés.`, 'Restaurer', () => {
          j.records.forEach(r => put(r.kind, r.id, r.data, { silent: true })); scheduleSync(); render(); toast('Sauvegarde restaurée'); }, false);
      } catch { toast('Fichier de sauvegarde invalide'); }
    };
  });
}
async function readText(file) {
  const buf = await file.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(buf);
  if (t.includes('�')) t = new TextDecoder('windows-1252').decode(buf);
  return t.replace(/^﻿/, '');
}
function csvWizard(rows, fname) {
  if (rows.length < 2) { toast('Fichier vide ou illisible'); return; }
  const hdr = rows[0];
  const m = {
    date: guessCol(hdr, ['date', 'jour']), amount: guessCol(hdr, ['montant', 'amount', 'somme', 'valeur', 'sum']),
    type: guessCol(hdr, ['type', 'nature']), category: guessCol(hdr, ['categ', 'category']),
    account: guessCol(hdr, ['compte', 'account', 'portefeuille', 'wallet']), currency: guessCol(hdr, ['devise', 'currency', 'monnaie']),
    note: guessCol(hdr, ['note', 'comment', 'descr', 'libell', 'memo']),
  };
  const opt = { header: true, order: 'dmy', positiveIs: 'auto', defAcc: accounts()[0]?.id };
  const sample = rows.slice(1, 60).map(r => r[m.date]).filter(Boolean);
  if (sample.some(s => { const x = /^(\d{1,2})[-/.](\d{1,2})/.exec(s); return x && +x[2] > 12; })) opt.order = 'mdy';
  const fields = [['date', 'Date *'], ['amount', 'Montant *'], ['type', 'Type (dépense/revenu)'], ['category', 'Catégorie'], ['account', 'Compte'], ['currency', 'Devise'], ['note', 'Note']];
  openSheet('Importer ' + fname, '<div data-w></div>', sh => {
    const box = $('[data-w]', sh);
    const build = () => {
      const data = opt.header ? rows.slice(1) : rows; const cols = rows[0].map((h, i) => opt.header ? h || `Colonne ${i + 1}` : `Colonne ${i + 1}`);
      const res = convert(data);
      box.innerHTML = `<div class="line"><span>1re ligne = titres</span><label class="toggle"><input type="checkbox" data-hdr ${opt.header ? 'checked' : ''}><span></span></label></div>
        ${fields.map(([k, l]) => `<div class="field"><label>${l}</label><select data-map="${k}"><option value="-1">— ignorer —</option>${cols.map((c, i) => `<option value="${i}" ${m[k] === i ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`).join('')}
        <div class="field"><label>Format des dates</label><select data-order><option value="dmy" ${opt.order === 'dmy' ? 'selected' : ''}>JJ/MM/AAAA</option><option value="mdy" ${opt.order === 'mdy' ? 'selected' : ''}>MM/JJ/AAAA</option></select></div>
        ${m.type < 0 ? `<div class="field"><label>Sans colonne Type, un montant positif est…</label><select data-pos><option value="auto" ${opt.positiveIs === 'auto' ? 'selected' : ''}>un revenu (négatif = dépense)</option><option value="expense" ${opt.positiveIs === 'expense' ? 'selected' : ''}>une dépense</option></select></div>` : ''}
        ${m.account < 0 ? `<div class="field"><label>Compte de destination</label><select data-defacc>${accounts().map(a => `<option value="${a.id}" ${a.id === opt.defAcc ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>` : ''}
        <div class="h2">Aperçu</div>
        <div class="scrollx"><table class="prev"><tr><th>Date</th><th>Type</th><th>Montant</th><th>Catégorie</th><th>Compte</th></tr>
          ${res.items.slice(0, 6).map(x => `<tr><td>${x.date}</td><td>${{ expense: 'Dép.', income: 'Rev.', transfer: 'Vir.' }[x.type]}</td><td>${esc(x.amount)}</td><td>${esc(x.catName || '—')}</td><td>${esc(x.accName)}</td></tr>`).join('')}</table></div>
        <div class="note ${res.bad ? 'warn' : ''}">${res.items.length} opération(s) prêtes · ${res.bad} ligne(s) ignorée(s)
          ${res.newCats.size ? `<br>${res.newCats.size} nouvelle(s) catégorie(s) : ${esc([...res.newCats].slice(0, 8).join(', '))}${res.newCats.size > 8 ? '…' : ''}` : ''}
          ${res.newAccs.size ? `<br>${res.newAccs.size} nouveau(x) compte(s) : ${esc([...res.newAccs].join(', '))}` : ''}</div>
        <button class="btn" data-go ${res.items.length ? '' : 'disabled'}>Importer ${res.items.length} opération(s)</button>`;
      $('[data-hdr]', box).onchange = e => { opt.header = e.target.checked; build(); };
      $$('[data-map]', box).forEach(s => s.onchange = () => { m[s.dataset.map] = Number(s.value); build(); });
      $('[data-order]', box).onchange = e => { opt.order = e.target.value; build(); };
      const p = $('[data-pos]', box); if (p) p.onchange = e => { opt.positiveIs = e.target.value; build(); };
      const d = $('[data-defacc]', box); if (d) d.onchange = e => { opt.defAcc = e.target.value; build(); };
      $('[data-go]', box).onclick = () => doImport(res);
    };
    const convert = data => {
      const catByName = new Map(all('category').map(c => [c.kind + '|' + norm(c.name), c.id]));
      const accByName = new Map(all('account').map(a => [norm(a.name), a.id]));
      const items = []; let bad = 0; const newCats = new Set(), newAccs = new Set(); const seen = {};
      for (const r of data) {
        const date = m.date >= 0 ? parseDateFlex(r[m.date], opt.order) : null;
        let amt = m.amount >= 0 ? parseNum(r[m.amount]) : null;
        if (!date || amt == null || amt === 0) { bad++; continue; }
        let type;
        if (m.type >= 0) { const t = norm(r[m.type]);
          type = /vir|transf/.test(t) ? 'transfer' : /rev|recet|income|entr|credit|gain/.test(t) ? 'income' : /dep|expen|sort|debit|achat/.test(t) ? 'expense' : (amt < 0 ? 'expense' : 'income'); }
        else type = opt.positiveIs === 'expense' ? (amt < 0 ? 'income' : 'expense') : (amt < 0 ? 'expense' : 'income');
        if (type === 'transfer') type = amt < 0 ? 'expense' : 'income';
        amt = Math.abs(amt);
        const catName = m.category >= 0 ? (r[m.category] || '').trim() : '';
        const accName = m.account >= 0 ? (r[m.account] || '').trim() : '';
        if (catName && !catByName.has(type + '|' + norm(catName))) newCats.add((type === 'income' ? '+' : '') + catName);
        if (accName && !accByName.has(norm(accName))) newAccs.add(accName);
        const key = [date, type, amt, norm(catName), norm(accName), r[m.note] || ''].join('|'); seen[key] = (seen[key] || 0) + 1;
        items.push({ date, type, amount: amt, catName, accName: accName || get(opt.defAcc)?.name || '', accRaw: accName,
          currency: m.currency >= 0 ? (r[m.currency] || '').trim().toUpperCase() : '', note: m.note >= 0 ? (r[m.note] || '') : '', id: 'imp_' + hashStr(key + '#' + seen[key]) });
      }
      return { items, bad, newCats, newAccs, catByName, accByName };
    };
    const doImport = res => {
      const pal = i => PALETTE[i % PALETTE.length];
      let ci = 0;
      for (const it of res.items) {
        let accId = it.accRaw ? res.accByName.get(norm(it.accRaw)) : opt.defAcc;
        if (!accId) { const cur = CURRENCIES[it.currency] ? it.currency : settings().base;
          accId = put('account', null, { name: it.accRaw, currency: cur, icon: 'wallet', color: pal(ci++), initial: 0, inTotal: true, order: accounts().length }, { silent: true }); res.accByName.set(norm(it.accRaw), accId); }
        let catId = null;
        if (it.catName) { const k = it.type + '|' + norm(it.catName); catId = res.catByName.get(k);
          if (!catId) { catId = put('category', null, { name: it.catName, icon: 'tag', color: pal(ci++), kind: it.type }, { silent: true }); res.catByName.set(k, catId); } }
        else { const k = it.type + '|' + norm(it.type === 'income' ? 'Autre revenu' : 'Autre'); catId = res.catByName.get(k) || null; }
        if (!S.records.has(it.id)) put('tx', it.id, { type: it.type, amount: it.amount, account: accId, category: catId, date: it.date, note: it.note, by: S.meta.userId || null, created: new Date().toISOString(), imported: true }, { silent: true });
      }
      scheduleSync(); closeAllSheets(); render(); toast(`${res.items.length} opération(s) importée(s)`);
      if (res.newCats.size) setTimeout(() => toast('Pense à choisir icônes et couleurs des nouvelles catégories (Plus › Catégories)', 4000), 2400);
    };
    build();
  });
}

/* =========================================================
   11. Écran de synchronisation (configuration du foyer)
   ========================================================= */
function syncSheet() {
  listSheet('Synchronisation à deux', () => syncHtml(), sh => bindSync(sh));
  refreshSyncInfo();
}
let syncInfo = { user: null, loading: true };
async function refreshSyncInfo() {
  syncInfo.loading = true; syncInfo.user = await currentUser().catch(() => null); syncInfo.loading = false;
  if (syncInfo.user && !S.meta.household) { try { const hh = await loadMembership(); if (hh) await attachExisting(); } catch (e) {} }
  S.refreshSheet && S.refreshSheet();
}
function syncHtml() {
  const c = S.meta.config || {};
  if (!sb) return `<div class="note">Les données restent sur ce téléphone tant que la synchro n’est pas configurée. Suis le guide fourni pour créer ta base Supabase (gratuite), puis colle ici l’adresse et la clé publique (anon / publishable).</div>
    <div class="field"><label>URL du projet Supabase</label><input data-url placeholder="https://xxxx.supabase.co" value="${esc(c.url || '')}" autocomplete="off"></div>
    <div class="field"><label>Clé publique (anon / publishable)</label><input data-key placeholder="eyJ… ou sb_publishable_…" value="${esc(c.key || '')}" autocomplete="off"></div>
    <button class="btn" data-savecfg>Enregistrer</button>`;
  if (syncInfo.loading) return `<div class="empty">Vérification…</div>`;
  if (!syncInfo.user) return `<div class="note">Chacun crée son propre identifiant (n’importe quelle adresse email, aucun lien avec Google ni avec vos contacts).</div>
    <div class="field"><input data-email type="email" placeholder="Email" autocomplete="username"></div>
    <div class="field"><input data-pass type="password" placeholder="Mot de passe (8 caractères min.)" autocomplete="current-password"></div>
    <div class="btns"><button class="btn" data-login>Se connecter</button><button class="btn sec" data-signup>Créer un compte</button></div>
    <button class="btn danger" style="margin-top:20px" data-resetcfg>Changer de projet Supabase</button>`;
  const hh = S.meta.household;
  if (!hh) return `<div class="note">Connecté : ${esc(syncInfo.user.email)}</div>
    <div class="field"><label>Ton prénom (affiché sur tes saisies)</label><input data-dname value="${esc(S.meta.myName || '')}" placeholder="ex. Gauthier"></div>
    <div class="h2">Premier téléphone</div>
    <div class="field"><input data-hname placeholder="Nom du foyer (ex. Famille Perrin)"></div>
    <button class="btn" data-create>Créer notre foyer</button>
    <div class="h2">Deuxième téléphone</div>
    <div class="field"><input data-code placeholder="Code d’invitation (6 caractères)" style="text-transform:uppercase;letter-spacing:3px"></div>
    <button class="btn sec" data-join>Rejoindre le foyer</button>
    <button class="btn danger" style="margin-top:20px" data-logout>Se déconnecter</button>`;
  const last = S.meta.lastSync ? new Date(S.meta.lastSync).toLocaleString('fr-FR') : 'jamais';
  return `<div class="note">Foyer <b>${esc(hh.name || '')}</b> · ${esc(syncInfo.user.email)}<br>État : ${{ ok: 'synchronisé', busy: 'en cours…', err: 'erreur — ' + esc(syncErr), off: 'inactif' }[syncState]} · dernière synchro : ${esc(last)}${S.outbox.size ? `<br>${S.outbox.size} modification(s) en attente d’envoi` : ''}</div>
    <div class="h2">Code d’invitation pour l’autre téléphone</div><div class="code">${esc(hh.join_code || '')}</div>
    <div class="h2">Membres</div>
    <div class="list" style="margin-top:0">${S.members.map(mb => `<div class="row">${icBubble('smile', '#2f6b52', 'sm')}<div class="main"><div class="t">${esc(mb.display_name || '(sans nom)')}${mb.user_id === S.meta.userId ? ' (toi)' : ''}</div></div></div>`).join('')}</div>
    <button class="btn" style="margin-top:14px" data-syncnow>Synchroniser maintenant</button>
    <button class="btn danger" data-logout>Se déconnecter de ce téléphone</button>`;
}
function bindSync(sh) {
  const on = (sel, fn) => { const el = $(sel, sh); if (el) el.onclick = fn; };
  on('[data-savecfg]', async () => {
    const url = $('[data-url]', sh).value.trim().replace(/\/+$/, ''), key = $('[data-key]', sh).value.trim();
    if (!/^https:\/\/.+/.test(url) || key.length < 20) return toast('URL ou clé invalide');
    await setMeta('config', { url, key }); initSupabase(); refreshSyncInfo();
  });
  on('[data-resetcfg]', async () => { await setMeta('config', null); sb = null; S.refreshSheet(); });
  const creds = () => ({ email: $('[data-email]', sh).value.trim(), password: $('[data-pass]', sh).value });
  on('[data-login]', async () => {
    const { error } = await sb.auth.signInWithPassword(creds());
    if (error) return toast(error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect' : error.message);
    refreshSyncInfo();
  });
  on('[data-signup]', async () => {
    const c = creds(); if (c.password.length < 8) return toast('Mot de passe : 8 caractères minimum');
    const { data, error } = await sb.auth.signUp(c);
    if (error) return toast(error.message);
    if (!data.session) toast('Compte créé. Confirme ton email (lien reçu), puis connecte-toi.', 5000);
    refreshSyncInfo();
  });
  on('[data-logout]', () => confirmSheet('Se déconnecter ? Les données restent sur ce téléphone mais ne seront plus synchronisées.', 'Se déconnecter', async () => {
    await sb.auth.signOut(); await setMeta('household', null); await setMeta('lastPull', null); setSync('off'); refreshSyncInfo(); render();
  }));
  on('[data-syncnow]', async () => { await sync(); S.refreshSheet(); toast(syncState === 'ok' ? 'Synchronisé' : 'Échec : ' + syncErr); });
  const dn = $('[data-dname]', sh); if (dn) dn.oninput = e => setMeta('myName', e.target.value.trim());
  on('[data-create]', async () => {
    const name = $('[data-dname]', sh).value.trim(); if (!name) return toast('Indique ton prénom');
    const { data, error } = await sb.rpc('create_household', { p_name: $('[data-hname]', sh).value.trim() || 'Foyer', p_display: name });
    if (error) return toast(error.message);
    await setMeta('household', { id: data.id, join_code: data.join_code, name: $('[data-hname]', sh).value.trim() || 'Foyer' });
    // tout ce qui existe sur ce téléphone part vers le foyer
    for (const r of S.records.values()) S.outbox.add(r.id);
    await setMeta('outbox', [...S.outbox]);
    // les saisies faites avant la connexion sont attribuées à ce téléphone
    for (const t of all('tx')) if (!t.by) put('tx', t.id, { ...t, by: S.meta.userId }, { silent: true });
    await sync(); S.refreshSheet(); render(); toast('Foyer créé — donne le code à ton épouse');
  });
  on('[data-join]', async () => {
    const name = $('[data-dname]', sh).value.trim(); if (!name) return toast('Indique ton prénom');
    const code = $('[data-code]', sh).value.trim().toUpperCase(); if (code.length !== 6) return toast('Le code fait 6 caractères');
    confirmSheet('Rejoindre ce foyer remplace les données de CE téléphone par celles du foyer. Continuer ?', 'Rejoindre', async () => {
      const { data, error } = await sb.rpc('join_household', { p_code: code, p_display: name });
      if (error) return toast(error.message);
      await setMeta('household', { id: data.id, join_code: data.join_code, name: '' });
      await afterJoin(true); await loadMembership(); S.refreshSheet && S.refreshSheet(); toast('Foyer rejoint');
    }, false);
  });
}
/* Connexion à un foyer existant (réinstallation, nouveau téléphone) :
   sans opération locale on repart des données du foyer, sinon on fusionne. */
async function attachExisting() {
  if (!all('tx').length) return afterJoin(true);
  for (const r of S.records.values()) S.outbox.add(r.id);
  await setMeta('outbox', [...S.outbox]);
  toast('Données de ce téléphone fusionnées avec le foyer', 3500);
  return afterJoin(false);
}
async function afterJoin(wipe) {
  if (wipe) { S.records.clear(); S.outbox.clear(); await IDB.clear('records'); await setMeta('outbox', []); await setMeta('lastPull', null); await setMeta('account', 'total'); }
  await sync(); render();
}

/* =========================================================
   11b. Plafonds, voyages / événements
   ========================================================= */
function limitsSheet() {
  listSheet('Plafonds mensuels', () => {
    const mr = monthRange(todayStr()); const cats = categories('expense').sort((a, b) => (Number(b.limit) > 0) - (Number(a.limit) > 0) || catSpent(b.id, mr[0], mr[1]) - catSpent(a.id, mr[0], mr[1]));
    const withL = cats.filter(c => Number(c.limit) > 0); const tot = withL.reduce((s, c) => s + Number(c.limit), 0);
    const spentTot = withL.reduce((s, c) => s + catSpent(c.id, mr[0], mr[1]), 0);
    return `<div class="note">Plafond par catégorie, en ${esc(settings().base)}, tous comptes confondus. Une alerte s’affiche à 80 % et en cas de dépassement. Mois en cours : ${esc(FMT_MONTH.format(dparse(mr[0])))}.</div>
      ${withL.length ? `<div class="card" style="margin-bottom:8px"><div class="t" style="font-weight:600">Total des catégories plafonnées</div>${limitBar(spentTot, tot, mr)}</div>` : ''}
      <div class="list" style="margin-top:0">${cats.map(c => { const sp = catSpent(c.id, mr[0], mr[1]);
        return `<div class="row">${icBubble(c.icon, c.color, 'sm')}<div class="main"><div class="t">${esc(c.name)} <span class="s" style="display:inline">· ${fmt(sp, settings().base)} ce mois</span></div>${Number(c.limit) > 0 ? limitBar(sp, Number(c.limit), mr) : ''}</div>
          <input data-lim="${c.id}" inputmode="decimal" placeholder="Aucun" value="${esc(c.limit || '')}" style="width:112px;padding:8px;text-align:right"></div>`; }).join('')}</div>
      <button class="btn sticky" style="margin-top:14px" data-save>Enregistrer les plafonds</button>`;
  }, sh => {
    $('[data-save]', sh).onclick = () => {
      let n = 0;
      $$('[data-lim]', sh).forEach(i => { const c = get(i.dataset.lim); const v = evalAmount(i.value); const nv = v > 0 ? v : null;
        if ((c.limit || null) !== nv) { put('category', c.id, { ...c, limit: nv }, { silent: true }); n++; } });
      scheduleSync(); document.activeElement?.blur(); render(); toast(n ? `${n} plafond(s) mis à jour` : 'Aucun changement');
    };
  });
}
function eventsSheet() {
  listSheet('Voyages et événements', () => {
    const act = activeEvent(); const base = settings().base;
    const list = events();
    return `<div class="note">Un événement regroupe les dépenses d’un voyage, d’une fête ou d’un chantier, quels que soient le compte et la catégorie. En <b>mode voyage</b>, toutes les saisies de ce téléphone y sont rattachées automatiquement.</div>
      <div class="list" style="margin-top:0">${list.length ? list.map(e => { const t = eventTotals(e.id);
        return `<button class="row" data-e="${e.id}" ${act?.id === e.id ? 'style="outline:2px solid var(--acc)"' : ''}>${icBubble(e.icon || 'plane', e.color || '#0ea5e9')}<div class="main"><div class="t">${esc(e.name)}${act?.id === e.id ? ' <span class="who" style="color:var(--acc)">actif</span>' : ''}</div>
          <div class="s">${e.start ? esc(FMT_SHORT.format(dparse(e.start))) : ''}${e.end ? ' → ' + esc(FMT_SHORT.format(dparse(e.end))) + ' ' + e.end.slice(0, 4) : ''} · ${t.list.length} opération(s)</div>
          ${Number(e.budget) > 0 ? limitBar(t.exp, Number(e.budget)) : ''}</div><span class="amt">${fmt(t.exp, base)}</span></button>`; }).join('') : '<div class="empty">Aucun événement pour l’instant.</div>'}</div>
      <button class="btn" style="margin-top:14px" data-add>Nouveau voyage / événement</button>`;
  }, sh => {
    $$('[data-e]', sh).forEach(b => b.onclick = () => eventDetail(b.dataset.e));
    $('[data-add]', sh).onclick = () => eventForm(null);
  });
}
function eventForm(existing) {
  const f = existing ? { ...existing } : { name: '', icon: 'plane', color: '#0ea5e9', start: todayStr(), end: '', account: '', budget: null };
  const isActive = existing && S.meta.activeEvent === existing.id;
  openSheet(existing ? 'Modifier l’événement' : 'Nouveau voyage / événement', `
    <div class="field"><input data-name placeholder="Nom (ex. Vacances France 2027, Mariage Hery…)" value="${esc(f.name)}"></div>
    <div class="two"><div class="field"><label>Début</label><input type="date" data-start value="${esc(f.start || '')}"></div><div class="field"><label>Fin (facultatif)</label><input type="date" data-end value="${esc(f.end || '')}"></div></div>
    <div class="field"><label>Compte proposé par défaut pendant le voyage</label><select data-acc><option value="">— inchangé —</option>${accounts().map(a => `<option value="${a.id}" ${a.id === f.account ? 'selected' : ''}>${esc(a.name)} (${a.currency})</option>`).join('')}</select></div>
    <div class="field"><label>Budget total (${esc(settings().base)}, facultatif)</label><input data-budget inputmode="decimal" value="${esc(f.budget || '')}"></div>
    <div class="line"><span>Compter ces dépenses dans les plafonds mensuels</span><label class="toggle"><input type="checkbox" data-inlim ${f.inLimits ? 'checked' : ''}><span></span></label></div>
    <div class="line"><span>Activer le mode voyage sur ce téléphone</span><label class="toggle"><input type="checkbox" data-active ${isActive || !existing ? 'checked' : ''}><span></span></label></div>
    <div class="field"><label>Couleur</label>${colorPicker(f.color)}</div>
    <div class="field"><label>Icône</label>${iconPicker(f.icon)}</div>
    <button class="btn sticky" data-save>${existing ? 'Enregistrer' : 'Créer'}</button>
    ${existing ? '<button class="btn danger" data-del>Supprimer l’événement</button>' : ''}`, sh => {
    bindPickers(sh, f);
    $('[data-save]', sh).onclick = () => {
      f.name = $('[data-name]', sh).value.trim(); if (!f.name) return toast('Donne un nom');
      f.start = $('[data-start]', sh).value || todayStr(); f.end = $('[data-end]', sh).value || null;
      if (f.end && f.end < f.start) return toast('La fin est avant le début');
      f.account = $('[data-acc]', sh).value || null; const b = evalAmount($('[data-budget]', sh).value); f.budget = b > 0 ? b : null; f.inLimits = $('[data-inlim]', sh).checked;
      const id = put('event', existing?.id, f, { silent: true });
      const on = $('[data-active]', sh).checked;
      if (on) setMeta('activeEvent', id); else if (S.meta.activeEvent === id) setMeta('activeEvent', null);
      scheduleSync(); render(); closeSheet(); toast(on ? `Mode voyage activé : ${f.name}` : 'Enregistré');
    };
    const d = $('[data-del]', sh); if (d) d.onclick = () => confirmSheet('Supprimer cet événement ? Les opérations sont conservées, elles ne seront simplement plus rattachées.', 'Supprimer', async () => {
      if (S.meta.activeEvent === existing.id) await setMeta('activeEvent', null);
      del(existing.id); closeAllSheets();
    });
  });
}
function eventDetail(evId) {
  listSheet('Voyage / événement', () => {
    const e = get(evId); if (!e) return '<div class="empty">Événement supprimé.</div>';
    const t = eventTotals(evId); const base = settings().base; const act = S.meta.activeEvent === evId;
    const cats = new Map(); const curOf = {}; all('account').forEach(a => curOf[a.id] = a.currency);
    t.list.filter(x => x.type === 'expense').forEach(x => cats.set(x.category || '_none', (cats.get(x.category || '_none') || 0) + (toBase(Number(x.amount), curOf[x.account], x.date, x.fxRate) || 0)));
    const crow = [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => { const c = get(id) || { name: 'Sans catégorie', icon: 'circle-help', color: '#64748b' };
      return `<div class="row">${icBubble(c.icon, c.color, 'sm')}<div class="main"><div class="t">${esc(c.name)}</div></div><span class="pct">${t.exp ? Math.round(v / t.exp * 100) : 0} %</span><span class="amt">${fmt(v, base)}</span></div>`; }).join('');
    const days = e.start ? Math.max(1, ((e.end && e.end < todayStr() ? dparse(e.end) : new Date()) - dparse(e.start)) / 864e5 + 1 | 0) : null;
    return `<div class="card"><div style="display:flex;gap:12px;align-items:center">${icBubble(e.icon || 'plane', e.color || '#0ea5e9')}<div style="flex:1"><div style="font-weight:700;font-size:18px">${esc(e.name)}</div>
      <div class="s" style="color:var(--mut);font-size:13px">${e.start ? esc(FMT_NUM.format(dparse(e.start))) : ''}${e.end ? ' → ' + esc(FMT_NUM.format(dparse(e.end))) : ''}</div></div><button class="iconbtn" data-edit>${svg('chevron-right')}</button></div>
      <div class="net" style="margin-top:12px"><div>Dépenses<b>${fmt(t.exp, base)}</b></div>${days && t.exp ? `<div>Par jour<b>${fmt(t.exp / days, base)}</b></div>` : ''}<div>Opérations<b>${t.list.length}</b></div></div>
      ${Number(e.budget) > 0 ? limitBar(t.exp, Number(e.budget)) : ''}
      <div class="line" style="margin-top:6px"><span>Mode voyage sur ce téléphone</span><label class="toggle"><input type="checkbox" data-active ${act ? 'checked' : ''}><span></span></label></div></div>
      ${crow ? `<div class="h2">Par catégorie</div><div class="list" style="margin-top:0">${crow}</div>` : ''}
      <div class="h2">Opérations</div><div class="list" style="gap:6px;margin-top:0">${txList(t.list)}</div>`;
  }, sh => {
    const a = $('[data-active]', sh); if (a) a.onchange = () => { setMeta('activeEvent', a.checked ? evId : null); render(); toast(a.checked ? 'Mode voyage activé' : 'Mode voyage désactivé'); };
    const ed = $('[data-edit]', sh); if (ed) ed.onclick = () => eventForm(get(evId));
    $$('[data-tx]', sh).forEach(b => b.onclick = () => txForm(get(b.dataset.tx)));
  });
}

/* =========================================================
   12. Navigation et événements
   ========================================================= */
function pickPeriodSheet() {
  const [f, t] = periodRange();
  openSheet('Choisir la période', `
    <div class="two"><div class="field"><label>Du</label><input type="date" data-from value="${f}"></div><div class="field"><label>Au</label><input type="date" data-to value="${t}"></div></div>
    <button class="btn" data-ok>Afficher</button><button class="btn sec" data-today>Revenir à aujourd’hui</button>`, sh => {
    $('[data-ok]', sh).onclick = () => { const a = $('[data-from]', sh).value, b = $('[data-to]', sh).value; if (!a || !b) return;
      S.period = { mode: 'custom', anchor: a, from: a <= b ? a : b, to: a <= b ? b : a }; closeSheet(); render(); };
    $('[data-today]', sh).onclick = () => { S.period.anchor = todayStr(); if (S.period.mode === 'custom') S.period.mode = 'month'; closeSheet(); render(); };
  });
}
function catDetailSheet(catId) {
  const c = get(catId) || { name: 'Sans catégorie' };
  listSheet(`${c.name} — ${periodLabel()}`, () => {
    const list = periodTxs().filter(t => (t.category || '_none') === catId && t.type !== 'transfer');
    const ctx = viewCtx(); const tot = list.reduce((s, t) => s + (ctx.conv(Number(t.amount), t) || 0), 0);
    return `<div class="note">${list.length} opération(s) · total ${fmt(tot, ctx.cur)}</div><div class="list" style="gap:6px">${txList(list)}</div>`;
  }, sh => { $$('[data-tx]', sh).forEach(b => b.onclick = () => txForm(get(b.dataset.tx))); });
}
document.addEventListener('click', e => {
  const t = e.target.closest('button,[data-cat]'); if (!t || t.closest('.sheet')) return;
  const d = t.dataset;
  if (d.tab) { S.tab = d.tab; window.scrollTo(0, 0); render(); return; }
  if (d.pmode) { if (d.pmode === 'custom') { pickPeriodSheet(); return; } if (S.period.mode === 'custom') S.period.anchor = S.period.from || todayStr(); S.period.mode = d.pmode; render(); return; }
  if (d.btype) { S.budgetType = d.btype; render(); return; }
  if (d.opsf) { S.opsFilter = d.opsf; render(); return; }
  if (d.cgran) { S.chart.gran = d.cgran; S.chart.sel = null; render(); return; }
  if (d.ctype) { S.chart.type = d.ctype; render(); return; }
  if (d.catdetail) { catDetailSheet(d.catdetail); return; }
  if (d.tx) { txForm(get(d.tx)); return; }
  if (d.more) { ({ accounts: () => accountsSheet(false), categories: categoriesSheet, recurring: recurringSheet, currencies: currenciesSheet, importexport: importSheet, syncsetup: syncSheet, about: aboutSheet, events: eventsSheet, limits: limitsSheet })[d.more](); return; }
  const act = d.act;
  if (act === 'newTx') txForm(null, { type: S.tab === 'budget' && S.budgetType === 'income' ? 'income' : 'expense' });
  else if (act === 'prev') shiftPeriod(-1);
  else if (act === 'next') shiftPeriod(1);
  else if (act === 'pickPeriod') pickPeriodSheet();
  else if (act === 'pickAccount') accountsSheet(true);
  else if (act === 'toggleHide') { setMeta('hide', !S.meta.hide); render(); }
  else if (act === 'openEvent') { const ev = activeEvent(); if (ev) eventDetail(ev.id); }
});
document.addEventListener('click', e => { // clic sur un segment du donut ou une barre
  const seg = e.target.closest('circle[data-cat]'); if (seg) { catDetailSheet(seg.dataset.cat); return; }
  const bar = e.target.closest('[data-bar]'); if (bar && !bar.closest('.sheet')) { S.chart.sel = bar.dataset.bar; render(); }
});
document.addEventListener('input', e => { if (e.target.matches('[data-search]')) { S.opsSearch = e.target.value; const pos = e.target.selectionStart; render(); const i = $('[data-search]'); i.focus(); i.setSelectionRange(pos, pos); } });
/* Balayage gauche/droite sur l’écran Budget/Opérations pour changer de période */
let tx0 = null;
document.addEventListener('touchstart', e => { if (e.target.closest('.sheet,input,.chips,.bars')) { tx0 = null; return; } tx0 = [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
document.addEventListener('touchend', e => {
  if (!tx0 || !['budget', 'ops'].includes(S.tab)) return; const dx = e.changedTouches[0].clientX - tx0[0], dy = e.changedTouches[0].clientY - tx0[1]; tx0 = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && S.period.mode !== 'custom') shiftPeriod(dx < 0 ? 1 : -1);
}, { passive: true });
function aboutSheet() {
  openSheet('À propos', `<p><b>Budget Foyer</b> — appli personnelle, sans publicité, sans accès à vos contacts.</p>
    <div class="note">Données : stockées sur chaque téléphone (fonctionne hors ligne) et, si la synchro est active, dans votre propre base Supabase. Rien d’autre n’est envoyé nulle part.</div>
    <div class="note">${S.records.size} éléments locaux · ${S.outbox.size} en attente d’envoi</div>
    <div class="note">Icônes : Lucide (licence ISC). Synchro : supabase-js (licence MIT).</div>`);
}

/* =========================================================
   13. Démarrage
   ========================================================= */
async function start() {
  $$('[data-i]').forEach(s => s.outerHTML = svg(s.dataset.i));
  try { await IDB.open(); } catch (e) { document.body.innerHTML = '<p style="padding:20px">Stockage local indisponible sur ce navigateur.</p>'; return; }
  const [recs, meta] = await Promise.all([IDB.all('records'), IDB.allMeta()]);
  recs.forEach(r => S.records.set(r.id, r)); S.meta = meta; fxVer++;
  (meta.outbox || []).forEach(id => S.outbox.add(id)); S.members = meta.members || [];
  if (!S.records.size && !meta.household) seed();
  if (USE_HISTORY) history.replaceState({ sheet: 0 }, '');
  initSupabase();
  runRecurring(); render();
  if (sb && S.meta.household) { setSync('busy'); sync(); } else setSync('off');
  if (sb && !S.meta.household) loadMembership().then(hh => { if (hh) attachExisting(); }).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (todayStr() !== S._day) { S._day = todayStr(); runRecurring(); render(); } scheduleSync(200); } });
  window.addEventListener('online', () => { scheduleSync(200); updateFx(); });
  setTimeout(() => updateFx(), 1500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateFx(); });
  setInterval(() => { if (!document.hidden) scheduleSync(0); }, 60000);
  S._day = todayStr();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
