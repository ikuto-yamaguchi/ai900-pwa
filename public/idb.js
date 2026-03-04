/* ===== IndexedDB Wrapper (idb.js) ===== */
'use strict';

const IDB = (() => {
  const DB_NAME = 'ai900app';
  const DB_VERSION = 3;

  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        const oldVersion = e.oldVersion;
        if (!db.objectStoreNames.contains('packs')) {
          db.createObjectStore('packs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('questions')) {
          const qs = db.createObjectStore('questions', { keyPath: 'qid' });
          qs.createIndex('pack', 'packId', { unique: false });
          qs.createIndex('domain', 'domain', { unique: false });
          qs.createIndex('type', 'type', { unique: false });
          qs.createIndex('fingerprint', 'fingerprint', { unique: false });
        }
        if (!db.objectStoreNames.contains('history')) {
          const hs = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          hs.createIndex('qid', 'qid', { unique: false });
          hs.createIndex('ts', 'ts', { unique: false });
        }
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('repos')) {
          db.createObjectStore('repos', { keyPath: 'url' });
        }
        if (!db.objectStoreNames.contains('fingerprints')) {
          db.createObjectStore('fingerprints', { keyPath: 'hash' });
        }
        // v3: add flagReason index to history
        if (oldVersion < 3 && db.objectStoreNames.contains('history')) {
          const historyStore = e.target.transaction.objectStore('history');
          if (!historyStore.indexNames.contains('flagReason')) {
            historyStore.createIndex('flagReason', 'flagReason', { unique: false });
          }
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const result = fn(t);
      t.oncomplete = () => resolve(result._value !== undefined ? result._value : undefined);
      t.onerror = e => reject(e.target.error);
    });
  }

  function _promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* ---- Pack CRUD ---- */
  async function savePack(packMeta) {
    const db = await open();
    return _promisify(db.transaction('packs', 'readwrite').objectStore('packs').put(packMeta));
  }
  async function getPack(id) {
    const db = await open();
    return _promisify(db.transaction('packs', 'readonly').objectStore('packs').get(id));
  }
  async function getAllPacks() {
    const db = await open();
    return _promisify(db.transaction('packs', 'readonly').objectStore('packs').getAll());
  }
  async function deletePack(id) {
    const db = await open();
    const t = db.transaction(['packs', 'questions', 'fingerprints'], 'readwrite');
    t.objectStore('packs').delete(id);
    const qs = t.objectStore('questions').index('pack');
    const fps = t.objectStore('fingerprints');
    const range = IDBKeyRange.only(id);
    const cursorReq = qs.openCursor(range);
    return new Promise((resolve, reject) => {
      cursorReq.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          if (cursor.value.fingerprint) {
            fps.delete(cursor.value.fingerprint);
          }
          cursor.delete();
          cursor.continue();
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = e => reject(e.target.error);
    });
  }

  /* ---- Question CRUD ---- */
  async function saveQuestion(q) {
    const db = await open();
    return _promisify(db.transaction('questions', 'readwrite').objectStore('questions').put(q));
  }
  async function getQuestion(qid) {
    const db = await open();
    return _promisify(db.transaction('questions', 'readonly').objectStore('questions').get(qid));
  }
  async function getAllQuestions() {
    const db = await open();
    return _promisify(db.transaction('questions', 'readonly').objectStore('questions').getAll());
  }
  async function getQuestionsByPack(packId) {
    const db = await open();
    const store = db.transaction('questions', 'readonly').objectStore('questions');
    const idx = store.index('pack');
    return _promisify(idx.getAll(IDBKeyRange.only(packId)));
  }

  /* ---- Fingerprint ---- */
  async function hasFingerprint(hash) {
    const db = await open();
    const r = await _promisify(db.transaction('fingerprints', 'readonly').objectStore('fingerprints').get(hash));
    return !!r;
  }
  async function saveFingerprint(hash, qid) {
    const db = await open();
    return _promisify(db.transaction('fingerprints', 'readwrite').objectStore('fingerprints').put({ hash, qid }));
  }

  /* ---- History ---- */
  async function addHistory(entry) {
    const db = await open();
    return _promisify(db.transaction('history', 'readwrite').objectStore('history').add(entry));
  }
  async function getRecentHistory(days = 7) {
    const db = await open();
    const since = Date.now() - days * 86400000;
    const store = db.transaction('history', 'readonly').objectStore('history');
    const idx = store.index('ts');
    return _promisify(idx.getAll(IDBKeyRange.lowerBound(since)));
  }
  async function getAllHistory() {
    const db = await open();
    return _promisify(db.transaction('history', 'readonly').objectStore('history').getAll());
  }

  /* ---- Sessions ---- */
  async function saveSession(s) {
    const db = await open();
    return _promisify(db.transaction('sessions', 'readwrite').objectStore('sessions').put(s));
  }
  async function getAllSessions() {
    const db = await open();
    return _promisify(db.transaction('sessions', 'readonly').objectStore('sessions').getAll());
  }
  async function getSession(id) {
    const db = await open();
    return _promisify(db.transaction('sessions', 'readonly').objectStore('sessions').get(id));
  }

  /* ---- Repos ---- */
  async function saveRepo(repo) {
    const db = await open();
    return _promisify(db.transaction('repos', 'readwrite').objectStore('repos').put(repo));
  }
  async function getAllRepos() {
    const db = await open();
    return _promisify(db.transaction('repos', 'readonly').objectStore('repos').getAll());
  }
  async function deleteRepo(url) {
    const db = await open();
    return _promisify(db.transaction('repos', 'readwrite').objectStore('repos').delete(url));
  }

  return {
    open, savePack, getPack, getAllPacks, deletePack,
    saveQuestion, getQuestion, getAllQuestions, getQuestionsByPack,
    hasFingerprint, saveFingerprint,
    addHistory, getRecentHistory, getAllHistory,
    saveSession, getAllSessions, getSession,
    saveRepo, getAllRepos, deleteRepo
  };
})();
