// Weights are stored in kilograms. Convert only when reading/writing a UI field.
export const SCHEMA_VERSION = 1;
const LB_PER_KG = 2.2046226218487757;
const LIMITS = { routines: 200, exercises: 200, sets: 100, sessions: 10000, text: 10000 };

export function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createSet({ reps = 10, weight = 0, rest = 90 } = {}) {
  return { id: uid(), reps, weight, rest };
}

export function createExercise(name = 'New exercise') {
  return { id: uid(), name, notes: '', sets: Array.from({ length: 3 }, () => createSet()) };
}

export function createRoutine(name = 'New workout') {
  return { id: uid(), name, description: '', exercises: [] };
}

export function createDefaultState() {
  const routine = (name, description, exercises) => ({
    ...createRoutine(name), description,
    exercises: exercises.map(([name, reps, rest, notes]) => ({
      ...createExercise(name), notes,
      sets: Array.from({ length: 3 }, () => createSet({ reps, rest })),
    })),
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { unit: 'kg' },
    routines: [
      routine('Upper body', 'Push, pull, and build a strong foundation.', [
        ['Bench press', 8, 120, 'Set your working weight before you start.'],
        ['Bent-over row', 10, 90, ''],
        ['Overhead press', 8, 90, ''],
        ['Lat pulldown', 12, 90, ''],
        ['Biceps curl', 12, 60, ''],
      ]),
      routine('Lower body', 'A focused session for legs and glutes.', [
        ['Squat', 8, 120, 'Set your working weight before you start.'],
        ['Romanian deadlift', 10, 120, ''],
        ['Reverse lunge', 10, 90, 'Reps per side.'],
        ['Leg curl', 12, 60, ''],
        ['Calf raise', 15, 60, ''],
      ]),
      routine('Full body', 'A little of everything, with room to progress.', [
        ['Goblet squat', 10, 90, ''],
        ['Dumbbell bench press', 10, 90, ''],
        ['Seated cable row', 12, 90, ''],
        ['Hip thrust', 12, 90, ''],
      ]),
    ],
    sessions: [],
    activeSession: null,
  };
}

// Starting a session snapshots the programme; edits never rewrite past sessions.
export function startSession(routine, now = new Date()) {
  const source = normalizeRoutine(routine, 'Workout');
  return {
    id: uid(), routineId: source.id, routineName: source.name,
    startedAt: dateString(now, 'Start time'), finishedAt: null, notes: '',
    exercises: source.exercises.map(exercise => ({
      id: exercise.id, name: exercise.name, notes: exercise.notes,
      sets: exercise.sets.map(set => ({
        id: set.id, targetReps: set.reps, targetWeight: set.weight,
        rest: set.rest, reps: set.reps, weight: set.weight, completed: false,
      })),
    })),
  };
}

export function finishSession(session, now = new Date()) {
  const result = normalizeSession(session, 'Session', false);
  result.finishedAt = dateString(now, 'Finish time');
  if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
    throw new Error('Finish time cannot be before start time.');
  }
  return result;
}

export function toKg(weight, unit = 'kg') {
  return unit === 'lb' ? weight / LB_PER_KG : weight;
}

export function fromKg(weight, unit = 'kg') {
  return unit === 'lb' ? weight * LB_PER_KG : weight;
}

export function sessionStats(session, now = Date.now()) {
  const sets = session.exercises.flatMap(exercise => exercise.sets);
  const completed = sets.filter(set => set.completed);
  return {
    completedSets: completed.length,
    totalSets: sets.length,
    reps: completed.reduce((sum, set) => sum + set.reps, 0),
    volume: completed.reduce((sum, set) => sum + set.reps * set.weight, 0),
    elapsedSeconds: Math.max(0, Math.floor(((session.finishedAt ? Date.parse(session.finishedAt) : Number(now)) - Date.parse(session.startedAt)) / 1000)),
  };
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function string(value, label, max = LIMITS.text, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? 'text' : 'non-empty text'} of at most ${max} characters.`);
  }
  return value;
}

function id(value, label) { return string(value, `${label} ID`, 200, false); }

function number(value, label, { integer = false, min = 0, max = 100000 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}

function list(value, label, max, normalize) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a list of at most ${max} items.`);
  const result = value.map((item, index) => normalize(item, `${label} ${index + 1}`));
  const ids = result.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate IDs.`);
  return result;
}

function dateString(value, label) {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date.`);
  return date.toISOString();
}

