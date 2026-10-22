import * as db from './db.js';
import * as auth from './auth.js';
import * as cloud from './cloud.js';
import * as lock from './lock.js';
import { toCSV, toXLSX, saveFile } from './exporter.js';
import { xirr, emi, schedule, incomeTax } from './finance.js';
import * as i18n from './i18n.js';
import { ADMIN_EMAILS } from './config.js';

const DEFAULT_CATEGORIES = {
  income: ['Freelance', 'Bonus', 'Interest', 'Rent', 'Gift', 'Other'],
  expense: ['Rent / EMI', 'Groceries', 'Food & dining', 'Transport', 'Bills & utilities', 'Shopping', 'Health', 'Entertainment', 'Other'],
  investment: ['Mutual fund / SIP', 'Stocks', 'Fixed deposit', 'PPF / EPF', 'Gold', 'Crypto', 'Other', 'Savings / cash'],
};
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'CAD', 'AUD', 'SGD', 'JPY'];
const TYPE_LABEL = { salary: 'Salary', income: 'Other income', expense: 'Spending' };
const METHODS = { upi: 'UPI', cash: 'Cash', card: 'Card', bank: 'Bank transfer', other: 'Other' };
const FREQ = { 1: 'Every month', 3: 'Every 3 months', 6: 'Every 6 months', 12: 'Every year' };
const RTYPE = { expense: 'Spending', income: 'Income', salary: 'Salary', investment: 'SIP' };
const ASSET = { equity: 'Equity', debt: 'Debt', gold: 'Gold', realestate: 'Real estate', crypto: 'Crypto', cash: 'Cash', other: 'Other' };
const LOAN_KIND = { home: 'Home loan', car: 'Car loan', personal: 'Personal loan', education: 'Education loan', gold: 'Gold loan', other: 'Other loan' };
const POLICY_KIND = { life: 'Life insurance', term: 'Term insurance', health: 'Health insurance', vehicle: 'Vehicle insurance', fd: 'Fixed deposit', other: 'Other' };
// Stores held in memory as arrays (settings is a single record).
const LISTS = db.STORES.filter(s => s !== 'settings');
const TABS = ['dashboard', 'income', 'spending', 'investments', 'plan', 'reports', 'family', 'settings', 'search'];

const state = {
  tab: 'dashboard',
  month: '',
  ...Object.fromEntries(LISTS.map(s => [s, []])),
  planView: 'budgets', // budgets | bills
  reportView: 'year',  // year | export
  fy: true,            // yearly report by financial year (Apr–Mar) or calendar year
  reportYear: null,
  search: {},
  bioAvailable: false,
  settings: { id: 'prefs', currency: 'INR' },
  family: null,        // admin only: [{ uid, name, email, data }]
  familyError: '',
  familyView: 'shared',
  role: '',            // this person's family role, set by an admin
  roles: {},           // admin only: everyone's role
  shared: { budgets: [], goals: [], splits: [], people: [] },
  sharedError: '',
  familyMember: null,  // uid of the member being viewed in the Family tab
  authMode: 'login',   // login | register | reset
  changingPassword: false,
};
let installPrompt = null;

// ---------- helpers ----------

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr, f = x => x) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const pad2 = n => String(n).padStart(2, '0');
const localISO = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayISO = () => localISO(new Date());
state.month = todayISO().slice(0, 7);

function money(n, compact = false) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2, ...(compact && Math.abs(n) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : {}) }).format(n || 0);
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
  return new Date(y, m - 1, 1).toLocaleDateString(i18n.locale(), opts);
}
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(i18n.locale(), { day: 'numeric', month: 'short', ...(String(y) === todayISO().slice(0, 4) ? {} : { year: 'numeric' }) });
}
const daysIn = month => new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
const toDate = iso => new Date(...iso.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0)));
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const monthsFrom = (start, n) => Array.from({ length: n }, (_, i) => shiftMonth(start, i));
// Financial year (India): April to March, named by the year it starts in.
const fyStart = month => (Number(month.slice(5)) >= 4 ? Number(month.slice(0, 4)) : Number(month.slice(0, 4)) - 1);
const lastMethod = () => { try { return localStorage.getItem('lastMethod') || 'upi'; } catch { return 'upi'; } };
const methodOptions = selected => `<option value="">Not set</option>` + Object.entries(METHODS).map(([k, l]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${l}</option>`).join('');
// Default date for a new entry: today if viewing this month, else the 1st of the viewed month.
const defaultDate = () => (todayISO().startsWith(state.month) ? todayISO() : `${state.month}-01`);

// Helpers take an optional dataset `d` so the Family tab can reuse them for other members.
// Categories can have one level of sub-categories (parentId), shown as "Food › Swiggy".
const catById = (id, d = state) => d.categories.find(c => c.id === id);
const parentOf = (id, d = state) => { const p = catById(id, d)?.parentId; return p && catById(p, d) ? p : null; };
const catName = (id, d = state) => {
  const c = catById(id, d);
  if (!c) return 'Uncategorized';
  const p = parentOf(id, d);
  return p ? `${catById(p, d).name} › ${c.name}` : c.name;
};
const topCatId = (id, d = state) => parentOf(id, d) || id;
const inCat = (e, catId, d = state) => e.categoryId === catId || parentOf(e.categoryId, d) === catId;
const byName = (a, b) => a.name.localeCompare(b.name);
// Categories of a kind, each top-level one followed by its sub-categories.
function catsOf(kind) {
  const all = state.categories.filter(c => c.kind === kind);
  return all.filter(c => !parentOf(c.id)).sort(byName).flatMap(p => [p, ...all.filter(c => c.parentId === p.id).sort(byName)]);
}
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

// With `rollup`, sub-categories count towards their parent.
function byCategory(list, d = state, rollup = false) {
  const map = new Map();
  for (const e of list) {
    const key = catName(rollup ? topCatId(e.categoryId, d) : e.categoryId, d);
    map.set(key, (map.get(key) || 0) + e.amount);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// `action` adds a button to the toast, e.g. { label: 'Undo', run() {…} }.
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? ` <button class="toast-btn">${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); action.run(); };
  t.classList.toggle('actionable', !!action);
  i18n.translate(t);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2600);
}

// Shrinks a photo to a JPEG data URL small enough to store (under about 700 KB).
async function compressImage(file) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That file is not a photo'));
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  let q = 0.7, url = c.toDataURL('image/jpeg', q);
  while (url.length > 700_000 && q > 0.2) url = c.toDataURL('image/jpeg', (q -= 0.15));
  return url;
}

