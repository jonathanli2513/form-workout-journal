import { validateState } from './model.js';

const FORMAT = 1;
const ABSENT = Symbol('absent');
const copy = value => value === ABSENT ? ABSENT : structuredClone(value);
const equal = (a, b) => a === ABSENT || b === ABSENT ? a === b : JSON.stringify(a) === JSON.stringify(b);
const emptyState = () => ({ schemaVersion: 1, settings: { unit: 'kg' }, routines: [], sessions: [], activeSession: null });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function mergeOrder(base, local, remote, ids, path, conflicts) {
  const surviving = new Set(ids);
  const old = new Set(base);
  const b = base.filter(id => surviving.has(id));
  const l = local.filter(id => surviving.has(id));
  const r = remote.filter(id => surviving.has(id));
  const lo = l.filter(id => old.has(id));
  const ro = r.filter(id => old.has(id));
  const localReordered = !equal(lo, b.filter(id => lo.includes(id)));
  const remoteReordered = !equal(ro, b.filter(id => ro.includes(id)));
  const commonOld = new Set(lo.filter(id => ro.includes(id)));
  if (localReordered && remoteReordered && !equal(lo.filter(id => commonOld.has(id)), ro.filter(id => commonOld.has(id)))) {
    conflicts.push(`${path}.order`);
    return [...new Set([...l, ...r, ...b])];
  }
  const spine = [...new Set([...(localReordered ? lo : remoteReordered ? ro : b), ...b])];
  const edges = new Map(ids.map(id => [id, new Set()]));
  const indegree = new Map(ids.map(id => [id, 0]));
  const edge = (a, z) => {
    if (a === z || !edges.has(a) || !edges.has(z) || edges.get(a).has(z)) return;
    edges.get(a).add(z); indegree.set(z, indegree.get(z) + 1);
  };
  for (let i = 1; i < spine.length; i++) edge(spine[i - 1], spine[i]);
  // Each device's inserted run keeps its neighbours and relative order. The
  // stable ranking below makes simultaneous insertions in the same gap deterministic.
  for (const side of [l, r]) {
    for (let i = 0; i < side.length; i++) {
      if (old.has(side[i])) continue;
      if (i > 0) edge(side[i - 1], side[i]);
      if (i + 1 < side.length) edge(side[i], side[i + 1]);
    }
  }
  const ranking = [...new Set([...l, ...r, ...b, ...ids])];
  const rank = new Map(ranking.map((id, i) => [id, i]));
  const available = ids.filter(id => indegree.get(id) === 0);
  const result = [];
  while (available.length) {
    available.sort((a, z) => rank.get(a) - rank.get(z));
    const id = available.shift(); result.push(id);
    for (const next of edges.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (!indegree.get(next)) available.push(next);
    }
  }
  if (result.length !== ids.length) {
    conflicts.push(`${path}.order`);
    return ranking.filter(id => surviving.has(id));
  }
  return result;
}

function mergeValue(base, local, remote, path, conflicts) {
  if (equal(local, remote)) return copy(local);
  if (equal(local, base)) return copy(remote);
  if (equal(remote, base)) return copy(local);
  if (local === ABSENT || remote === ABSENT || base === ABSENT) {
    conflicts.push(path); return copy(local);
  }
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const keyed = list => list.every(item => object(item) && typeof item.id === 'string');
    if (keyed(base) && keyed(local) && keyed(remote)) {
      const maps = [base, local, remote].map(list => new Map(list.map(item => [item.id, item])));
      const ids = [...new Set([...base, ...local, ...remote].map(item => item.id))];
      const values = new Map();
      for (const id of ids) {
        const parts = maps.map(map => map.has(id) ? map.get(id) : ABSENT);
        const value = mergeValue(...parts, `${path}[${id}]`, conflicts);
        if (value !== ABSENT) values.set(id, value);
      }
      const order = mergeOrder(base.map(x => x.id), local.map(x => x.id), remote.map(x => x.id), [...values.keys()], path, conflicts);
      return order.map(id => values.get(id));
    }
  } else if (object(base) && object(local) && object(remote)) {
    // Independent active workouts cannot be combined into one valid session.
    if (path === 'activeSession' && local.id !== remote.id) {
      conflicts.push(path); return copy(local);
    }
    const value = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const merged = mergeValue(key in base ? base[key] : ABSENT, key in local ? local[key] : ABSENT, key in remote ? remote[key] : ABSENT, path ? `${path}.${key}` : key, conflicts);
      if (merged !== ABSENT) value[key] = merged;
    }
    return value;
  }
  conflicts.push(path || 'library');
  return copy(local);
}

