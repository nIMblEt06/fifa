// The library cache lives in IndexedDB rather than localStorage: a large
// library serialises to several megabytes, which overruns the ~5MB
// localStorage quota and fails the write, forcing a full re-fetch every visit.

const DB_NAME = "hub-song";
const DB_VERSION = 1;
const STORE = "library";
const KEY = "liked";
const TTL = 1000 * 60 * 60 * 24;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function readLibraryCache() {
  try {
    const value = await withStore("readonly", (s) => s.get(KEY));
    if (!value?.tracks?.length) return null;
    if (Date.now() - value.at > TTL) return null;
    return value;
  } catch {
    return null; // private mode, blocked storage — the game still works
  }
}

export async function writeLibraryCache(tracks, genresComplete) {
  try {
    await withStore("readwrite", (s) =>
      s.put({ at: Date.now(), tracks, genresComplete }, KEY)
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearLibraryCache() {
  try {
    await withStore("readwrite", (s) => s.delete(KEY));
  } catch {
    // Nothing to clear if the store cannot be opened.
  }
}
