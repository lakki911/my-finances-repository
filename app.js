import * as db from './db.js';
import * as auth from './auth.js';
import * as cloud from './cloud.js';

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
  family: null,        // admin only: [{ uid, name, email, data }]
  familyError: '',
  familyMember: null,  // uid of the member being viewed in the Family tab
  authMode: 'login',   // login | register | reset
  changingPassword: false,
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

// Helpers take an optional dataset `d` so the Family tab can reuse them for other members.
const catName = (id, d = state) => d.categories.find(c => c.id === id)?.name || 'Uncategorized';
const catsOf = kind => state.categories.filter(c => c.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
const entriesIn = (month, type, d = state) => d.entries.filter(e => e.date.startsWith(month) && (!type || e.type === type));
const investedIn = (month, d = state) => sum(d.investments.flatMap(i => i.contributions || []).filter(c => c.date.startsWith(month)), c => c.amount);
const investedTotal = inv => sum(inv.contributions || [], c => c.amount);

function monthTotals(month, d = state) {
  const salary = sum(entriesIn(month, 'salary', d), e => e.amount);
  const other = sum(entriesIn(month, 'income', d), e => e.amount);
  const spent = sum(entriesIn(month, 'expense', d), e => e.amount);
  const invested = investedIn(month, d);
  const income = salary + other;
  return { salary, other, income, spent, invested, saved: income - spent - invested };
}

function byCategory(list, d = state) {
  const map = new Map();
  for (const e of list) map.set(catName(e.categoryId, d), (map.get(catName(e.categoryId, d)) || 0) + e.amount);
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
  const last = cloud.lastSynced();
  if (!last) return 'Not synced yet.';
  const mins = Math.round((Date.now() - new Date(last)) / 60000);
  return `Synced ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : new Date(last).toLocaleString()}.`;
}
function showSyncStatus() {
  const el = $('#sync-status');
  if (el) el.textContent = syncStatusText();
}

async function runSync(interactive = false) {
  if (!auth.current()) return;
  syncMessage = 'Syncing…';
  showSyncStatus();
  try {
    const changed = await cloud.syncNow();
    syncMessage = '';
    if (changed) { await load(); render(); } else showSyncStatus();
    if (interactive) toast('All synced');
  } catch (err) {
    if (err instanceof auth.SignedOut) return signedOut();
    syncMessage = err.message || 'Sync failed. Try again later.';
    showSyncStatus();
    if (interactive) toast(syncMessage);
  }
}

// Push local changes a few seconds after the last edit.
function scheduleSync() {
  if (!auth.current()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(false), 2000);
}

// ---------- accounts ----------

// Open this person's local database. The first account to sign in on a device
// that was used before accounts existed takes over that device's data.
async function enterAccount() {
  const me = auth.current();
  db.useDatabase(me.uid);
  let migrated = null;
  try { migrated = localStorage.getItem('legacy.migratedTo'); } catch {}
  if (!migrated) {
    const legacy = await db.readLegacy().catch(() => null);
    if (legacy) {
      await db.importAll(legacy);
      toast('Your existing data was moved into your account');
    }
    try { localStorage.setItem('legacy.migratedTo', me.uid); } catch {}
  }
  Object.assign(state, { entries: [], investments: [], categories: [], settings: { id: 'prefs', currency: 'INR' }, family: null, familyMember: null });
  await load();
  if (!['dashboard', 'income', 'spending', 'investments', 'settings', 'family'].includes(state.tab) || (state.tab === 'family' && !auth.isAdmin())) state.tab = 'dashboard';
  render();
  await runSync(false);
}

function signedOut() {
  clearTimeout(syncTimer);
  state.authMode = 'login';
  state.changingPassword = false;
  render();
}

async function loadFamily() {
  state.familyError = '';
  try {
    state.family = await cloud.family();
  } catch (err) {
    if (err instanceof auth.SignedOut) return signedOut();
    state.familyError = auth.current()?.verified ? err.message : 'Verify your email address first (check your inbox), then sign out and sign in again.';
  }
  if (state.tab === 'family') render();
}

// ---------- views ----------

// Stable color per category name, picked from the theme's category palette.
function catColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--c${h % 8})`;
}
const avatar = name => `<span class="avatar" style="--tone:${catColor(name)}" aria-hidden="true">${esc([...name.trim()][0] || '?').toUpperCase()}</span>`;

// With a dataset `d` other than the signed-in person's, the row is read-only.
// (Also used directly as a .map() callback, where the 2nd argument is an index.)
function entryRow(e, d) {
  if (!d?.entries) d = state;
  const cls = e.type === 'expense' ? 'spend' : 'income';
  const title = e.type === 'salary' ? 'Salary' : catName(e.categoryId, d);
  return `<div class="row${d === state ? '' : ' static'}" ${d === state ? `data-action="edit-entry" data-id="${e.id}"` : ''}>
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

