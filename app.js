import * as db from './db.js';
import * as sync from './sync.js';

const DEFAULT_CATEGORIES = {
  income: ['Freelance', 'Bonus', 'Interest', 'Rent', 'Gift', 'Other'],
  expense: ['Rent / EMI', 'Groceries', 'Food & dining', 'Transport', 'Bills & utilities', 'Shopping', 'Health', 'Entertainment', 'Other'],
  investment: ['Mutual fund / SIP', 'Stocks', 'Fixed deposit', 'PPF / EPF', 'Gold', 'Crypto', 'Other'],
};
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'CAD', 'AUD', 'SGD', 'JPY'];
const TYPE_LABEL = { salary: 'Salary', income: 'Other income', expense: 'Spending' };

const state = {
  tab: 'dashboard',
  month: new Date().toISOString().slice(0, 7),
  entries: [],
  investments: [],
  categories: [],
  settings: { id: 'prefs', currency: 'INR' },
};
let installPrompt = null;

// ---------- helpers ----------

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr, f = x => x) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const todayISO = () => new Date().toISOString().slice(0, 10);

function money(n) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n || 0);
  } catch {
    return (n || 0).toFixed(2);
  }
}
const pct = n => (isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '–');

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(month, opts = { month: 'long', year: 'numeric' }) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, opts);
}
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
// Default date for a new entry: today if viewing this month, else the 1st of the viewed month.
const defaultDate = () => (todayISO().startsWith(state.month) ? todayISO() : `${state.month}-01`);

