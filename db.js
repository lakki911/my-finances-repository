// Local storage layer (IndexedDB).
// Every record carries `id`, `updatedAt` and `deleted` so a cloud sync can be
// added later: sync = push records changed since last sync, pull remote ones,
// keep whichever has the newer `updatedAt`.

const DB_NAME = 'finance-app';
const DB_VERSION = 1;
export const STORES = ['entries', 'investments', 'categories', 'settings'];

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
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

export function put(store, record) {
  const rec = { ...record, id: record.id || uid(), updatedAt: new Date().toISOString(), deleted: false };
  return run(store, 'readwrite', s => s.put(rec)).then(() => rec);
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