function portfolio(d = state) {
  const invested = sum(d.investments, investedTotal);
  const current = sum(d.investments, i => i.currentValue ?? investedTotal(i));
  return { invested, current, gain: current - invested, gainPct: invested ? ((current - invested) / invested) * 100 : NaN };
}

const stat = (label, value, cls = '', sub = '') =>
  `<div class="card stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

function accountCard() {
  const me = auth.current();
  return `<h2>Account</h2>
    <div class="card account">
      <div class="row static">
        ${avatar(me.name)}
        <div class="main"><div class="title">${esc(me.name)} ${auth.isAdmin() ? '<span class="badge">Admin</span>' : ''}</div><div class="meta">${esc(me.email)}</div></div>
      </div>
      ${me.verified ? '' : `<p class="notice">Please verify your email address. We sent a link to ${esc(me.email)}. <button class="link" data-action="resend-verify">Send it again</button></p>`}
      <p class="muted" id="sync-status">${esc(syncStatusText())}</p>
      <div class="btn-row"><button class="btn primary" data-action="sync-now">Sync now</button><button class="btn" data-action="change-password">Change password</button><button class="btn" data-action="sign-out">Sign out</button></div>
      ${state.changingPassword ? `<form class="password-form" data-form="password">
        <label class="field">Current password<input name="current" type="password" autocomplete="current-password" required></label>
        <label class="field">New password<input name="next" type="password" autocomplete="new-password" minlength="6" required><span class="hint">At least 6 characters</span></label>
        <label class="field">Repeat new password<input name="repeat" type="password" autocomplete="new-password" minlength="6" required></label>
        <div class="btn-row"><button class="btn primary">Save new password</button><button type="button" class="btn" data-action="change-password">Cancel</button></div>
      </form>` : ''}
    </div>`;
}

// One person's summary, used for the family total and for each member.
function personRow(p, t) {
  return `<div class="row" data-action="family-member" data-id="${p.uid}">
    ${avatar(p.name)}
    <div class="main"><div class="title">${esc(p.name)}</div>
      <div class="meta">In <span class="income">${money(t.income)}</span> · Out <span class="spend">${money(t.spent)}</span> · Invested <span class="invest">${money(t.invested)}</span></div></div>
    <div class="amt ${t.saved < 0 ? 'neg' : ''}">${money(t.saved)}<div class="meta">left over</div></div>
  </div>`;
}

const AUTH_FORMS = {
  login: () => `
    <h2>Sign in</h2>
    <label class="field">Email<input name="email" type="email" autocomplete="email" required autofocus></label>
    <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary big">Sign in</button>
    <div class="auth-links"><button type="button" class="link" data-action="auth-mode" data-id="register">Create an account</button><button type="button" class="link" data-action="auth-mode" data-id="reset">Forgot password?</button></div>`,
  register: () => `
    <h2>Create your account</h2>
    <label class="field">Your name<input name="name" autocomplete="name" maxlength="40" required autofocus></label>
    <label class="field">Email<input name="email" type="email" autocomplete="email" required></label>
    <label class="field">Password<input name="password" type="password" autocomplete="new-password" minlength="6" required><span class="hint">At least 6 characters</span></label>
    <button class="btn primary big">Create account</button>
    <div class="auth-links"><button type="button" class="link" data-action="auth-mode" data-id="login">I already have an account</button></div>`,
  reset: () => `
    <h2>Reset your password</h2>
    <p class="muted">Enter your email and we'll send you a link to choose a new password.</p>
    <label class="field">Email<input name="email" type="email" autocomplete="email" required autofocus></label>
    <button class="btn primary big">Send reset link</button>
    <div class="auth-links"><button type="button" class="link" data-action="auth-mode" data-id="login">Back to sign in</button></div>`,
};

function authView() {
  if (!auth.isConfigured()) return `<section class="auth"><div class="auth-brand">My Finances</div><p class="muted">Accounts aren't set up yet. Add the Firebase settings to config.js.</p></section>`;
  return `<section class="auth">
    <div class="auth-brand">My Finances</div>
    <p class="auth-tag">Your family's salary, spending and investments, each person in their own space.</p>
    <form class="card auth-card" data-form="auth">${AUTH_FORMS[state.authMode]()}</form>
  </section>`;
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
      ${accountCard()}
      <h2>Look</h2>
      <div class="card"><div class="seg" role="radiogroup" aria-label="Look">${Object.entries(SKINS).map(([k, l]) => `<label><input type="radio" name="skin" value="${k}" ${document.documentElement.dataset.skin === k ? 'checked' : ''}>${l}</label>`).join('')}</div></div>
      <h2>Currency</h2>
      <div class="card"><select class="inline-input" id="currency">${CURRENCIES.map(c => `<option ${c === state.settings.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      ${catBlock('income', 'Income categories')}
      ${catBlock('expense', 'Spending categories')}
      ${catBlock('investment', 'Investment types')}
      <h2>Backup</h2>
      <div class="card">
        <p class="muted" style="margin-top:0">Your data is saved in your account and on this device. You can also export a backup file for safekeeping.</p>
        <div class="btn-row">
          <button class="btn primary" data-action="export">Export backup</button>
          <label class="btn">Import backup<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        </div>
      </div>
      ${installPrompt ? `<h2>App</h2><div class="card"><button class="btn primary" data-action="install">Install on this device</button></div>` : ''}`;
  },

  family() {
    if (state.familyError) return `<div class="card"><p class="notice" style="margin:0">${esc(state.familyError)}</p><div class="btn-row" style="margin-top:12px"><button class="btn" data-action="family-reload">Try again</button></div></div>`;
    if (!state.family) return `<div class="card"><div class="empty">Loading everyone's records…</div></div>`;
    const member = state.family.find(p => p.uid === state.familyMember);
    if (member) return memberView(member);
    const people = state.family.map(p => ({ p, t: monthTotals(state.month, p.data), port: portfolio(p.data) }));
    const total = people.reduce((a, { t }) => ({ income: a.income + t.income, spent: a.spent + t.spent, invested: a.invested + t.invested, saved: a.saved + t.saved }), { income: 0, spent: 0, invested: 0, saved: 0 });
    const port = people.reduce((a, { port }) => ({ invested: a.invested + port.invested, current: a.current + port.current }), { invested: 0, current: 0 });
    return `
      <section class="hero">
        <div class="hero-label">Family left over in ${esc(monthLabel(state.month, { month: 'long' }))}</div>
        <div class="hero-value">${money(total.saved)}</div>
        <div class="hero-sub">${people.length} ${people.length === 1 ? 'person' : 'people'} · earned <b>${money(total.income)}</b></div>
        <div class="hero-meter" aria-hidden="true">
          <span style="flex:${total.spent || 0};background:var(--hero-spend)"></span>
          <span style="flex:${total.invested || 0};background:var(--hero-invest)"></span>
          <span style="flex:${Math.max(total.saved, 0)};background:var(--hero-save)"></span>
        </div>
        <div class="hero-legend"><span><i style="background:var(--hero-spend)"></i>Spent</span><span><i style="background:var(--hero-invest)"></i>Invested</span><span><i style="background:var(--hero-save)"></i>Kept</span></div>
      </section>
      <div class="grid quad">
        ${stat('Family income', money(total.income), 'income')}
        ${stat('Family spending', money(total.spent), 'spend')}
        ${stat('Invested this month', money(total.invested), 'invest')}
        ${stat('Portfolio value', money(port.current), '', `${money(port.invested)} invested`)}
      </div>
      <div class="section-head"><h2>Members</h2><button class="btn small" data-action="family-reload">Refresh</button></div>
      ${listCard(people.map(({ p, t }) => personRow(p, t)), 'No one has signed up yet.')}
      <p class="muted small-note">Tap a person to see their records. Only you can see this tab.</p>`;
  },
};