const catName = id => state.categories.find(c => c.id === id)?.name || 'Uncategorized';
const catsOf = kind => state.categories.filter(c => c.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
const entriesIn = (month, type) => state.entries.filter(e => e.date.startsWith(month) && (!type || e.type === type));
const investedIn = month => sum(state.investments.flatMap(i => i.contributions || []).filter(c => c.date.startsWith(month)), c => c.amount);
const investedTotal = inv => sum(inv.contributions || [], c => c.amount);

function monthTotals(month) {
  const salary = sum(entriesIn(month, 'salary'), e => e.amount);
  const other = sum(entriesIn(month, 'income'), e => e.amount);
  const spent = sum(entriesIn(month, 'expense'), e => e.amount);
  const invested = investedIn(month);
  const income = salary + other;
  return { salary, other, income, spent, invested, saved: income - spent - invested };
}

function byCategory(list) {
  const map = new Map();
  for (const e of list) map.set(catName(e.categoryId), (map.get(catName(e.categoryId)) || 0) + e.amount);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- data ----------

async function load() {
  [state.entries, state.investments, state.categories] = await Promise.all([db.all('entries'), db.all('investments'), db.all('categories')]);
  const prefs = (await db.all('settings')).find(s => s.id === 'prefs');
  if (prefs) state.settings = prefs;
  if (!prefs) {
    // First run: seed default categories.
    for (const [kind, names] of Object.entries(DEFAULT_CATEGORIES)) {
      for (const name of names) state.categories.push(await db.put('categories', { kind, name }, { seed: true }));
    }
    state.settings = await db.put('settings', state.settings, { seed: true });
  }
}

async function save(store, record) {
  const rec = await db.put(store, record);
  if (Array.isArray(state[store])) {
    const i = state[store].findIndex(r => r.id === rec.id);
    if (i >= 0) state[store][i] = rec; else state[store].push(rec);
  }
  scheduleSync();
  return rec;
}
async function drop(store, id) {
  await db.remove(store, id);
  state[store] = state[store].filter(r => r.id !== id);
  scheduleSync();
}

// ---------- sync ----------

let syncMessage = '';
let syncTimer;

function syncStatusText() {
  if (syncMessage) return syncMessage;
  const last = sync.lastSynced();
  if (!last) return 'Not synced yet.';
  const mins = Math.round((Date.now() - new Date(last)) / 60000);
  return `Last synced ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : new Date(last).toLocaleString()}.`;
}
function showSyncStatus() {
  const el = $('#sync-status');
  if (el) el.textContent = syncStatusText();
}

async function runSync(interactive = false) {
  if (!interactive && !sync.isEnabled()) return;
  syncMessage = 'Syncing…';
  showSyncStatus();
  try {
    const changed = await sync.syncNow({ interactive });
    syncMessage = '';
    if (changed) { await load(); render(); } else if (interactive) render(); else showSyncStatus();
    if (interactive) toast('Synced with Google Drive');
  } catch (err) {
    syncMessage = err instanceof sync.NeedsSignIn ? 'Signed out of Google. Tap Sync now to sign in again.' : (err.message || 'Sync failed. Try again later.');
    showSyncStatus();
    if (interactive) toast(syncMessage);
  }
}

// Push local changes a few seconds after the last edit.
function scheduleSync() {
  if (!sync.isEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(false), 3000);
}

// ---------- views ----------

// Stable color per category name, picked from the theme's category palette.
function catColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--c${h % 8})`;
}
const avatar = name => `<span class="avatar" style="--tone:${catColor(name)}" aria-hidden="true">${esc([...name.trim()][0] || '?').toUpperCase()}</span>`;

function entryRow(e) {
  const cls = e.type === 'expense' ? 'spend' : 'income';
  const title = e.type === 'salary' ? 'Salary' : catName(e.categoryId);
  return `<div class="row" data-action="edit-entry" data-id="${e.id}">
    ${avatar(title)}
    <div class="main"><div class="title">${esc(title)}</div><div class="meta">${fmtDate(e.date)}${e.note ? ' · ' + esc(e.note) : ''}</div></div>
    <div class="amt ${cls}">${e.type === 'expense' ? '−' : '+'}${money(e.amount)}</div>
  </div>`;
}
const listCard = (rows, empty) => `<div class="card list">${rows.length ? rows.join('') : `<div class="empty">${empty}</div>`}</div>`;
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.updatedAt || '').localeCompare(a.updatedAt || '');

function bars(pairs, cls = '') {
  if (!pairs.length) return '<div class="empty">Nothing yet this month.</div>';
  const max = pairs[0][1] || 1;
  const total = sum(pairs, p => p[1]);
  return `<div class="bars">${pairs.map(([name, v]) => `<div class="bar-row" style="--tone:${catColor(name)}">
    <div class="bar-top"><span><i class="dot"></i>${esc(name)}</span><span><b>${money(v)}</b> <span class="muted">${Math.round((v / total) * 100)}%</span></span></div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${(v / max) * 100}%"></div></div>
  </div>`).join('')}</div>`;
}

function donut(pairs) {
  const total = sum(pairs, p => p[1]);
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = pairs.map(([name, v]) => {
    const len = (v / total) * C;
    const arc = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${catColor(name)}" stroke-width="18" stroke-dasharray="${Math.max(len - 2, 0.1)} ${C}" stroke-dashoffset="${-offset}"><title>${esc(name)} ${money(v)}</title></circle>`;
    offset += len;
    return arc;
  }).join('');
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="Spending by category">
    <circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--surface-2)" stroke-width="18"/>
    <g transform="rotate(-90 70 70)">${arcs}</g>
    <text x="70" y="66" text-anchor="middle" class="donut-label">Spent</text>
    <text x="70" y="86" text-anchor="middle" class="donut-value">${money(total)}</text>
  </svg>`;
}

function trendChart() {
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(state.month, i - 5));
  const data = months.map(m => ({ m, ...monthTotals(m) }));
  const max = Math.max(1, ...data.flatMap(d => [d.income, d.spent + d.invested]));
  const W = 600, H = 240, pad = 30, gw = W / 6, bw = Math.min(28, gw / 3.2);
  const h = v => ((H - pad - 8) * v) / max;
  const groups = data.map((d, i) => {
    const x = i * gw + gw / 2;
    const spendH = h(d.spent), invH = h(d.invested);
    return `<g>
      <rect x="${x - bw - 2}" y="${H - pad - h(d.income)}" width="${bw}" height="${h(d.income)}" rx="3" fill="var(--income)"><title>Income ${money(d.income)}</title></rect>
      <rect x="${x + 2}" y="${H - pad - spendH}" width="${bw}" height="${spendH}" rx="3" fill="var(--spend)"><title>Spending ${money(d.spent)}</title></rect>
      <rect x="${x + 2}" y="${H - pad - spendH - invH}" width="${bw}" height="${invH}" rx="3" fill="var(--invest)"><title>Invested ${money(d.invested)}</title></rect>
      <text x="${x}" y="${H - 8}" text-anchor="middle" ${d.m === state.month ? 'style="font-weight:700;fill:var(--text)"' : ''}>${esc(monthLabel(d.m, { month: 'short' }))}</text>
    </g>`;
  }).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income versus spending and investing over the last 6 months">
    <line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" stroke="var(--border)"/>${groups}</svg>
    <div class="legend"><span><i style="background:var(--income)"></i>Income</span><span><i style="background:var(--spend)"></i>Spending</span><span><i style="background:var(--invest)"></i>Invested</span></div></div>`;
}