/** Merge changes relative to the last shared baseline; conflicts never pick a
 * winner silently. Callers must not upload the returned state if conflicts exist. */
export function mergeStates(base, local, remote) {
  const b = validateState(base), l = validateState(local), r = validateState(remote);
  const conflicts = [];
  const candidate = mergeValue(b, l, r, '', conflicts);
  try { return { state: validateState(candidate), conflicts: [...new Set(conflicts)] }; }
  catch {
    // E.g. one device finished a workout while another independently imported
    // it as active, or the combined library exceeds the supported size.
    return { state: l, conflicts: [...new Set([...conflicts, 'library'])] };
  }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Sync revision is invalid.');
  return value;
}
function document(value) {
  if (value === null) return null;
  if (!object(value)) throw new Error('The cloud returned an invalid workout document.');
  return { revision: revision(value.revision), state: validateState(value.state) };
}
function conflict(value) {
  if (value === null) return null;
  if (!object(value) || !Array.isArray(value.paths) || value.paths.some(path => typeof path !== 'string')) throw new Error('Saved sync conflict is invalid.');
  return {
    local: validateState(value.local), remote: validateState(value.remote), base: validateState(value.base),
    remoteRevision: revision(value.remoteRevision), paths: [...value.paths],
  };
}
function parseEnvelope(raw, userId) {
  const value = JSON.parse(raw);
  if (!object(value) || value.format !== FORMAT || value.userId !== userId || typeof value.pending !== 'boolean' || !Array.isArray(value.recoveries)) throw new Error('Saved sync cache is invalid.');
  const base = document(value.base);
  const current = validateState(value.current);
  const lastSyncedAt = value.lastSyncedAt === null ? null : new Date(value.lastSyncedAt).toISOString();
  const recoveries = value.recoveries.map(item => {
    if (!object(item) || !['local', 'remote'].includes(item.choice)) throw new Error('Saved sync recovery is invalid.');
    return { ...conflict(item), choice: item.choice, savedAt: new Date(item.savedAt).toISOString() };
  });
  return {
    format: FORMAT, userId, base, current, pending: base ? !equal(base.state, current) : value.pending,
    conflict: conflict(value.conflict), lastSyncedAt, recoveries,
  };
}

/** Offline queue and optimistic sync, with no transport/auth dependencies.
 *
 * remote.read(): Promise<null | {revision, state}>
 * remote.write(expectedRevision, state): Promise<null | {revision, state}>
 * A null write means its expected revision is stale. onApply(state) should install
 * state synchronously and return false if the app's local save failed.
 *
 * connect() loads only; call sync() on sign-in, online/focus, and after a debounce.
 * For a new account, adoptLocal must be explicitly true to upload guest data.
 */
