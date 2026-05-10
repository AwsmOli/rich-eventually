/**
 * Thin IndexedDB wrapper used as the single persistent store for the app.
 *
 * Stores
 * ──────
 *  kv                – generic key/value (auth, filters, cached results, route cache …)
 *  market-orders     – one record per region  { regionId, data: CompactOrder[], storedAt }
 *  history-summaries – one record per "regionId:typeId"  { key, avgOrderCount, avgPrice, expiresAt }
 *  type-cache        – one record per typeId  { typeId, name, volumeM3, expiresAt }
 */

const DB_NAME = "rich-eventually";
const DB_VERSION = 1;

type StoreName = "kv" | "market-orders" | "history-summaries" | "type-cache";

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv"); // keyPath = external key passed to put/get
      }
      if (!db.objectStoreNames.contains("market-orders")) {
        db.createObjectStore("market-orders", { keyPath: "regionId" });
      }
      if (!db.objectStoreNames.contains("history-summaries")) {
        db.createObjectStore("history-summaries", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("type-cache")) {
        db.createObjectStore("type-cache", { keyPath: "typeId" });
      }
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(
  db: IDBDatabase,
  store: StoreName,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── KV store ─────────────────────────────────────────────────────────────────

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return wrap<T | undefined>(tx(db, "kv", "readonly").get(key));
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  await wrap(tx(db, "kv", "readwrite").put(value, key));
}

export async function kvDelete(key: string): Promise<void> {
  const db = await openDB();
  await wrap(tx(db, "kv", "readwrite").delete(key));
}

// ── Market orders ─────────────────────────────────────────────────────────────

export interface MarketOrdersRecord {
  regionId: number;
  /** Compact order tuples: [typeId, price, isBuyOrder(0|1), systemId, volumeRemain, minVolume, locationId] */
  data: Array<[number, number, 0 | 1, number, number, number, number]>;
  storedAt: number;
}

export async function marketOrdersGet(
  regionId: number,
): Promise<MarketOrdersRecord | undefined> {
  const db = await openDB();
  return wrap<MarketOrdersRecord | undefined>(
    tx(db, "market-orders", "readonly").get(regionId),
  );
}

export async function marketOrdersPut(
  record: MarketOrdersRecord,
): Promise<void> {
  const db = await openDB();
  await wrap(tx(db, "market-orders", "readwrite").put(record));
}

export async function marketOrdersDelete(regionId: number): Promise<void> {
  const db = await openDB();
  await wrap(tx(db, "market-orders", "readwrite").delete(regionId));
}

// ── History summaries ─────────────────────────────────────────────────────────

export interface HistorySummaryRecord {
  key: string; // "regionId:typeId"
  avgOrderCount: number;
  avgPrice: number | undefined;
  expiresAt: number;
}

export async function historySummaryGet(
  key: string,
): Promise<HistorySummaryRecord | undefined> {
  const db = await openDB();
  return wrap<HistorySummaryRecord | undefined>(
    tx(db, "history-summaries", "readonly").get(key),
  );
}

export async function historySummaryPut(
  record: HistorySummaryRecord,
): Promise<void> {
  const db = await openDB();
  await wrap(tx(db, "history-summaries", "readwrite").put(record));
}

// ── Type cache ────────────────────────────────────────────────────────────────

export interface TypeCacheRecord {
  typeId: number;
  name: string;
  volumeM3: number;
  /** Optional — only present for types with a distinct packaged volume (e.g. ships). */
  canBeAssembled?: boolean;
  expiresAt: number;
}

export async function typeCacheGetAll(): Promise<TypeCacheRecord[]> {
  const db = await openDB();
  return wrap<TypeCacheRecord[]>(tx(db, "type-cache", "readonly").getAll());
}

export async function typeCachePutBulk(
  records: TypeCacheRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const db = await openDB();
  const store = db
    .transaction("type-cache", "readwrite")
    .objectStore("type-cache");
  await Promise.all(records.map((r) => wrap(store.put(r))));
}

export async function typeCacheClear(): Promise<void> {
  const db = await openDB();
  await wrap(
    db.transaction("type-cache", "readwrite").objectStore("type-cache").clear(),
  );
}
