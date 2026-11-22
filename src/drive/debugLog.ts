export type SyncDebugCategory =
  | 'drive_api'
  | 'sync'
  | 'share'
  | 'picker'
  | 'auth';

export interface SyncDebugEvent {
  ts: number;
  iso: string;
  category: SyncDebugCategory;
  event: string;
  detail?: Record<string, unknown>;
}

const STORAGE_KEY = 'storytape.syncDebugLog.v1';
const MAX_EVENTS = 120;

let memoryLog: SyncDebugEvent[] | null = null;

function sanitizeValue(val: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    // Strip any accidental bearer token or query API key
    return val
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
      .slice(0, 600);
  }
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (Array.isArray(val)) {
    return val.slice(0, 30).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (
        /token|secret|password|authorization|apikey|api_key/i.test(k) &&
        typeof v === 'string'
      ) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeValue(v, depth + 1);
      }
    }
    return out;
  }
  return String(val);
}

function loadLog(): SyncDebugEvent[] {
  if (memoryLog) return memoryLog;
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(STORAGE_KEY)
        : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        memoryLog = parsed.slice(-MAX_EVENTS) as SyncDebugEvent[];
        return memoryLog;
      }
    }
  } catch {
    // Ignore storage read errors
  }
  memoryLog = [];
  return memoryLog;
}

function persistLog(entries: SyncDebugEvent[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_EVENTS)));
    }
  } catch {
    // Ignore quota / private-mode storage errors
  }
}

export function recordSyncDebugEvent(
  category: SyncDebugCategory,
  event: string,
  detail?: Record<string, unknown>,
): void {
  const now = Date.now();
  const entry: SyncDebugEvent = {
    ts: now,
    iso: new Date(now).toISOString(),
    category,
    event,
    detail: detail
      ? (sanitizeValue(detail) as Record<string, unknown>)
      : undefined,
  };
  const entries = loadLog();
  entries.push(entry);
  if (entries.length > MAX_EVENTS) {
    entries.splice(0, entries.length - MAX_EVENTS);
  }
  persistLog(entries);
}

export function getSyncDebugLog(): SyncDebugEvent[] {
  return loadLog().slice();
}

export function clearSyncDebugLog(): void {
  memoryLog = [];
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}
