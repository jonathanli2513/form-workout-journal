import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultState, createRoutine, createExercise, createSet, startSession,
  finishSession, toKg, fromKg, sessionStats, validateState, parseBackup, serializeBackup,
} from './model.js';

test('starter programmes contain editable targets and no invented records', () => {
  const state = createDefaultState();
  assert.equal(state.routines.length, 3);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.activeSession, null);
  assert.deepEqual(validateState(state), state);
  const ids = state.routines.flatMap(r => [r.id, ...r.exercises.flatMap(e => [e.id, ...e.sets.map(s => s.id)])]);
  assert.equal(new Set(ids).size, ids.length);
});

test('session snapshots retain order and targets when a programme changes', () => {
  const routine = createRoutine('My programme');
  routine.exercises = [createExercise('Row'), createExercise('Press')];
  routine.exercises[0].sets = [createSet({ reps: 6, weight: 42.5, rest: 120 })];
  const session = startSession(routine, new Date('2026-01-01T10:00:00Z'));
  routine.name = 'Renamed';
  routine.exercises[0].name = 'Squat';
  routine.exercises[0].sets[0].weight = 80;
  routine.exercises.reverse();
  assert.equal(session.routineName, 'My programme');
  assert.deepEqual(session.exercises.map(e => e.name), ['Row', 'Press']);
  assert.equal(session.exercises[0].sets[0].targetWeight, 42.5);
  assert.equal(session.exercises[0].sets[0].weight, 42.5);
  session.exercises[0].sets[0].reps = 5;
  assert.equal(session.exercises[0].sets[0].targetReps, 6);
});

test('only completed sets contribute actual reps and volume', () => {
  const state = createDefaultState();
  const session = startSession(state.routines[0], new Date('2026-01-01T10:00:00Z'));
  Object.assign(session.exercises[0].sets[0], { reps: 8, weight: 50, completed: true });
  Object.assign(session.exercises[0].sets[1], { reps: 6, weight: 52.5, completed: true });
  Object.assign(session.exercises[0].sets[2], { reps: 10, weight: 100, completed: false });
  const finished = finishSession(session, new Date('2026-01-01T10:30:05Z'));
  assert.equal(session.finishedAt, null);
  assert.deepEqual(sessionStats(finished), { completedSets: 2, totalSets: 15, reps: 14, volume: 715, elapsedSeconds: 1805 });
  assert.throws(() => finishSession(session, new Date('2026-01-01T09:00:00Z')), /before/);
});

test('unit changes round trip without mutating stored weights', () => {
  const pounds = fromKg(100, 'lb');
  assert.ok(Math.abs(pounds - 220.4622621849) < 0.00001);
  assert.ok(Math.abs(toKg(pounds, 'lb') - 100) < 0.00000001);
  assert.equal(toKg(42.5, 'kg'), 42.5);
});

test('backup round trip preserves history, actual values, notes, and an active session', () => {
  const state = createDefaultState();
  const session = startSession(state.routines[0], new Date('2026-01-01T10:00:00Z'));
  session.notes = 'Good session\nTry another rep next time.';
  Object.assign(session.exercises[0].sets[0], { reps: 7, weight: 55, completed: true });
  state.sessions.push(finishSession(session, new Date('2026-01-01T11:00:00Z')));
  state.activeSession = startSession(state.routines[1], new Date('2026-01-02T10:00:00Z'));
  state.settings.unit = 'lb';
  assert.deepEqual(parseBackup(serializeBackup(state)), state);
});

test('malformed imports cannot silently overwrite data with invalid records', () => {
  const bad = mutate => { const state = createDefaultState(); mutate(state); return state; };
  for (const value of [null, [], {}, { schemaVersion: 2 }, bad(s => { s.settings.unit = 'stone'; }),
    bad(s => { s.routines[0].exercises[0].sets[0].reps = 3.5; }),
    bad(s => { s.routines[0].exercises[0].sets[0].weight = -1; }),
    bad(s => { s.routines[0].exercises[0].sets[0].weight = Infinity; }),
    bad(s => { s.routines[0].name = ' '; }),
    bad(s => { s.routines.push(s.routines[0]); }),
    bad(s => { s.routines[0].exercises[0].sets.push(s.routines[0].exercises[0].sets[0]); }),
    bad(s => { s.activeSession = startSession(s.routines[0]); s.activeSession.exercises[0].sets[0].completed = 'false'; }),
    bad(s => { s.activeSession = startSession(s.routines[0]); s.activeSession.startedAt = 'no date'; }),
    bad(s => { s.activeSession = startSession(s.routines[0]); s.sessions.push(finishSession(s.activeSession)); }),
  ]) assert.throws(() => validateState(value));
  assert.throws(() => parseBackup('{not-json}'), /not valid JSON/);
});

test('import returns independent objects and discards unknown fields', () => {
  const original = createDefaultState();
  original.malicious = { payload: true };
  original.routines[0].extra = 'discard me';
  const clean = validateState(original);
  clean.routines[0].exercises[0].sets[0].weight = 999;
  assert.equal(original.routines[0].exercises[0].sets[0].weight, 0);
  assert.equal('malicious' in clean, false);
  assert.equal('extra' in clean.routines[0], false);
});
