import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState, createRoutine, startSession, finishSession, validateState } from './model.js';
import { createSyncEngine, mergeStates } from './sync-engine.js';

const clone = value => structuredClone(value);
function initial() { const state = createDefaultState(); state.routines = state.routines.slice(0, 2); return state; }
function memoryStorage() {
  const records = new Map();
  return { records, fail: false, getItem(key) { if (this.fail) throw new Error('storage blocked'); return records.get(key) ?? null; }, setItem(key, value) { if (this.fail) throw new Error('storage full'); records.set(key, value); } };
}
function cloudStore(state = null) {
  return {
    value: state ? { revision: 1, state: clone(state) } : null, reads: 0, writes: 0, offline: false,
    async read() { this.reads++; if (this.offline) throw new Error('project unavailable'); return clone(this.value); },
    async write(expectedRevision, state) {
      this.writes++; if (this.offline) throw new Error('project unavailable');
      if ((this.value?.revision ?? 0) !== expectedRevision) return null;
      this.value = { revision: expectedRevision + 1, state: validateState(state) }; return clone(this.value);
    },
  };
}
function harness({ state = initial(), storage = memoryStorage(), cloud = cloudStore(), onApply } = {}) {
  let current = clone(state);
  const statuses = [];
  const engine = createSyncEngine({
    storage, remote: cloud, getState: () => clone(current),
    onApply: next => { current = clone(next); return onApply?.(next); },
    onStatus: next => statuses.push(next),
  });
  return { engine, storage, cloud, statuses, get state() { return clone(current); }, change(fn) { fn(current); return engine.changed(current); } };
}
function deferred() { let resolve, reject; const promise = new Promise((a, z) => { resolve = a; reject = z; }); return { promise, resolve, reject }; }

// The queue is keyed by authenticated user ID; guest imports are opt-in.
test('new account never uploads the previous account or guest data without adoption', async () => {
  const h = harness();
  await h.engine.connect('account-a');
  await h.engine.sync();
  assert.equal(h.state.routines.length, 0);
  assert.equal(h.cloud.writes, 0);
  assert.equal(h.engine.status.phase, 'synced');
  const guest = initial();
  const adopted = harness({ state: guest });
  await adopted.engine.connect('account-a', { adoptLocal: true });
  assert.equal(await adopted.engine.sync(), true);
  assert.deepEqual(adopted.cloud.value.state, guest);
});

test('separate devices merge independent routine edits and new completed sessions', async () => {
  const base = initial(), cloud = cloudStore(base);
  const a = harness({ cloud }), b = harness({ cloud });
  await a.engine.connect('owner'); await a.engine.sync();
  await b.engine.connect('owner'); await b.engine.sync();
  a.change(s => { s.routines[0].description = 'Device A programme'; });
  b.change(s => {
    s.routines[1].description = 'Device B programme';
    const active = startSession(s.routines[1], '2026-11-20T10:00:00Z'); active.exercises[0].sets[0].completed = true;
    s.sessions.push(finishSession(active, '2026-11-20T11:00:00Z'));
  });
  await b.engine.sync(); await a.engine.sync(); await b.engine.sync();
  assert.equal(a.cloud.value.state.routines[0].description, 'Device A programme');
  assert.equal(a.cloud.value.state.routines[1].description, 'Device B programme');
  assert.equal(a.cloud.value.state.sessions.length, 1);
  assert.deepEqual(a.state, b.state);
});

test('same exercise fields can merge independently while exercise order survives', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.routines[0].exercises[0].notes = 'Local cue';
  remote.routines[0].exercises[1].sets[0].weight = 32.5;
  remote.routines[0].exercises.reverse();
  const merged = mergeStates(base, local, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.state.routines[0].exercises.map(e => e.id), remote.routines[0].exercises.map(e => e.id));
  assert.equal(merged.state.routines[0].exercises.find(e => e.id === local.routines[0].exercises[0].id).notes, 'Local cue');
  assert.equal(merged.state.routines[0].exercises.find(e => e.id === remote.routines[0].exercises.at(-2).id).sets[0].weight, 32.5);
});

test('simultaneous insertions preserve each device’s positions and list order', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  const addedA = createRoutine('A'), addedB = createRoutine('B');
  local.routines.splice(1, 0, addedA); remote.routines.splice(1, 0, addedB);
  const result = mergeStates(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.state.routines.map(r => r.name), [base.routines[0].name, 'A', 'B', base.routines[1].name]);
});