function normalizeSet(value, label) {
  object(value, label);
  return {
    id: id(value.id, label),
    reps: number(value.reps, `${label} reps`, { integer: true, min: 1 }),
    weight: number(value.weight, `${label} weight`),
    rest: number(value.rest, `${label} rest`, { integer: true, max: 86400 }),
  };
}

function normalizeExercise(value, label) {
  object(value, label);
  return {
    id: id(value.id, label), name: string(value.name, `${label} name`, 200, false),
    notes: string(value.notes, `${label} notes`),
    sets: list(value.sets, `${label} sets`, LIMITS.sets, normalizeSet),
  };
}

function normalizeRoutine(value, label) {
  object(value, label);
  return {
    id: id(value.id, label), name: string(value.name, `${label} name`, 200, false),
    description: string(value.description, `${label} description`),
    exercises: list(value.exercises, `${label} exercises`, LIMITS.exercises, normalizeExercise),
  };
}

function normalizeSessionSet(value, label) {
  object(value, label);
  if (typeof value.completed !== 'boolean') throw new Error(`${label} completion must be true or false.`);
  return {
    id: id(value.id, label),
    targetReps: number(value.targetReps, `${label} target reps`, { integer: true, min: 1 }),
    targetWeight: number(value.targetWeight, `${label} target weight`),
    rest: number(value.rest, `${label} rest`, { integer: true, max: 86400 }),
    reps: number(value.reps, `${label} reps`, { integer: true }),
    weight: number(value.weight, `${label} weight`), completed: value.completed,
  };
}

function normalizeSession(value, label, completed) {
  object(value, label);
  const startedAt = dateString(value.startedAt, `${label} start time`);
  const finishedAt = completed ? dateString(value.finishedAt, `${label} finish time`) : null;
  if (!completed && value.finishedAt !== null) throw new Error('An active session cannot have a finish time.');
  if (finishedAt && Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error(`${label} finishes before it starts.`);
  return {
    id: id(value.id, label), routineId: id(value.routineId, `${label} routine`),
    routineName: string(value.routineName, `${label} name`, 200, false),
    startedAt, finishedAt, notes: string(value.notes, `${label} notes`),
    exercises: list(value.exercises, `${label} exercises`, LIMITS.exercises, (exercise, exerciseLabel) => {
      object(exercise, exerciseLabel);
      return {
        id: id(exercise.id, exerciseLabel), name: string(exercise.name, `${exerciseLabel} name`, 200, false),
        notes: string(exercise.notes, `${exerciseLabel} notes`),
        sets: list(exercise.sets, `${exerciseLabel} sets`, LIMITS.sets, normalizeSessionSet),
      };
    }),
  };
}

// Validate and rebuild known fields only, preventing imported keys/prototypes from
// entering application state. Throws an actionable error; never mutates input.
export function validateState(value) {
  object(value, 'Backup');
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('This backup uses an unsupported format. Expected schema version 1.');
  object(value.settings, 'Settings');
  if (!['kg', 'lb'].includes(value.settings.unit)) throw new Error('Weight unit must be kg or lb.');
  const sessions = list(value.sessions, 'History', LIMITS.sessions, (session, label) => normalizeSession(session, label, true));
  const activeSession = value.activeSession === null ? null : normalizeSession(value.activeSession, 'Active session', false);
  if (activeSession && sessions.some(session => session.id === activeSession.id)) throw new Error('The active session already exists in history.');
  return {
    schemaVersion: SCHEMA_VERSION, settings: { unit: value.settings.unit },
    routines: list(value.routines, 'Workouts', LIMITS.routines, normalizeRoutine),
    sessions, activeSession,
  };
}

export function parseBackup(text) {
  if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) throw new Error('Choose a JSON backup smaller than 20 MB.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('This file is not valid JSON. Choose an exported workout backup.'); }
  return validateState(value);
}

export function serializeBackup(state) {
  return JSON.stringify(validateState(state), null, 2);
}