function portfolio() {
  const invested = sum(state.investments, investedTotal);
  const current = sum(state.investments, i => i.currentValue ?? investedTotal(i));
  return { invested, current, gain: current - invested, gainPct: invested ? ((current - invested) / invested) * 100 : NaN };
}

const stat = (label, value, cls = '', sub = '') =>
  `<div class="card stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

function syncCard() {
  if (!sync.isConfigured()) return '';
  return `<h2>Google Drive sync</h2>
    <div class="card">
      ${sync.isEnabled()
        ? `<p style="margin-top:0" id="sync-status">${esc(syncStatusText())}</p>
           <div class="btn-row"><button class="btn primary" data-action="sync-now">Sync now</button><button class="btn" data-action="sync-disconnect">Turn off sync</button></div>`
        : `<p class="muted" style="margin-top:0">Keep this device in sync with your other devices through your own Google Drive. The data goes into a private app folder that only this app can read.</p>
           <p class="muted" id="sync-status">${syncMessage ? esc(syncMessage) : ''}</p>
           <button class="btn primary" data-action="sync-now">Connect Google Drive</button>`}
    </div>`;
}

const views = {
  dashboard() {
    const t = monthTotals(state.month);
    const rate = t.income ? (t.saved / t.income) * 100 : NaN;
    const p = portfolio();
    const spendCats = byCategory(entriesIn(state.month, 'expense'));
    return `
      <section class="hero">
        <div class="hero-label">Left over in ${esc(monthLabel(state.month, { month: 'long' }))}</div>
        <div class="hero-value">${money(t.saved)}</div>
        <div class="hero-sub">${isFinite(rate) ? `You kept <b>${rate.toFixed(0)}%</b> of what you earned` : 'Add your salary to get started'}</div>
        <div class="hero-meter" aria-hidden="true">
          <span style="flex:${t.spent || 0};background:var(--hero-spend)"></span>
          <span style="flex:${t.invested || 0};background:var(--hero-invest)"></span>
          <span style="flex:${Math.max(t.saved, 0)};background:var(--hero-save)"></span>
        </div>
        <div class="hero-legend"><span><i style="background:var(--hero-spend)"></i>Spent</span><span><i style="background:var(--hero-invest)"></i>Invested</span><span><i style="background:var(--hero-save)"></i>Kept</span></div>
      </section>
      <div class="grid quad">
        ${stat('Salary', money(t.salary), 'income')}
        ${stat('Other income', money(t.other), 'income')}
        ${stat('Spending', money(t.spent), 'spend')}
        ${stat('Invested', money(t.invested), 'invest')}
      </div>
      <h2>Where the money went</h2>
      <div class="card">${spendCats.length ? `<div class="donut-wrap">${donut(spendCats)}${bars(spendCats)}</div>` : bars(spendCats)}</div>
      <h2>Last 6 months</h2>
      <div class="card">${trendChart()}</div>
      <h2>Portfolio</h2>
      <div class="grid">
        ${stat('Total invested', money(p.invested), 'invest')}
        ${stat('Current value', money(p.current))}
        ${stat('Gain / loss', money(p.gain), p.gain < 0 ? 'neg' : 'income', pct(p.gainPct))}
      </div>`;
  },

  income() {
    const salaries = entriesIn(state.month, 'salary').sort(byDateDesc);
    const others = entriesIn(state.month, 'income').sort(byDateDesc);
    const t = monthTotals(state.month);
    const salaryBlock = salaries.length
      ? listCard(salaries.map(entryRow), '')
      : `<div class="card"><div class="empty">No salary recorded for ${esc(monthLabel(state.month))}.<br><br>
          <button class="btn primary" data-action="add-salary">Add salary${lastSalary() ? ' (' + money(lastSalary().amount) + ')' : ''}</button></div></div>`;
    return `
      <div class="grid">
        ${stat('Total income', money(t.income), 'income')}
        ${stat('Salary', money(t.salary))}
        ${stat('Other income', money(t.other))}
      </div>
      <div class="section-head"><h2>Salary</h2>${salaries.length ? '<button class="btn small" data-action="add-salary">+ Salary</button>' : ''}</div>
      ${salaryBlock}
      <div class="section-head"><h2>Other income</h2><button class="btn small" data-action="add-income">+ Income</button></div>
      ${new Set(others.map(e => e.categoryId)).size > 1 ? `<div class="card" style="margin-bottom:12px">${bars(byCategory(others), 'income-bar')}</div>` : ''}
      ${listCard(others.map(entryRow), 'No other income this month.')}`;
  },

  spending() {
    const list = entriesIn(state.month, 'expense').sort(byDateDesc);
    const prev = sum(entriesIn(shiftMonth(state.month, -1), 'expense'), e => e.amount);
    const total = sum(list, e => e.amount);
    const change = prev ? ((total - prev) / prev) * 100 : NaN;
    return `
      <div class="grid">
        ${stat('Spent this month', money(total), 'spend', isFinite(change) ? `${pct(change)} vs last month` : '')}
        ${stat('Entries', list.length)}
      </div>
      <h2>By category</h2>
      <div class="card">${bars(byCategory(list))}</div>
      <div class="section-head"><h2>All spending</h2><button class="btn small" data-action="add-expense">+ Spending</button></div>
      ${listCard(list.map(entryRow), 'No spending recorded this month.')}`;
  },

  investments() {
    const p = portfolio();
    const rows = [...state.investments].sort((a, b) => a.name.localeCompare(b.name)).map(i => {
      const inv = investedTotal(i), cur = i.currentValue ?? inv, g = inv ? ((cur - inv) / inv) * 100 : NaN;
      return `<div class="row" data-action="edit-investment" data-id="${i.id}">
        ${avatar(i.name)}
        <div class="main"><div class="title">${esc(i.name)}</div><div class="meta">${esc(catName(i.categoryId))} · invested ${money(inv)}</div></div>
        <div class="amt">${money(cur)}<div class="meta ${cur < inv ? 'neg' : 'income'}">${pct(g)}</div></div>
      </div>`;
    });
    const thisMonth = state.investments.flatMap(i => (i.contributions || []).filter(c => c.date.startsWith(state.month)).map(c => ({ ...c, inv: i })))
      .sort(byDateDesc)
      .map(c => `<div class="row" data-action="edit-investment" data-id="${c.inv.id}">
        <div class="main"><div class="title">${esc(c.inv.name)}</div><div class="meta">${fmtDate(c.date)}</div></div>
        <div class="amt invest">${money(c.amount)}</div></div>`);
    return `
      <div class="grid">
        ${stat('Total invested', money(p.invested), 'invest')}
        ${stat('Current value', money(p.current))}
        ${stat('Gain / loss', money(p.gain), p.gain < 0 ? 'neg' : 'income', pct(p.gainPct))}
        ${stat(`Invested in ${esc(monthLabel(state.month, { month: 'short' }))}`, money(investedIn(state.month)), 'invest')}
      </div>
      <div class="section-head"><h2>Holdings</h2><button class="btn small" data-action="add-investment">+ Investment</button></div>
      ${listCard(rows, 'No investments yet. Add your SIPs, stocks, FDs and more.')}
      <h2>Added in ${esc(monthLabel(state.month))}</h2>
      ${listCard(thisMonth, 'Nothing added this month. Open a holding to record a contribution.')}`;
  },

  settings() {
    const catBlock = (kind, title) => `
      <h2>${title}</h2>
      <div class="card">
        <div class="chips">${catsOf(kind).map(c => `<span class="chip">${esc(c.name)}<button data-action="delete-category" data-id="${c.id}" aria-label="Remove ${esc(c.name)}">×</button></span>`).join('') || '<span class="muted">No categories.</span>'}</div>
        <form class="inline-form" data-form="add-category" data-kind="${kind}">
          <input class="inline-input" name="name" placeholder="New category" maxlength="40" required>
          <button class="btn">Add</button>
        </form>
      </div>`;
    return `
      <h2>Look</h2>
      <div class="card"><div class="seg" role="radiogroup" aria-label="Look">${Object.entries(SKINS).map(([k, l]) => `<label><input type="radio" name="skin" value="${k}" ${document.documentElement.dataset.skin === k ? 'checked' : ''}>${l}</label>`).join('')}</div></div>
      <h2>Currency</h2>
      <div class="card"><select class="inline-input" id="currency">${CURRENCIES.map(c => `<option ${c === state.settings.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      ${catBlock('income', 'Income categories')}
      ${catBlock('expense', 'Spending categories')}
      ${catBlock('investment', 'Investment types')}
      ${syncCard()}
      <h2>Backup</h2>
      <div class="card">
        <p class="muted" style="margin-top:0">${sync.isEnabled() ? 'Your data is also kept in your Google Drive.' : 'Your data is stored only on this device.'} Export a backup file now and then for safekeeping.</p>
        <div class="btn-row">
          <button class="btn primary" data-action="export">Export backup</button>
          <label class="btn">Import backup<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        </div>
      </div>
      ${installPrompt ? `<h2>App</h2><div class="card"><button class="btn primary" data-action="install">Install on this device</button></div>` : ''}
      <h2>Danger zone</h2>
      <div class="card"><button class="btn danger" data-action="wipe">Delete all data on this device</button></div>`;
  },
};