test('deletion of an unchanged record propagates; deletion versus edit conflicts', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.routines.shift();
  assert.equal(mergeStates(base, local, remote).state.routines.length, 1);
  remote.routines[0].name = 'Keep this edited programme';
  assert.ok(mergeStates(base, local, remote).conflicts.length);
});

test('conflicting changes stop uploading and both snapshots remain through reload and resolution', async () => {
  const base = initial(), cloud = cloudStore(base), storage = memoryStorage();
  const h = harness({ cloud, storage });
  await h.engine.connect('owner'); await h.engine.sync();
  h.change(s => { s.routines[0].name = 'Local name'; });
  cloud.value = { revision: 2, state: clone(base) }; cloud.value.state.routines[0].name = 'Remote name';
  assert.equal(await h.engine.sync(), false);
  assert.equal(h.engine.status.phase, 'conflict'); assert.equal(cloud.writes, 0);
  assert.equal(h.engine.getConflict().local.routines[0].name, 'Local name');
  const reloaded = harness({ storage, cloud });
  await reloaded.engine.connect('owner');
  assert.equal(reloaded.engine.status.phase, 'conflict');
  assert.equal(await reloaded.engine.resolveConflict('local'), true);
  assert.equal(cloud.value.state.routines[0].name, 'Local name');
  assert.equal(reloaded.engine.getRecoveries()[0].remote.routines[0].name, 'Remote name');
  const reloadedAgain = harness({ storage, cloud }); await reloadedAgain.engine.connect('owner');
  assert.equal(reloadedAgain.engine.getRecoveries().length, 1);
  assert.equal(reloadedAgain.engine.clearRecoveries(), true);
  assert.equal(reloadedAgain.engine.getRecoveries().length, 0);
});

test('choosing cloud explicitly preserves discarded local data in recoveries', async () => {
  const base = initial(), h = harness({ cloud: cloudStore(base) });
  await h.engine.connect('owner'); await h.engine.sync();
  h.change(s => { s.routines[0].description = 'Local'; });
  h.cloud.value.state.routines[0].description = 'Remote'; h.cloud.value.revision++;
  await h.engine.sync();
  assert.equal(await h.engine.resolveConflict('remote'), true);
  assert.equal(h.state.routines[0].description, 'Remote');
  assert.equal(h.engine.getRecoveries()[0].local.routines[0].description, 'Local');
});

test('offline changes persist, survive reload, and upload after the backend resumes', async () => {
  const cloud = cloudStore(initial()), storage = memoryStorage(), h = harness({ cloud, storage });
  await h.engine.connect('owner'); await h.engine.sync();
  h.change(s => { s.routines[0].exercises[0].sets[0].weight = 80; });
  cloud.offline = true; assert.equal(await h.engine.sync(), false);
  assert.equal(h.engine.status.phase, 'offline'); assert.equal(h.engine.status.pending, true);
  const reloaded = harness({ cloud, storage }); await reloaded.engine.connect('owner');
  assert.equal(reloaded.state.routines[0].exercises[0].sets[0].weight, 80);
  cloud.offline = false; await reloaded.engine.sync();
  assert.equal(cloud.value.state.routines[0].exercises[0].sets[0].weight, 80);
  assert.equal(reloaded.engine.status.pending, false);
});

test('edits arriving during a cloud read are included rather than overwritten', async () => {
  const cloud = cloudStore(initial()), h = harness({ cloud });
  await h.engine.connect('owner'); await h.engine.sync();
  const gate = deferred(), entered = deferred(); const originalRead = cloud.read.bind(cloud);
  cloud.read = async () => { entered.resolve(); await gate.promise; return originalRead(); };
  const syncing = h.engine.sync(); await entered.promise;
  h.change(s => { s.routines[0].name = 'Edited while fetching'; }); gate.resolve();
  assert.equal(await syncing, true);
  assert.equal(cloud.value.state.routines[0].name, 'Edited while fetching');
  assert.equal(h.state.routines[0].name, 'Edited while fetching');
});