// Admin's read-only look at one member.
function memberView(m) {
  const d = m.data;
  const t = monthTotals(state.month, d);
  const list = entriesIn(state.month, null, d).sort(byDateDesc);
  const p = portfolio(d);
  const holdings = [...d.investments].sort((a, b) => a.name.localeCompare(b.name)).map(i => {
    const inv = investedTotal(i), cur = i.currentValue ?? inv;
    return `<div class="row static">${avatar(i.name)}<div class="main"><div class="title">${esc(i.name)}</div><div class="meta">${esc(catName(i.categoryId, d))} · invested ${money(inv)}</div></div><div class="amt">${money(cur)}</div></div>`;
  });
  return `
    <button class="btn small back" data-action="family-member" data-id="">‹ All members</button>
    <div class="person-head">${avatar(m.name)}<div><div class="title">${esc(m.name)}</div><div class="meta muted">${esc(m.email)}</div></div></div>
    <div class="grid quad">
      ${stat('Income', money(t.income), 'income')}
      ${stat('Spending', money(t.spent), 'spend')}
      ${stat('Invested', money(t.invested), 'invest')}
      ${stat('Left over', money(t.saved), t.saved < 0 ? 'neg' : '')}
    </div>
    <h2>Where the money went</h2>
    <div class="card">${bars(byCategory(entriesIn(state.month, 'expense', d), d))}</div>
    <h2>Records in ${esc(monthLabel(state.month))}</h2>
    ${listCard(list.map(e => entryRow(e, d)), 'Nothing recorded this month.')}
    <h2>Investments</h2>
    <div class="grid">${stat('Invested', money(p.invested), 'invest')}${stat('Current value', money(p.current))}</div>
    <div style="height:10px"></div>
    ${listCard(holdings, 'No investments.')}`;
}

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
  const signedIn = !!auth.current();
  document.body.classList.toggle('signed-out', !signedIn);
  $('.tabs [data-tab=family]').hidden = !auth.isAdmin();
  if (!signedIn) {
    $('#view').innerHTML = authView();
    $('#view [autofocus]')?.focus();
    return;
  }
  document.querySelectorAll('.tabs button').forEach(b => { if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('#month').value = state.month;
  $('#month-text').textContent = monthLabel(state.month, { month: 'short', year: 'numeric' });
  $('.month-picker').style.visibility = state.tab === 'settings' ? 'hidden' : '';
  $('.fab').hidden = state.tab === 'family' || state.tab === 'settings';
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
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    location.hash = state.tab;
    if (state.tab === 'family') { state.familyMember = null; if (!state.family) loadFamily(); }
    render();
    return;
  }
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
    case 'install': installPrompt?.prompt(); installPrompt = null; render(); break;
    case 'auth-mode': state.authMode = id; render(); break;
    case 'change-password':
      state.changingPassword = !state.changingPassword;
      render();
      if (state.changingPassword) $('[data-form="password"] input')?.focus();
      break;
    case 'resend-verify':
      try { await auth.resendVerification(); toast('Verification email sent'); } catch (err) { toast(err.message); }
      break;
    case 'family-member': state.familyMember = id || null; render(); window.scrollTo(0, 0); break;
    case 'family-reload': state.family = null; render(); loadFamily(); break;
    case 'sign-out': {
      el.disabled = true;
      let synced = true;
      try { await cloud.syncNow(); } catch { synced = false; }
      if (!synced && !confirm('Some changes have not reached the cloud yet (no internet?). If you sign out now they stay only on this device. Sign out anyway?')) { el.disabled = false; return; }
      auth.logout();
      state.family = null;
      signedOut();
      toast('Signed out');
      break;
    }
  }
});