const parseTags = s => [...new Set(String(s || '').split(/[\s,]+/).map(t => t.replace(/^#+/, '').toLowerCase()).filter(Boolean))].slice(0, 10);
const monthDiff = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

// ---------- data ----------

async function load() {
  const lists = await Promise.all(LISTS.map(s => db.all(s)));
  LISTS.forEach((s, i) => { state[s] = lists[i]; });
  const settings = await db.all('settings');
  const prefs = settings.find(s => s.id === 'prefs');
  // Other single records kept in the settings store: net worth by month, tax helper inputs.
  state.netLog = settings.find(s => s.id === 'networth') || { id: 'networth', months: {} };
  state.taxInputs = settings.find(s => s.id === 'tax') || { id: 'tax', years: {} };
  if (prefs) state.settings = prefs;
  if (!prefs) state.settings = await db.put('settings', state.settings, { seed: true });
  // Seed the default categories of any kind that has none (first run, or an account
  // that lost them). Fixed ids, so two devices seeding at once don't make duplicates.
  for (const [kind, names] of Object.entries(DEFAULT_CATEGORIES)) {
    if (state.categories.some(c => c.kind === kind)) continue;
    for (const [i, name] of names.entries()) {
      const id = `default-${kind}-${i}`;
      // A deleted default comes back as a fresh record, so the old delete can't win the next sync.
      const dead = await db.get('categories', id);
      state.categories.push(await db.put('categories', { id, kind, name }, { seed: !dead }));
    }
    if (prefs) scheduleSync();
  }
  // A default seeded here before the first sync is dropped when the account already has
  // a category of the same name (saved by an older version or another device).
  const key = c => `${c.kind}|${c.name.toLowerCase()}`;
  const twins = new Set(state.categories.filter(c => !c.id.startsWith('default-')).map(key));
  const used = new Set(['entries', 'investments', 'budgets', 'recurring', 'templates'].flatMap(s => state[s].map(r => r.categoryId)));
  for (const c of state.categories.filter(c => c.id.startsWith('default-') && twins.has(key(c)) && !used.has(c.id))) {
    await db.remove('categories', c.id);
    state.categories = state.categories.filter(x => x.id !== c.id);
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
    if (inFamily()) cloud.publishTotals(myTotals()).catch(() => {});
    if (changed) { await load(); render(); } else showSyncStatus();
    if (interactive) toast('All synced');
  } catch (err) {
    if (err instanceof auth.SignedOut) return signedOut();
    syncMessage = err.message || 'Sync failed. Try again later.';
    showSyncStatus();
    if (interactive) toast(syncMessage);
  }
  // Post recurring items only after pulling, so another device's work is seen first.
  const added = await runRecurring().catch(() => 0);
  if (added) { render(); toast(`${added} recurring ${added === 1 ? 'entry' : 'entries'} added`); }
}

// Push local changes a few seconds after the last edit.
function scheduleSync() {
  if (!auth.current()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(false), 2000);
}

// ---------- recurring items, bills and budgets ----------

// A rule falls due every `every` months from `start`, on `day` (capped at the month's length).
// `doneThrough` is the last month that was posted (auto) or paid or skipped (reminder).
const dueDate = (r, m) => `${m}-${pad2(Math.min(r.day, daysIn(m)))}`;
function nextDue(r) {
  let m = r.start;
  while (r.doneThrough && m <= r.doneThrough) m = shiftMonth(m, Number(r.every) || 1);
  return { month: m, date: dueDate(r, m) };
}

// Ids are derived from the rule and month, so two devices never post the same item twice.
async function postRecurring(r, m) {
  const id = `${r.id}-${m}`;
  const date = dueDate(r, m);
  if (r.type === 'investment') {
    const inv = state.investments.find(i => i.id === r.investmentId);
    if (inv && !(inv.contributions || []).some(c => c.id === id)) {
      await save('investments', { ...inv, contributions: [...(inv.contributions || []), { id, date, amount: r.amount }] });
    }
  } else if (!(await db.get('entries', id))) {
    await save('entries', { id, type: r.type, amount: r.amount, categoryId: r.type === 'salary' ? null : r.categoryId, method: r.method || '', date, note: r.note || r.name, recurringId: r.id });
  }
}

// Adds every automatic item that has fallen due. Returns how many were added.
async function runRecurring() {
  const today = todayISO();
  let added = 0;
  for (const r of state.recurring.filter(x => x.mode === 'auto')) {
    let last = '';
    for (let n = nextDue(r); n.date <= today; n = nextDue({ ...r, doneThrough: n.month })) {
      await postRecurring(r, n.month);
      last = n.month;
      added++;
    }
    if (last) await save('recurring', { ...r, doneThrough: last });
  }
  return added;
}

// Every rule with its next due date, soonest first.
function upcoming() {
  const today = todayISO();
  return state.recurring.map(r => ({ r, ...nextDue(r), days: daysBetween(today, nextDue(r).date) })).sort((a, b) => a.date.localeCompare(b.date));
}
const dueSoon = (within = 3) => upcoming().filter(u => u.r.mode === 'remind' && u.days <= within);

const budgetSpent = (b, month) => sum(entriesIn(month, 'expense').filter(e => b.categoryId === 'all' || inCat(e, b.categoryId)), e => e.amount);
// With rollover, money left unspent in earlier months (since the budget began, up to 2 years) adds to this month's limit.
function budgetLimit(b, month) {
  if (!b.rollover || !b.since || month <= b.since) return b.amount;
  let carry = 0;
  for (let m = b.since < shiftMonth(month, -24) ? shiftMonth(month, -24) : b.since; m < month; m = shiftMonth(m, 1)) carry = Math.max(0, b.amount + carry - budgetSpent(b, m));
  return b.amount + carry;
}

function budgetStatus(month) {
  return state.budgets.map(b => {
    const spent = budgetSpent(b, month);
    const limit = budgetLimit(b, month);
    return { b, name: b.categoryId === 'all' ? 'All spending' : catName(b.categoryId), spent, limit, carry: limit - b.amount, pct: limit ? (spent / limit) * 100 : 0 };
  }).sort((x, y) => (x.b.categoryId === 'all' ? -1 : y.b.categoryId === 'all' ? 1 : y.pct - x.pct));
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
  Object.assign(state, { ...Object.fromEntries(LISTS.map(s => [s, []])), settings: { id: 'prefs', currency: 'INR' }, family: null, familyMember: null,
    role: '', roles: {}, shared: { budgets: [], goals: [], splits: [], people: [] }, sharedError: '', devices: null });
  await load();
  if (!TABS.includes(state.tab)) state.tab = 'dashboard';
  render();
  await runSync(false);
  let navRun = '';
  try { navRun = localStorage.getItem('nav.lastRun') || ''; } catch {}
  if (navRun !== todayISO() && state.investments.some(i => i.schemeCode && i.units > 0)) refreshNav(undefined, true);
  recordNetWorth();
  loadShared();
  noteDevice();
}

function signedOut() {
  clearTimeout(syncTimer);
  state.authMode = 'login';
  state.changingPassword = false;
  render();
}

// ---------- idle sign-out and devices ----------

const idleLimit = () => { try { return Number(localStorage.getItem('idleSignout') || 0); } catch { return 0; } };
let activeWritten = 0;
function markActive() {
  if (Date.now() - activeWritten < 30_000) return;
  activeWritten = Date.now();
  try { localStorage.setItem('lastActive', String(activeWritten)); } catch {}
}
// Signs out if this device has been unused for longer than the chosen limit.
// Unsynced changes stay in this person's local database and sync at the next sign-in.
function idleExpired() {
  const lim = idleLimit();
  if (!lim || !auth.current()) return false;
  let last = 0;
  try { last = Number(localStorage.getItem('lastActive') || 0); } catch {}
  return !!last && Date.now() - last > lim * 60_000;
}
function checkIdle() {
  if (!idleExpired()) return;
  auth.logout();
  lock.clear();
  state.family = null;
  signedOut();
  toast('Signed out because the app was not used for a while');
}

function deviceLabel() {
  if (window.Capacitor?.isNativePlatform?.()) return 'Android app';
  const ua = navigator.userAgent;
  return /Android/.test(ua) ? 'Browser on Android' : /iPhone|iPad/.test(ua) ? 'Browser on iPhone or iPad' : /Windows/.test(ua) ? 'Browser on Windows' : /Mac/.test(ua) ? 'Browser on Mac' : 'Browser';
}
async function noteDevice() {
  try {
    state.deviceId = localStorage.getItem('deviceId');
    if (!state.deviceId) localStorage.setItem('deviceId', (state.deviceId = db.uid()));
    state.devices = await cloud.touchDevice(state.deviceId, deviceLabel());
    if (state.tab === 'settings') render();
  } catch {}
}

// ---------- shared family space ----------

const ROLE = { member: 'Member', viewer: 'Viewer', coadmin: 'Co-admin', removed: 'Removed' };
const RULES_MSG = 'Family sharing needs the updated security rules in Firebase. The admin can paste them from the user guide (Family sharing setup).';
const inFamily = () => auth.isAdmin() || ['member', 'viewer', 'coadmin'].includes(state.role);
const canEditShared = () => auth.isAdmin() || ['member', 'coadmin'].includes(state.role);
const canSeeAll = () => auth.isAdmin() || state.role === 'coadmin';
const live = list => (list || []).filter(r => !r.deleted);

// Spending by main category for recent months, shared so family budgets can add it up.
function myTotals() {
  const months = {};
  for (let i = 0; i < 3; i++) {
    const m = shiftMonth(todayISO().slice(0, 7), -i);
    const list = entriesIn(m, 'expense');
    months[m] = { _all: sum(list, e => e.amount), ...Object.fromEntries(byCategory(list, state, true)) };
  }
  return { months, lastActive: new Date().toISOString() };
}

let sharedLoadedAt = 0;
async function loadShared() {
  if (!auth.current()) return;
  sharedLoadedAt = Date.now();
  try {
    state.roles = await cloud.roles();
    state.role = state.roles[auth.current().uid] || '';
  } catch (err) {
    if (err instanceof auth.SignedOut) return signedOut();
    state.sharedError = err.status === 403 ? RULES_MSG : err.message;
  }
  if (inFamily()) {
    try {
      await cloud.publishTotals(myTotals());
      const [budgets, goals, splits, people] = await Promise.all(['budgets', 'goals', 'splits'].map(n => cloud.getShared(n)).concat(cloud.people()));
      state.shared = { budgets: budgets || [], goals: goals || [], splits: splits || [], people: people || [] };
      state.sharedError = '';
    } catch (err) {
      state.sharedError = err.status === 403 ? RULES_MSG : err.message;
    }
  }
  if (state.tab === 'family' && !inFamily()) state.tab = 'dashboard';
  render();
}

async function saveShared(name, rec) {
  const r = { ...rec, id: rec.id || db.uid(), updatedAt: new Date().toISOString(), deleted: false };
  state.shared[name] = await cloud.mergeShared(name, [r]);
  render();
  return r;
}
async function dropShared(name, rec) {
  state.shared[name] = await cloud.mergeShared(name, [{ ...rec, deleted: true, updatedAt: new Date().toISOString() }]);
  render();
}

function familyBudgetStatus(b) {
  const key = b.category === 'all' ? '_all' : b.category;
  const parts = state.shared.people.map(p => [p.name, p.months?.[state.month]?.[key] || 0]).filter(x => x[1] > 0);
  const spent = sum(parts, x => x[1]);
  return { b, name: b.category === 'all' ? 'All family spending' : b.category, spent, parts, pct: b.amount ? (spent / b.amount) * 100 : 0 };
}
function familyBudgetBar({ b, name, spent, parts, pct }) {
  const left = b.amount - spent;
  return `<div class="budget ${pct > 100 ? 'over' : pct >= 80 ? 'near' : ''}" ${canEditShared() ? `data-action="edit-fbudget" data-id="${b.id}"` : ''}>
    <div class="bar-top"><span><b>${esc(name)}</b></span><span>${money(spent)} <span class="muted">of ${money(b.amount)}</span></span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>
    <div class="budget-meta">${left >= 0 ? `${money(left)} left` : `${money(-left)} over budget`}${parts.length ? ' · ' + parts.map(([n, v]) => `${esc(n)} ${money(v)}`).join(', ') : ''}</div>
  </div>`;
}
function familyGoalCard(g) {
  const saved = sum(g.saved || [], c => c.amount), pctDone = g.target ? Math.min(100, (saved / g.target) * 100) : 0;
  const byPerson = [...(g.saved || []).reduce((m, c) => m.set(c.name, (m.get(c.name) || 0) + c.amount), new Map())];
  const months = g.by ? Math.max(1, monthDiff(todayISO().slice(0, 7), g.by) + 1) : 0, need = Math.max(0, g.target - saved);
  return `<div class="card goal" data-action="edit-fgoal" data-id="${g.id}" style="--tone:${catColor(g.name)}">
    <div class="goal-top">${avatar(g.name)}<div class="main"><div class="title">${esc(g.name)}</div><div class="meta">${money(saved)} of ${money(g.target)}</div></div><div class="goal-pct">${Math.round(pctDone)}%</div></div>
    <div class="bar-track"><div class="bar-fill" style="width:${pctDone}%"></div></div>
    <div class="goal-plan">${need <= 0 ? '<b class="income">Reached together!</b>' : g.by ? `Together, put aside <b>${money(need / months)}</b> a month to reach it by ${esc(monthLabel(g.by, { month: 'short', year: 'numeric' }))}` : `${money(need)} to go`}${byPerson.length ? `<br>${byPerson.map(([n, v]) => `${esc(n)} ${money(v)}`).join(' · ')}` : ''}</div>
  </div>`;
}

// Net balance per person: positive means the others owe them.
function splitBalances() {
  const bal = {};
  for (const s of live(state.shared.splits)) {
    bal[s.paidBy] = (bal[s.paidBy] || 0) + s.amount;
    for (const [uid, share] of Object.entries(s.shares || {})) bal[uid] = (bal[uid] || 0) - share;
  }
  return bal;
}
const personName = uid => state.shared.people.find(p => p.uid === uid)?.name || 'Someone';
function splitRow(s) {
  const n = Object.keys(s.shares || {}).length;
  return `<div class="row" data-action="edit-split" data-id="${s.id}">
    ${avatar(s.settle ? personName(s.paidBy) : s.desc)}
    <div class="main"><div class="title">${s.settle ? `${esc(personName(s.paidBy))} paid ${esc(personName(Object.keys(s.shares)[0]))}` : esc(s.desc)}</div>
      <div class="meta">${fmtDate(s.date)}${s.settle ? ' · settled up' : ` · paid by ${esc(personName(s.paidBy))} · split ${n} way${n === 1 ? '' : 's'}`}</div></div>
    <div class="amt">${money(s.amount)}</div>
  </div>`;
}

const ago = iso => {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  return mins < 60 ? `${Math.max(1, mins)} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
};
// Latest records added or changed by anyone in the family (admins and co-admins).
function activity() {
  return (state.family || []).flatMap(p => p.data.entries.map(e => ({ p, e }))).filter(x => x.e.updatedAt > '1971')
    .sort((a, b) => b.e.updatedAt.localeCompare(a.e.updatedAt)).slice(0, 20)
    .map(({ p, e }) => `<div class="row static">${avatar(p.name)}
      <div class="main"><div class="title">${esc(p.name)} · ${esc(e.type === 'salary' ? 'Salary' : catName(e.categoryId, p.data))}</div><div class="meta">${TYPE_LABEL[e.type]} on ${fmtDate(e.date)} · ${ago(e.updatedAt)}</div></div>
      <div class="amt ${e.type === 'expense' ? 'spend' : 'income'}">${e.type === 'expense' ? '−' : '+'}${money(e.amount)}</div></div>`);
}
function rolesCard() {
  const admins = new Set(ADMIN_EMAILS.map(e => e.toLowerCase()));
  return `<h2>Roles</h2>
    <div class="card settings-list">${(state.family || []).map(p => `<div class="setting"><div><b>${esc(p.name)}</b><div class="muted">${esc(p.email)}</div></div>
      ${admins.has(p.email.toLowerCase()) ? '<span class="badge">Admin</span>' : `<select class="inline-input role-select" data-uid="${p.uid}"><option value="">Not added yet</option>${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${state.roles[p.uid] === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</div>`).join('')}</div>
    <p class="muted small-note">Members share family budgets, goals and split expenses. Viewers can see them but not change them. Co-admins can also see everyone's records. Removed people can't sync any more.</p>`;
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
    <div class="main"><div class="title">${esc(title)}</div><div class="meta">${[fmtDate(e.date), e.orig && `${esc(e.orig.currency)} ${e.orig.amount}`, METHODS[e.method], e.note && esc(e.note), (e.tags || []).map(t => '#' + esc(t)).join(' '), e.receipt && 'receipt'].filter(Boolean).join(' · ')}</div></div>
    <div class="amt ${cls}">${e.type === 'expense' ? '−' : '+'}${money(e.amount)}</div>
  </div>`;
}
const listCard = (rows, empty) => `<div class="card list">${rows.length ? rows.join('') : `<div class="empty">${empty}</div>`}</div>`;
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.updatedAt || '').localeCompare(a.updatedAt || '');

function bars(pairs, cls = '', empty = 'Nothing yet this month.') {
  if (!pairs.length) return `<div class="empty">${empty}</div>`;
  const max = pairs[0][1] || 1;
  const total = sum(pairs, p => p[1]);
  return `<div class="bars">${pairs.map(([name, v]) => `<div class="bar-row" style="--tone:${catColor(name)}">
    <div class="bar-top"><span><i class="dot"></i>${esc(name)}</span><span><b>${money(v)}</b> <span class="muted">${Math.round((v / total) * 100)}%</span></span></div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${(v / max) * 100}%"></div></div>
  </div>`).join('')}</div>`;
}

function donut(pairs, label = 'Spent') {
  const total = sum(pairs, p => p[1]);
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = pairs.map(([name, v]) => {
    const len = (v / total) * C;
    const arc = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${catColor(name)}" stroke-width="18" stroke-dasharray="${Math.max(len - 2, 0.1)} ${C}" stroke-dashoffset="${-offset}"><title>${esc(name)} ${money(v)}</title></circle>`;
    offset += len;
    return arc;
  }).join('');
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="${esc(label)} by category">
    <circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--surface-2)" stroke-width="18"/>
    <g transform="rotate(-90 70 70)">${arcs}</g>
    <text x="70" y="66" text-anchor="middle" class="donut-label">${esc(label)}</text>
    <text x="70" y="86" text-anchor="middle" class="donut-value">${money(total)}</text>
  </svg>`;
}

function trendChart(months = monthsFrom(shiftMonth(state.month, -5), 6)) {
  const data = months.map(m => ({ m, ...monthTotals(m) }));
  const max = Math.max(1, ...data.flatMap(d => [d.income, d.spent + d.invested]));
  const W = 600, H = 240, pad = 30, gw = W / months.length, bw = Math.min(28, gw / 3.2);
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
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income versus spending and investing, month by month">
    <line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" stroke="var(--border)"/>${groups}</svg>
    <div class="legend"><span><i style="background:var(--income)"></i>Income</span><span><i style="background:var(--spend)"></i>Spending</span><span><i style="background:var(--invest)"></i>Invested</span></div></div>`;
}

function portfolio(d = state) {
  const invested = sum(d.investments, investedTotal);
  const current = sum(d.investments, i => i.currentValue ?? investedTotal(i));
  return { invested, current, gain: current - invested, gainPct: invested ? ((current - invested) / invested) * 100 : NaN };
}

// Chips that switch between the sections of a tab (Plan, Reports).
const subnav = (group, options) => `<div class="subnav">${Object.entries(options).map(([k, l]) =>
  `<button class="chip-btn" data-action="subview" data-group="${group}" data-id="${k}" ${state[group + 'View'] === k ? 'aria-current="true"' : ''}>${l}</button>`).join('')}</div>`;

function budgetBar({ b, name, spent, limit, carry, pct }) {
  const left = limit - spent;
  return `<div class="budget ${pct > 100 ? 'over' : pct >= 80 ? 'near' : ''}" data-action="edit-budget" data-id="${b.id}">
    <div class="bar-top"><span><b>${esc(name)}</b></span><span>${money(spent)} <span class="muted">of ${money(limit)}</span></span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>
    <div class="budget-meta">${left >= 0 ? `${money(left)} left` : `${money(-left)} over budget`} · ${Math.round(pct)}%${carry > 0 ? ` · includes ${money(carry)} carried over` : ''}</div>
  </div>`;
}

const dueText = days => (days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`);
function dueRow(u) {
  return `<div class="row static due ${u.days < 0 ? 'overdue' : u.days <= 3 ? 'soon' : ''}">
    ${avatar(u.r.name)}
    <div class="main"><div class="title">${esc(u.r.name)}</div><div class="meta">${dueText(u.days)} · ${fmtDate(u.date)}</div></div>
    <div class="amt">${money(u.r.amount)}</div>
    <div class="row-actions"><button class="btn small primary" data-action="pay-bill" data-id="${u.r.id}">Paid</button><button class="btn small" data-action="skip-bill" data-id="${u.r.id}">Skip</button></div>
  </div>`;
}
function recurringRow(u) {
  const r = u.r;
  const what = r.type === 'investment' ? state.investments.find(i => i.id === r.investmentId)?.name || 'SIP' : r.type === 'salary' ? 'Salary' : catName(r.categoryId);
  return `<div class="row" data-action="edit-recurring" data-id="${r.id}">
    ${avatar(r.name)}
    <div class="main"><div class="title">${esc(r.name)}</div><div class="meta">${esc(what)} · ${FREQ[r.every] || FREQ[1]} · next ${fmtDate(u.date)} · ${r.mode === 'auto' ? 'added automatically' : 'reminder'}</div></div>
    <div class="amt ${r.type === 'expense' ? 'spend' : r.type === 'investment' ? 'invest' : 'income'}">${money(r.amount)}</div>
  </div>`;
}

// Asset class: chosen on the holding, or guessed from its type.
function assetClassOf(i) {
  if (ASSET[i.assetClass]) return i.assetClass;
  const n = catName(i.categoryId).toLowerCase();
  return /stock|equity|share|elss|index/.test(n) ? 'equity' : /mutual|sip/.test(n) ? 'equity' : /fixed|deposit|ppf|epf|bond|debt|nps|rd/.test(n) ? 'debt'
    : /gold/.test(n) ? 'gold' : /crypto|bitcoin/.test(n) ? 'crypto' : /property|real|land|flat/.test(n) ? 'realestate' : 'other';
}
// Annual return of holdings: contributions paid in, current value received today.
const holdingXirr = list => xirr([
  ...list.flatMap(i => (i.contributions || []).map(c => ({ date: c.date, amount: -c.amount }))),
  { date: todayISO(), amount: sum(list, i => i.currentValue ?? investedTotal(i)) },
]);

// JSON from another site. The Android app falls back to native HTTP if the browser route is blocked.
async function getJSON(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.json();
  } catch {}
  if (window.Capacitor?.isNativePlatform?.()) {
    const http = window.Capacitor.Plugins?.CapacitorHttp || window.Capacitor.registerPlugin('CapacitorHttp');
    const res = await http.request({ url, method: 'GET' });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  }
  throw new Error('Could not reach the fund price service. Check your internet connection.');
}

// Mutual fund values from the latest NAV (free daily AMFI data via api.mfapi.in).
async function refreshNav(list = state.investments.filter(i => i.schemeCode && i.units > 0), quiet = false) {
  let n = 0;
  for (const i of list) {
    try {
      const d = await getJSON(`https://api.mfapi.in/mf/${encodeURIComponent(i.schemeCode)}/latest`);
      const nav = parseFloat(d?.data?.[0]?.nav);
      if (!(nav > 0)) continue;
      const [dd, mm, yy] = d.data[0].date.split('-');
      await save('investments', { ...state.investments.find(x => x.id === i.id), nav, navDate: `${yy}-${mm}-${dd}`, currentValue: Math.round(i.units * nav * 100) / 100 });
      n++;
    } catch (err) {
      if (!quiet) { toast(err.message); return n; }
    }
  }
  try { localStorage.setItem('nav.lastRun', todayISO()); } catch {}
  if (n) render();
  if (!quiet) toast(n ? `Updated ${n} fund${n === 1 ? '' : 's'}` : 'No fund values changed');
  return n;
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
    const spendCats = byCategory(entriesIn(state.month, 'expense'), state, true);
    const due = dueSoon();
    const debtsDue = debtsDueSoon();
    const polDue = policiesDue(7);
    const last = shiftMonth(state.month, -1), lt = monthTotals(last);
    const showSummary = state.month === todayISO().slice(0, 7) && Number(todayISO().slice(8)) <= 7 && (lt.income || lt.spent);
    const budgets = budgetStatus(state.month);
    const tips = insights();
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
      ${state.templates.length ? `<h2>Quick add</h2><div class="quick">${[...state.templates].sort(byName).map(q => `<button class="chip-btn" data-action="quick-template" data-id="${q.id}">${esc(q.name)} · ${money(q.amount)}</button>`).join('')}</div>` : ''}
      ${showSummary ? `<div class="card summary-teaser"><div><b>${esc(monthLabel(last, { month: 'long' }))} in short:</b> you kept ${money(lt.saved)}${lt.income ? ` (${Math.round((lt.saved / lt.income) * 100)}% of income)` : ''} and spent ${money(lt.spent)}.</div><button class="btn small" data-action="open-summary">See summary</button></div>` : ''}
      ${tips.length ? `<div class="card tips">${tips.map(x => `<p class="tip">${x}</p>`).join('')}</div>` : ''}
      ${due.length || debtsDue.length || polDue.length ? `<div class="section-head"><h2>Due soon</h2><button class="btn small" data-tab="plan" data-plan="bills">All bills</button></div>${listCard([...due.map(dueRow), ...debtsDue.map(debtRow), ...polDue.map(p => policyRow(p, true))], '')}` : ''}
      ${budgets.length ? `<div class="section-head"><h2>Budgets</h2><button class="btn small" data-tab="plan" data-plan="budgets">Manage</button></div>
        <div class="card budgets">${budgets.slice(0, 4).map(budgetBar).join('')}</div>` : ''}
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
    const byMethod = [...list.reduce((m, e) => m.set(METHODS[e.method] || 'Not set', (m.get(METHODS[e.method] || 'Not set') || 0) + e.amount), new Map())].sort((a, b) => b[1] - a[1]);
    return `
      <div class="grid">
        ${stat('Spent this month', money(total), 'spend', isFinite(change) ? `${pct(change)} vs last month` : '')}
        ${stat('Entries', list.length)}
      </div>
      <h2>By category</h2>
      <div class="card">${bars(byCategory(list))}</div>
      ${byMethod.length > 1 || (byMethod[0] && byMethod[0][0] !== 'Not set') ? `<h2>By payment method</h2><div class="card">${bars(byMethod)}</div>` : ''}
      <div class="section-head"><h2>All spending</h2><button class="btn small" data-action="add-expense">+ Spending</button></div>
      ${listCard(list.map(entryRow), 'No spending recorded this month.')}`;
  },

  investments() {
    const p = portfolio();
    const rows = [...state.investments].sort((a, b) => a.name.localeCompare(b.name)).map(i => {
      const inv = investedTotal(i), cur = i.currentValue ?? inv, g = inv ? ((cur - inv) / inv) * 100 : NaN;
      const r = holdingXirr([i]);
      return `<div class="row" data-action="edit-investment" data-id="${i.id}">
        ${avatar(i.name)}
        <div class="main"><div class="title">${esc(i.name)}</div><div class="meta">${esc(catName(i.categoryId))} · invested ${money(inv)}${isFinite(r) ? ` · ${pct(r * 100)} a year` : ''}${i.navDate ? ` · NAV ${esc(fmtDate(i.navDate))}` : ''}</div></div>
        <div class="amt">${money(cur)}<div class="meta ${cur < inv ? 'neg' : 'income'}">${pct(g)}</div></div>
      </div>`;
    });
    const alloc = [...state.investments.reduce((m, i) => m.set(ASSET[assetClassOf(i)], (m.get(ASSET[assetClassOf(i)]) || 0) + (i.currentValue ?? investedTotal(i))), new Map())].filter(a => a[1] > 0).sort((a, b) => b[1] - a[1]);
    const allR = holdingXirr(state.investments);
    const linked = state.investments.some(i => i.schemeCode && i.units > 0);
    const thisMonth = state.investments.flatMap(i => (i.contributions || []).filter(c => c.date.startsWith(state.month)).map(c => ({ ...c, inv: i })))
      .sort(byDateDesc)
      .map(c => `<div class="row" data-action="edit-investment" data-id="${c.inv.id}">
        <div class="main"><div class="title">${esc(c.inv.name)}</div><div class="meta">${fmtDate(c.date)}</div></div>
        <div class="amt ${c.amount < 0 ? 'spend' : 'invest'}">${c.amount < 0 ? `Withdrawn ${money(-c.amount)}` : money(c.amount)}</div></div>`);
    return `
      <div class="grid">
        ${stat('Total invested', money(p.invested), 'invest')}
        ${stat('Current value', money(p.current))}
        ${stat('Gain / loss', money(p.gain), p.gain < 0 ? 'neg' : 'income', pct(p.gainPct))}
        ${stat(`Invested in ${esc(monthLabel(state.month, { month: 'short' }))}`, money(investedIn(state.month)), 'invest')}
        ${isFinite(allR) ? stat('Return per year (XIRR)', pct(allR * 100), allR < 0 ? 'neg' : 'income', 'Across all holdings') : ''}
      </div>
      ${alloc.length ? `<h2>Asset allocation</h2><div class="card"><div class="donut-wrap">${donut(alloc, 'Worth')}${bars(alloc)}</div></div>` : ''}
      <div class="section-head"><h2>Holdings</h2><div class="btn-row">${linked ? '<button class="btn small" data-action="refresh-nav">Update NAVs</button>' : ''}<button class="btn small" data-action="add-investment">+ Investment</button></div></div>
      ${listCard(rows, 'No investments yet. Add your SIPs, stocks, FDs and more.')}
      <h2>Added in ${esc(monthLabel(state.month))}</h2>
      ${listCard(thisMonth, 'Nothing added this month. Open a holding to record a contribution.')}`;
  },

  settings() {
    const catBlock = (kind, title) => `
      <h2>${title}</h2>
      <div class="card">
        <div class="chips">${catsOf(kind).map(c => `<span class="chip ${parentOf(c.id) ? 'sub' : ''}">${esc(catName(c.id))}<button data-action="delete-category" data-id="${c.id}" aria-label="Remove ${esc(catName(c.id))}">×</button></span>`).join('') || '<span class="muted">No categories.</span>'}</div>
        <form class="inline-form" data-form="add-category" data-kind="${kind}">
          <input class="inline-input" name="name" placeholder="New category" maxlength="40" required>
          ${kind === 'investment' ? '' : `<select class="inline-input parent-select" name="parentId" aria-label="Sub-category of"><option value="">Main category</option>${catsOf(kind).filter(c => !parentOf(c.id)).map(c => `<option value="${c.id}">Under ${esc(c.name)}</option>`).join('')}</select>`}
          <button class="btn">Add</button>
        </form>
      </div>`;
    return `
      ${accountCard()}
      <h2>Security</h2>
      <div class="card settings-list">
        <div class="setting"><div><b>App lock</b><div class="muted">${lock.enabled() ? 'On. A PIN is needed to open the app on this device.' : 'Ask for a PIN when the app opens on this device.'}</div></div>
          <button class="btn small" data-action="${lock.enabled() ? 'pin-off' : 'pin-set'}">${lock.enabled() ? 'Turn off' : 'Set a PIN'}</button></div>
        ${lock.enabled() ? `<div class="setting"><div><b>Change PIN</b></div><button class="btn small" data-action="pin-change">Change</button></div>` : ''}
        <div class="setting"><div><b>Sign out when idle</b><div class="muted">On this device, after no use for a while.</div></div>
          <select class="inline-input" id="idle-select" style="width:auto">${[[0, 'Never'], [15, 'After 15 minutes'], [60, 'After 1 hour'], [1440, 'After 1 day']].map(([v, l]) => `<option value="${v}" ${idleLimit() === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${state.devices?.length ? `<div class="setting"><div><b>Signed-in devices</b>${state.devices.map(d => `<div class="muted">${esc(d.label)}${d.id === state.deviceId ? ' (this one)' : ''} · last used ${ago(d.lastSeen)}</div>`).join('')}
          <div class="muted hint" style="margin-top:4px">To sign out everywhere else, change your password.</div></div></div>` : ''}
        ${lock.enabled() && state.bioAvailable ? `<label class="setting"><div><b>Fingerprint or face unlock</b><div class="muted">Unlock without typing the PIN.</div></div><input type="checkbox" class="switch" id="bio-toggle" ${lock.biometricOn() ? 'checked' : ''}></label>` : ''}
      </div>
      <h2>Quick-add buttons</h2>
      <div class="card">
        ${state.templates.length ? `<div class="chips">${[...state.templates].sort(byName).map(q => `<span class="chip">${esc(q.name)} · ${money(q.amount)}<button data-action="delete-template" data-id="${q.id}" aria-label="Remove ${esc(q.name)}">×</button></span>`).join('')}</div>` : ''}
        <p class="muted" style="margin:${state.templates.length ? '12px' : '0'} 0 0">${state.templates.length ? 'They appear on the Overview. One tap adds the entry for today.' : 'When you add an entry, tick "Also save as a quick-add button". It then appears on the Overview, and one tap adds it for today.'}</p>
      </div>
      <h2>Look</h2>
      <div class="card settings-list">
        <div class="seg" role="radiogroup" aria-label="Look" style="margin:10px 0">${Object.entries(SKINS).map(([k, l]) => `<label><input type="radio" name="skin" value="${k}" ${skinChoice() === k ? 'checked' : ''}>${l}</label>`).join('')}</div>
        <p class="muted hint" style="margin:0 0 8px">Auto uses Vault when your phone or PC is in dark mode.</p>
        <div class="setting"><div><b>Language</b></div><select class="inline-input" id="lang-select" style="width:auto">${Object.entries(i18n.LANGS).map(([k, l]) => `<option value="${k}" ${i18n.lang() === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
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

  plan() {
    return subnav('plan', { budgets: 'Budgets', bills: 'Bills & recurring', goals: 'Goals', lending: 'Lent & borrowed', loans: 'Loans', policies: 'Insurance & FDs' }) + planViews[state.planView]();
  },

  reports() {
    return subnav('report', { year: 'Year', summary: 'Monthly summary', trends: 'Trends', networth: 'Net worth', tax: 'Tax', export: 'Export' }) + reportViews[state.reportView]();
  },

  search() {
    const f = state.search;
    const opt = (v, l, cur) => `<option value="${v}" ${v === (cur || '') ? 'selected' : ''}>${esc(l)}</option>`;
    return `
      <form class="card search-form" data-form="search">
        <input class="inline-input" type="search" name="q" placeholder="Search notes, categories or amounts" value="${esc(f.q || '')}" autofocus>
        <div class="filters">
          <label class="mini">Type<select class="inline-input" name="type">${opt('', 'All', f.type)}${Object.entries(TYPE_LABEL).map(([k, l]) => opt(k, l, f.type)).join('')}</select></label>
          <label class="mini">Category<select class="inline-input" name="cat">${opt('', 'All', f.cat)}${['expense', 'income'].flatMap(k => catsOf(k).map(c => opt(c.id, catName(c.id), f.cat))).join('')}</select></label>
          <label class="mini">Payment method<select class="inline-input" name="method">${opt('', 'Any', f.method)}${Object.entries(METHODS).map(([k, l]) => opt(k, l, f.method)).join('')}</select></label>
          <label class="mini">From date<input class="inline-input" type="date" name="from" value="${esc(f.from || '')}"></label>
          <label class="mini">To date<input class="inline-input" type="date" name="to" value="${esc(f.to || '')}"></label>
          <label class="mini">Amount from<input class="inline-input" type="number" inputmode="decimal" name="min" value="${esc(f.min || '')}"></label>
          <label class="mini">Amount up to<input class="inline-input" type="number" inputmode="decimal" name="max" value="${esc(f.max || '')}"></label>
        </div>
        <div class="btn-row"><button type="button" class="btn small" data-action="search-clear">Clear</button></div>
      </form>
      <div id="search-results">${searchResults()}</div>`;
  },

  family() {
    const tabs = { shared: 'Budgets & goals', splits: 'Split expenses', ...(canSeeAll() ? { members: 'Members' } : {}) };
    if (!tabs[state.familyView]) state.familyView = 'shared';
    return subnav('family', tabs) + familyViews[state.familyView]();
  },
};

const familyViews = {
  members() {
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
      <h2>Recent activity</h2>
      ${listCard(activity(), 'Nothing recorded yet.')}
      ${auth.isAdmin() ? rolesCard() : ''}
      <p class="muted small-note">Tap a person to see their records. Only admins and co-admins can see this section.</p>`;
  },
  shared() {
    if (state.sharedError) return `<div class="card"><p class="notice" style="margin:0">${esc(state.sharedError)}</p><div class="btn-row" style="margin-top:12px"><button class="btn" data-action="shared-reload">Try again</button></div></div>`;
    const budgets = live(state.shared.budgets).map(familyBudgetStatus).sort((a, b) => b.pct - a.pct);
    const goals = live(state.shared.goals);
    return `
      <div class="section-head"><h2>Family budgets for ${esc(monthLabel(state.month))}</h2>${canEditShared() ? '<button class="btn small" data-action="add-fbudget">+ Budget</button>' : ''}</div>
      ${budgets.length ? `<div class="card budgets">${budgets.map(familyBudgetBar).join('')}</div>` : `<div class="card"><div class="empty">A family budget adds up everyone's spending in a category, for example Groceries for the whole house.</div></div>`}
      <div class="section-head"><h2>Family goals</h2>${canEditShared() ? '<button class="btn small" data-action="add-fgoal">+ Goal</button>' : ''}</div>
      ${goals.length ? `<div class="goal-list">${goals.map(familyGoalCard).join('')}</div>` : `<div class="card"><div class="empty">Save together, for a family holiday or a new home. Everyone can add what they put aside.</div></div>`}
      <p class="muted small-note">Family budgets use each member's main categories, matched by name. Members who haven't opened the app since the last update don't count yet.</p>`;
  },
  splits() {
    if (state.sharedError) return `<div class="card"><p class="notice" style="margin:0">${esc(state.sharedError)}</p></div>`;
    const me = auth.current().uid;
    const bal = splitBalances();
    const splits = live(state.shared.splits).sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const rows = state.shared.people.map(p => {
      const v = bal[p.uid] || 0;
      return `<div class="row static">${avatar(p.name)}<div class="main"><div class="title">${esc(p.name)}${p.uid === me ? ' (you)' : ''}</div><div class="meta">${Math.abs(v) < 0.5 ? 'All square' : v > 0 ? `gets back ${money(v)}` : `owes ${money(-v)}`}</div></div>
        ${p.uid === me && v < -0.5 && canEditShared() ? '<button class="btn small primary" data-action="settle-up">Settle up</button>' : ''}</div>`;
    });
    return `
      <h2>Who owes whom</h2>
      ${listCard(rows, 'No one yet.')}
      <div class="section-head"><h2>Shared expenses</h2>${canEditShared() ? '<button class="btn small" data-action="add-split">+ Split</button>' : ''}</div>
      ${listCard(splits.slice(0, 60).map(splitRow), 'Record a shared bill, like dinner out or a trip, and see who owes whom.')}`;
  },
};



const planViews = {
  budgets() {
    const rows = budgetStatus(state.month);
    const over = rows.filter(r => r.pct > 100).length;
    return `
      <div class="section-head"><h2>Budgets for ${esc(monthLabel(state.month))}</h2><button class="btn small" data-action="add-budget">+ Budget</button></div>
      ${rows.length ? `<div class="card budgets">${rows.map(budgetBar).join('')}</div>
        <p class="muted small-note">${over ? `${over} budget${over === 1 ? ' is' : 's are'} over the limit this month. ` : ''}Bars turn amber at 80% and red when you go over. Tap one to change it.</p>`
        : `<div class="card"><div class="empty">Set a monthly limit for a category, or for all spending, and see how much is left as you go.<br><br><button class="btn primary" data-action="add-budget">Set a budget</button></div></div>`}`;
  },
  bills() {
    const ups = upcoming();
    const due = ups.filter(u => u.r.mode === 'remind' && u.days <= 7);
    return `
      <h2>Due in the next 7 days</h2>
      ${listCard(due.map(dueRow), 'Nothing due in the next 7 days.')}
      <div class="section-head"><h2>All bills and recurring items</h2><button class="btn small" data-action="add-recurring">+ Add</button></div>
      ${listCard(ups.map(recurringRow), 'Add rent, EMIs, SIPs, subscriptions and other regular payments. Choose to be reminded, or have them added automatically.')}`;
  },
  goals() {
    const goals = [...state.goals].sort((a, b) => (a.by || '').localeCompare(b.by || ''));
    return `
      <div class="section-head"><h2>Savings goals</h2><button class="btn small" data-action="add-goal">+ Goal</button></div>
      ${goals.length ? `<div class="goal-list">${goals.map(goalCard).join('')}</div>`
        : `<div class="card"><div class="empty">Save towards something: a car, a holiday, an emergency fund, a child's education. See how much to put aside each month.<br><br><button class="btn primary" data-action="add-goal">Add a goal</button></div></div>`}`;
  },
  lending() {
    const open = state.debts.filter(x => debtLeft(x) > 0.005).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    const done = state.debts.filter(x => debtLeft(x) <= 0.005).sort((a, b) => b.date.localeCompare(a.date));
    const owedToMe = sum(open.filter(x => x.direction === 'lent'), debtLeft), iOwe = sum(open.filter(x => x.direction === 'borrowed'), debtLeft);
    return `
      <div class="grid">${stat('Others owe you', money(owedToMe), 'income')}${stat('You owe', money(iOwe), 'spend')}</div>
      <div class="section-head"><h2>Open</h2><button class="btn small" data-action="add-debt">+ Add</button></div>
      ${listCard(open.map(debtRow), 'Keep track of money you lend to friends and family, or borrow from them.')}
      ${done.length ? `<h2>Settled</h2>${listCard(done.slice(0, 30).map(debtRow), '')}` : ''}`;
  },
  loans() {
    const ls = state.loans.map(l => ({ l, ...loanNow(l) })).sort((a, b) => b.left - a.left);
    return `
      <div class="grid">${stat('Still to repay', money(sum(ls, x => x.left)), 'spend')}${stat('EMIs each month', money(sum(ls.filter(x => x.left > 0), x => x.emi)))}${stat('Interest paid so far', money(sum(ls, x => x.interestPaid)))}</div>
      <div class="section-head"><h2>Loans</h2><button class="btn small" data-action="add-loan">+ Loan</button></div>
      ${listCard(ls.map(loanRow), 'Add your home, car or personal loans to see what is left to pay, the interest so far, and when each one ends.')}
      ${ls.length ? '<p class="muted small-note">EMIs are assumed paid on schedule. Record any part-prepayment in the loan to see the new end date.</p>' : ''}`;
  },
  policies() {
    const all = state.policies.filter(p => !p.closed).sort((a, b) => (a.next || '9').localeCompare(b.next || '9'));
    const soon = policiesDue(30);
    const cover = sum(all.filter(p => p.kind !== 'fd'), p => p.cover || 0);
    return `
      <div class="grid">${stat('Insurance cover', money(cover))}${stat('Premiums a year', money(sum(all.filter(p => p.kind !== 'fd'), p => (p.premium || 0) * (12 / (Number(p.every) || 12)))), 'spend')}${stat('Fixed deposits', money(sum(all.filter(p => p.kind === 'fd'), p => p.premium || 0)), 'invest')}</div>
      <h2>Coming up in the next 30 days</h2>
      ${listCard(soon.map(p => policyRow(p, true)), 'No renewals or maturities in the next 30 days.')}
      <div class="section-head"><h2>All policies and deposits</h2><button class="btn small" data-action="add-policy">+ Add</button></div>
      ${listCard(all.map(p => policyRow(p)), 'Add insurance policies and fixed deposits to get reminders before premiums are due and deposits mature.')}`;
  },
};

// ---- loans ----
function loanNow(l) {
  const rows = schedule(l);
  const cur = todayISO().slice(0, 7);
  const past = rows.filter(r => r.month <= cur);
  return { rows, emi: l.emi || emi(l.principal, l.rate, l.months), left: past.length ? past.at(-1).balance : l.principal, interestPaid: sum(past, r => r.interest), end: rows.at(-1)?.month || l.start };
}
function loanRow(x) {
  return `<div class="row" data-action="edit-loan" data-id="${x.l.id}">
    ${avatar(x.l.name)}
    <div class="main"><div class="title">${esc(x.l.name)}</div><div class="meta">${LOAN_KIND[x.l.kind] || 'Loan'} · EMI ${money(x.emi)} · ${x.left > 0 ? `ends ${esc(monthLabel(x.end, { month: 'short', year: 'numeric' }))}` : 'paid off'}</div></div>
    <div class="amt spend">${money(x.left)}<div class="meta">left</div></div>
  </div>`;
}

// ---- insurance and fixed deposits ----
const addMonthsISO = (iso, n) => { const m = shiftMonth(iso.slice(0, 7), n); return `${m}-${pad2(Math.min(Number(iso.slice(8)), daysIn(m)))}`; };
function policiesDue(within) {
  const today = todayISO();
  return state.policies.filter(p => !p.closed && p.next && daysBetween(today, p.next) <= within).sort((a, b) => a.next.localeCompare(b.next));
}
function policyRow(p, withActions = false) {
  const days = p.next ? daysBetween(todayISO(), p.next) : null;
  const fd = p.kind === 'fd';
  const when = p.next ? (fd ? `matures ${fmtDate(p.next)}` : `${days < 0 ? 'was due' : 'due'} ${fmtDate(p.next)}`) : '';
  return `<div class="row ${withActions ? 'static due' : ''} ${days !== null && days < 0 ? 'overdue' : days !== null && days <= 7 ? 'soon' : ''}" ${withActions ? '' : `data-action="edit-policy" data-id="${p.id}"`}>
    ${avatar(p.name)}
    <div class="main"><div class="title">${esc(p.name)}</div><div class="meta">${POLICY_KIND[p.kind] || ''}${p.provider ? ' · ' + esc(p.provider) : ''}${when ? ' · ' + when : ''}</div></div>
    <div class="amt ${fd ? 'invest' : ''}">${money(fd ? p.maturity || p.premium : p.premium)}<div class="meta">${fd ? 'at maturity' : FREQ[p.every] ? ({ 1: 'a month', 3: 'a quarter', 6: 'half-yearly', 12: 'a year' })[p.every] : ''}</div></div>
    ${withActions ? `<div class="row-actions">${fd ? `<button class="btn small primary" data-action="policy-close" data-id="${p.id}">Matured</button>` : `<button class="btn small primary" data-action="policy-paid" data-id="${p.id}">Paid</button>`}<button class="btn small" data-action="edit-policy" data-id="${p.id}">Open</button></div>` : ''}
  </div>`;
}
async function insuranceCategory() {
  const c = state.categories.find(x => x.kind === 'expense' && x.name.toLowerCase() === 'insurance');
  return c ? c.id : (await save('categories', { kind: 'expense', name: 'Insurance' })).id;
}

// ---- net worth ----
function netWorthNow() {
  const investments = portfolio().current;
  const open = state.debts.filter(x => debtLeft(x) > 0.005);
  const lent = sum(open.filter(x => x.direction === 'lent'), debtLeft), borrowed = sum(open.filter(x => x.direction === 'borrowed'), debtLeft);
  const loans = sum(state.loans, l => loanNow(l).left);
  return { investments, lent, loans, borrowed, assets: investments + lent, liabilities: loans + borrowed, net: investments + lent - loans - borrowed };
}
// Keeps one net worth figure per month, so the trend builds up over time.
async function recordNetWorth() {
  const n = netWorthNow();
  const m = todayISO().slice(0, 7), v = Math.round(n.net);
  if ((!n.assets && !n.liabilities) || state.netLog.months?.[m] === v) return;
  state.netLog = await db.put('settings', { ...state.netLog, months: { ...state.netLog.months, [m]: v } });
  scheduleSync();
}

// Simple bar chart of [label, value] pairs; values may be negative. `avg` draws a dashed line.
function simpleBars(pairs, color = 'var(--invest)', avg = null) {
  if (!pairs.length) return '';
  const W = 600, H = 220, pad = 30, gw = W / pairs.length, bw = Math.min(36, gw * 0.6);
  const max = Math.max(0, ...pairs.map(p => p[1]), avg || 0), min = Math.min(0, ...pairs.map(p => p[1]));
  const span = max - min || 1, y = v => 8 + ((max - v) / span) * (H - pad - 8);
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img">
    <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--border)"/>
    ${pairs.map(([l, v], i) => `<g><rect x="${i * gw + (gw - bw) / 2}" y="${Math.min(y(v), y(0))}" width="${bw}" height="${Math.abs(y(v) - y(0))}" rx="3" fill="${v < 0 ? 'var(--danger)' : color}"><title>${esc(l)}: ${money(v)}</title></rect>
      <text x="${i * gw + gw / 2}" y="${H - 6}" text-anchor="middle">${esc(l)}</text></g>`).join('')}
    ${avg !== null ? `<line x1="0" x2="${W}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--muted)" stroke-dasharray="6 6"/>` : ''}
  </svg></div>`;
}

// ---- tax helper ----
// What the app can work out for a financial year starting in April of `fy`.
function taxAuto(fy) {
  const from = `${fy}-04`, to = `${fy + 1}-03`;
  const inFY = d => d && d.slice(0, 7) >= from && d.slice(0, 7) <= to;
  const fyEntries = state.entries.filter(e => inFY(e.date));
  const contrib = tag => sum(state.investments.filter(i => i.tax === tag).flatMap(i => (i.contributions || []).filter(c => c.amount > 0 && inFY(c.date))), c => c.amount);
  const premiums = kinds => sum(fyEntries.filter(e => e.policyId && kinds.includes(state.policies.find(p => p.id === e.policyId)?.kind)), e => e.amount);
  const homeRows = state.loans.filter(l => l.kind === 'home').flatMap(l => schedule(l).filter(r => r.month >= from && r.month <= to));
  return {
    salary: sum(fyEntries.filter(e => e.type === 'salary'), e => e.amount),
    other: sum(fyEntries.filter(e => e.type === 'income'), e => e.amount),
    c80: contrib('80C') + premiums(['life', 'term']) + sum(homeRows, r => r.principal),
    d80: premiums(['health']),
    nps: contrib('nps'),
    homeInterest: sum(homeRows, r => r.interest),
    hra: 0,
    otherDed: 0,
  };
}
const TAX_FIELDS = {
  salary: ['Gross salary for the year', 'Use the gross figure from Form 16 or your payslips. The suggestion adds up the salary you recorded, which is usually take-home pay.'],
  other: ['Other income', 'Interest, rent, freelance and other taxable income.'],
  c80: ['80C investments', 'PPF, EPF, ELSS, life insurance premiums, home loan principal, tuition fees. Counts up to ₹1.5 lakh.'],
  d80: ['80D health insurance', 'Health insurance premiums for you, your family and parents.'],
  nps: ['NPS, 80CCD(1B)', 'Your own extra NPS contribution, up to ₹50,000.'],
  homeInterest: ['Home loan interest, 24(b)', 'For a house you live in, up to ₹2 lakh.'],
  hra: ['HRA exemption', 'The exempt part of your house rent allowance.'],
  otherDed: ['Other deductions', 'For example 80E education loan interest or 80G donations.'],
};
function taxResult(fy) {
  const auto = taxAuto(fy), saved = state.taxInputs.years?.[fy] || {};
  const v = k => (saved[k] !== undefined && saved[k] !== '' ? Number(saved[k]) : auto[k]);
  return incomeTax({ salary: v('salary'), other: v('other') }, { c80: v('c80'), d80: v('d80'), d80max: 100000, nps: v('nps'), homeInterest: v('homeInterest'), hra: v('hra'), other: v('otherDed') });
}
function taxResultHtml(fy) {
  const r = taxResult(fy);
  const better = r.newRegime.tax <= r.oldRegime.tax ? 'new' : 'old', diff = Math.abs(r.newRegime.tax - r.oldRegime.tax);
  const card = (key, title, x) => `<div class="card regime ${better === key ? 'best' : ''}">
    <div class="label">${title}${better === key ? ' <span class="badge">Lower</span>' : ''}</div>
    <div class="value">${money(Math.round(x.tax))}</div>
    <div class="sub">Taxable income ${money(Math.round(x.taxable))}</div></div>`;
  return `<div class="grid">${card('new', 'New regime', r.newRegime)}${card('old', 'Old regime', r.oldRegime)}</div>
    <p class="small-note">${r.gross ? (diff >= 1 ? `The <b>${better} regime</b> saves you about <b>${money(Math.round(diff))}</b> this year.` : 'Both regimes come to the same tax.') : 'Enter your gross salary to see an estimate.'}
    <span class="muted">Tax shown includes 4% cess. This is an estimate for individuals below 60 using the FY 2025–26 rules; check with your CA before filing.</span></p>`;
}

// ---- goals ----
const goalSaved = g => sum(g.saved || [], c => c.amount) + (g.investmentId ? (i => (i ? i.currentValue ?? investedTotal(i) : 0))(state.investments.find(i => i.id === g.investmentId)) : 0);
function goalCard(g) {
  const saved = goalSaved(g), pctDone = g.target ? Math.min(100, (saved / g.target) * 100) : 0;
  const months = g.by ? Math.max(1, monthDiff(todayISO().slice(0, 7), g.by) + 1) : 0;
  const need = Math.max(0, g.target - saved);
  const plan = need <= 0 ? '<b class="income">Reached. Well done!</b>'
    : g.by ? (monthDiff(todayISO().slice(0, 7), g.by) < 0 ? `<span class="neg">Target date passed</span> · ${money(need)} to go` : `Put aside <b>${money(need / months)}</b> a month to reach it by ${esc(monthLabel(g.by, { month: 'short', year: 'numeric' }))}`)
    : `${money(need)} to go`;
  return `<div class="card goal" data-action="edit-goal" data-id="${g.id}" style="--tone:${catColor(g.name)}">
    <div class="goal-top">${avatar(g.name)}<div class="main"><div class="title">${esc(g.name)}</div><div class="meta">${money(saved)} of ${money(g.target)}</div></div><div class="goal-pct">${Math.round(pctDone)}%</div></div>
    <div class="bar-track"><div class="bar-fill" style="width:${pctDone}%"></div></div>
    <div class="goal-plan">${plan}</div>
  </div>`;
}

// ---- money lent and borrowed ----
const debtLeft = x => x.amount - sum(x.repaid || [], p => p.amount);
function debtsDueSoon() {
  const today = todayISO();
  return state.debts.filter(x => x.due && debtLeft(x) > 0.005 && daysBetween(today, x.due) <= 3);
}
function debtRow(x) {
  const left = debtLeft(x), today = todayISO();
  const days = x.due ? daysBetween(today, x.due) : null;
  const status = left <= 0.005 ? 'Settled' : x.due ? (days < 0 ? `<span class="neg">${-days} days overdue</span>` : `due ${fmtDate(x.due)}`) : '';
  return `<div class="row" data-action="edit-debt" data-id="${x.id}">
    ${avatar(x.person)}
    <div class="main"><div class="title">${esc(x.person)}</div><div class="meta">${x.direction === 'lent' ? 'You lent' : 'You borrowed'} ${money(x.amount)} on ${fmtDate(x.date)}${status ? ' · ' + status : ''}</div></div>
    <div class="amt ${left <= 0.005 ? '' : x.direction === 'lent' ? 'income' : 'spend'}">${money(left > 0.005 ? left : x.amount)}<div class="meta">${left > 0.005 ? (x.direction === 'lent' ? 'owes you' : 'you owe') : ''}</div></div>
  </div>`;
}

// ---- insights ----
// Short "heads up" lines for the Overview: budgets that are over, and categories
// already above all of last month's spending.
function insights() {
  const out = [];
  for (const s of budgetStatus(state.month).filter(s => s.pct > 100)) out.push(`<b>${esc(s.name)}</b> is ${money(s.spent - s.limit)} over budget this month.`);
  if (state.month === todayISO().slice(0, 7) && Number(todayISO().slice(8)) < daysIn(state.month)) {
    const now = byCategory(entriesIn(state.month, 'expense'), state, true), before = new Map(byCategory(entriesIn(shiftMonth(state.month, -1), 'expense'), state, true));
    for (const [name, v] of now) {
      const last = before.get(name);
      if (last && v > last && v - last >= 200) out.push(`You've already spent more on <b>${esc(name)}</b> (${money(v)}) than in all of last month (${money(last)}).`);
    }
  }
  return out.slice(0, 3);
}

// After saving a spending entry: warn about budgets crossing 80% or 100%,
// or an amount far above what's usual for that category.
function spendingAlert(e, before = 0) {
  if (e.type !== 'expense') return '';
  for (const s of budgetStatus(e.date.slice(0, 7))) {
    if (s.b.categoryId !== 'all' && !inCat(e, s.b.categoryId)) continue;
    const was = s.limit ? ((s.spent - e.amount + before) / s.limit) * 100 : 0;
    if (s.pct > 100 && was <= 100) return `Heads up: ${s.name} is now ${money(s.spent - s.limit)} over budget.`;
    if (s.pct >= 80 && was < 80) return `Heads up: ${s.name} has used ${Math.round(s.pct)}% of its budget.`;
  }
  const top = topCatId(e.categoryId);
  const past = state.entries.filter(x => x.type === 'expense' && x.id !== e.id && topCatId(x.categoryId) === top && x.date <= e.date && daysBetween(x.date, e.date) <= 180).map(x => x.amount).sort((a, b) => a - b);
  if (past.length >= 5) {
    const usual = past[Math.floor(past.length / 2)];
    if (e.amount >= 3 * usual && e.amount - usual >= 500) return `Heads up: that's about ${Math.round(e.amount / usual)} times your usual ${catName(top)} spend.`;
  }
  return '';
}

// The range picked for export, as months.
function exportRange(kind) {
  const fy = fyStart(state.month), y = state.month.slice(0, 4);
  if (kind === 'month') return { from: state.month, to: state.month, label: monthLabel(state.month), file: state.month };
  if (kind === 'fy') return { from: `${fy}-04`, to: `${fy + 1}-03`, label: `FY ${fy}–${String(fy + 1).slice(2)}`, file: `FY${fy}-${String(fy + 1).slice(2)}` };
  if (kind === 'year') return { from: `${y}-01`, to: `${y}-12`, label: y, file: y };
  const months = [...state.entries.map(e => e.date), ...state.investments.flatMap(i => (i.contributions || []).map(c => c.date))].map(d => d.slice(0, 7)).sort();
  return { from: months[0] || state.month, to: months.at(-1) || state.month, label: 'Everything', file: 'all' };
}

function exportRows(range) {
  const inRange = d => d.slice(0, 7) >= range.from && d.slice(0, 7) <= range.to;
  const entries = state.entries.filter(e => inRange(e.date)).sort((a, b) => a.date.localeCompare(b.date));
  const contribs = state.investments.flatMap(i => (i.contributions || []).filter(c => inRange(c.date)).map(c => ({ ...c, inv: i }))).sort((a, b) => a.date.localeCompare(b.date));
  const months = [];
  for (let m = range.from; m <= range.to; m = shiftMonth(m, 1)) months.push(m);
  return {
    entries: [['Date', 'Type', 'Category', 'Amount', 'Payment method', 'Note'],
      ...entries.map(e => [e.date, TYPE_LABEL[e.type], e.type === 'salary' ? 'Salary' : catName(e.categoryId), e.amount, METHODS[e.method] || '', e.note || ''])],
    contributions: [['Date', 'Holding', 'Type', 'Amount'], ...contribs.map(c => [c.date, c.inv.name, catName(c.inv.categoryId), c.amount])],
    holdings: [['Holding', 'Type', 'Invested', 'Current value', 'Gain'],
      ...state.investments.map(i => { const inv = investedTotal(i), cur = i.currentValue ?? inv; return [i.name, catName(i.categoryId), inv, cur, cur - inv]; })],
    summary: [['Month', 'Salary', 'Other income', 'Spending', 'Invested', 'Left over'],
      ...months.map(m => { const t = monthTotals(m); return [monthLabel(m, { month: 'short', year: 'numeric' }), t.salary, t.other, t.spent, t.invested, t.saved]; })],
  };
}

const reportViews = {
  year() {
    const fy = state.fy;
    const y = state.reportYear ?? (fy ? fyStart(state.month) : Number(state.month.slice(0, 4)));
    state.reportYear = y;
    const months = monthsFrom(fy ? `${y}-04` : `${y}-01`, 12);
    const rows = months.map(m => ({ m, ...monthTotals(m) }));
    const T = Object.fromEntries(['salary', 'other', 'income', 'spent', 'invested', 'saved'].map(k => [k, sum(rows, r => r[k])]));
    const label = fy ? `FY ${y}–${String(y + 1).slice(2)}` : String(y);
    const spend = state.entries.filter(e => e.type === 'expense' && e.date.slice(0, 7) >= months[0] && e.date.slice(0, 7) <= months[11]);
    const cell = v => (v ? money(v, true) : '–');
    return `
      <div class="year-head">
        <div class="seg">${[['fy', 'Apr–Mar'], ['cal', 'Jan–Dec']].map(([k, l]) => `<label><input type="radio" name="fy" value="${k}" ${(k === 'fy') === fy ? 'checked' : ''}>${l}</label>`).join('')}</div>
        <div class="month-picker"><button class="icon-btn" data-action="year-step" data-id="-1" aria-label="Previous year">‹</button><span class="month-label">${label}</span><button class="icon-btn" data-action="year-step" data-id="1" aria-label="Next year">›</button></div>
      </div>
      <div class="grid quad">
        ${stat('Income', money(T.income), 'income', `Salary ${money(T.salary)}`)}
        ${stat('Spending', money(T.spent), 'spend')}
        ${stat('Invested', money(T.invested), 'invest')}
        ${stat('Left over', money(T.saved), T.saved < 0 ? 'neg' : '', T.income ? `${Math.round((T.saved / T.income) * 100)}% of income kept` : '')}
      </div>
      <h2>Month by month</h2>
      <div class="card">${trendChart(months)}</div>
      <div class="card table-card"><table class="table">
        <thead><tr><th>Month</th><th>In</th><th>Out</th><th>Invested</th><th>Left</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="${r.income || r.spent || r.invested ? '' : 'dim'}"><td>${esc(monthLabel(r.m, { month: 'short' }))}</td><td class="income">${cell(r.income)}</td><td class="spend">${cell(r.spent)}</td><td class="invest">${cell(r.invested)}</td><td class="${r.saved < 0 ? 'neg' : ''}">${cell(r.saved)}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td>${money(T.income, true)}</td><td>${money(T.spent, true)}</td><td>${money(T.invested, true)}</td><td>${money(T.saved, true)}</td></tr></tbody>
      </table></div>
      <h2>Top spending in ${esc(label)}</h2>
      <div class="card">${bars(byCategory(spend).slice(0, 8), '', 'No spending recorded in this year.')}</div>`;
  },
  summary() {
    const m = state.month, prev = shiftMonth(m, -1);
    const t = monthTotals(m), p = monthTotals(prev);
    const change = p.spent ? ((t.spent - p.spent) / p.spent) * 100 : NaN;
    const top = byCategory(entriesIn(m, 'expense'), state, true).slice(0, 3);
    const budgets = budgetStatus(m);
    const over = budgets.filter(b => b.pct > 100), within = budgets.filter(b => b.pct <= 100);
    const goalsMoved = state.goals.map(g => ({ g, added: sum((g.saved || []).filter(c => c.date.startsWith(m)), c => c.amount) })).filter(x => x.added);
    const lines = [
      t.income ? `You earned <b>${money(t.income)}</b> and kept <b>${money(t.saved)}</b>, which is ${Math.round((t.saved / t.income) * 100)}% of it.` : 'No income was recorded this month.',
      t.spent ? `You spent <b>${money(t.spent)}</b>${isFinite(change) ? `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(0)}% on ${esc(monthLabel(prev, { month: 'long' }))}` : ''}.` : 'No spending was recorded.',
      t.invested ? `You invested <b>${money(t.invested)}</b>.` : '',
      top.length ? `Most went on ${top.map(([n, v]) => `${esc(n)} (${money(v)})`).join(', ')}.` : '',
      budgets.length ? (over.length ? `${over.length} budget${over.length === 1 ? ' went' : 's went'} over: ${over.map(b => esc(b.name)).join(', ')}.` : `All ${within.length} budget${within.length === 1 ? '' : 's'} stayed within the limit.`) : '',
      ...goalsMoved.map(x => `You put ${money(x.added)} towards <b>${esc(x.g.name)}</b>.`),
    ].filter(Boolean);
    return `
      <section class="hero">
        <div class="hero-label">${esc(monthLabel(m))} in short</div>
        <div class="hero-value">${money(t.saved)}</div>
        <div class="hero-sub">left over${t.income ? ` · <b>${Math.round((t.saved / t.income) * 100)}%</b> of income kept` : ''}</div>
      </section>
      <div class="card summary-lines">${lines.map(l => `<p>${l}</p>`).join('')}</div>
      <p class="muted small-note">Use the month at the top to see any month's summary.</p>`;
  },
  trends() {
    const cur = todayISO().slice(0, 7);
    const months = monthsFrom(shiftMonth(cur, -11), 12);
    const cats = catsOf('expense').filter(c => !parentOf(c.id));
    const sel = state.trendCat || 'all';
    const spentIn = m => sum(entriesIn(m, 'expense').filter(e => sel === 'all' || inCat(e, sel)), e => e.amount);
    const vals = months.map(m => [monthLabel(m, { month: 'short' }), spentIn(m)]);
    const used = vals.filter(v => v[1] > 0);
    const avg = used.length ? sum(used, v => v[1]) / used.length : 0;
    const high = [...vals].sort((a, b) => b[1] - a[1])[0];
    const now = vals.at(-1)[1];
    return `
      <label class="field">Category<select class="inline-input" id="trend-cat"><option value="all">All spending</option>${cats.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <div class="grid" style="margin-top:12px">${stat('This month', money(now), 'spend', avg ? `${pct(((now - avg) / avg) * 100)} vs average` : '')}${stat('Monthly average', money(avg), '', 'Months with spending')}${stat('Highest', money(high[1]), '', high[1] ? esc(high[0]) : '')}</div>
      <h2>Last 12 months</h2>
      <div class="card">${simpleBars(vals, 'var(--spend)', avg || null)}<div class="legend"><span><i style="background:var(--spend)"></i>Spent</span><span>– – Average</span></div></div>`;
  },
  networth() {
    const n = netWorthNow();
    const hist = Object.entries(state.netLog.months || {}).sort().slice(-12).map(([m, v]) => [monthLabel(m, { month: 'short' }), v]);
    return `
      <section class="hero">
        <div class="hero-label">Net worth today</div>
        <div class="hero-value">${money(n.net)}</div>
        <div class="hero-sub">What you own minus what you owe</div>
      </section>
      <div class="grid quad">
        ${stat('Investments', money(n.investments), 'invest')}
        ${stat('Money lent', money(n.lent), 'income')}
        ${stat('Loans', money(n.loans), 'spend')}
        ${stat('Money borrowed', money(n.borrowed), 'spend')}
      </div>
      <h2>Month by month</h2>
      <div class="card">${hist.length > 1 ? simpleBars(hist, 'var(--income)') : '<div class="empty">The app records your net worth each month when you open it. The chart fills in from next month.</div>'}</div>
      <p class="muted small-note">Investments use their current value. Bank balances and property aren't included unless you add them as holdings in Invest.</p>`;
  },
  tax() {
    const fy = state.taxYear ?? fyStart(todayISO().slice(0, 7));
    state.taxYear = fy;
    const auto = taxAuto(fy), saved = state.taxInputs.years?.[fy] || {};
    return `
      <div class="year-head"><b>Income tax estimate</b>
        <div class="month-picker"><button class="icon-btn" data-action="tax-year" data-id="-1" aria-label="Previous year">‹</button><span class="month-label">FY ${fy}–${String(fy + 1).slice(2)}</span><button class="icon-btn" data-action="tax-year" data-id="1" aria-label="Next year">›</button></div></div>
      <div id="tax-results">${taxResultHtml(fy)}</div>
      <h2>Your figures</h2>
      <form class="card tax-form" data-form="tax" data-fy="${fy}">
        ${Object.entries(TAX_FIELDS).map(([k, [label, help]]) => `<label class="field">${label}<input name="${k}" type="number" inputmode="decimal" min="0" step="1" value="${saved[k] ?? ''}" placeholder="${Math.round(auto[k])}"><span class="hint">${help}${auto[k] ? ` Worked out from your records: ${money(Math.round(auto[k]))}.` : ''}</span></label>`).join('')}
        <p class="muted hint" style="margin:0">Leave a box empty to use the figure worked out from your records (shown faintly). Mark tax-saving holdings in Invest, and life or health policies under Plan → Insurance, to fill these in automatically.</p>
      </form>`;
  },
  export() {
    const kinds = { month: monthLabel(state.month), fy: exportRange('fy').label, year: `Calendar year ${state.month.slice(0, 4)}`, all: 'Everything' };
    return `
      <h2>Download your records</h2>
      <div class="card export-card">
        <label class="field">Period<select class="inline-input" id="export-range">${Object.entries(kinds).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
        <div class="btn-row"><button class="btn primary" data-action="export-xlsx">Excel file (.xlsx)</button><button class="btn" data-action="export-csv">CSV file</button></div>
        <p class="muted" style="margin:0">The Excel file has four sheets: all entries, investment contributions, holdings, and a month-by-month summary. The CSV file has the entries only. Both open in Excel and Google Sheets.</p>
      </div>
      <p class="muted small-note">To move all your data to another app or keep a full copy, use Export backup in Settings.</p>`;
  },
};

function searchResults() {
  const f = state.search;
  const q = (f.q || '').trim().toLowerCase();
  const min = parseFloat(f.min), max = parseFloat(f.max);
  const active = q || ['type', 'cat', 'method', 'from', 'to', 'min', 'max'].some(k => f[k]);
  if (!active) return '<p class="muted small-note">Search all your records, in every month. Use the filters to narrow it down.</p>';
  const list = state.entries.filter(e => (!f.type || e.type === f.type) && (!f.cat || inCat(e, f.cat)) && (!f.method || e.method === f.method)
    && (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to) && (!(min > 0) || e.amount >= min) && (!(max > 0) || e.amount <= max)
    && (!q || [e.note, e.type === 'salary' ? 'salary' : catName(e.categoryId), METHODS[e.method], String(e.amount), e.date, ...(e.tags || []).map(t => '#' + t)].join(' ').toLowerCase().includes(q)))
    .sort(byDateDesc);
  const moneyIn = sum(list.filter(e => e.type !== 'expense'), e => e.amount), moneyOut = sum(list.filter(e => e.type === 'expense'), e => e.amount);
  return `<div class="grid">${stat('Found', list.length)}${stat('Money in', money(moneyIn), 'income')}${stat('Money out', money(moneyOut), 'spend')}</div>
    <div style="height:10px"></div>
    ${listCard(list.slice(0, 200).map(e => entryRow(e)), 'Nothing matches.')}
    ${list.length > 200 ? '<p class="muted small-note">Showing the latest 200. Narrow the search to see others.</p>' : ''}`;
}

function lockView() {
  return `<section class="auth">
    <div class="auth-brand">My Finances</div>
    <p class="auth-tag">Locked. Enter your PIN to open.</p>
    <form class="card auth-card" data-form="unlock">
      <label class="field">PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" required autofocus class="pin-input"></label>
      <button class="btn primary big">Unlock</button>
      <div class="auth-links">${lock.biometricOn() ? '<button type="button" class="link" data-action="bio-unlock">Use fingerprint</button>' : '<span></span>'}<button type="button" class="link" data-action="forgot-pin">Forgot PIN?</button></div>
    </form>
  </section>`;
}

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

const SKINS = { fresh: 'Fresh', vault: 'Vault', auto: 'Auto' };
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
darkQuery?.addEventListener?.('change', () => render());
// 'auto' follows the device: Vault when it is in dark mode, Fresh otherwise.
const skinChoice = () => { try { const s = localStorage.getItem('skin'); return SKINS[s] ? s : 'fresh'; } catch { return 'fresh'; } };
function applySkin() {
  const preview = new URLSearchParams(location.search).get('skin');
  const choice = SKINS[preview] ? preview : skinChoice();
  document.documentElement.dataset.skin = choice === 'auto' ? (darkQuery?.matches ? 'vault' : 'fresh') : choice;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bar-color').trim() || '#0e9f6e');
}

let bioPrompted = false;
async function tryBiometric() {
  if (await lock.biometricUnlock()) { lock.unlock(); render(); }
}

function render() {
  applySkin();
  const signedIn = !!auth.current();
  const locked = signedIn && lock.isLocked();
  document.body.classList.toggle('signed-out', !signedIn || locked);
  $('.tabs [data-tab=family]').hidden = !inFamily();
  if (!signedIn || locked) {
    $('#view').innerHTML = locked ? lockView() : authView();
    i18n.translate($('#view'));
    $('#view [autofocus]')?.focus();
    if (locked && lock.biometricOn() && !bioPrompted) { bioPrompted = true; setTimeout(tryBiometric, 300); }
    return;
  }
  bioPrompted = false;
  document.querySelectorAll('.tabs button, .top-actions button').forEach(b => { if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const urgent = dueSoon().length + debtsDueSoon().length + policiesDue(7).length;
  $('.tabs [data-tab=plan] .tab-badge').textContent = urgent || '';
  $('#month').value = state.month;
  $('#month-text').textContent = monthLabel(state.month, { month: 'short', year: 'numeric' });
  $('.month-picker').style.visibility = ['settings', 'search'].includes(state.tab) || (state.tab === 'reports' && state.reportView !== 'summary') ? 'hidden' : '';
  $('.fab').hidden = ['family', 'settings', 'reports', 'search'].includes(state.tab);
  $('#view').innerHTML = views[state.tab]();
  i18n.translate(document.body);
}

// ---------- dialogs ----------

function openDialog(html, onSubmit, onReady) {
  const dlg = $('#dialog'), form = $('#dialog-form');
  form.innerHTML = html;
  i18n.translate(form);
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
  catsOf(kind).map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(catName(c.id))}</option>`).join('') + '<option value="__new">+ New category…</option>';

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
    <div class="amount-row">${amountField(e.orig ? e.orig.amount : e.amount ?? '')}
      <label class="field">Currency<select name="cur">${[...new Set([state.settings.currency, ...CURRENCIES])].map(c => `<option ${c === (e.orig?.currency || state.settings.currency) ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
    <label class="field" id="fx-field" hidden><span id="fx-label">Rate</span><input name="rate" type="number" inputmode="decimal" step="0.0001" min="0" value="${e.orig?.rate ?? ''}"></label>
    <p class="muted hint" id="fx-hint" style="margin:0" hidden></p>
    <label class="field" id="cat-field">Category<select name="categoryId"></select></label>
    <div class="two">
      <label class="field">Date<input name="date" type="date" required value="${e.date}"></label>
      <label class="field">Payment method<select name="method">${methodOptions(e.method ?? (e.type === 'salary' ? 'bank' : lastMethod()))}</select></label>
    </div>
    <label class="field">Note (optional)<input name="note" maxlength="120" value="${esc(e.note || '')}"></label>
    <label class="field">Tags (optional)<input name="tags" maxlength="120" value="${esc((e.tags || []).map(t => '#' + t).join(' '))}" placeholder="#trip-goa #office"></label>
    <label class="field">Receipt photo (optional)<input name="receipt" type="file" accept="image/*"></label>
    ${e.receipt ? `<button type="button" class="btn small" data-action="view-receipt" data-id="${e.id}">View receipt</button>` : ''}
    ${isEdit ? '' : '<label class="check"><input type="checkbox" name="template"> Also save as a quick-add button</label>'}
    ${actions(isEdit)}`,
  async (fd, action) => {
    if (action === 'delete') {
      if (!confirm('Delete this entry?')) return false;
      await drop('entries', e.id);
      if (e.receipt) cloud.deleteReceipt(e.id);
      toast('Entry deleted');
    } else {
      const type = fd.get('type');
      const typed = parseFloat(fd.get('amount'));
      if (!(typed > 0)) throw new Error('Enter an amount above zero');
      // Another currency: keep what was typed, and store the amount converted at the given rate.
      const cur = fd.get('cur'), rate = parseFloat(fd.get('rate'));
      const foreign = cur !== state.settings.currency;
      if (foreign && !(rate > 0)) throw new Error(`Enter the rate for ${cur}`);
      const amount = foreign ? Math.round(typed * rate * 100) / 100 : typed;
      const orig = foreign ? { currency: cur, amount: typed, rate } : null;
      if (foreign) try { localStorage.setItem(`fx.${cur}.${state.settings.currency}`, rate); } catch {}
      let categoryId = type === 'salary' ? null : fd.get('categoryId');
      if (categoryId === '__new') throw new Error('Pick or create a category');
      const method = fd.get('method');
      const tags = parseTags(fd.get('tags'));
      const note = fd.get('note').trim();
      let rec = await save('entries', { ...e, type, amount, orig, categoryId, method, date: fd.get('date'), note, tags });
      const photo = fd.get('receipt');
      if (photo && photo.size) {
        try {
          await cloud.putReceipt(rec.id, await compressImage(photo));
          rec = await save('entries', { ...rec, receipt: true });
        } catch (err) {
          toast(err.status === 403 ? 'Receipt not saved: the admin needs to update the security rules first.' : 'Receipt not saved. Check your internet and try again.');
        }
      }
      if (method && type === 'expense') try { localStorage.setItem('lastMethod', method); } catch {}
      if (fd.get('template')) await save('templates', { name: note || (type === 'salary' ? 'Salary' : catName(categoryId).split(' › ').pop()), type, amount, categoryId, method, note, tags });
      if (!fd.get('date').startsWith(state.month)) state.month = fd.get('date').slice(0, 7);
      toast(spendingAlert(rec, isEdit && e.type === 'expense' ? e.amount : 0) || (isEdit ? 'Saved' : `${TYPE_LABEL[type]} added`));
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
    // Currency: show the rate box for anything other than the home currency.
    const home = state.settings.currency, curSel = form.querySelector('select[name=cur]'), rateIn = form.querySelector('input[name=rate]');
    const fxHint = () => {
      const foreign = curSel.value !== home, a = parseFloat(form.querySelector('input[name=amount]').value), r = parseFloat(rateIn.value);
      form.querySelector('#fx-field').hidden = !foreign;
      form.querySelector('#fx-label').textContent = `Rate: 1 ${curSel.value} = ? ${home}`;
      const hint = form.querySelector('#fx-hint');
      hint.hidden = !(foreign && a > 0 && r > 0);
      hint.textContent = `Saved as ${money(Math.round(a * r * 100) / 100)}`;
    };
    curSel.addEventListener('change', async () => {
      if (curSel.value !== home) {
        try { rateIn.value = localStorage.getItem(`fx.${curSel.value}.${home}`) || ''; } catch {}
        fxHint();
        try {
          const d = await getJSON(`https://api.frankfurter.app/latest?from=${curSel.value}&to=${home}`);
          if (d?.rates?.[home]) rateIn.value = d.rates[home];
        } catch {}
      }
      fxHint();
    });
    form.querySelectorAll('input[name=amount], input[name=rate]').forEach(i => i.addEventListener('input', fxHint));
    fxHint();
    // Salary usually arrives by bank transfer; other types keep the last method used.
    if (!isEdit) form.querySelectorAll('input[name=type]').forEach(r => r.addEventListener('change', () => {
      form.querySelector('select[name=method]').value = r.value === 'salary' ? 'bank' : lastMethod();
    }));
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