export function createSyncEngine({ storage, keyPrefix = 'form-sync-v1:', getState, onApply = () => {}, onStatus = () => {}, remote }) {
  let userId = null;
  let envelope = null;
  let lastRaw = null;
  let epoch = 0;
  let localVersion = 0;
  let blocked = null;
  let running = null;
  let status = { phase: 'disconnected', userId: null, pending: false, revision: null, lastSyncedAt: null, message: '', code: null, conflict: false, recoveries: 0 };
  const storageKey = () => `${keyPrefix}${encodeURIComponent(userId)}`;
  const active = token => userId !== null && token === epoch;
  const emit = (phase, message = '', code = null) => {
    status = {
      phase, userId, pending: Boolean(envelope?.pending), revision: envelope?.base?.revision ?? null,
      lastSyncedAt: envelope?.lastSyncedAt ?? null, message, code,
      conflict: Boolean(envelope?.conflict), recoveries: envelope?.recoveries.length ?? 0,
    };
    try { onStatus(copy(status)); } catch { /* Reporting must not lose queued data. */ }
  };
  const fail = (code, message) => { blocked = code; emit('error', message, code); return false; };
  function save() {
    if (!userId || !envelope || blocked) return false;
    try {
      // Do not replace a newer queue written by another tab during a request.
      if (storage.getItem(storageKey()) !== lastRaw) return fail('other-tab', 'Sync data changed in another tab. Reload before syncing; export this tab’s records first.');
      const raw = JSON.stringify(envelope);
      storage.setItem(storageKey(), raw);
      lastRaw = raw;
      return true;
    } catch {
      return fail('storage-unavailable', 'The sync queue could not be saved on this device. Export a backup before closing.');
    }
  }
  async function applyCurrent(token) {
    // If application installation yields to another edit, re-install the latest
    // queued state before acknowledging; never put an old download over an edit.
    for (let attempt = 0; attempt < 5 && active(token); attempt++) {
      const version = localVersion;
      let result;
      try { result = await onApply(copy(envelope.current)); }
      catch { return active(token) ? fail('storage-unavailable', 'The workout data could not be installed on this device. Export a backup before closing.') : false; }
      if (!active(token)) return false;
      if (result === false) return fail('storage-unavailable', 'The downloaded workout data could not be saved on this device. Export a backup before closing.');
      if (version === localVersion) return true;
    }
    return false;
  }
  function installConflict(base, remoteDocument, paths) {
    envelope.conflict = {
      local: copy(envelope.current), remote: copy(remoteDocument.state), base: copy(base),
      remoteRevision: remoteDocument.revision, paths,
    };
    envelope.pending = true;
    if (save()) emit('conflict', 'Changes on two devices need your choice. Both versions are kept on this device.');
  }
  async function connect(id, { adoptLocal = false } = {}) {
    epoch++; localVersion++; userId = null; envelope = null; lastRaw = null; blocked = null;
    if (typeof id !== 'string' || !id.trim() || id.length > 200) { emit('error', 'Sign in to a valid account before syncing.', 'invalid-account'); return false; }
    userId = id;
    const token = epoch;
    try {
      lastRaw = storage.getItem(storageKey());
      if (lastRaw !== null) envelope = parseEnvelope(lastRaw, userId);
      else envelope = {
        format: FORMAT, userId, base: null,
        current: adoptLocal ? validateState(getState()) : emptyState(), pending: Boolean(adoptLocal),
        conflict: null, lastSyncedAt: null, recoveries: [],
      };
    } catch {
      return fail('corrupt-cache', 'This account’s saved sync cache could not be read. It has not been replaced. Export the browser records before repairing the cache.');
    }
    if (!save() || !await applyCurrent(token)) return false;
    if (!active(token)) return false;
    emit(envelope.conflict ? 'conflict' : envelope.pending ? 'pending' : 'idle', envelope.conflict ? 'Changes on two devices need your choice.' : envelope.pending ? 'Changes are saved on this device and waiting to sync.' : 'Ready to check for your latest workouts.');
    return true;
  }
  function disconnect() {
    epoch++; localVersion++; userId = null; envelope = null; lastRaw = null; blocked = null;
    emit('disconnected');
  }
  function changed(value = getState()) {
    if (!userId) return true; // Guest persistence belongs to the app.
    if (!envelope) return false;
    let next;
    try { next = validateState(value); }
    catch { emit('error', 'These workout changes are invalid and could not be queued.', 'invalid-state'); return false; }
    envelope.current = next; localVersion++;
    envelope.pending = !envelope.base || !equal(envelope.base.state, next);
    if (envelope.conflict) envelope.conflict.local = copy(next);
    if (!save()) { if (blocked) emit('error', status.message, blocked); return false; }
    emit(envelope.conflict ? 'conflict' : envelope.pending ? 'pending' : envelope.lastSyncedAt ? 'synced' : 'idle', envelope.conflict ? 'Changes on two devices need your choice.' : envelope.pending ? 'Changes are saved on this device and waiting to sync.' : 'All changes synced.');
    return true;
  }
  async function runSync(token) {
    if (!envelope || blocked || !active(token)) return false;
    if (envelope.conflict) { emit('conflict', 'Changes on two devices need your choice.'); return false; }
    if (!save()) return false;
    emit('syncing', 'Checking your latest workouts…');
    try {
      for (let attempt = 0; attempt < 4 && active(token); attempt++) {
        const fetched = document(await remote.read());
        if (!active(token) || blocked) return false;
        const cloud = fetched ?? { revision: 0, state: emptyState() };
        if (envelope.base && cloud.revision < envelope.base.revision) {
          emit('error', 'The cloud returned an older version. Your device records are preserved; try syncing again later.', 'stale-cloud');
          return false;
        }
        if (envelope.base && cloud.revision === envelope.base.revision && !equal(cloud.state, envelope.base.state)) {
          emit('error', 'The cloud version does not match its saved revision. Your device records are preserved; check the cloud project before syncing.', 'cloud-version-mismatch');
          return false;
        }
        const base = envelope.base?.state ?? emptyState();
        const before = copy(envelope.current);
        // A fresh account without explicit guest adoption follows its cloud copy.
        const result = envelope.base === null && !envelope.pending
          ? { state: copy(cloud.state), conflicts: [] }
          : mergeStates(base, envelope.current, cloud.state);
        if (result.conflicts.length) { installConflict(base, cloud, result.conflicts); return false; }
        envelope.base = copy(cloud);
        envelope.current = result.state;
        envelope.pending = !equal(cloud.state, result.state);
        if (!save()) return false;
        if (!equal(before, envelope.current) && !await applyCurrent(token)) return false;
        if (!active(token) || blocked) return false;
        // An edit made during onApply() can make a formerly clean state pending.
        envelope.pending = !equal(envelope.base.state, envelope.current);
        if (!envelope.pending) {
          envelope.lastSyncedAt = new Date().toISOString();
          if (!save()) return false;
          emit('synced', 'All changes synced.'); return true;
        }
        const written = copy(envelope.current);
        const expectedRevision = envelope.base.revision;
        if (!save()) return false;
        const accepted = document(await remote.write(expectedRevision, written));
        if (!active(token) || blocked) return false;
        if (accepted === null) continue;
        if (accepted.revision <= expectedRevision) throw new Error('The cloud returned an invalid sync revision.');
        const currentBeforeAck = copy(envelope.current);
        const acknowledged = mergeStates(written, envelope.current, accepted.state);
        if (acknowledged.conflicts.length) { installConflict(written, accepted, acknowledged.conflicts); return false; }
        envelope.base = accepted;
        envelope.current = acknowledged.state;
        envelope.pending = !equal(accepted.state, acknowledged.state);
        envelope.lastSyncedAt = new Date().toISOString();
        if (!save()) return false;
        if (!equal(currentBeforeAck, envelope.current) && !await applyCurrent(token)) return false;
        if (!active(token) || blocked) return false;
        if (!envelope.pending) { emit('synced', 'All changes synced.'); return true; }
      }
      if (active(token)) emit('pending', 'Changes are saved on this device. Sync will retry after other updates finish.');
      return false;
    } catch (error) {
      if (active(token) && !blocked) emit('offline', 'Sync is unavailable. Your changes stay on this device and will retry when connected.', typeof error?.code === 'string' ? error.code : 'network');
      return false;
    }
  }
  function sync() {
    if (!userId || !envelope || blocked) return Promise.resolve(false);
    if (running?.epoch === epoch) return running.promise;
    const token = epoch;
    const record = { epoch: token, promise: null };
    record.promise = Promise.resolve().then(() => runSync(token)).finally(() => { if (running === record) running = null; });
    running = record;
    return record.promise;
  }
  async function resolveConflict(choice) {
    if (!['local', 'remote'].includes(choice) || !envelope?.conflict || blocked) return false;
    const token = epoch;
    const previous = copy(envelope.conflict);
    // Keep the discarded version recoverable until explicitly cleared after export.
    envelope.recoveries.push({ ...previous, choice, savedAt: new Date().toISOString() });
    envelope.base = { revision: previous.remoteRevision, state: copy(previous.remote) };
    envelope.current = copy(choice === 'local' ? previous.local : previous.remote);
    envelope.conflict = null; envelope.pending = !equal(envelope.base.state, envelope.current); localVersion++;
    if (!save() || !await applyCurrent(token)) return false;
    if (!active(token)) return false;
    emit(envelope.pending ? 'pending' : 'idle', 'Your choice is saved. Both versions remain in recovery backups.');
    await sync();
    // The choice is resolved once safely stored; an unavailable backend leaves
    // it queued and does not undo the recovery copy or the user's selection.
    return active(token);
  }
  return {
    connect, disconnect, changed, sync, resolveConflict,
    getStatus: () => copy(status),
    get status() { return copy(status); },
    getConflict: () => copy(envelope?.conflict ?? null),
    getRecoveries: () => copy(envelope?.recoveries ?? []),
    clearRecoveries() {
      if (!envelope || blocked) return false;
      envelope.recoveries = [];
      if (!save()) return false;
      emit(status.phase, status.message, status.code); return true;
    },
    hasAccount(id) {
      try { return storage.getItem(`${keyPrefix}${encodeURIComponent(id)}`) !== null; }
      catch { return false; }
    },
  };
}