test('edits arriving during a cloud write are queued and written in the same bounded sync', async () => {
  const cloud = cloudStore(initial()), h = harness({ cloud });
  await h.engine.connect('owner'); await h.engine.sync();
  h.change(s => { s.routines[0].description = 'First edit'; });
  const gate = deferred(), entered = deferred(); const originalWrite = cloud.write.bind(cloud); let first = true;
  cloud.write = async (...args) => { if (first) { first = false; entered.resolve(); await gate.promise; } return originalWrite(...args); };
  const syncing = h.engine.sync(); await entered.promise;
  h.change(s => { s.routines[1].description = 'Another edit during upload'; }); gate.resolve();
  assert.equal(await syncing, true);
  assert.equal(cloud.value.state.routines[1].description, 'Another edit during upload');
  assert.equal(h.engine.status.pending, false);
  assert.equal(cloud.writes, 2);
});

test('stale compare-and-swap retries against latest cloud data without dropping either edit', async () => {
  const base = initial(), cloud = cloudStore(base), h = harness({ cloud });
  await h.engine.connect('owner'); await h.engine.sync();
  h.change(s => { s.routines[0].name = 'Local change'; });
  const originalWrite = cloud.write.bind(cloud); let race = true;
  cloud.write = async (...args) => {
    if (race) { race = false; cloud.value.revision++; cloud.value.state.routines[1].name = 'Other device'; }
    return originalWrite(...args);
  };
  assert.equal(await h.engine.sync(), true);
  assert.equal(cloud.value.state.routines[0].name, 'Local change');
  assert.equal(cloud.value.state.routines[1].name, 'Other device');
});

test('finishing a shared active session propagates to history without reviving it', async () => {
  const base = initial(); base.activeSession = startSession(base.routines[0], '2026-11-20T10:00:00Z');
  const cloud = cloudStore(base), a = harness({ cloud }), b = harness({ cloud });
  await a.engine.connect('owner'); await a.engine.sync(); await b.engine.connect('owner'); await b.engine.sync();
  a.change(s => { s.activeSession.exercises[0].sets[0].completed = true; s.sessions.push(finishSession(s.activeSession, '2026-11-20T11:00:00Z')); s.activeSession = null; });
  await a.engine.sync(); await b.engine.sync();
  assert.equal(b.state.activeSession, null); assert.equal(b.state.sessions.length, 1);
  assert.equal(b.state.sessions[0].exercises[0].sets[0].completed, true);
});

test('independent active workouts and incompatible reorders require an explicit choice', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.activeSession = startSession(base.routines[0]); remote.activeSession = startSession(base.routines[1]);
  assert.ok(mergeStates(base, local, remote).conflicts.includes('activeSession'));
  const a = clone(base), b = clone(base);
  a.routines[0].exercises.reverse(); b.routines[0].exercises.push(b.routines[0].exercises.shift());
  assert.ok(mergeStates(base, a, b).conflicts.some(path => path.endsWith('.order')));
});

test('local storage failures prevent uploads and never report queued data as synced', async () => {
  const storage = memoryStorage(), cloud = cloudStore(initial()), h = harness({ storage, cloud });
  await h.engine.connect('owner'); await h.engine.sync(); const writes = cloud.writes, reads = cloud.reads;
  storage.fail = true;
  assert.equal(h.change(s => { s.routines[0].name = 'In memory only'; }), false);
  assert.equal(await h.engine.sync(), false);
  assert.equal(h.engine.status.phase, 'error'); assert.equal(h.engine.status.pending, true);
  assert.equal(cloud.writes, writes); assert.equal(cloud.reads, reads);
  const unavailable = memoryStorage(); unavailable.fail = true;
  const noStorage = harness({ storage: unavailable, cloud });
  assert.equal(await noStorage.engine.connect('owner', { adoptLocal: true }), false);
  assert.equal(await noStorage.engine.sync(), false);
});

test('corrupt account metadata is preserved and never treated as a fresh upload', async () => {
  const storage = memoryStorage(), raw = '{"format":1,"current":"broken"}'; storage.records.set('form-sync-v1:owner', raw);
  const h = harness({ storage });
  assert.equal(h.engine.hasAccount('owner'), true);
  assert.equal(await h.engine.connect('owner', { adoptLocal: true }), false);
  assert.equal(h.engine.status.code, 'corrupt-cache');
  assert.equal(storage.records.get('form-sync-v1:owner'), raw); assert.equal(h.cloud.reads, 0);
});