const SKINS = { fresh: 'Fresh', vault: 'Vault' };
function applySkin() {
  const preview = new URLSearchParams(location.search).get('skin');
  let saved = null;
  try { saved = localStorage.getItem('skin'); } catch {}
  document.documentElement.dataset.skin = SKINS[preview] ? preview : (SKINS[saved] ? saved : 'fresh');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bar-color').trim() || '#0e9f6e');
}

function render() {
  applySkin();
  document.querySelectorAll('.tabs button').forEach(b => { if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('#month').value = state.month;
  $('#month-text').textContent = monthLabel(state.month, { month: 'short', year: 'numeric' });
  $('.month-picker').style.visibility = state.tab === 'settings' ? 'hidden' : '';
  $('#view').innerHTML = views[state.tab]();
}

// ---------- dialogs ----------

function openDialog(html, onSubmit, onReady) {
  const dlg = $('#dialog'), form = $('#dialog-form');
  form.innerHTML = html;
  form.onsubmit = async e => {
    e.preventDefault();
    const action = e.submitter?.value || 'save';
    if (action === 'cancel') return dlg.close();
    try {
      if ((await onSubmit(new FormData(form), action)) !== false) dlg.close();
    } catch (err) {
      toast(err.message || 'Something went wrong');
    }
  };
  onReady?.(form);
  dlg.showModal();
  form.querySelector('[autofocus]')?.focus();
}

const actions = (canDelete) => `<div class="dialog-actions">
  ${canDelete ? '<button class="btn danger" value="delete" formnovalidate>Delete</button>' : ''}
  <div class="right"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="save">Save</button></div></div>`;

const amountField = (value = '', label = 'Amount') =>
  `<label class="field">${label}<input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required autofocus value="${value}"></label>`;

const categoryOptions = (kind, selected) =>
  catsOf(kind).map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('') + '<option value="__new">+ New category…</option>';

function lastSalary() {
  return [...state.entries].filter(e => e.type === 'salary').sort(byDateDesc)[0];
}

// `entry` is either a saved record (has an id) or a template with prefilled fields.
function entryDialog(entry) {
  const e = entry || { type: 'expense', date: defaultDate() };
  const isEdit = !!e.id;
  const kindOf = type => (type === 'expense' ? 'expense' : 'income');
  openDialog(`
    <h3>${isEdit ? 'Edit entry' : 'Add entry'}</h3>
    <div class="seg">${Object.entries(TYPE_LABEL).map(([v, l]) => `<label><input type="radio" name="type" value="${v}" ${e.type === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
    ${amountField(e.amount ?? '')}
    <label class="field" id="cat-field">Category<select name="categoryId"></select></label>
    <label class="field">Date<input name="date" type="date" required value="${e.date}"></label>
    <label class="field">Note (optional)<input name="note" maxlength="120" value="${esc(e.note || '')}"></label>
    ${actions(isEdit)}`,
  async (fd, action) => {
    if (action === 'delete') {
      if (!confirm('Delete this entry?')) return false;
      await drop('entries', e.id);
      toast('Entry deleted');
    } else {
      const type = fd.get('type');
      const amount = parseFloat(fd.get('amount'));
      if (!(amount > 0)) throw new Error('Enter an amount above zero');
      let categoryId = type === 'salary' ? null : fd.get('categoryId');
      if (categoryId === '__new') throw new Error('Pick or create a category');
      await save('entries', { ...e, type, amount, categoryId, date: fd.get('date'), note: fd.get('note').trim() });
      if (!fd.get('date').startsWith(state.month)) state.month = fd.get('date').slice(0, 7);
      toast(isEdit ? 'Saved' : `${TYPE_LABEL[type]} added`);
    }
    render();
  },
  form => {
    const select = form.querySelector('select[name=categoryId]');
    const sync = () => {
      const type = form.querySelector('input[name=type]:checked').value;
      form.querySelector('#cat-field').hidden = type === 'salary';
      select.innerHTML = categoryOptions(kindOf(type), e.categoryId);
    };
    form.querySelectorAll('input[name=type]').forEach(r => r.addEventListener('change', sync));
    select.addEventListener('change', async () => {
      if (select.value !== '__new') return;
      const kind = kindOf(form.querySelector('input[name=type]:checked').value);
      const name = prompt('New category name')?.trim();
      if (!name) { select.selectedIndex = 0; return; }
      const cat = await save('categories', { kind, name });
      select.innerHTML = categoryOptions(kind, cat.id);
    });
    sync();
  });
}

function investmentDialog(inv) {
  const i = inv || { contributions: [] };
  const contribs = [...(i.contributions || [])].sort(byDateDesc);
  openDialog(`
    <h3>${inv ? esc(inv.name) : 'Add investment'}</h3>
    <label class="field">Name<input name="name" required maxlength="60" value="${esc(i.name || '')}" placeholder="e.g. Nifty 50 index fund" ${inv ? '' : 'autofocus'}></label>
    <label class="field">Type<select name="categoryId">${catsOf('investment').map(c => `<option value="${c.id}" ${c.id === i.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    ${inv ? '' : `<label class="field">Amount invested now (optional)<input name="initial" type="number" inputmode="decimal" step="0.01" min="0"></label>
    <label class="field">Date<input name="date" type="date" value="${defaultDate()}"></label>`}
    <label class="field">Current value (optional)<input name="currentValue" type="number" inputmode="decimal" step="0.01" min="0" value="${i.currentValue ?? ''}" placeholder="Leave blank to use amount invested"></label>
    ${inv ? `
      <div class="section-head" style="margin:6px 0 0"><b>Contributions</b><span class="muted">${money(investedTotal(i))} total</span></div>
      <div class="inline-form" style="margin-top:0">
        <input class="inline-input" name="cAmount" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="Amount">
        <input class="inline-input" name="cDate" type="date" value="${defaultDate()}">
        <button class="btn" value="contribute" formnovalidate>Add</button>
      </div>
      <div style="max-height:180px;overflow:auto">${contribs.map(c => `<div class="row" style="padding:8px 4px;cursor:default">
        <div class="main meta">${fmtDate(c.date)} ${c.date.slice(0, 4)}</div><div class="amt invest">${money(c.amount)}</div>
        <button class="btn small" value="rm:${c.id}" formnovalidate aria-label="Remove">×</button></div>`).join('') || '<div class="empty">No contributions yet.</div>'}</div>` : ''}
    <label class="field">Note (optional)<input name="note" maxlength="120" value="${esc(i.note || '')}"></label>
    ${actions(!!inv)}`,
  async (fd, action) => {
    const cv = fd.get('currentValue');
    const base = { ...i, name: fd.get('name').trim(), categoryId: fd.get('categoryId'), currentValue: cv === '' ? null : parseFloat(cv), note: fd.get('note').trim() };
    if (action === 'delete') {
      if (!confirm(`Delete ${inv.name} and all its contributions?`)) return false;
      await drop('investments', inv.id);
      toast('Investment deleted');
    } else if (action === 'contribute') {
      const amount = parseFloat(fd.get('cAmount'));
      if (!(amount > 0)) throw new Error('Enter an amount above zero');
      const saved = await save('investments', { ...base, contributions: [...(i.contributions || []), { id: db.uid(), date: fd.get('cDate') || defaultDate(), amount }] });
      render();
      investmentDialog(saved); // reopen with the new contribution listed
      return false;
    } else if (action.startsWith('rm:')) {
      const saved = await save('investments', { ...base, contributions: i.contributions.filter(c => c.id !== action.slice(3)) });
      render();
      investmentDialog(saved);
      return false;
    } else {
      if (!base.name) throw new Error('Give the investment a name');
      const initial = parseFloat(fd.get('initial'));
      if (!inv && initial > 0) base.contributions = [{ id: db.uid(), date: fd.get('date') || defaultDate(), amount: initial }];
      await save('investments', base);
      toast(inv ? 'Saved' : 'Investment added');
    }
    render();
  });
}

// ---------- events ----------

document.addEventListener('click', async e => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { state.tab = tabBtn.dataset.tab; location.hash = state.tab; render(); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'pick-month': try { $('#month').showPicker(); } catch {} break;
    case 'prev-month': state.month = shiftMonth(state.month, -1); render(); break;
    case 'next-month': state.month = shiftMonth(state.month, 1); render(); break;
    case 'quick-add':
      if (state.tab === 'investments') investmentDialog();
      else entryDialog({ type: state.tab === 'income' ? 'income' : 'expense', date: defaultDate() });
      break;
    case 'add-salary': {
      const last = lastSalary();
      entryDialog({ type: 'salary', amount: last?.amount, date: last ? `${state.month}-${last.date.slice(8)}` : defaultDate() });
      break;
    }
    case 'add-income': entryDialog({ type: 'income', date: defaultDate() }); break;
    case 'add-expense': entryDialog({ type: 'expense', date: defaultDate() }); break;
    case 'edit-entry': entryDialog(state.entries.find(x => x.id === id)); break;
    case 'add-investment': investmentDialog(); break;
    case 'edit-investment': investmentDialog(state.investments.find(x => x.id === id)); break;
    case 'delete-category': {
      const used = state.entries.some(x => x.categoryId === id) || state.investments.some(x => x.categoryId === id);
      if (!confirm(used ? `"${catName(id)}" is in use. Remove it anyway? Those entries will show as Uncategorized.` : `Remove "${catName(id)}"?`)) return;
      await drop('categories', id);
      render();
      break;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify(await db.exportAll(), null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `finance-backup-${todayISO()}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Backup downloaded');
      break;
    }
    case 'sync-now': runSync(true); break;
    case 'sync-disconnect':
      if (!confirm('Turn off sync on this device? Your data stays on this device and in Google Drive.')) return;
      await sync.disconnect();
      render();
      toast('Sync turned off');
      break;
    case 'install': installPrompt?.prompt(); installPrompt = null; render(); break;
    case 'wipe':
      if (prompt(`This deletes everything on this device${sync.isEnabled() ? ' and turns off sync. Your Google Drive copy is kept' : ''}. Type DELETE to confirm.`) !== 'DELETE') return;
      await sync.disconnect();
      await db.wipe();
      Object.assign(state, { entries: [], investments: [], categories: [] });
      await load();
      render();
      toast('All data deleted');
      break;
  }
});

document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-form="add-category"]');
  if (!form) return;
  e.preventDefault();
  const name = new FormData(form).get('name').trim();
  if (!name) return;
  await save('categories', { kind: form.dataset.kind, name });
  render();
});

document.addEventListener('change', async e => {
  if (e.target.id === 'month' && e.target.value) { state.month = e.target.value; render(); }
  if (e.target.name === 'skin') {
    try { localStorage.setItem('skin', e.target.value); } catch {}
    render();
  }
  if (e.target.id === 'currency') {
    state.settings = await db.put('settings', { ...state.settings, currency: e.target.value });
    scheduleSync();
    toast(`Currency set to ${e.target.value}`);
  }
  if (e.target.id === 'import-file' && e.target.files[0]) {
    try {
      const n = await db.importAll(JSON.parse(await e.target.files[0].text()));
      await load();
      render();
      toast(`Imported ${n} record${n === 1 ? '' : 's'}`);
      scheduleSync();
    } catch (err) {
      toast(err.message || 'Could not read that file');
    }
  }
});

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (state.tab === 'settings') render(); });

// ---------- start ----------

if (['dashboard', 'income', 'spending', 'investments', 'settings'].includes(location.hash.slice(1))) state.tab = location.hash.slice(1);
await load();
render();
runSync(false);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(false); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