document.addEventListener('submit', async e => {
  const authForm = e.target.closest('[data-form="auth"]');
  if (authForm) {
    e.preventDefault();
    const f = new FormData(authForm);
    const btn = authForm.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      const email = String(f.get('email')).trim();
      if (state.authMode === 'reset') {
        await auth.resetPassword(email);
        toast('Check your inbox for the reset link');
        state.authMode = 'login';
        render();
        return;
      }
      if (state.authMode === 'register') await auth.register(String(f.get('name')).trim(), email, f.get('password'));
      else await auth.login(email, f.get('password'));
      await enterAccount();
      toast(`Welcome, ${auth.current().name}`);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  const pwForm = e.target.closest('[data-form="password"]');
  if (pwForm) {
    e.preventDefault();
    const f = new FormData(pwForm);
    if (f.get('next') !== f.get('repeat')) return toast('The new passwords don\'t match');
    const btn = pwForm.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      await auth.changePassword(f.get('current'), f.get('next'));
      state.changingPassword = false;
      render();
      toast('Password changed');
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
    return;
  }
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

if (['dashboard', 'income', 'spending', 'investments', 'settings', 'family'].includes(location.hash.slice(1))) state.tab = location.hash.slice(1);
if (auth.current()) {
  await enterAccount();
  if (state.tab === 'family') loadFamily();
} else {
  render();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(false); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
