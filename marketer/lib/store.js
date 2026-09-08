/**
 * MarketerTwin store — EVERYTHING lives in one NEW IndexedDB inside Chrome.
 * No server, no localhost: the extension IS the app.
 *
 * MarketerTwin stores:
 *  chats        conversation threads {id, title, createdAt, updatedAt, messages[]}
 *  memories     everything the twin should recall {id, kind, text, topic, at}
 *  facts        extracted facts about YOU {key, value, at, source}
 *  style        your writing-style profile (learned statistics) {key, value}
 *  flows        automation flows: recorded click/write/scroll steps
 *  descriptions saved manual descriptions + hashtag sets
 *  monitors     Facebook group links + check interval + snapshots
 *
 * Engine memory stores (the twin's "large context"):
 *  queue        capture outbox (retries)
 *  pages        local page cache (recent reading)
 *  chunks       retrieval chunks of everything you read/analyzed
 *  interests    derived interest statistics
 *  convs        conversation log (what was asked & answered)
 *  audit        every capture/search/analysis event tail
 *  meta         settings, budgets, misc key/value
 */

const DB_NAME = 'marktertwin';
const DB_VERSION = 2;

const CHATS = 'chats';
const MEMORIES = 'memories';
const FACTS = 'facts';
const STYLE = 'style';
const FLOWS = 'flows';
const DESCRIPTIONS = 'descriptions';
const MONITORS = 'monitors';
const QUEUE = 'queue';
const PAGES = 'pages';
const CHUNKS = 'chunks';
const INTERESTS = 'interests';
const CONVS = 'convs';
const AUDIT = 'audit';
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
      if (!db.objectStoreNames.contains(CHATS)) {
        const s = db.createObjectStore(CHATS, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(MEMORIES)) {
        const s = db.createObjectStore(MEMORIES, { keyPath: 'id', autoIncrement: true });
        s.createIndex('kind', 'kind', { unique: false });
        s.createIndex('at', 'at', { unique: false });
      }
      if (!db.objectStoreNames.contains(FACTS)) db.createObjectStore(FACTS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STYLE)) db.createObjectStore(STYLE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(FLOWS)) db.createObjectStore(FLOWS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DESCRIPTIONS)) db.createObjectStore(DESCRIPTIONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(MONITORS)) db.createObjectStore(MONITORS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(QUEUE)) {
        const s = db.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('kind', 'kind', { unique: false });
        s.createIndex('at', 'at', { unique: false });
      }
      if (!db.objectStoreNames.contains(PAGES)) {
        const s = db.createObjectStore(PAGES, { keyPath: 'url' });
        s.createIndex('at', 'at', { unique: false });
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const s = db.createObjectStore(CHUNKS, { keyPath: 'id' });
        s.createIndex('pageId', 'pageId', { unique: false });
      }
      if (!db.objectStoreNames.contains(INTERESTS)) db.createObjectStore(INTERESTS, { keyPath: 'topic' });
      if (!db.objectStoreNames.contains(CONVS)) {
        const s = db.createObjectStore(CONVS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('at', 'at', { unique: false });
      }
      if (!db.objectStoreNames.contains(AUDIT)) {
        const s = db.createObjectStore(AUDIT, { keyPath: 'id', autoIncrement: true });
        s.createIndex('at', 'at', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
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
    const done = fn(store);
    // Resolve with the request's value once the transaction completes. When
    // fn returns a wrapped promise we adopt it here — this stays correct on
    // real IndexedDB AND on the in-memory test fake, whose oncomplete can fire
    // before the request callbacks do.
    transaction.oncomplete = () => {
      if (done && typeof done.then === 'function') done.then(resolve, reject);
      else resolve(done && done.result !== undefined ? done.result : done);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('tx aborted'));
  }));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAll(storeName) {
  return openDb().then((db) => wrap(db.transaction(storeName, 'readonly')
    .objectStore(storeName).getAll()));
}

// ---- chats (multi-chat threads) -------------------------------------------