test('another tab changing the account queue blocks stale local writes', async () => {
  const storage = memoryStorage(), cloud = cloudStore(initial()), h = harness({ storage, cloud });
  await h.engine.connect('owner'); await h.engine.sync();
  const value = JSON.parse(storage.records.get('form-sync-v1:owner')); value.current.routines[0].name = 'Other tab'; value.pending = true;
  const raw = JSON.stringify(value); storage.records.set('form-sync-v1:owner', raw);
  assert.equal(h.change(s => { s.routines[0].name = 'Stale tab'; }), false);
  assert.equal(h.engine.status.code, 'other-tab'); assert.equal(await h.engine.sync(), false);
  assert.equal(storage.records.get('form-sync-v1:owner'), raw);
});

test('account changes and disconnects ignore in-flight responses from the old user', async () => {
  const cloud = cloudStore(initial()), h = harness({ cloud });
  await h.engine.connect('account-a'); await h.engine.sync();
  const gate = deferred(), entered = deferred(); const originalRead = cloud.read.bind(cloud);
  cloud.read = async () => { const snapshot = await originalRead(); entered.resolve(); await gate.promise; return snapshot; };
  const syncing = h.engine.sync(); await entered.promise;
  h.engine.disconnect(); await h.engine.connect('account-b'); gate.resolve(); await syncing;
  assert.equal(h.state.routines.length, 0); assert.equal(h.engine.status.userId, 'account-b');
  await h.engine.connect('account-a'); assert.equal(h.state.routines.length, 2);
});

test('overlapping sync calls share one request and callback mutation cannot change engine state', async () => {
  const cloud = cloudStore(initial()), h = harness({ cloud });
  await h.engine.connect('owner');
  const a = h.engine.sync(), b = h.engine.sync(); assert.equal(a, b); await a;
  assert.equal(cloud.reads, 1);
  const status = h.engine.getStatus(); status.phase = 'error'; assert.equal(h.engine.status.phase, 'synced');
});

test('failed app installation blocks acknowledgements and further uploads', async () => {
  const cloud = cloudStore(initial());
  const h = harness({ cloud, onApply() { throw new Error('app storage unavailable'); } });
  assert.equal(await h.engine.connect('owner'), false);
  assert.equal(h.engine.status.code, 'storage-unavailable');
  assert.equal(await h.engine.sync(), false); assert.equal(cloud.writes, 0); assert.equal(cloud.reads, 0);
  const normal = harness({ cloud }); await normal.engine.connect('owner'); await normal.engine.sync();
  assert.equal(normal.engine.status.phase, 'synced');
  normal.change(() => {}); assert.equal(normal.engine.status.phase, 'synced'); assert.equal(normal.engine.status.pending, false);
});

test('active set progress made on two devices merges without losing either set', () => {
  const base = initial(); base.activeSession = startSession(base.routines[0]);
  const local = clone(base), remote = clone(base);
  local.activeSession.exercises[0].sets[0].completed = true;
  local.activeSession.exercises[0].sets[0].weight = 70;
  remote.activeSession.exercises[0].sets[1].completed = true;
  remote.activeSession.exercises[0].sets[1].weight = 72.5;
  const result = mergeStates(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.state.activeSession.exercises[0].sets[0].weight, 70);
  assert.equal(result.state.activeSession.exercises[0].sets[1].weight, 72.5);
  assert.equal(result.state.activeSession.exercises[0].sets.filter(s => s.completed).length, 2);
});

test('explicit guest adoption unions separate starter IDs with a nonempty cloud library', async () => {
  const guest = initial(), remote = initial(), h = harness({ state: guest, cloud: cloudStore(remote) });
  assert.notEqual(guest.routines[0].id, remote.routines[0].id);
  await h.engine.connect('owner', { adoptLocal: true });
  assert.equal(await h.engine.sync(), true);
  assert.equal(h.cloud.value.state.routines.length, guest.routines.length + remote.routines.length);
  assert.deepEqual(new Set(h.cloud.value.state.routines.map(r => r.id)), new Set([...guest.routines, ...remote.routines].map(r => r.id)));
});

test('a lower cloud revision or missing cloud row cannot roll back an acknowledged library', async () => {
  const initialState = initial(), cloud = cloudStore(initialState), h = harness({ cloud });
  await h.engine.connect('owner'); await h.engine.sync();
  h.change(s => { s.routines[0].description = 'Acknowledged recent data'; }); await h.engine.sync();
  assert.equal(cloud.value.revision, 2); const current = h.state, latest = clone(cloud.value), writes = cloud.writes;
  cloud.value = { revision: 1, state: initialState };
  assert.equal(await h.engine.sync(), false); assert.equal(h.engine.status.code, 'stale-cloud');
  assert.deepEqual(h.state, current); assert.equal(h.engine.status.revision, 2); assert.equal(cloud.writes, writes);
  cloud.value = null;
  assert.equal(await h.engine.sync(), false); assert.equal(h.engine.status.code, 'stale-cloud'); assert.deepEqual(h.state, current);
  cloud.value = latest;
  assert.equal(await h.engine.sync(), true); assert.deepEqual(h.state, current);
});

