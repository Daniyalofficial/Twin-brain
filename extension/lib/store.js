/**
 * IndexedDB outbox + local cache.
 *
 * If the Flask backend is not running (laptop asleep, server stopped, first
 * install), captures are queued here and flushed the moment the backend answers
 * again. Nothing you read is silently dropped, and nothing is sent anywhere
 * except your own local backend.
 */

const DB_NAME = 'twinbrain';
const DB_VERSION = 1;
const QUEUE = 'queue';
const PAGES = 'pages';
const META = 'meta';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE)) {
        const store = db.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('kind', 'kind', { unique: false });
        store.createIndex('at', 'at', { unique: false });
      }
      if (!db.objectStoreNames.contains(PAGES)) {
        const store = db.createObjectStore(PAGES, { keyPath: 'url' });
        store.createIndex('at', 'at', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB open failed'));
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    const done = fn(store);
    if (done && typeof done.then === 'function') {
      done.then((value) => { result = value; }).catch(reject);
    }
    transaction.oncomplete = () => resolve(result !== undefined ? result : (done && done.result));
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('tx aborted'));
  }));
}

// --- outbox ---------------------------------------------------------------

export async function enqueue(kind, payload) {
  const item = { kind, payload, at: Date.now(), tries: 0 };
  return tx(QUEUE, 'readwrite', (store) => store.add(item));
}

export async function queueItems(limit = 50) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const out = [];
    const request = db.transaction(QUEUE, 'readonly').objectStore(QUEUE)
      .index('at').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    request.onerror = () => reject(request.error);
  }));
}

export async function removeQueued(id) {
  return tx(QUEUE, 'readwrite', (store) => store.delete(id));
}

export async function markTried(id) {
  return tx(QUEUE, 'readwrite', (store) => {
    const get = store.get(id);
    get.onsuccess = () => {
      const item = get.result;
      if (item) {
        item.tries = (item.tries || 0) + 1;
        store.put(item);
      }
    };
    return get;
  });
}

export async function queueLength() {
  return openDb().then((db) => new Promise((resolve) => {
    const request = db.transaction(QUEUE, 'readonly').objectStore(QUEUE).count();
    request.onsuccess = () => resolve(request.result || 0);
    request.onerror = () => resolve(0);
  }));
}

export async function clearQueue() {
  return tx(QUEUE, 'readwrite', (store) => store.clear());
}

// --- local page cache (lets the popup answer when the backend is down) -----

export async function cachePage(page) {
  const record = {
    url: page.url,
    title: page.title || page.url,
    domain: page.domain || '',
    at: Date.now(),
    visitedAt: page.visited_at || new Date().toISOString().slice(0, 19),
    dwellSeconds: page.dwell_seconds || 0,
    scrollDepth: page.scroll_depth || 0,
    words: (page.text || '').split(/\s+/).filter(Boolean).length,
    mode: page.mode || 'full',
    excerpt: (page.text || '').slice(0, 400)
  };
  return tx(PAGES, 'readwrite', (store) => store.put(record));
}

export async function recentPages(limit = 30) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const out = [];
    const request = db.transaction(PAGES, 'readonly').objectStore(PAGES)
      .index('at').openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    request.onerror = () => reject(request.error);
  }));
}

export async function forgetCachedUrl(url) {
  return tx(PAGES, 'readwrite', (store) => store.delete(url));
}

export async function clearCachedPages() {
  return tx(PAGES, 'readwrite', (store) => store.clear());
}

// --- misc key/value -------------------------------------------------------

export async function setMeta(key, value) {
  return tx(META, 'readwrite', (store) => store.put({ key, value, at: Date.now() }));
}

export async function getMeta(key, fallback = null) {
  return openDb().then((db) => new Promise((resolve) => {
    const request = db.transaction(META, 'readonly').objectStore(META).get(key);
    request.onsuccess = () => resolve(request.result ? request.result.value : fallback);
    request.onerror = () => resolve(fallback);
  }));
}