export async function listChats() {
  return getAll(CHATS)
    .then((rows) => rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
}
export async function getChat(id) { return tx(CHATS, 'readonly', (s) => wrap(s.get(id))); }
export async function putChat(chat) {
  chat.updatedAt = new Date().toISOString();
  return tx(CHATS, 'readwrite', (s) => wrap(s.put(chat)));
}
export async function deleteChat(id) { return tx(CHATS, 'readwrite', (s) => wrap(s.delete(id))); }

// ---- memories (the long-term recall) ---------------------------------------

export async function addMemory(memory) {
  const row = { kind: 'chat', at: new Date().toISOString(), topic: '', ...memory };
  return tx(MEMORIES, 'readwrite', (s) => wrap(s.add(row)));
}
export async function allMemories() { return getAll(MEMORIES); }
export async function memoriesByKind(kind) {
  return openDb().then((db) => wrap(db.transaction(MEMORIES, 'readonly')
    .objectStore(MEMORIES).index('kind').getAll(kind)));
}

// ---- facts + style ----------------------------------------------------------

export async function getFact(key) { return tx(FACTS, 'readonly', (s) => wrap(s.get(key))); }
export async function putFact(key, value, source = '') {
  return tx(FACTS, 'readwrite', (s) => wrap(s.put({ key, value, source, at: new Date().toISOString() })));
}
export async function allFacts() { return getAll(FACTS); }
export async function getStyle(key) { return tx(STYLE, 'readonly', (s) => wrap(s.get(key))); }
export async function putStyle(key, value) {
  return tx(STYLE, 'readwrite', (s) => wrap(s.put({ key, value })));
}
export async function allStyle() { return getAll(STYLE); }

// ---- flows (the position recorder / player) ---------------------------------

export async function listFlows() { return getAll(FLOWS); }
export async function getFlow(id) { return tx(FLOWS, 'readonly', (s) => wrap(s.get(id))); }
export async function putFlow(flow) { return tx(FLOWS, 'readwrite', (s) => wrap(s.put(flow))); }
export async function deleteFlow(id) { return tx(FLOWS, 'readwrite', (s) => wrap(s.delete(id))); }

// ---- descriptions library ----------------------------------------------------

export async function listDescriptions() { return getAll(DESCRIPTIONS); }
export async function putDescription(desc) { return tx(DESCRIPTIONS, 'readwrite', (s) => wrap(s.put(desc))); }
export async function deleteDescription(id) { return tx(DESCRIPTIONS, 'readwrite', (s) => wrap(s.delete(id))); }

// ---- monitors (group link watchers) ------------------------------------------

export async function listMonitors() { return getAll(MONITORS); }
export async function getMonitor(id) { return tx(MONITORS, 'readonly', (s) => wrap(s.get(id))); }
export async function putMonitor(mon) { return tx(MONITORS, 'readwrite', (s) => wrap(s.put(mon))); }
export async function deleteMonitor(id) { return tx(MONITORS, 'readwrite', (s) => wrap(s.delete(id))); }

// ---- capture outbox -----------------------------------------------------------

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
      if (cursor && out.length < limit) { out.push(cursor.value); cursor.continue(); }
      else resolve(out);
    };
    request.onerror = () => reject(request.error);
  }));
}

export async function removeQueued(id) { return tx(QUEUE, 'readwrite', (store) => store.delete(id)); }

export async function markTried(id) {
  return tx(QUEUE, 'readwrite', (store) => {
    const get = store.get(id);
    get.onsuccess = () => {
      const item = get.result;
      if (item) { item.tries = (item.tries || 0) + 1; store.put(item); }
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

export async function clearQueue() { return tx(QUEUE, 'readwrite', (store) => store.clear()); }

// ---- local page cache ----------------------------------------------------------

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
    excerpt: (page.text || '').slice(0, 400),
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
      if (cursor && out.length < limit) { out.push(cursor.value); cursor.continue(); }
      else resolve(out);
    };
    request.onerror = () => reject(request.error);
  }));
}

export async function forgetCachedUrl(url) { return tx(PAGES, 'readwrite', (store) => store.delete(url)); }
export async function clearCachedPages() { return tx(PAGES, 'readwrite', (store) => store.clear()); }

// ---- on-device brain stores -----------------------------------------------------

export async function putChunks(chunks) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(CHUNKS, 'readwrite');
    const store = transaction.objectStore(CHUNKS);
    chunks.forEach((chunk) => store.put(chunk));
    transaction.oncomplete = () => resolve(chunks.length);
    transaction.onerror = () => reject(transaction.error);
  }));
}

export async function getAllChunks() { return getAll(CHUNKS); }

export async function deleteChunksByPage(pageId) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(CHUNKS, 'readwrite');
    const store = transaction.objectStore(CHUNKS);
    const index = store.index('pageId');
    const request = index.openCursor(IDBKeyRange.only(pageId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error);
  }));
}

export async function putInterests(rows) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(INTERESTS, 'readwrite');
    const store = transaction.objectStore(INTERESTS);
    store.clear();
    rows.forEach((row) => store.put(row));
    transaction.oncomplete = () => resolve(rows.length);
    transaction.onerror = () => reject(transaction.error);
  }));
}

export async function getInterests() { return getAll(INTERESTS); }

export async function putConversation(entry) {
  return tx(CONVS, 'readwrite', (store) => store.add(Object.assign({ at: Date.now() }, entry)));
}

export async function recentConversations(limit = 6) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const out = [];
    const request = db.transaction(CONVS, 'readonly').objectStore(CONVS)
      .index('at').openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && out.length < limit) { out.push(cursor.value); cursor.continue(); }
      else resolve(out.reverse());
    };
    request.onerror = () => reject(request.error);
  }));
}

export async function addAudit(entry) {
  return tx(AUDIT, 'readwrite', (store) => store.add(Object.assign({ at: Date.now() }, entry)));
}

export async function recentAudit(limit = 60) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const out = [];
    const request = db.transaction(AUDIT, 'readonly').objectStore(AUDIT)
      .index('at').openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && out.length < limit) { out.push(cursor.value); cursor.continue(); }
      else resolve(out);
    };
    request.onerror = () => reject(request.error);
  }));
}

// ---- meta / settings -------------------------------------------------------------

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

export async function getAllMeta() { return getAll(META); }

export async function getSettings() {
  return (await getMeta('settings')) || {};
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await setMeta('settings', next);
  return next;
}

/** Full export for backup — every store, everything you own. */
export async function exportAll() {
  return {
    chats: await listChats(),
    memories: await allMemories(),
    facts: await allFacts(),
    style: await allStyle(),
    flows: await listFlows(),
    descriptions: await listDescriptions(),
    monitors: await listMonitors(),
    pages: await recentPages(1000),
    chunks: (await getAllChunks()).length,
    conversations: await recentConversations(1000),
    audit: await recentAudit(1000),
    meta: await getAllMeta(),
    settings: await getSettings(),
    exportedAt: new Date().toISOString(),
  };
}