function budgetDialog(b) {
  const x = b || { categoryId: '' };
  const taken = new Set(state.budgets.filter(o => o.id !== x.id).map(o => o.categoryId));
  const opts = [['all', 'All spending'], ...catsOf('expense').map(c => [c.id, catName(c.id)])].filter(([id]) => !taken.has(id));
  if (!opts.length) return toast('Every category already has a budget');
  openDialog(`
    <h3>${b ? 'Edit budget' : 'New monthly budget'}</h3>
    <label class="field">For<select name="categoryId">${opts.map(([id, n]) => `<option value="${id}" ${id === x.categoryId ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    ${amountField(x.amount ?? '', 'Monthly limit')}
    <label class="setting"><div><b>Carry over what's left</b><div class="muted">Money not spent this month is added to next month's limit.</div></div><input type="checkbox" class="switch" name="rollover" ${x.rollover ? 'checked' : ''}></label>
    ${actions(!!b)}`,
  async (fd, action) => {
    if (action === 'delete') {
      await drop('budgets', b.id);
      toast('Budget removed');
    } else {
      const amount = parseFloat(fd.get('amount'));
      if (!(amount > 0)) throw new Error('Enter a limit above zero');
      await save('budgets', { ...x, categoryId: fd.get('categoryId'), amount, rollover: fd.get('rollover') === 'on', since: x.since || state.month });
      toast('Budget saved');
    }
    render();
  });
}

function recurringDialog(r) {
  const today = todayISO();
  const x = r || { type: 'expense', every: 1, day: Number(today.slice(8)), start: today.slice(0, 7), mode: 'remind', method: lastMethod() };
  const MODE_HINT = { remind: 'It shows under Due soon from 3 days before. Tap Paid to record it.', auto: 'It is added to your records on the due day, every time.' };
  openDialog(`
    <h3>${r ? 'Edit bill or recurring item' : 'New bill or recurring item'}</h3>
    <label class="field">Name<input name="name" required maxlength="60" value="${esc(x.name || '')}" placeholder="e.g. House rent, Netflix, SIP" ${r ? '' : 'autofocus'}></label>
    <div class="seg">${Object.entries(RTYPE).map(([v, l]) => `<label><input type="radio" name="type" value="${v}" ${x.type === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
    <label class="field">Amount<input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required value="${x.amount ?? ''}"></label>
    <label class="field" id="r-cat">Category<select name="categoryId"></select></label>
    <label class="field" id="r-inv">Holding<select name="investmentId">${state.investments.map(i => `<option value="${i.id}" ${i.id === x.investmentId ? 'selected' : ''}>${esc(i.name)}</option>`).join('') || '<option value="">Add a holding in Invest first</option>'}</select></label>
    <div class="two">
      <label class="field">Day of month<input name="day" type="number" inputmode="numeric" min="1" max="31" required value="${x.day}"></label>
      <label class="field">Repeats<select name="every">${Object.entries(FREQ).map(([k, l]) => `<option value="${k}" ${Number(k) === Number(x.every) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="two">
      <label class="field">Starting<input name="start" type="month" required value="${x.start}"></label>
      <label class="field" id="r-method">Payment method<select name="method">${methodOptions(x.method)}</select></label>
    </div>
    <div class="seg">${[['remind', 'Remind me'], ['auto', 'Add automatically']].map(([v, l]) => `<label><input type="radio" name="mode" value="${v}" ${x.mode === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
    <p class="muted hint" id="mode-hint" style="margin:0"></p>
    ${actions(!!r)}`,
  async (fd, action) => {
    if (action === 'delete') {
      if (!confirm(`Delete "${r.name}"? Records already added stay.`)) return false;
      await drop('recurring', r.id);
      toast('Removed');
    } else {
      const type = fd.get('type');
      const amount = parseFloat(fd.get('amount'));
      const day = Math.round(Number(fd.get('day')));
      if (!fd.get('name').trim()) throw new Error('Give it a name');
      if (!(amount > 0)) throw new Error('Enter an amount above zero');
      if (!(day >= 1 && day <= 31)) throw new Error('Day of month must be 1 to 31');
      if (type === 'investment' && !fd.get('investmentId')) throw new Error('Add the holding in Invest first');
      const categoryId = type === 'expense' || type === 'income' ? fd.get('categoryId') : null;
      if (categoryId === '__new') throw new Error('Pick a category');
      await save('recurring', { ...x, name: fd.get('name').trim(), type, amount, day, every: Number(fd.get('every')), start: fd.get('start'),
        mode: fd.get('mode'), method: fd.get('method'), categoryId, investmentId: type === 'investment' ? fd.get('investmentId') : null, doneThrough: x.doneThrough || '' });
      toast('Saved');
      const added = await runRecurring();
      if (added) toast(`Saved, and ${added} ${added === 1 ? 'entry' : 'entries'} added for dates already passed`);
    }
    render();
  },
  form => {
    const select = form.querySelector('select[name=categoryId]');
    const sync = () => {
      const type = form.querySelector('input[name=type]:checked').value;
      form.querySelector('#r-cat').hidden = !(type === 'expense' || type === 'income');
      form.querySelector('#r-inv').hidden = type !== 'investment';
      if (type === 'expense' || type === 'income') select.innerHTML = categoryOptions(type, x.categoryId).replace('<option value="__new">+ New category…</option>', '');
      form.querySelector('#mode-hint').textContent = MODE_HINT[form.querySelector('input[name=mode]:checked').value];
    };
    form.querySelectorAll('input[name=type], input[name=mode]').forEach(i => i.addEventListener('change', sync));
    sync();
  });
}

// mode: 'set' (new PIN), 'change' (old + new), 'off' (old only)
function pinDialog(mode) {
  const pinField = (name, label, focus) => `<label class="field">${label}<input name="${name}" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" required autocomplete="off" class="pin-input" ${focus ? 'autofocus' : ''}></label>`;
  openDialog(`
    <h3>${{ set: 'Set a PIN', change: 'Change PIN', off: 'Turn off app lock' }[mode]}</h3>
    ${mode !== 'set' ? pinField('old', 'Current PIN', true) : ''}
    ${mode !== 'off' ? pinField('pin', 'New PIN (4 to 6 digits)', mode === 'set') + pinField('repeat', 'Repeat new PIN') : ''}
    ${mode === 'set' ? '<p class="muted hint" style="margin:0">The PIN is kept on this device only. If you forget it, sign in again with your password.</p>' : ''}
    ${actions(false)}`,
  async fd => {
    if (mode !== 'set' && !(await lock.check(fd.get('old')))) throw new Error('Wrong PIN');
    if (mode === 'off') {
      lock.clear();
      toast('App lock turned off');
    } else {
      if (fd.get('pin') !== fd.get('repeat')) throw new Error('The PINs don\'t match');
      await lock.setPin(fd.get('pin'), mode === 'change' ? lock.biometricOn() : state.bioAvailable);
      lock.unlock();
      toast(mode === 'set' ? 'App lock is on' : 'PIN changed');
    }
    render();
  });
}

function goalDialog(goal) {
  const g = goal || { saved: [] };
  const list = [...(g.saved || [])].sort(byDateDesc);
  openDialog(`
    <h3>${goal ? esc(goal.name) : 'New savings goal'}</h3>
    <label class="field">Goal<input name="name" required maxlength="60" value="${esc(g.name || '')}" placeholder="e.g. New car, Emergency fund" ${goal ? '' : 'autofocus'}></label>
    <div class="two">
      <label class="field">Target amount<input name="target" type="number" inputmode="decimal" step="0.01" min="1" required value="${g.target ?? ''}"></label>
      <label class="field">Reach it by<input name="by" type="month" value="${g.by || ''}"></label>
    </div>
    <label class="field">Count a holding towards it (optional)<select name="investmentId"><option value="">No</option>${state.investments.map(i => `<option value="${i.id}" ${i.id === g.investmentId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
    ${goal ? `
      <div class="section-head" style="margin:6px 0 0"><b>Money put aside</b><span class="muted">${money(goalSaved(g))} so far</span></div>
      <div class="inline-form" style="margin-top:0">
        <input class="inline-input" name="sAmount" type="number" inputmode="decimal" step="0.01" placeholder="Amount (minus to take out)">
        <input class="inline-input" name="sDate" type="date" value="${todayISO()}">
        <button class="btn" value="add-saving" formnovalidate>Add</button>
      </div>
      <div style="max-height:160px;overflow:auto">${list.map(c => `<div class="row static" style="padding:8px 4px"><div class="main meta">${fmtDate(c.date)}</div><div class="amt ${c.amount < 0 ? 'neg' : 'income'}">${money(c.amount)}</div><button class="btn small" value="rm:${c.id}" formnovalidate aria-label="Remove">×</button></div>`).join('') || '<div class="empty">Nothing added yet.</div>'}</div>`
    : '<label class="field">Already saved (optional)<input name="initial" type="number" inputmode="decimal" step="0.01" min="0"></label>'}
    <p class="muted hint" style="margin:0">Amounts here only track the goal. They don't change your monthly totals.</p>
    ${actions(!!goal)}`,
  async (fd, action) => {
    const base = { ...g, name: fd.get('name').trim(), target: parseFloat(fd.get('target')), by: fd.get('by') || '', investmentId: fd.get('investmentId') || null };
    if (action === 'delete') {
      if (!confirm(`Delete the goal "${goal.name}"?`)) return false;
      await drop('goals', goal.id);
      toast('Goal deleted');
    } else if (action === 'add-saving' || action.startsWith('rm:')) {
      const amount = parseFloat(fd.get('sAmount'));
      if (action === 'add-saving' && !amount) throw new Error('Enter an amount');
      const saved = action === 'add-saving' ? [...(g.saved || []), { id: db.uid(), date: fd.get('sDate') || todayISO(), amount }] : g.saved.filter(c => c.id !== action.slice(3));
      const rec = await save('goals', { ...base, saved });
      render();
      goalDialog(rec);
      return false;
    } else {
      if (!base.name) throw new Error('Give the goal a name');
      if (!(base.target > 0)) throw new Error('Enter a target above zero');
      const initial = parseFloat(fd.get('initial'));
      if (!goal && initial > 0) base.saved = [{ id: db.uid(), date: todayISO(), amount: initial }];
      await save('goals', base);
      toast(goal ? 'Saved' : 'Goal added');
    }
    render();
  });
}

function debtDialog(debt) {
  const x = debt || { direction: 'lent', date: todayISO(), repaid: [] };
  const paid = [...(x.repaid || [])].sort(byDateDesc);
  const left = debt ? debtLeft(debt) : 0;
  openDialog(`
    <h3>${debt ? `${esc(debt.person)}` : 'Money lent or borrowed'}</h3>
    <div class="seg">${[['lent', 'I lent'], ['borrowed', 'I borrowed']].map(([v, l]) => `<label><input type="radio" name="direction" value="${v}" ${x.direction === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
    <label class="field">Person<input name="person" required maxlength="60" value="${esc(x.person || '')}" ${debt ? '' : 'autofocus'}></label>
    <div class="two">
      <label class="field">Amount<input name="amount" type="number" inputmode="decimal" step="0.01" min="0.01" required value="${x.amount ?? ''}"></label>
      <label class="field">On<input name="date" type="date" required value="${x.date}"></label>
    </div>
    <label class="field">To be returned by (optional)<input name="due" type="date" value="${x.due || ''}"></label>
    <label class="field">Note (optional)<input name="note" maxlength="120" value="${esc(x.note || '')}"></label>
    ${debt ? `
      <div class="section-head" style="margin:6px 0 0"><b>Paid back</b><span class="muted">${left > 0.005 ? `${money(left)} left` : 'Settled'}</span></div>
      <div class="inline-form" style="margin-top:0">
        <input class="inline-input" name="pAmount" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="Amount">
        <input class="inline-input" name="pDate" type="date" value="${todayISO()}">
        <button class="btn" value="repay" formnovalidate>Add</button>
      </div>
      ${left > 0.005 ? `<button class="btn" value="settle" formnovalidate>Mark fully paid back (${money(left)})</button>` : ''}
      <div style="max-height:140px;overflow:auto">${paid.map(p => `<div class="row static" style="padding:8px 4px"><div class="main meta">${fmtDate(p.date)}</div><div class="amt">${money(p.amount)}</div><button class="btn small" value="rm:${p.id}" formnovalidate aria-label="Remove">×</button></div>`).join('')}</div>` : ''}
    ${actions(!!debt)}`,
  async (fd, action) => {
    const base = { ...x, direction: fd.get('direction'), person: fd.get('person').trim(), amount: parseFloat(fd.get('amount')), date: fd.get('date'), due: fd.get('due') || '', note: fd.get('note').trim() };
    if (action === 'delete') {
      if (!confirm('Delete this record?')) return false;
      await drop('debts', debt.id);
      toast('Deleted');
    } else if (action === 'repay' || action === 'settle' || action.startsWith('rm:')) {
      let repaid = x.repaid || [];
      if (action === 'repay') {
        const amount = parseFloat(fd.get('pAmount'));
        if (!(amount > 0)) throw new Error('Enter an amount above zero');
        repaid = [...repaid, { id: db.uid(), date: fd.get('pDate') || todayISO(), amount }];
      } else if (action === 'settle') repaid = [...repaid, { id: db.uid(), date: todayISO(), amount: left }];
      else repaid = repaid.filter(p => p.id !== action.slice(3));
      const rec = await save('debts', { ...base, repaid });
      render();
      if (action === 'settle') { toast(`Settled with ${rec.person}`); return; }
      debtDialog(rec);
      return false;
    } else {
      if (!base.person) throw new Error('Who is it with?');
      if (!(base.amount > 0)) throw new Error('Enter an amount above zero');
      await save('debts', base);
      toast('Saved');
    }
    render();
  });
}

function loanDialog(loan) {
  const l = loan || { kind: 'home', start: todayISO().slice(0, 7), emiDay: 5, prepay: [] };
  const now = loan ? loanNow(loan) : null;
  const years = now ? [...now.rows.reduce((m, r) => { const y = r.month.slice(0, 4); const a = m.get(y) || { interest: 0, principal: 0, balance: 0 }; a.interest += r.interest; a.principal += r.principal; a.balance = r.balance; return m.set(y, a); }, new Map())] : [];
  openDialog(`
    <h3>${loan ? esc(loan.name) : 'Add a loan'}</h3>
    <div class="two">
      <label class="field">Kind<select name="kind">${Object.entries(LOAN_KIND).map(([k, v]) => `<option value="${k}" ${k === l.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">Name<input name="name" required maxlength="60" value="${esc(l.name || '')}" placeholder="e.g. SBI home loan" ${loan ? '' : 'autofocus'}></label>
    </div>
    <div class="two">
      <label class="field">Loan amount<input name="principal" type="number" inputmode="decimal" min="1" step="1" required value="${l.principal ?? ''}"></label>
      <label class="field">Interest % a year<input name="rate" type="number" inputmode="decimal" min="0" max="60" step="0.01" required value="${l.rate ?? ''}"></label>
    </div>
    <div class="two">
      <label class="field">Tenure in months<input name="months" type="number" inputmode="numeric" min="1" max="480" step="1" required value="${l.months ?? ''}"></label>
      <label class="field">First EMI month<input name="start" type="month" required value="${l.start}"></label>
    </div>
    <label class="field">EMI (optional)<input name="emi" type="number" inputmode="decimal" min="0" step="1" value="${l.emi ?? ''}" placeholder="${now ? Math.round(now.emi) : 'Worked out for you'}"></label>
    ${loan ? `
      <div class="grid loan-stats">${stat('Left to repay', money(now.left), 'spend')}${stat('Interest so far', money(now.interestPaid))}${stat('Ends', esc(monthLabel(now.end, { month: 'short', year: 'numeric' })))}</div>
      <div class="section-head" style="margin:6px 0 0"><b>Part-prepayments</b></div>
      <div class="inline-form" style="margin-top:0">
        <input class="inline-input" name="pAmount" type="number" inputmode="decimal" step="1" min="1" placeholder="Amount">
        <input class="inline-input" name="pDate" type="date" value="${todayISO()}">
        <button class="btn" value="prepay" formnovalidate>Add</button>
      </div>
      ${(l.prepay || []).map(p => `<div class="row static" style="padding:6px 4px"><div class="main meta">${fmtDate(p.date)}</div><div class="amt">${money(p.amount)}</div><button class="btn small" value="rm:${p.id}" formnovalidate aria-label="Remove">×</button></div>`).join('')}
      <details><summary>Year-by-year schedule</summary><table class="table"><thead><tr><th>Year</th><th>Interest</th><th>Principal</th><th>Left</th></tr></thead><tbody>${years.map(([y, a]) => `<tr><td>${y}</td><td>${money(a.interest, true)}</td><td>${money(a.principal, true)}</td><td>${money(a.balance, true)}</td></tr>`).join('')}</tbody></table></details>`
    : `<label class="check"><input type="checkbox" name="remind" checked> Remind me of the EMI each month (in Bills)</label>
       <label class="field">EMI day of month<input name="emiDay" type="number" min="1" max="31" value="${l.emiDay}"></label>`}
    ${actions(!!loan)}`,
  async (fd, action) => {
    const base = { ...l, kind: fd.get('kind'), name: fd.get('name').trim(), principal: parseFloat(fd.get('principal')), rate: parseFloat(fd.get('rate')),
      months: Math.round(Number(fd.get('months'))), start: fd.get('start'), emi: parseFloat(fd.get('emi')) || null };
    if (action === 'delete') {
      if (!confirm(`Delete ${loan.name}?`)) return false;
      await drop('loans', loan.id);
      toast('Loan deleted');
    } else if (action === 'prepay' || action.startsWith('rm:')) {
      const amount = parseFloat(fd.get('pAmount'));
      if (action === 'prepay' && !(amount > 0)) throw new Error('Enter an amount above zero');
      const prepay = action === 'prepay' ? [...(l.prepay || []), { id: db.uid(), date: fd.get('pDate') || todayISO(), amount }] : l.prepay.filter(p => p.id !== action.slice(3));
      const rec = await save('loans', { ...base, prepay });
      render();
      loanDialog(rec);
      return false;
    } else {
      if (!base.name) throw new Error('Give the loan a name');
      if (!(base.principal > 0) || !(base.months > 0) || !(base.rate >= 0)) throw new Error('Fill in the amount, interest and tenure');
      if (base.emi && base.emi <= base.principal * base.rate / 1200) throw new Error('That EMI does not cover the monthly interest');
      const rec = await save('loans', base);
      if (!loan && fd.get('remind')) {
        const cat = state.categories.find(c => c.kind === 'expense' && /emi/i.test(c.name));
        // Reminders start from the next EMI date; past EMIs are assumed paid.
        const day = Math.min(31, Math.max(1, Number(fd.get('emiDay')) || 5));
        const today = todayISO(), lastDue = dueDate({ day }, today.slice(0, 7)) <= today ? today.slice(0, 7) : shiftMonth(today.slice(0, 7), -1);
        await save('recurring', { name: `${rec.name} EMI`, type: 'expense', amount: Math.round(rec.emi || emi(rec.principal, rec.rate, rec.months)), categoryId: cat?.id || catsOf('expense')[0]?.id,
          day, every: 1, start: rec.start, mode: 'remind', method: 'bank', doneThrough: lastDue < rec.start ? '' : lastDue });
      }
      toast(loan ? 'Saved' : 'Loan added');
    }
    render();
  });
}

function policyDialog(pol) {
  const p = pol || { kind: 'health', every: 12 };
  openDialog(`
    <h3>${pol ? esc(pol.name) : 'Add insurance or a fixed deposit'}</h3>
    <label class="field">Kind<select name="kind">${Object.entries(POLICY_KIND).map(([k, v]) => `<option value="${k}" ${k === p.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <div class="two">
      <label class="field">Name<input name="name" required maxlength="60" value="${esc(p.name || '')}" placeholder="e.g. Family health cover" ${pol ? '' : 'autofocus'}></label>
      <label class="field">Insurer or bank<input name="provider" maxlength="60" value="${esc(p.provider || '')}"></label>
    </div>
    <label class="field">Policy or account number (optional)<input name="number" maxlength="40" value="${esc(p.number || '')}"></label>
    <div class="two">
      <label class="field" id="p-amt">Premium<input name="premium" type="number" inputmode="decimal" min="0" step="1" value="${p.premium ?? ''}"></label>
      <label class="field" id="p-cover">Sum insured<input name="cover" type="number" inputmode="decimal" min="0" step="1" value="${p.cover ?? p.maturity ?? ''}"></label>
    </div>
    <div class="two">
      <label class="field" id="p-every">Premium paid<select name="every">${[[12, 'Yearly'], [6, 'Half-yearly'], [3, 'Quarterly'], [1, 'Monthly']].map(([k, v]) => `<option value="${k}" ${Number(p.every) === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field" id="p-next">Next premium due<input name="next" type="date" value="${p.next || ''}"></label>
    </div>
    <label class="field">Note (optional)<input name="note" maxlength="120" value="${esc(p.note || '')}"></label>
    ${actions(!!pol)}`,
  async (fd, action) => {
    if (action === 'delete') {
      if (!confirm(`Delete ${pol.name}?`)) return false;
      await drop('policies', pol.id);
      toast('Deleted');
    } else {
      const kind = fd.get('kind'), fdep = kind === 'fd';
      const amount = parseFloat(fd.get('premium')) || 0, second = parseFloat(fd.get('cover')) || 0;
      if (!fd.get('name').trim()) throw new Error('Give it a name');
      await save('policies', { ...p, kind, name: fd.get('name').trim(), provider: fd.get('provider').trim(), number: fd.get('number').trim(), premium: amount,
        cover: fdep ? 0 : second, maturity: fdep ? second : 0, every: Number(fd.get('every')), next: fd.get('next') || '', note: fd.get('note').trim() });
      toast('Saved');
    }
    render();
  },
  form => {
    const sync = () => {
      const fdep = form.querySelector('select[name=kind]').value === 'fd';
      form.querySelector('#p-amt').firstChild.textContent = fdep ? 'Amount deposited' : 'Premium';
      form.querySelector('#p-cover').firstChild.textContent = fdep ? 'Maturity amount' : 'Sum insured';
      form.querySelector('#p-next').firstChild.textContent = fdep ? 'Matures on' : 'Next premium due';
      form.querySelector('#p-every').hidden = fdep;
    };
    form.querySelector('select[name=kind]').addEventListener('change', sync);
    sync();
  });
}

function familyBudgetDialog(b) {
  const x = b || {};
  const names = ['all', ...catsOf('expense').filter(c => !parentOf(c.id)).map(c => c.name)];
  openDialog(`
    <h3>${b ? 'Edit family budget' : 'New family budget'}</h3>
    <label class="field">For<select name="category">${names.map(n => `<option value="${esc(n)}" ${n === x.category ? 'selected' : ''}>${n === 'all' ? 'All family spending' : esc(n)}</option>`).join('')}</select></label>
    ${amountField(x.amount ?? '', 'Monthly limit for the whole family')}
    ${actions(!!b)}`,
  async (fd, action) => {
    if (action === 'delete') { await dropShared('budgets', b); toast('Family budget removed'); return; }
    const amount = parseFloat(fd.get('amount'));
    if (!(amount > 0)) throw new Error('Enter a limit above zero');
    await saveShared('budgets', { ...x, category: fd.get('category'), amount });
    toast('Family budget saved');
  });
}

function familyGoalDialog(goal) {
  const g = goal || { saved: [] };
  const me = auth.current();
  openDialog(`
    <h3>${goal ? esc(goal.name) : 'New family goal'}</h3>
    ${canEditShared() ? `
      <label class="field">Goal<input name="name" required maxlength="60" value="${esc(g.name || '')}" ${goal ? '' : 'autofocus'}></label>
      <div class="two">
        <label class="field">Target amount<input name="target" type="number" inputmode="decimal" min="1" step="1" required value="${g.target ?? ''}"></label>
        <label class="field">Reach it by<input name="by" type="month" value="${g.by || ''}"></label>
      </div>` : ''}
    ${goal && canEditShared() ? `
      <div class="section-head" style="margin:6px 0 0"><b>Add what you put aside</b></div>
      <div class="inline-form" style="margin-top:0"><input class="inline-input" name="sAmount" type="number" inputmode="decimal" step="1" placeholder="Amount"><button class="btn" value="add-saving" formnovalidate>Add</button></div>` : ''}
    ${goal ? `<div style="max-height:180px;overflow:auto">${[...(g.saved || [])].sort(byDateDesc).map(c => `<div class="row static" style="padding:8px 4px"><div class="main meta">${esc(c.name)} · ${fmtDate(c.date)}</div><div class="amt income">${money(c.amount)}</div>${c.uid === me.uid ? `<button class="btn small" value="rm:${c.id}" formnovalidate aria-label="Remove">×</button>` : ''}</div>`).join('') || '<div class="empty">Nothing added yet.</div>'}</div>` : ''}
    ${canEditShared() ? actions(!!goal) : '<div class="dialog-actions"><div class="right"><button class="btn" value="cancel" formnovalidate>Close</button></div></div>'}`,
  async (fd, action) => {
    if (action === 'delete') { if (!confirm(`Delete the family goal "${goal.name}"?`)) return false; await dropShared('goals', goal); toast('Goal deleted'); return; }
    const base = { ...g, name: fd.get('name').trim(), target: parseFloat(fd.get('target')), by: fd.get('by') || '' };
    if (action === 'add-saving' || action.startsWith('rm:')) {
      const amount = parseFloat(fd.get('sAmount'));
      if (action === 'add-saving' && !amount) throw new Error('Enter an amount');
      const saved = action === 'add-saving' ? [...(g.saved || []), { id: db.uid(), date: todayISO(), amount, uid: me.uid, name: me.name }] : g.saved.filter(c => c.id !== action.slice(3));
      const rec = await saveShared('goals', { ...base, saved });
      familyGoalDialog(rec);
      return false;
    }
    if (!base.name || !(base.target > 0)) throw new Error('Give the goal a name and a target');
    await saveShared('goals', base);
    toast(goal ? 'Saved' : 'Family goal added');
  });
}

function splitDialog(split) {
  const me = auth.current().uid;
  const people = state.shared.people;
  const s = split || { date: todayISO(), paidBy: me, shares: Object.fromEntries(people.map(p => [p.uid, 0])) };
  if (split?.settle) {
    openDialog(`<h3>Settle-up</h3><p>${esc(personName(s.paidBy))} paid ${esc(personName(Object.keys(s.shares)[0]))} ${money(s.amount)} on ${fmtDate(s.date)}.</p>
      ${canEditShared() ? actions(true).replace('<button class="btn primary" value="save">Save</button>', '') : ''}`,
    async (fd, action) => { if (action === 'delete') { await dropShared('splits', split); toast('Removed'); } });
    return;
  }
  openDialog(`
    <h3>${split ? 'Shared expense' : 'Split an expense'}</h3>
    <label class="field">What for<input name="desc" required maxlength="60" value="${esc(s.desc || '')}" placeholder="e.g. Dinner out" ${split ? '' : 'autofocus'}></label>
    <div class="two">
      ${amountField(s.amount ?? '', 'Amount').replace(' autofocus', '')}
      <label class="field">Date<input name="date" type="date" required value="${s.date}"></label>
    </div>
    <label class="field">Paid by<select name="paidBy">${people.map(p => `<option value="${p.uid}" ${p.uid === s.paidBy ? 'selected' : ''}>${esc(p.name)}${p.uid === me ? ' (you)' : ''}</option>`).join('')}</select></label>
    <fieldset class="field split-who"><legend>Split equally between</legend>${people.map(p => `<label class="check"><input type="checkbox" name="who" value="${p.uid}" ${s.shares && p.uid in s.shares ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</fieldset>
    ${split ? '' : '<label class="check"><input type="checkbox" name="mine" checked> Add my share to my own spending</label>'}
    ${canEditShared() ? actions(!!split) : ''}`,
  async (fd, action) => {
    if (action === 'delete') { if (!confirm('Delete this shared expense?')) return false; await dropShared('splits', split); toast('Deleted'); return; }
    const amount = parseFloat(fd.get('amount'));
    const who = fd.getAll('who');
    if (!fd.get('desc').trim()) throw new Error('What was it for?');
    if (!(amount > 0)) throw new Error('Enter an amount above zero');
    if (!who.length) throw new Error('Pick who shares it');
    const each = Math.round((amount / who.length) * 100) / 100;
    const shares = Object.fromEntries(who.map((uid, i) => [uid, i === 0 ? Math.round((amount - each * (who.length - 1)) * 100) / 100 : each]));
    await saveShared('splits', { ...s, desc: fd.get('desc').trim(), amount, date: fd.get('date'), paidBy: fd.get('paidBy'), shares });
    if (!split && fd.get('mine') && shares[me]) await save('entries', { type: 'expense', amount: shares[me], categoryId: catsOf('expense')[0]?.id, method: lastMethod(), date: fd.get('date'), note: `${fd.get('desc').trim()} (my share)`, tags: ['shared'] });
    toast(split ? 'Saved' : 'Split added');
    render();
  });
}

function settleDialog() {
  const me = auth.current().uid, bal = splitBalances();
  const owed = state.shared.people.filter(p => p.uid !== me && (bal[p.uid] || 0) > 0.5);
  if (!owed.length) return toast('No one is waiting for money from you');
  openDialog(`
    <h3>Settle up</h3>
    <label class="field">You paid<select name="to">${owed.map(p => `<option value="${p.uid}">${esc(p.name)} (gets back ${money(bal[p.uid])})</option>`).join('')}</select></label>
    ${amountField(Math.round(Math.min(-bal[me], bal[owed[0].uid]) * 100) / 100, 'Amount')}
    ${actions(false)}`,
  async fd => {
    const amount = parseFloat(fd.get('amount'));
    if (!(amount > 0)) throw new Error('Enter an amount above zero');
    await saveShared('splits', { settle: true, desc: 'Settle-up', amount, date: todayISO(), paidBy: me, shares: { [fd.get('to')]: amount } });
    toast('Settled up');
  });
}

function investmentDialog(inv) {
  const i = inv || { contributions: [] };
  const contribs = [...(i.contributions || [])].sort(byDateDesc);
  openDialog(`
    <h3>${inv ? esc(inv.name) : 'Add investment'}</h3>
    <label class="field">Name<input name="name" required maxlength="60" value="${esc(i.name || '')}" placeholder="e.g. Nifty 50 index fund" ${inv ? '' : 'autofocus'}></label>
    <label class="field">Type<select name="categoryId">${catsOf('investment').map(c => `<option value="${c.id}" ${c.id === i.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <div class="two">
      <label class="field">Asset class<select name="assetClass">${Object.entries(ASSET).map(([k, l]) => `<option value="${k}" ${k === (inv ? assetClassOf(i) : i.assetClass) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Tax saving<select name="tax"><option value="">None</option><option value="80C" ${i.tax === '80C' ? 'selected' : ''}>80C (ELSS, PPF, EPF…)</option><option value="nps" ${i.tax === 'nps' ? 'selected' : ''}>NPS, 80CCD(1B)</option></select></label>
    </div>
    <details class="fund" ${i.schemeCode ? 'open' : ''}><summary>Mutual fund? Update its value from the daily NAV</summary>
      <div class="inline-form"><input class="inline-input" name="fundQuery" placeholder="Fund name, e.g. parag parikh flexi"><button class="btn" value="fund-search" formnovalidate>Find</button></div>
      <select class="inline-input" name="schemeCode" style="margin-top:8px"><option value="">Not linked</option>${i.schemeCode ? `<option value="${esc(i.schemeCode)}" selected>${esc(i.schemeName || i.schemeCode)}</option>` : ''}</select>
      <label class="field" style="margin-top:8px">Units held<input name="units" type="number" inputmode="decimal" step="0.001" min="0" value="${i.units ?? ''}" placeholder="From your fund statement"></label>
      ${i.nav ? `<p class="muted hint" style="margin:6px 0 0">NAV ${money(i.nav)} on ${esc(fmtDate(i.navDate))}. Updated once a day when you open the app.</p>` : ''}
    </details>
    ${inv ? '' : `<label class="field">Amount invested now (optional)<input name="initial" type="number" inputmode="decimal" step="0.01" min="0"></label>
    <label class="field">Date<input name="date" type="date" value="${defaultDate()}"></label>`}
    <label class="field">Current value (optional)<input name="currentValue" type="number" inputmode="decimal" step="0.01" min="0" value="${i.currentValue ?? ''}" placeholder="Leave blank to use amount invested"></label>
    ${inv ? `
      <div class="section-head" style="margin:6px 0 0"><b>Money in and out</b><span class="muted">${money(investedTotal(i))} put in, after withdrawals</span></div>
      <div class="inline-form money-move" style="margin-top:0">
        <input class="inline-input" name="cAmount" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="Amount">
        <input class="inline-input" name="cDate" type="date" value="${defaultDate()}">
        <button class="btn" value="contribute" formnovalidate>Add</button>
        <button class="btn" value="withdraw" formnovalidate>Withdraw</button>
      </div>
      <div style="max-height:180px;overflow:auto">${contribs.map(c => `<div class="row" style="padding:8px 4px;cursor:default">
        <div class="main meta">${fmtDate(c.date)} ${c.date.slice(0, 4)}</div><div class="amt ${c.amount < 0 ? 'spend' : 'invest'}">${c.amount < 0 ? `Withdrawn ${money(-c.amount)}` : money(c.amount)}</div>
        <button class="btn small" value="rm:${c.id}" formnovalidate aria-label="Remove">×</button></div>`).join('') || '<div class="empty">No contributions yet.</div>'}</div>` : ''}
    <label class="field">Note (optional)<input name="note" maxlength="120" value="${esc(i.note || '')}"></label>
    ${actions(!!inv)}`,
  async (fd, action) => {
    const cv = fd.get('currentValue');
    const sel = $('#dialog-form select[name=schemeCode]');
    const units = parseFloat(fd.get('units'));
    const base = { ...i, name: fd.get('name').trim(), categoryId: fd.get('categoryId'), currentValue: cv === '' ? null : parseFloat(cv), note: fd.get('note').trim(),
      assetClass: fd.get('assetClass'), tax: fd.get('tax'), schemeCode: fd.get('schemeCode') || '', schemeName: sel.value ? sel.selectedOptions[0].textContent : '', units: units > 0 ? units : null };
    if (action === 'fund-search') {
      const q = String(fd.get('fundQuery')).trim();
      if (q.length < 3) throw new Error('Type at least 3 letters of the fund name');
      const found = await getJSON(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
      sel.innerHTML = '<option value="">Not linked</option>' + (found || []).slice(0, 50).map(f => `<option value="${f.schemeCode}">${esc(f.schemeName)}</option>`).join('');
      if (found?.length) sel.selectedIndex = 1;
      toast(found?.length ? `${found.length} funds found. Pick yours from the list.` : 'No funds found');
      return false;
    }
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
    } else if (action === 'withdraw') {
      // Stored as a negative contribution, so totals, this month's figures and returns all net it off.
      const amount = parseFloat(fd.get('cAmount'));
      if (!(amount > 0)) throw new Error('Enter an amount above zero');
      const have = base.currentValue ?? investedTotal(i);
      if (amount > have + 0.005 && !confirm(`That's more than the ${money(have)} this holding is worth. Withdraw anyway?`)) return false;
      const saved = await save('investments', { ...base, currentValue: base.currentValue == null ? null : Math.max(0, base.currentValue - amount),
        contributions: [...(i.contributions || []), { id: db.uid(), date: fd.get('cDate') || defaultDate(), amount: -amount }] });
      toast(saved.schemeCode ? `Withdrew ${money(amount)}. Also update Units held for the new value.` : `Withdrew ${money(amount)}`);
      render();
      investmentDialog(saved);
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
      const rec = await save('investments', base);
      toast(inv ? 'Saved' : 'Investment added');
      if (rec.schemeCode && rec.units > 0 && (rec.schemeCode !== i.schemeCode || rec.units !== i.units || !rec.nav)) refreshNav([rec]);
    }
    render();
  });
}

// ---------- events ----------

document.addEventListener('click', async e => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    if (tabBtn.dataset.plan) state.planView = tabBtn.dataset.plan;
    location.hash = state.tab;
    window.scrollTo(0, 0);
    if (state.tab === 'family') {
      // Until the new rules are in place, admins still get the members view.
      if (state.sharedError && canSeeAll() && state.familyView === 'shared') state.familyView = 'members';
      state.familyMember = null; if (!state.family && canSeeAll()) loadFamily(); if (Date.now() - sharedLoadedAt > 60_000) loadShared(); }
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
      else if (state.tab === 'plan') ({ budgets: budgetDialog, bills: recurringDialog, goals: goalDialog, lending: debtDialog, loans: loanDialog, policies: policyDialog })[state.planView]();
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
      try { await saveFile(`finance-backup-${todayISO()}.json`, blob); toast('Backup ready'); } catch { toast('Could not save the file'); }
      break;
    }
    case 'export-xlsx':
    case 'export-csv': {
      const range = exportRange($('#export-range').value);
      const rows = exportRows(range);
      const xlsx = el.dataset.action === 'export-xlsx';
      const blob = xlsx
        ? toXLSX([{ name: 'Entries', rows: rows.entries }, { name: 'Investments', rows: rows.contributions }, { name: 'Holdings', rows: rows.holdings }, { name: 'Monthly summary', rows: rows.summary }])
        : new Blob([toCSV(rows.entries)], { type: 'text/csv' });
      try { await saveFile(`my-finances-${range.file}.${xlsx ? 'xlsx' : 'csv'}`, blob); toast('File ready'); } catch { toast('Could not save the file'); }
      break;
    }
    case 'subview': state[el.dataset.group + 'View'] = id; render(); break;
    case 'add-loan': loanDialog(); break;
    case 'edit-loan': loanDialog(state.loans.find(x => x.id === id)); break;
    case 'add-policy': policyDialog(); break;
    case 'edit-policy': policyDialog(state.policies.find(x => x.id === id)); break;
    case 'policy-paid': {
      const p = state.policies.find(x => x.id === id);
      if (p.premium > 0) await save('entries', { type: 'expense', amount: p.premium, categoryId: await insuranceCategory(), method: lastMethod(), date: todayISO(), note: `${p.name} premium`, policyId: p.id });
      await save('policies', { ...p, next: p.next ? addMonthsISO(p.next, Number(p.every) || 12) : '' });
      toast(`${p.name} premium recorded`);
      render();
      break;
    }
    case 'policy-close': {
      const p = state.policies.find(x => x.id === id);
      await save('policies', { ...p, closed: true });
      toast(`${p.name} marked as matured`);
      render();
      break;
    }
    case 'refresh-nav': el.disabled = true; await refreshNav(); break;
    case 'open-summary': state.tab = 'reports'; state.reportView = 'summary'; state.month = shiftMonth(state.month, -1); render(); window.scrollTo(0, 0); break;
    case 'tax-year': state.taxYear += Number(id); render(); break;
    case 'add-goal': goalDialog(); break;
    case 'edit-goal': goalDialog(state.goals.find(x => x.id === id)); break;
    case 'add-debt': debtDialog(); break;
    case 'edit-debt': debtDialog(state.debts.find(x => x.id === id)); break;
    case 'quick-template': {
      const q = state.templates.find(x => x.id === id);
      const rec = await save('entries', { type: q.type, amount: q.amount, categoryId: q.categoryId, method: q.method || '', note: q.note || '', tags: q.tags || [], date: todayISO() });
      state.month = todayISO().slice(0, 7);
      render();
      toast(spendingAlert(rec) || `Added ${q.name} ${money(q.amount)}`, { label: 'Undo', async run() { await drop('entries', rec.id); render(); toast('Removed'); } });
      break;
    }
    case 'delete-template': await drop('templates', id); render(); break;
    case 'add-budget': budgetDialog(); break;
    case 'edit-budget': budgetDialog(state.budgets.find(x => x.id === id)); break;
    case 'add-recurring': recurringDialog(); break;
    case 'edit-recurring': recurringDialog(state.recurring.find(x => x.id === id)); break;
    case 'pay-bill':
    case 'skip-bill': {
      const r = state.recurring.find(x => x.id === id);
      const { month } = nextDue(r);
      if (el.dataset.action === 'pay-bill') await postRecurring(r, month);
      await save('recurring', { ...r, doneThrough: month });
      toast(el.dataset.action === 'pay-bill' ? `${r.name} recorded` : `${r.name} skipped this time`);
      render();
      break;
    }
    case 'search-clear': state.search = {}; render(); break;
    case 'year-step': state.reportYear += Number(id); render(); break;
    case 'pin-set': pinDialog('set'); break;
    case 'pin-change': pinDialog('change'); break;
    case 'pin-off': pinDialog('off'); break;
    case 'bio-unlock': tryBiometric(); break;
    case 'forgot-pin':
      if (!confirm('To reset your PIN, sign in again with your email and password. Sign out now?')) return;
      try { await cloud.syncNow(); } catch {}
      auth.logout();
      lock.clear();
      lock.unlock();
      state.family = null;
      signedOut();
      break;
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
    case 'shared-reload': state.sharedError = ''; render(); loadShared(); break;
    case 'add-fbudget': familyBudgetDialog(); break;
    case 'edit-fbudget': familyBudgetDialog(live(state.shared.budgets).find(x => x.id === id)); break;
    case 'add-fgoal': familyGoalDialog(); break;
    case 'edit-fgoal': familyGoalDialog(live(state.shared.goals).find(x => x.id === id)); break;
    case 'add-split': splitDialog(); break;
    case 'edit-split': splitDialog(live(state.shared.splits).find(x => x.id === id)); break;
    case 'settle-up': settleDialog(); break;
    case 'view-receipt': {
      toast('Opening the receipt…');
      try {
        const img = await cloud.getReceipt(id, el.dataset.uid || undefined);
        if (!img?.startsWith('data:image/')) return toast('Receipt not found');
        openDialog(`<h3>Receipt</h3><img class="receipt" src="${img}" alt="Receipt photo"><div class="dialog-actions"><div class="right"><button class="btn" value="cancel" formnovalidate>Close</button></div></div>`, async () => {});
      } catch (err) { toast(err.message); }
      break;
    }
    case 'sign-out': {
      el.disabled = true;
      let synced = true;
      // Don't let a stuck sync hold sign-out: wait at most 15 seconds.
      try { await Promise.race([cloud.syncNow(), new Promise((_, no) => setTimeout(no, 15000))]); } catch { synced = false; }
      if (!synced && !confirm('Some changes have not reached the cloud yet (no internet?). If you sign out now they stay only on this device. Sign out anyway?')) { el.disabled = false; return; }
      auth.logout();
      lock.clear();
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
  const unlockForm = e.target.closest('[data-form="unlock"]');
  if (unlockForm) {
    e.preventDefault();
    const input = unlockForm.querySelector('[name=pin]');
    if (Date.now() < (unlockForm.waitUntil || 0)) return toast('Too many tries. Wait 30 seconds.');
    if (await lock.check(input.value)) { lock.unlock(); render(); return; }
    unlockTries++;
    input.value = '';
    if (unlockTries % 5 === 0) unlockForm.waitUntil = Date.now() + 30_000;
    toast(unlockTries % 5 === 0 ? 'Too many tries. Wait 30 seconds.' : 'Wrong PIN');
    return;
  }
  if (e.target.closest('[data-form="search"], [data-form="tax"]')) { e.preventDefault(); return; }
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
  const fd = new FormData(form);
  const name = fd.get('name').trim();
  if (!name) return;
  await save('categories', { kind: form.dataset.kind, name, ...(fd.get('parentId') ? { parentId: fd.get('parentId') } : {}) });
  render();
});

let unlockTries = 0;
let taxSaveTimer;

document.addEventListener('input', e => {
  const searchForm = e.target.closest('[data-form="search"]');
  if (searchForm) {
    state.search = Object.fromEntries(new FormData(searchForm));
    $('#search-results').innerHTML = searchResults();
    i18n.translate($('#search-results'));
  }
  const taxForm = e.target.closest('[data-form="tax"]');
  if (taxForm) {
    const fy = Number(taxForm.dataset.fy);
    state.taxInputs = { ...state.taxInputs, years: { ...state.taxInputs.years, [fy]: Object.fromEntries(new FormData(taxForm)) } };
    $('#tax-results').innerHTML = taxResultHtml(fy);
    i18n.translate($('#tax-results'));
    clearTimeout(taxSaveTimer);
    taxSaveTimer = setTimeout(async () => { state.taxInputs = await db.put('settings', state.taxInputs); scheduleSync(); }, 800);
  }
  // Unlock as soon as the PIN is complete.
  if (e.target.name === 'pin' && e.target.closest('[data-form="unlock"]') && e.target.value.length === lock.pinLength()) {
    e.target.form.requestSubmit();
  }
});

document.addEventListener('change', async e => {
  if (e.target.name === 'fy') { state.fy = e.target.value === 'fy'; state.reportYear = null; render(); }
  if (e.target.id === 'trend-cat') { state.trendCat = e.target.value; render(); }
  if (e.target.id === 'idle-select') { try { localStorage.setItem('idleSignout', e.target.value); } catch {} markActive(); toast('Saved'); }
  if (e.target.id === 'lang-select') { i18n.setLang(e.target.value); location.reload(); }
  if (e.target.classList.contains('role-select')) {
    try {
      await cloud.setRole(e.target.dataset.uid, e.target.value || 'none');
      state.roles[e.target.dataset.uid] = e.target.value;
      toast('Role saved');
    } catch (err) { toast(err.status === 403 ? RULES_MSG : err.message); }
  }
  if (e.target.id === 'bio-toggle') lock.setBiometric(e.target.checked);
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

if (TABS.includes(location.hash.slice(1))) state.tab = location.hash.slice(1);
lock.biometricAvailable().then(ok => { state.bioAvailable = ok; if (ok && state.tab === 'settings') render(); });
const shortcut = new URLSearchParams(location.search).get('add');
checkIdle();
markActive();
['click', 'keydown', 'touchstart'].forEach(t => document.addEventListener(t, markActive, { passive: true }));
setInterval(checkIdle, 60_000);
if (auth.current()) {
  await enterAccount();
  if (state.tab === 'family') loadFamily();
  if (TYPE_LABEL[shortcut] && !lock.isLocked()) { history.replaceState(null, '', location.pathname + location.hash); entryDialog({ type: shortcut, date: todayISO() }); }
} else {
  render();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') return lock.onHidden();
  checkIdle();
  if (!auth.current()) return;
  if (lock.onVisible()) render();
  runSync(false);
  if (Date.now() - sharedLoadedAt > 5 * 60_000) loadShared();
});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
