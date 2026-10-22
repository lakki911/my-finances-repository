// Local storage layer (IndexedDB), one database per signed-in person.
// Every record carries `id`, `updatedAt` and `deleted` so sync can merge:
// whichever copy has the newer `updatedAt` wins, and deletes travel as tombstones.

export const LEGACY_DB = 'finance-app'; // the single-user database from before accounts
const DB_VERSION = 2;
// v2 added the planning stores. Every store syncs as its own cloud chunk.
export const STORES = ['entries', 'investments', 'categories', 'settings', 'budgets', 'recurring', 'goals', 'debts', 'loans', 'policies', 'templates'];

let dbName = LEGACY_DB;
let dbPromise;

// Switch to the database of the person who just signed in.
export function useDatabase(uid) {
  const name = `${LEGACY_DB}-${uid}`;
  if (name === dbName) return;
  dbPromise?.then(db => db.close()).catch(() => {});
  dbName = name;
  dbPromise = null;
}

function openNamed(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
  }));
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// All live (non-deleted) records in a store.
export async function all(store) {
  const rows = await run(store, 'readonly', s => s.getAll());
  return rows.filter(r => !r.deleted);
}

// `seed: true` marks built-in defaults as oldest, so synced data always wins over them.
export function put(store, record, { seed = false } = {}) {
  const rec = { ...record, id: record.id || uid(), updatedAt: seed ? new Date(0).toISOString() : new Date().toISOString(), deleted: false };
  return run(store, 'readwrite', s => s.put(rec)).then(() => rec);
}

// One record by id, including a deleted one (its tombstone).
export function get(store, id) {
  return run(store, 'readonly', s => s.get(id));
}

// Soft delete: keep a tombstone so a future sync can propagate the delete.
export async function remove(store, id) {
  const rec = await run(store, 'readonly', s => s.get(id));
  if (!rec) return;
  await run(store, 'readwrite', s => s.put({ ...rec, deleted: true, updatedAt: new Date().toISOString() }));
}

export async function exportAll() {
  const data = { app: 'finance-app', version: 1, exportedAt: new Date().toISOString() };
  for (const name of STORES) data[name] = await run(name, 'readonly', s => s.getAll());
  return data;
}

// Merge a backup into the local database; the newer `updatedAt` wins per record.
export async function importAll(data) {
  if (!data || data.app !== 'finance-app') throw new Error('This file is not a finance app backup.');
  let count = 0;
  for (const name of STORES) {
    const incoming = Array.isArray(data[name]) ? data[name] : [];
    const existing = new Map((await run(name, 'readonly', s => s.getAll())).map(r => [r.id, r]));
    const toWrite = incoming.filter(r => r && r.id && (!existing.has(r.id) || (r.updatedAt || '') > (existing.get(r.id).updatedAt || '')));
    if (toWrite.length) {
      await run(name, 'readwrite', s => { toWrite.forEach(r => s.put(r)); });
      count += toWrite.length;
    }
  }
  return count;
}

export async function wipe() {
  for (const name of STORES) await run(name, 'readwrite', s => s.clear());
}

// Everything in the pre-accounts database, or null if it holds no entries or investments.
export async function readLegacy() {
  const known = indexedDB.databases ? (await indexedDB.databases()).some(d => d.name === LEGACY_DB) : true;
  if (!known) return null;
  const db = await openNamed(LEGACY_DB);
  const read = store => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const data = { app: 'finance-app', version: 1 };
  for (const store of STORES) data[store] = db.objectStoreNames.contains(store) ? await read(store) : [];
  db.close();
  return data.entries.length || data.investments.length ? data : null;
}
