/**
 * localStorage finto, in memoria, per i test in Node.
 * Conta lo spazio come il browser (caratteri UTF-16 di chiave e valore, 2 byte l'uno) e può
 * simulare la memoria piena (quotaBytes) o un errore su una chiave precisa (failWrites).
 */

export function quotaError() {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

export class FakeStorage {
  constructor({ quotaBytes = Infinity } = {}) {
    this.map = new Map();
    this.quotaBytes = quotaBytes;
    /** (key, value) => true per far fallire quella scrittura con un errore di quota. */
    this.failWrites = null;
    this.writes = 0;
  }

  get length() {
    return this.map.size;
  }

  key(i) {
    return Array.from(this.map.keys())[i] ?? null;
  }

  getItem(key) {
    const k = String(key);
    return this.map.has(k) ? this.map.get(k) : null;
  }

  setItem(key, value) {
    const k = String(key);
    const v = String(value);
    if (this.failWrites && this.failWrites(k, v)) throw quotaError();
    const old = this.map.has(k) ? (k.length + this.map.get(k).length) * 2 : 0;
    const next = this.usedBytes() - old + (k.length + v.length) * 2;
    if (next > this.quotaBytes) throw quotaError();
    this.map.set(k, v);
    this.writes++;
  }

  removeItem(key) {
    this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }

  usedBytes() {
    let total = 0;
    for (const [k, v] of this.map) total += (k.length + v.length) * 2;
    return total;
  }

  /** Copia di tutto il contenuto, per confrontare prima e dopo un'operazione fallita. */
  snapshot() {
    return Object.fromEntries(this.map);
  }

  getJson(key) {
    const raw = this.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }

  setJson(key, value) {
    this.map.set(key, JSON.stringify(value));
  }
}

/** Installa un FakeStorage come globalThis.localStorage e lo restituisce. */
export function installFakeStorage(options) {
  const storage = options instanceof FakeStorage ? options : new FakeStorage(options);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage
  });
  return storage;
}

/** Simula un browser che nega l'accesso a localStorage (modalità privata, cookie bloccati). */
export function installBrokenStorage() {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    get() {
      throw new DOMException('Access is denied for this document.', 'SecurityError');
    }
  });
}

export function uninstallStorage() {
  delete globalThis.localStorage;
}
