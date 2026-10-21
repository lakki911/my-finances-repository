// Google Drive sync. The whole database is kept as one JSON file in the app's
// hidden Drive folder (appDataFolder), which only this app can see.
// A sync pulls that file, merges it (newer `updatedAt` wins per record),
// then uploads the merged result.

import * as db from './db.js';
import { GOOGLE_CLIENT_ID } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'finance-data.json';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const isNative = () => !!window.Capacitor?.isNativePlatform?.();

export class NeedsSignIn extends Error {
  constructor() { super('Sign in to Google Drive to sync'); }
}

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem('sync.' + key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem('sync.' + key, JSON.stringify(value)); } catch {} },
  remove(key) { try { localStorage.removeItem('sync.' + key); } catch {} },
};

export const isConfigured = () => !!GOOGLE_CLIENT_ID;
export const isEnabled = () => isConfigured() && store.get('enabled') === true;
export const lastSynced = () => store.get('last');

// ---------- access tokens ----------

let socialLogin;
async function nativePlugin() {
  if (!socialLogin) {
    socialLogin = window.Capacitor.registerPlugin('SocialLogin');
    await socialLogin.initialize({ google: { webClientId: GOOGLE_CLIENT_ID, mode: 'online' } });
  }
  return socialLogin;
}

async function nativeToken(interactive) {
  const plugin = await nativePlugin();
  const res = await plugin.login({
    provider: 'google',
    options: interactive
      ? { scopes: [SCOPE], forceRefreshToken: true }
      : { scopes: [SCOPE], forceRefreshToken: true, style: 'bottom', filterByAuthorizedAccounts: true, autoSelectEnabled: true },
  }).catch(err => { if (interactive) throw err; throw new NeedsSignIn(); });
  const token = res?.result?.accessToken?.token;
  if (!token) throw new NeedsSignIn();
  return token;
}

function loadGoogleScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not reach Google. Check your internet connection.'));
    document.head.appendChild(s);
  });
}

async function webToken(interactive) {
  const saved = store.get('token');
  if (saved && saved.expires > Date.now() + 60_000) return saved.token;
  // A new token needs a Google popup, which browsers only allow after a click.
  if (!interactive) throw new NeedsSignIn();
  await loadGoogleScript();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: r => {
        if (r.error) return reject(new Error(r.error_description || 'Google sign-in failed'));
        store.set('token', { token: r.access_token, expires: Date.now() + r.expires_in * 1000 });
        resolve(r.access_token);
      },
      error_callback: e => reject(new Error(e.type === 'popup_closed' ? 'Sign-in was cancelled' : 'Google sign-in failed')),
    });
    client.requestAccessToken({ prompt: store.get('enabled') ? '' : 'consent' });
  });
}

const getToken = interactive => (isNative() ? nativeToken(interactive) : webToken(interactive));

// ---------- Drive calls ----------

async function drive(token, url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  if (res.status === 401) { store.remove('token'); throw new NeedsSignIn(); }
  if (!res.ok) throw new Error(`Google Drive error (${res.status}). Try again later.`);
  return res;
}

async function findFile(token) {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const res = await drive(token, `${API}?spaces=appDataFolder&q=${q}&fields=files(id)&pageSize=1`);
  return (await res.json()).files?.[0]?.id || null;
}

async function upload(token, fileId, data) {
  if (!fileId) {
    const res = await drive(token, `${API}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' }),
    });
    fileId = (await res.json()).id;
  }
  await drive(token, `${UPLOAD}/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return fileId;
}

// A new device starts with its own copy of the default categories. After the
// first merge, fold same-named categories into one and repoint entries to it.
async function mergeDuplicateCategories(remoteIds) {
  const [cats, entries, investments] = await Promise.all([db.all('categories'), db.all('entries'), db.all('investments')]);
  const used = new Set([...entries, ...investments].map(r => r.categoryId));
  const groups = new Map();
  for (const c of cats) {
    const key = `${c.kind}|${c.name.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = group.find(c => used.has(c.id)) || group.find(c => remoteIds.has(c.id)) || group[0];
    for (const dup of group.filter(c => c !== keep)) {
      for (const r of entries.filter(e => e.categoryId === dup.id)) await db.put('entries', { ...r, categoryId: keep.id });
      for (const r of investments.filter(i => i.categoryId === dup.id)) await db.put('investments', { ...r, categoryId: keep.id });
      await db.remove('categories', dup.id);
    }
  }
}

// ---------- public API ----------

let running = null;

// Returns the number of records that changed locally.
export function syncNow({ interactive = false } = {}) {
  if (!isConfigured()) return Promise.resolve(0);
  // A change made mid-sync is picked up by a second pass once this one ends.
  if (running) return running.catch(() => {}).then(() => syncNow());
  running = (async () => {
    const token = await getToken(interactive);
    let fileId = await findFile(token);
    let changed = 0;
    if (fileId) {
      const remote = await (await drive(token, `${API}/${fileId}?alt=media`)).json();
      changed = await db.importAll(remote);
      await mergeDuplicateCategories(new Set((remote.categories || []).map(c => c.id)));
    }
    await upload(token, fileId, await db.exportAll());
    store.set('enabled', true);
    store.set('last', new Date().toISOString());
    return changed;
  })().finally(() => { running = null; });
  return running;
}

export async function disconnect() {
  store.remove('enabled');
  store.remove('token');
  store.remove('last');
  if (isNative()) await (await nativePlugin()).logout({ provider: 'google' }).catch(() => {});
}
