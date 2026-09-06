/**
 * A minimal in-memory IndexedDB fake — just enough surface for lib/store.js,
 * so the full on-device brain (ingest -> retrieve -> explain -> permissions ->
 * facts) can be integration-tested in Node with `node --test`.
 *
 * Implements: open/onupgradeneeded, transactions with oncomplete, objectStore
 * put/add/get/getAll/clear/delete, index().openCursor (both directions) and
 * IDBKeyRange.only.
 */

class FakeStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath || null;
    this.rows = new Map();     // key -> value
    this.auto = 0;
  }

  _key(value, explicitKey) {
    if (explicitKey !== undefined) return explicitKey;
    if (this.keyPath) {
      if (value[this.keyPath] !== undefined) return value[this.keyPath];
      this.auto += 1;                       // autoIncrement store (convs, audit)
      value[this.keyPath] = this.auto;
      return this.auto;
    }
    this.auto += 1;
    return this.auto;
  }

  put(value, key) {
    const k = this._key(value, key);
    this.rows.set(k, JSON.parse(JSON.stringify(value)));
    return syncRequest(k);
  }

  add(value, key) { return this.put(value, key); }

  get(key) { return syncRequest(this.rows.has(key) ? this.rows.get(key) : undefined); }

  getAll() { return syncRequest([...this.rows.values()]); }

  clear() { this.rows.clear(); return syncRequest(undefined); }

  delete(key) { this.rows.delete(key); return syncRequest(undefined); }

  index(name) {
    const store = this;
    return {
      openCursor(range, direction) {
        let entries = [...store.rows.entries()];
        if (range && range.only !== undefined) {
          entries = entries.filter(([, value]) => value[name] === range.only);
        }
        entries.sort((a, b) => (a[1][name] > b[1][name] ? 1 : -1));
        if (direction === 'prev') entries.reverse();
        return cursorRequest(store, entries);
      },
    };
  }

  openCursor() {
    return cursorRequest(this, [...this.rows.entries()]);
  }

  createIndex() { /* indexes are computed on the fly */ }
}

function syncRequest(result) {
  const request = { result, onsuccess: null, onerror: null };
  queueMicrotask(() => { if (request.onsuccess) request.onsuccess({ target: request }); });
  return request;
}

function cursorRequest(store, entries) {
  let i = 0;
  const request = { result: null, onsuccess: null, onerror: null };
  const fire = () => { if (request.onsuccess) request.onsuccess({ target: request }); };
  const step = () => {
    if (i >= entries.length) { request.result = null; fire(); return; }
    const [key, value] = entries[i];
    request.result = {
      value,
      primaryKey: key,
      delete() { store.rows.delete(key); },
      continue() { i += 1; queueMicrotask(step); },
    };
    fire();
  };
  queueMicrotask(step);
  return request;
}

class FakeTransaction {
  constructor(db, storeNames) {
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._db = db;
    this._names = Array.isArray(storeNames) ? storeNames : [storeNames];
    queueMicrotask(() => { if (this.oncomplete) this.oncomplete(); });
  }

  objectStore(name) { return this._db._store(name); }
}

class FakeDb {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = {
      contains: (name) => this.stores.has(name),
    };
  }

  _store(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeStore(name, null));
    return this.stores.get(name);
  }

  createObjectStore(name, options) {
    const store = new FakeStore(name, options && options.keyPath);
    this.stores.set(name, store);
    return store;
  }

  transaction(storeNames, mode) { return new FakeTransaction(this, storeNames, mode); }
}

export function installFakeIndexedDb() {
  const dbs = new Map();
  globalThis.indexedDB = {
    open(name, version) {
      const request = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let db = dbs.get(name);
        if (!db) { db = new FakeDb(); dbs.set(name, db); }
        request.result = db;
        if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
  };
  globalThis.IDBKeyRange = { only: (value) => ({ only: value }) };
  return dbs;
}
