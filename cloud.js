// Cloud sync through Firestore's REST API.
// Each person's data lives under users/{uid}/data/{chunk}, where a chunk is
// 'categories', 'investments', 'settings' or 'entries-YYYY'. A chunk document
// holds its records as one JSON string, so a full sync reads only a handful of
// documents. Merging is per record: the newer `updatedAt` wins.
// Who may read what is enforced by Firestore security rules (firestore.rules).

import * as db from './db.js';
import * as auth from './auth.js';
import { FIREBASE } from './config.js';

const base = () => `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents`;

async function request(path, options = {}) {
  const send = async t => {
    try {
      return await fetch(`${base()}/${path}`, { ...options, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...options.headers } });
    } catch {
      throw new Error('Offline. Changes are saved on this device and will sync later.');
    }
  };
  let res = await send(await auth.token());
  if (res.status === 401) res = await send(await auth.token({ force: true }));
  if (res.status === 403) throw new Error('The family database refused access. Check the security rules in Firebase.');
  if (res.status === 404 && options.method !== 'PATCH') return null;
  if (!res.ok) throw new Error(`Sync failed (${res.status}). Try again later.`);
  return res.json();
}

// All documents in a collection, following pagination.
async function list(path) {
  const docs = [];
  let pageToken = '';
  do {
    const page = await request(`${path}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    docs.push(...(page?.documents || []));
    pageToken = page?.nextPageToken || '';
  } while (pageToken);
  return docs;
}

const docId = doc => doc.name.split('/').pop();
const str = v => ({ stringValue: String(v ?? '') });

// Records grouped by chunk name, each chunk as a stable JSON string.
function chunksOf(data) {
  const groups = {};
  const add = (chunk, rec) => (groups[chunk] ||= []).push(rec);
  for (const store of db.STORES) {
    for (const rec of data[store] || []) add(store === 'entries' ? `entries-${String(rec.date || '').slice(0, 4) || 'none'}` : store, rec);
  }
  const out = {};
  for (const [chunk, recs] of Object.entries(groups)) out[chunk] = JSON.stringify(recs.sort((a, b) => (a.id < b.id ? -1 : 1)));
  return out;
}

function fromChunks(docs) {
  const data = { app: 'finance-app', version: 1, entries: [], investments: [], categories: [], settings: [] };
  const raw = {};
  for (const doc of docs) {
    const chunk = docId(doc);
    const json = doc.fields?.json?.stringValue || '[]';
    raw[chunk] = json;
    const store = chunk.startsWith('entries-') ? 'entries' : chunk;
    if (data[store]) data[store].push(...JSON.parse(json));
  }
  return { data, raw };
}

// A new account starts with its own default categories. After merging, fold
// same-named categories into one and repoint entries to it.
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

let running = null;
let profileSaved = false;

// Pull, merge, push. Returns the number of records that changed on this device.
export function syncNow() {
  if (running) return running.catch(() => {}).then(() => syncNow());
  running = (async () => {
    const me = auth.current();
    if (!me) throw new auth.SignedOut();
    if (!profileSaved) {
      await request(`users/${me.uid}`, { method: 'PATCH', body: JSON.stringify({ fields: { name: str(me.name), email: str(me.email) } }) });
      profileSaved = true;
    }
    const { data: remote, raw } = fromChunks(await list(`users/${me.uid}/data`));
    const changed = await db.importAll(remote);
    await mergeDuplicateCategories(new Set(remote.categories.map(c => c.id)));
    const local = chunksOf(await db.exportAll());
    for (const [chunk, json] of Object.entries(local)) {
      if (raw[chunk] === json) continue;
      await request(`users/${me.uid}/data/${chunk}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { json: str(json), updatedAt: { timestampValue: new Date().toISOString() } } }),
      });
    }
    try { localStorage.setItem(`sync.last.${me.uid}`, new Date().toISOString()); } catch {}
    return changed;
  })().finally(() => { running = null; });
  return running;
}

export function lastSynced() {
  try { return localStorage.getItem(`sync.last.${auth.current()?.uid}`); } catch { return null; }
}

// Admin only: every member's profile and data (deleted records removed).
export async function family() {
  const people = await list('users');
  return Promise.all(people.map(async p => {
    const uid = docId(p);
    const { data } = fromChunks(await list(`users/${uid}/data`));
    for (const store of db.STORES) data[store] = data[store].filter(r => !r.deleted);
    return { uid, name: p.fields?.name?.stringValue || 'Unnamed', email: p.fields?.email?.stringValue || '', data };
  }));
}