test('cloud content cannot change under an already acknowledged revision', async () => {
  const cloud = cloudStore(initial()), h = harness({ cloud });
  await h.engine.connect('owner'); await h.engine.sync(); const before = h.state;
  cloud.value.state.routines[0].name = 'Changed without incrementing revision';
  assert.equal(await h.engine.sync(), false); assert.equal(h.engine.status.code, 'cloud-version-mismatch');
  assert.deepEqual(h.state, before); assert.equal(cloud.writes, 0);
});

test('Postgres JSONB key ordering does not cause phantom edits or conflicts', async () => {
  const sortedKeys = value => Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;
  const cloud = cloudStore(initial()), h = harness({ cloud });
  await h.engine.connect('owner'); await h.engine.sync();
  const before = h.state;
  cloud.value.state = sortedKeys(cloud.value.state);
  assert.notEqual(JSON.stringify(before), JSON.stringify(cloud.value.state));
  assert.equal(await h.engine.sync(), true);
  assert.equal(h.engine.status.pending, false); assert.equal(h.engine.status.conflict, false); assert.equal(cloud.writes, 0);
  assert.deepEqual(h.state, before);
  const local = sortedKeys(before), remote = clone(before); local.routines[0].description = 'A'; remote.routines[1].description = 'B';
  const merged = mergeStates(sortedKeys(before), local, remote);
  assert.deepEqual(merged.conflicts, []); assert.equal(merged.state.routines[0].description, 'A'); assert.equal(merged.state.routines[1].description, 'B');
});

test('choosing the known cloud copy while offline durably keeps both recovery snapshots', async () => {
  const base = initial(), storage = memoryStorage(), cloud = cloudStore(base), h = harness({ cloud, storage });
  await h.engine.connect('owner'); await h.engine.sync();
  h.change(s => { s.routines[0].name = 'Offline local record'; });
  cloud.value.revision++; cloud.value.state.routines[0].name = 'Selected cloud record';
  await h.engine.sync(); assert.equal(h.engine.status.phase, 'conflict');
  cloud.offline = true;
  assert.equal(await h.engine.resolveConflict('remote'), true);
  assert.equal(h.engine.status.phase, 'offline'); assert.equal(h.state.routines[0].name, 'Selected cloud record');
  const reloaded = harness({ cloud, storage }); await reloaded.engine.connect('owner');
  assert.equal(reloaded.state.routines[0].name, 'Selected cloud record');
  assert.equal(reloaded.engine.getRecoveries()[0].local.routines[0].name, 'Offline local record');
  assert.equal(reloaded.engine.getRecoveries()[0].remote.routines[0].name, 'Selected cloud record');
});

test('finished versus concurrently edited active workout is a conflict, never an automatic revival', async () => {
  const base = initial(); base.activeSession = startSession(base.routines[0], '2026-11-20T10:00:00Z');
  const finished = clone(base), progressed = clone(base);
  finished.sessions.push(finishSession(finished.activeSession, '2026-11-20T11:00:00Z')); finished.activeSession = null;
  progressed.activeSession.exercises[0].sets[0].weight = 85; progressed.activeSession.exercises[0].sets[0].completed = true;
  assert.ok(mergeStates(base, finished, progressed).conflicts.length);
  assert.ok(mergeStates(base, progressed, finished).conflicts.length);
  const cloud = cloudStore(base), h = harness({ cloud });
  await h.engine.connect('owner'); await h.engine.sync();
  h.change(s => { s.sessions = finished.sessions; s.activeSession = null; });
  cloud.value = { revision: 2, state: progressed };
  assert.equal(await h.engine.sync(), false); assert.equal(h.engine.status.phase, 'conflict');
  assert.equal(h.state.activeSession, null); assert.equal(h.state.sessions.length, 1); assert.equal(cloud.writes, 0);
  assert.equal(h.engine.getConflict().remote.activeSession.exercises[0].sets[0].weight, 85);
});
