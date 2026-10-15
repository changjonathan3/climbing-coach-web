/**
 * Browser-local video blob storage (IndexedDB).
 *
 * When Jon uploads a video for analysis we keep the file here keyed by the
 * saved analysis ID, so the Analyze results and History views can play the
 * clip back like the artifact does. This is local-only: it does not sync
 * across devices, and old analyses migrated before this existed have no
 * stored video. All failures are non-fatal — callers treat a miss as
 * "video not available on this device".
 */

const DB_NAME = 'climbing-coach-videos';
const STORE_NAME = 'videos';
const DB_VERSION = 1;

type StoredVideo = {
  id: string;
  blob: Blob;
  savedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/** Store a video blob under an analysis ID. Resolves even on quota errors. */
export async function putVideo(id: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id, blob, savedAt: Date.now() } satisfies StoredVideo);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      });
    } finally {
      db.close();
    }
  } catch {
    // Quota or privacy-mode failures: video playback just won't be available.
  }
}

/** Fetch a stored video blob, or null when absent/unavailable. */
export async function getVideo(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    try {
      const row = await new Promise<StoredVideo | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result as StoredVideo | undefined);
        req.onerror = () => reject(req.error ?? new Error('get failed'));
      });
      return row?.blob ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Remove a stored video (currently unused; kept for future cleanup). */
export async function deleteVideo(id: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('delete failed'));
      });
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}
