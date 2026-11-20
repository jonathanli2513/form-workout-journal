import { uid, createDefaultState, createRoutine, createExercise, createSet, startSession, finishSession, toKg, fromKg, sessionStats, parseBackup, serializeBackup, validateState } from './model.js';
import { createCloudClient } from './cloud.js';
import { cloudConfig } from './cloud-config.js';
import { createSyncEngine, mergeStates } from './sync-engine.js';

const KEY = 'form-workout-v1';
const OWNER_KEY = KEY + ':owner';
const SYNC_PREFIX = 'form-sync-v1:';
const browserStorage = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
};
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
let storageError = '';
let unreadableBackup = null;
let owner = loadOwner();
let state = loadState();
let view = state.activeSession ? 'session' : 'workouts';
let draft = null;
let draftBaseState = null;
let dirty = false;
let detailId = null;
let toastTimeout;
let restUntil = 0;
let dragId = null;
let externalChange = false;
let memoryUnsaved = false;
let syncEngine = null;
let syncStatus = { phase: 'disconnected', pending: false, conflict: false };
let cloud = null;
let cloudPromise = null;
let cloudStarting = false;
let cloudError = '';
let confirmedUserId = null;
let authUser = null;
let pendingAccount = null;
let authQueue = Promise.resolve();
let authSequence = 0;
let authEventVersion = 0;
let lastQueuedAuth;
let explicitSignOut = false;
let authBusy = false;
let authFeedback = '';
let signInEmail = '';
let syncTimeout;
let uiReady = false;
let deferredRender = false;
const paths = {
  cloud: '<path d="M6 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 17 7a5 5 0 1 1 1 10.9M8 18l4 3 4-3M12 21v-9"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
  logo: '<path d="M5 20V4h14M5 11h11"/><path d="M11 20v-4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  dumbbell: '<path d="m7 7 10 10M3 8l5-5M16 21l5-5M5 10l5-5M14 19l5-5M2 6l4-4M18 22l4-4"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/>',
  chart: '<path d="M4 20h17M7 16v-5M12 16V5M17 16V8"/>',
  settings: '<path d="m9 3-1 3-3 1v4l2 1v3l-2 2 3 3 3-1 2 2 3-2 3 1 2-3-1-3 2-2-1-4-3-1-1-3-4 1Z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m13 6 5 5"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  book: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 3v18M12 8h4M12 12h4"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  note: '<path d="M14 3H5v18h14V8ZM14 3v6h5M8 13h8M8 17h6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 4V3H3v13h1"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 3v4M18 5h4"/>',
  grip: '<circle cx="9" cy="5" r=".7"/><circle cx="15" cy="5" r=".7"/><circle cx="9" cy="12" r=".7"/><circle cx="15" cy="12" r=".7"/><circle cx="9" cy="19" r=".7"/><circle cx="15" cy="19" r=".7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.dumbbell}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const weight = value => Math.round(fromKg(value, state.settings.unit) * 1000) / 1000;
const unit = () => state.settings.unit;
const totalSets = routine => routine.exercises.reduce((n, exercise) => n + exercise.sets.length, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const elapsed = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const dateFormat = (date, options) => new Date(date).toLocaleDateString(undefined, options);
const listButton = (action, label, ico, extra = '', type = 'btn-secondary') => `<button class="btn ${type}" data-action="${action}" ${extra}>${ico ? icon(ico) : ''}${label}</button>`;
const iconButton = (action, label, ico, extra = '') => `<button class="icon-btn" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${icon(ico)}</button>`;

function loadState() {
  try {
    const raw = browserStorage.getItem(dataKey());
    if (raw) {
      try { return parseBackup(raw); }
      catch { unreadableBackup = raw; storageError = 'Your saved data could not be read. Download it before replacing this device’s copy.'; }
    }
  } catch { storageError = 'Browser storage is unavailable. Changes will last only while this page is open. Export a backup to keep your records.'; }
  return owner ? emptyLibrary() : createDefaultState();
}
function persist({ fromCloud = false } = {}) {
  if (unreadableBackup !== null || externalChange) { memoryUnsaved = true; updateSyncUI(); return false; }
  try {
    const backup = serializeBackup(state);
    if (owner && !fromCloud) {
      if (syncEngine?.getStatus().userId !== owner.id || !syncEngine.changed(state)) {
        memoryUnsaved = true;
        storageError = syncEngine?.getStatus().message || 'The account queue could not be saved. Export a backup before closing.';
        showStorageError(); updateSyncUI(); return false;
      }
    }
    browserStorage.setItem(dataKey(), backup);
    storageError = ''; memoryUnsaved = false;
    if (owner && !rememberOwner()) return false;
    if (owner && !fromCloud) scheduleSync();
    showStorageError(); updateSyncUI(); return true;
  } catch {
    memoryUnsaved = true;
    storageError = 'Your changes could not be saved to this browser. Export a backup before closing the page.';
    showStorageError(); updateSyncUI(); return false;
  }
}
function showStorageError() {
  const host = document.querySelector('#storage-warning');
  if (host) host.innerHTML = warning();
}
function warning() {
  if (externalChange) return '<div class="notice">Your library changed in another tab. <button data-action="reload-data">Reload the latest data</button> before making more changes. Export a backup to keep this tab’s version.</div>';
  if (!storageError) return '';
  const actions = unreadableBackup !== null
    ? `<button data-action="recover-raw">Download saved data</button> · <button data-action="reset-corrupt">${owner?'Reload saved account data':'Start a new library'}</button>`
    : '<button data-action="export">Export backup</button>';
  return `<div class="notice">${esc(storageError)} ${actions}</div>`;
}

function toast(message) {
  const target = document.querySelector('#toast'); target.textContent = message; target.classList.add('show');
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => target.classList.remove('show'), 3600);
}
function confirmAction(title, text, confirmLabel = 'Continue', danger = false) {
  return new Promise(resolve => {
    dialog.innerHTML = `<h2 id="dialog-title">${esc(title)}</h2><p>${esc(text)}</p><div class="dialog-actions">${listButton('dialog-cancel', 'Cancel', '', '', 'btn-secondary')}${listButton('dialog-confirm', esc(confirmLabel), '', '', danger ? 'btn-danger' : 'btn-primary')}</div>`;
    dialog.setAttribute('aria-labelledby', 'dialog-title');
    const close = () => { dialog.removeEventListener('close', close); resolve(dialog.returnValue === 'confirm'); };
    dialog.addEventListener('close', close); dialog.returnValue = ''; dialog.showModal();
  });
}
function unitControl() {
  return `<div class="unit-toggle" role="group" aria-label="Weight units"><button data-action="unit" data-unit="kg" class="${unit() === 'kg' ? 'selected' : ''}" aria-pressed="${unit() === 'kg'}">kg</button><button data-action="unit" data-unit="lb" class="${unit() === 'lb' ? 'selected' : ''}" aria-pressed="${unit() === 'lb'}">lb</button></div>`;
}
function render() {
  const navView = view === 'editor' ? 'workouts' : view === 'detail' ? 'history' : view;
  app.innerHTML = `<div class="app-shell"><aside class="sidebar"><a class="brand" href="#workouts" data-action="nav" data-view="workouts" aria-label="Form home"><span class="brand-symbol">${icon('logo')}</span>form<span style="color:#a398df">.</span></a><div class="brand-sub">YOUR TRAINING SPACE</div><div class="nav-label">WORKSPACE</div><nav class="nav" aria-label="Main navigation">${[['workouts','Workouts','grid'],['history','History','history'],['progress','Progress','chart'],['settings','Settings','settings']].map(([id,label,ico]) => `<button data-action="nav" data-view="${id}" class="${navView === id ? 'active' : ''}" ${navView === id ? 'aria-current="page"' : ''}>${icon(ico)}<span>${label}</span>${id === 'workouts' ? `<span class="count">${state.routines.length}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="storage-note"><span class="icon-box">${icon('lock')}</span><strong>Your space. Your progress.</strong><p>${owner ? 'Saved locally, with account sync.' : 'Saved on this device.<br>Sign in to sync across devices.'}</p></div><div class="profile"><div class="avatar">Y</div><div><span>${owner ? 'Account workspace' : 'Your workspace'}</span><small class="profile-email">${esc(owner?.email || 'Personal workout journal')}</small></div>${icon('chevron')}</div></div></aside><div class="workspace"><header class="topbar"><div class="topbar-title">${icon('grid')}<span>${({workouts:'Workout library',editor:'Workout builder',session:'Workout in progress',history:'Training history',detail:'Session details',progress:'Training progress',settings:'Workspace settings'})[view]}</span></div><div class="mobile-logo">${icon('logo')}form<span style="color:#a398df">.</span></div><div class="topbar-tools"><span id="cloud-status">${syncChip()}</span><span class="today">${icon('calendar').replace('<svg ', '<svg style="vertical-align:-3px;margin-right:6px;width:15px;height:15px" ')}${new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}</span>${unitControl()}</div></header><main id="main" class="main page-enter" tabindex="-1"><div id="storage-warning">${warning()}</div><div id="sync-warning">${syncNotice()}</div>${view !== 'session' && state.activeSession ? resumeBanner() : ''}${renderView()}</main></div></div>`;
  updateLive();
  updateSyncUI();
}
function renderView() {
  if (view === 'editor') return renderEditor();
  if (view === 'session') return state.activeSession ? renderSession() : renderWorkouts();
  if (view === 'history') return renderHistory();
  if (view === 'detail') return renderDetail();
  if (view === 'progress') return renderProgress();
  if (view === 'settings') return renderSettings();
  return renderWorkouts();
}
function heading(title, subtitle, action = '', eyebrow = '') {
  return `<div class="page-heading"><div>${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`;
}
function resumeBanner() {
  const s = state.activeSession; const stats = sessionStats(s);
  return `<div class="resume-banner"><span class="icon-box">${icon('dumbbell')}</span><div class="resume-text"><strong>${esc(s.routineName)} is in progress</strong><p>${stats.completedSets} of ${stats.totalSets} sets logged. Pick up where you left off.</p></div>${listButton('resume','Resume workout','play','','btn-primary')}</div>`;
}
function statsCards(items) {
  return `<div class="metrics">${items.map(([ico,label,value,suffix]) => `<div class="metric"><div class="metric-top">${icon(ico)}${label}</div><div class="metric-value">${value}${suffix ? `<small>${esc(suffix)}</small>` : ''}</div></div>`).join('')}</div>`;
}
function weekStart() { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
function renderWorkouts() {
  const week = state.sessions.filter(s => new Date(s.finishedAt) >= weekStart());
  const stats = week.map(s => sessionStats(s));
  return `${heading('A little stronger, every session.', 'Your plan. Your pace. A space to keep showing up.', listButton('new','New workout','plus','','btn-primary'), 'LET’S GET TO WORK')}${statsCards([['grid','Your workouts',state.routines.length,'programmed'],['calendar','Sessions this week',week.length,'sessions'],['check','Sets this week',stats.reduce((n,s)=>n+s.completedSets,0),'completed'],['dumbbell','Volume this week',fmt(fromKg(stats.reduce((n,s)=>n+s.volume,0),unit())),unit()]])}<section><div class="section-heading"><h2>Your workouts <span class="muted small" style="margin-left:5px;font-weight:450">${state.routines.length}</span></h2><span class="subtitle">${icon('book')}Ready when you are</span></div>${state.routines.length ? `<div class="routine-grid">${state.routines.map(routineCard).join('')}</div>` : emptyState('grid','Build your first workout','Add exercises, set your targets, and make a plan that works for you.',listButton('new','Create workout','plus','','btn-primary'))}</section><section class="recent-section"><div class="section-heading"><h2>Recent activity</h2>${state.sessions.length ? '<button class="small muted" data-action="nav" data-view="history">View all sessions</button>' : '<span class="subtitle">Every session counts</span>'}</div>${state.sessions.length ? `<div class="history-list">${sortedSessions().slice(0,3).map(historyRow).join('')}</div>` : `<div class="empty-activity"><div class="empty-illustration" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div><h3>Your first session is waiting.</h3><p>Start a workout and log your sets. This is where your progress becomes a story.</p></div></div>`}</section><p class="footer-note">${icon('lock')}Local recording stays available. Export a backup in Settings to keep another copy.</p>`;
}
function routineCard(routine, index) {
  return `<article class="routine-card"><div class="routine-art ${['','mint','sand'][index % 3]}"><span class="art-icon">${icon('dumbbell')}</span></div><div class="routine-content"><div class="routine-title"><h3>${esc(routine.name)}</h3>${iconButton('edit','Edit ' + routine.name,'edit',`data-id="${esc(routine.id)}"`)}</div><p class="routine-description">${esc(routine.description || 'A workout built around you.')}</p><div class="routine-meta"><span>${icon('grid')}${plural(routine.exercises.length,'exercise')}</span><span>${icon('dumbbell')}${plural(totalSets(routine),'set')}</span></div><ul class="exercise-preview">${routine.exercises.slice(0,3).map(e=>`<li><span class="exercise-dot"></span><span class="exercise-name">${esc(e.name)}</span><span class="exercise-sets">${plural(e.sets.length,'set')} × ${[...new Set(e.sets.map(s=>s.reps))].join('/')} reps</span></li>`).join('')}${routine.exercises.length>3 ? `<li class="more">+ ${routine.exercises.length-3} more ${routine.exercises.length-3===1?'exercise':'exercises'}</li>` : ''}</ul><div class="routine-actions">${listButton('start','Start workout','play',`data-id="${esc(routine.id)}"`,'btn-primary')}${iconButton('copy','Duplicate ' + routine.name,'copy',`data-id="${esc(routine.id)}"`)}</div></div></article>`;
}
function emptyState(ico,title,description,action='') { return `<div class="empty-state"><span class="icon-box">${icon(ico)}</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</div>`; }
function renderEditor() {
  return `<button class="back-button" data-action="nav" data-view="workouts">${icon('back')}Workout library</button><div class="page-heading"><div class="editor-title"><span class="icon-box">${icon('dumbbell')}</span><div><h1>${state.routines.some(r=>r.id===draft.id) ? 'Make it your workout.' : 'Build your next session.'}</h1><div class="editor-meta">Exercise order · Set targets · The details that matter</div></div></div></div><form id="editor-form"><div class="editor-layout"><div class="editor-form"><div class="section-heading"><h2>Exercises</h2><span class="subtitle">${plural(draft.exercises.length,'exercise')} · ${plural(totalSets(draft),'set')}</span></div><div id="exercise-list">${draft.exercises.map(editorExercise).join('')}</div><button type="button" class="add-exercise" data-action="add-exercise">${icon('plus')}Add exercise</button><div class="editor-footer"><span class="save-status">${dirty ? 'Unsaved changes' : 'Set it up. Make it yours.'}</span><div class="actions">${listButton('nav','Cancel','', 'type="button" data-view="workouts"')}${listButton('save','Save workout','check','type="button"','btn-primary')}</div></div></div><aside class="editor-aside"><section class="panel"><h3>Workout details</h3><label class="field"><span>Workout name</span><input class="input input-name" data-field="name" value="${esc(draft.name)}" maxlength="200" required aria-label="Workout name" placeholder="e.g. Upper body" /></label><label class="field"><span>Description</span><textarea class="input input-note" data-field="description" maxlength="10000" placeholder="What’s the focus?" aria-label="Workout description">${esc(draft.description)}</textarea></label>${state.routines.some(r=>r.id===draft.id) ? `<button type="button" class="delete-link" data-action="delete-routine" data-id="${esc(draft.id)}">${icon('trash')}Delete workout</button>` : ''}</section><section class="tip">${icon('sparkle')}<strong>A plan with room to grow.</strong><p>Move exercises into your preferred order. Set a different weight or rep target for each set, then record what actually happened when you train.</p></section><p class="panel-help">Weights shown in <strong>${unit()}</strong>. Set 0 for bodyweight or an unweighted exercise. Rest is in seconds.</p></aside></div><datalist id="exercise-suggestions">${['Bench press','Squat','Deadlift','Romanian deadlift','Overhead press','Lat pulldown','Bent-over row','Pull-up','Push-up','Biceps curl','Triceps extension','Leg press','Leg curl','Calf raise','Hip thrust','Reverse lunge','Goblet squat','Dumbbell bench press','Seated cable row','Lateral raise','Plank'].map(n=>`<option value="${n}"></option>`).join('')}</datalist></form>`;
}
function editorExercise(exercise, index) {
  const eid = esc(exercise.id);
  return `<section class="panel exercise-editor" data-exercise="${eid}"><div class="exercise-heading"><span class="drag-handle" draggable="true" data-drag="${eid}" title="Drag to reorder" aria-hidden="true">${icon('grip')}</span><span class="ordinal">${index+1}</span><input class="input input-name" data-field="exercise-name" data-eid="${eid}" value="${esc(exercise.name)}" list="exercise-suggestions" required maxlength="200" placeholder="Exercise name" aria-label="Exercise ${index+1} name" /><div class="exercise-controls">${iconButton('move-up','Move ' + exercise.name + ' up','up',`type="button" data-eid="${eid}" ${index===0?'disabled':''}`)}${iconButton('move-down','Move ' + exercise.name + ' down','down',`type="button" data-eid="${eid}" ${index===draft.exercises.length-1?'disabled':''}`)}${iconButton('remove-exercise','Remove ' + exercise.name,'trash',`type="button" data-eid="${eid}"`)}</div></div><table class="set-table"><thead><tr><th scope="col">Set</th><th scope="col">Reps</th><th scope="col">Weight (${unit()})</th><th scope="col">Rest (s)</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>${exercise.sets.map((s,i)=>`<tr><td>${i+1}</td>${[['reps',s.reps,1,100000,1],['weight',weight(s.weight),0,fromKg(100000,unit()),'any'],['rest',s.rest,0,86400,1]].map(([field,value,min,max,step])=>`<td><input type="number" class="input" inputmode="decimal" data-field="set-${field}" data-eid="${eid}" data-sid="${esc(s.id)}" value="${value}" min="${min}" max="${max}" step="${step}" ${field==='weight'?`data-weight-unit="${unit()}"`:''} required aria-label="${esc(exercise.name)} set ${i+1} ${field}${field==='weight'?' in '+unit():''}" /></td>`).join('')}<td>${iconButton('remove-set',`Remove ${exercise.name} set ${i+1}`,'close',`type="button" data-eid="${eid}" data-sid="${esc(s.id)}" ${exercise.sets.length===1?'disabled':''}`)}</td></tr>`).join('')}</tbody></table><button class="add-set" type="button" data-action="add-set" data-eid="${eid}">${icon('plus')}Add set</button><div class="exercise-note">${icon('note')}<textarea rows="1" data-field="exercise-notes" data-eid="${eid}" maxlength="10000" placeholder="Cues, tempo, or anything to remember…" aria-label="${esc(exercise.name)} notes">${esc(exercise.notes)}</textarea></div></section>`;
}
function renderSession() {
  const s = state.activeSession, stats = sessionStats(s);
  return `<button class="back-button" data-action="nav" data-view="workouts">${icon('back')}Workout library · Session saves automatically</button>${heading(s.routineName,'One set at a time. Log what you do, then check it off.',listButton('finish','Finish workout','check','','btn-primary session-finish'),'YOU’RE SHOWING UP')}<form id="session-form"><div class="session-layout"><div>${s.exercises.map(sessionExercise).join('')}<section class="panel"><label class="field"><span>Session notes</span><textarea class="input input-note" data-field="session-notes" maxlength="10000" placeholder="How did it feel? Any wins or things to change?" aria-label="Session notes">${esc(s.notes)}</textarea></label></section><button type="button" class="delete-link" data-action="discard-session">${icon('close')}Discard this session</button></div><aside class="editor-aside"><section class="panel"><h3>Session progress</h3><div class="session-progress"><i id="progress-fill" style="width:${stats.totalSets?stats.completedSets/stats.totalSets*100:0}%"></i></div><div class="session-stats"><div><strong id="set-count">${stats.completedSets}<span> / ${stats.totalSets}</span></strong><span>sets completed</span></div><div><strong id="elapsed-time">${elapsed(stats.elapsedSeconds)}</strong><span>elapsed time</span></div></div></section><section class="panel"><h3>Rest timer</h3><div class="timer-display" id="rest-time" role="timer">Ready</div><div class="rest-actions">${listButton('rest-add','+ 30s','','type="button"','btn-soft')}${listButton('rest-stop','Skip','','type="button"','btn-secondary')}</div></section><section class="tip">${icon('note')}<strong>Record the real thing.</strong><p>Your targets are a starting point. Change reps and weight to match the set you did. Checking a set starts its rest timer.</p></section></aside></div></form>`;
}
function sessionExercise(exercise,index) {
  return `<section class="panel session-exercise" data-exercise="${esc(exercise.id)}"><div class="exercise-heading"><span class="ordinal">${index+1}</span><h3>${esc(exercise.name)}</h3><p>${plural(exercise.sets.length,'set')}</p></div>${exercise.notes?`<p class="session-exercise-note details-description">${esc(exercise.notes)}</p>`:''}<table class="set-table"><thead><tr><th scope="col">Set</th><th scope="col">Target</th><th scope="col">${unit()}</th><th scope="col">Reps</th><th scope="col">Done</th></tr></thead><tbody>${exercise.sets.map((s,i)=>`<tr class="${s.completed?'completed':''}"><td>${i+1}</td><td><span class="target-value">${fmt(fromKg(s.targetWeight,unit()))} ${unit()} × ${s.targetReps}</span></td><td><input class="input" type="number" inputmode="decimal" value="${weight(s.weight)}" min="0" max="${fromKg(100000,unit())}" step="any" required data-weight-unit="${unit()}" data-field="actual-weight" data-eid="${esc(exercise.id)}" data-sid="${esc(s.id)}" aria-label="${esc(exercise.name)} set ${i+1} actual weight in ${unit()}" /></td><td><input class="input" type="number" inputmode="numeric" value="${s.reps}" min="0" max="100000" step="1" required data-field="actual-reps" data-eid="${esc(exercise.id)}" data-sid="${esc(s.id)}" aria-label="${esc(exercise.name)} set ${i+1} actual reps" /></td><td><button type="button" class="check-set ${s.completed?'checked':''}" data-action="complete-set" data-eid="${esc(exercise.id)}" data-sid="${esc(s.id)}" aria-label="${esc(exercise.name)} set ${i+1} complete" aria-pressed="${s.completed}">${icon('check')}</button></td></tr>`).join('')}</tbody></table><div class="exercise-note">${icon('note')}<textarea rows="1" data-field="actual-notes" data-eid="${esc(exercise.id)}" maxlength="10000" placeholder="Exercise notes…" aria-label="${esc(exercise.name)} session notes">${esc(exercise.notes)}</textarea></div></section>`;
}
const sortedSessions = () => [...state.sessions].sort((a,b)=>Date.parse(b.finishedAt)-Date.parse(a.finishedAt));
function historyRow(s) {
  const stats = sessionStats(s);
  return `<button class="history-row" data-action="detail" data-id="${esc(s.id)}"><div class="history-date">${dateFormat(s.finishedAt,{month:'short'})}<strong>${dateFormat(s.finishedAt,{day:'numeric'})}</strong></div><div class="history-title"><strong>${esc(s.routineName)}</strong><p>${plural(stats.completedSets,'set')} completed · ${plural(Math.round(stats.elapsedSeconds/60),'minute')} · ${dateFormat(s.finishedAt,{year:'numeric'})}</p></div><div class="history-stat">${fmt(fromKg(stats.volume,unit()))} ${unit()}<small>total volume</small></div>${icon('chevron')}</button>`;
}
function renderHistory() {
  return `${heading('The work you’ve put in.','Every recorded session, all in one place.',listButton('nav','Back to workouts','grid','data-view="workouts"'))}${state.sessions.length?`<div class="section-heading"><h2>All sessions</h2><span class="subtitle">${plural(state.sessions.length,'workout')} logged</span></div><div class="history-list">${sortedSessions().map(historyRow).join('')}</div>`:emptyState('history','Your story starts with a session.','Complete a workout to see your sets, weights, and session notes here.',listButton('nav','Find a workout','dumbbell','data-view="workouts"','btn-primary'))}`;
}
function renderDetail() {
  const s = state.sessions.find(s=>s.id===detailId); if(!s) return renderHistory();
  const stats = sessionStats(s);
  return `<button class="back-button" data-action="nav" data-view="history">${icon('back')}All sessions</button>${heading(s.routineName,dateFormat(s.finishedAt,{weekday:'long',year:'numeric',month:'long',day:'numeric'}),'','SESSION COMPLETE')}${statsCards([['clock','Duration',Math.round(stats.elapsedSeconds/60),'min'],['check','Completed sets',stats.completedSets,`of ${stats.totalSets}`],['dumbbell','Total volume',fmt(fromKg(stats.volume,unit())),unit()],['grid','Exercises',s.exercises.length,'in session']])}${s.exercises.map(e=>`<section class="panel session-exercise history-detail"><h3>${esc(e.name)}</h3>${e.notes?`<p class="session-exercise-note details-description">${esc(e.notes)}</p>`:''}<table class="set-table"><thead><tr><th scope="col">Set</th><th scope="col">Planned</th><th scope="col">Recorded</th><th scope="col">Status</th></tr></thead><tbody>${e.sets.map((set,i)=>`<tr><td>${i+1}</td><td class="muted">${fmt(fromKg(set.targetWeight,unit()))} ${unit()} × ${set.targetReps}</td><td>${set.completed?`${fmt(fromKg(set.weight,unit()))} ${unit()} × ${set.reps}`:'—'}</td><td><span class="${set.completed?'completed-label':'muted'}">${set.completed?'Done':'Skipped'}</span></td></tr>`).join('')}</tbody></table></section>`).join('')}${s.notes?`<section class="panel"><h3>Session notes</h3><p class="small muted details-description">${esc(s.notes)}</p></section>`:''}`;
}
function renderProgress() {
  const stats = state.sessions.map(s=>sessionStats(s));
  const volume = stats.reduce((n,s)=>n+s.volume,0);
  const weeks = Array.from({length:6},(_,i)=>{const start=new Date(weekStart()); start.setDate(start.getDate()-(5-i)*7); const end=new Date(start);end.setDate(end.getDate()+7);const sessions=state.sessions.filter(s=>new Date(s.finishedAt)>=start&&new Date(s.finishedAt)<end);return {start,sessions,volume:sessions.reduce((n,s)=>n+sessionStats(s).volume,0)};});
  const max = Math.max(1,...weeks.map(w=>w.sessions.length));
  return `${heading('See the bigger picture.','Small efforts add up. Here’s what you’ve recorded so far.')}${statsCards([['history','Total workouts',state.sessions.length,'logged'],['check','Completed sets',stats.reduce((n,s)=>n+s.completedSets,0),'sets'],['dumbbell','Total volume',fmt(fromKg(volume,unit())),unit()],['clock','Training time',Math.round(stats.reduce((n,s)=>n+s.elapsedSeconds,0)/60),'min']])}${state.sessions.length?`<section class="panel chart-panel"><div class="section-heading"><h2>Your consistency</h2><span class="subtitle">Sessions · Last 6 weeks</span></div><div class="chart" role="img" aria-label="Sessions per week: ${weeks.map(w=>`${dateFormat(w.start,{month:'short',day:'numeric'})}: ${w.sessions.length}`).join(', ')}">${weeks.map(w=>`<div class="chart-column"><div class="chart-bar" style="height:${Math.max(3,w.sessions.length/max*120)}px"><b>${w.sessions.length}</b></div><span>${dateFormat(w.start,{month:'short',day:'numeric'})}</span></div>`).join('')}</div></section>`:emptyState('chart','Progress begins with showing up.','Your completed sessions will build a picture of your consistency, training time, and total volume.',listButton('nav','Plan your next session','dumbbell','data-view="workouts"','btn-primary'))}<p class="footer-note">Volume is the sum of completed reps × weight. Bodyweight sets contribute 0 weighted volume.</p>`;
}
function renderSettings() {
  return `${heading('Make yourself at home.','Your training space, ready here and wherever you sign in.')}${accountPanel()}<div class="settings-grid"><section class="panel"><span class="icon-box" style="margin-bottom:18px">${icon('dumbbell')}</span><h3>Weight preferences</h3><p>Switch between kilograms and pounds. Your saved weights convert automatically.</p><div class="settings-unit"><span>Display weight in</span>${unitControl()}</div></section><section class="panel"><span class="icon-box" style="margin-bottom:18px">${icon('download')}</span><h3>Export a backup</h3><p>Download this library’s workouts, session history, and current session as a JSON file. Keep a regular copy, including before changing sync versions.</p>${listButton('export','Download backup','download','','btn-primary')}</section><section class="panel"><span class="icon-box" style="margin-bottom:18px">${icon('upload')}</span><h3>Restore your data</h3><p>Restore a previous backup into the open library. If you are using an account, the replacement is queued for that account’s next sync.</p>${listButton('import','Choose backup file','upload')}</section><section class="panel"><span class="icon-box" style="margin-bottom:18px">${icon('lock')}</span><h3>Your records belong to you.</h3><p>Account records are private to your sign-in. Local copies and pending changes stay in this browser. Clearing site data can remove changes that have not synced, so export a backup first.</p><p class="small" style="margin:0">Form · Your workout journal</p></section></div>`;
}

async function navigate(next) {
  if (dirty && !(await confirmAction('Leave the workout builder?','Your unsaved programme changes will be lost. Your recorded sessions will stay saved.','Leave builder'))) return;
  draft=null;draftBaseState=null;dirty=false;deferredRender=false;view=next;render();window.scrollTo({top:0});
}
function editRoutine(routine) { draftBaseState=structuredClone(state);draft=structuredClone(routine);dirty=false;view='editor';render();window.scrollTo({top:0}); }
function validFields() { const form=document.querySelector('#editor-form, #session-form');return !form||form.reportValidity(); }
function markDirty() { dirty=true;const label=document.querySelector('.save-status');if(label)label.textContent='Unsaved changes'; }
function saveRoutine() {
  if(!validFields())return false;
  draft.name=draft.name.trim();draft.exercises.forEach(e=>e.name=e.name.trim());
  if(!draft.name||draft.exercises.some(e=>!e.name)) {toast('Give your workout and every exercise a name.');return false;}
  if(!draft.exercises.length) {toast('Add at least one exercise before saving.');return false;}
  try {
    const base = draftBaseState || structuredClone(state);
    const edited = structuredClone(base);
    const index = edited.routines.findIndex(r=>r.id===draft.id);
    if(index<0) edited.routines.push(draft); else edited.routines[index]=draft;
    const merged = mergeStates(base, validateState(edited), state);
    let copied = false;
    if (merged.conflicts.length) {
      const next = structuredClone(state);
      const deviceCopy = structuredClone(draft);
      deviceCopy.id = uid(); deviceCopy.name = `${deviceCopy.name.slice(0,180)} (device copy)`;
      deviceCopy.exercises.forEach(e=>{e.id=uid();e.sets.forEach(set=>set.id=uid());});
      next.routines.push(deviceCopy); state=validateState(next); copied=true;
    } else state=merged.state;
    persist();draft=null;draftBaseState=null;dirty=false;deferredRender=false;view='workouts';render();scheduleSync();
    toast(memoryUnsaved ? 'Workout ready in this tab. Export a backup to keep your changes.' : copied ? 'Another version changed. Your edit is saved as a device copy.' : 'Workout saved on this device.');return true;
  }
  catch(error){toast(error.message);return false;}
}
function moveExercise(eid,direction) {
  const index=draft.exercises.findIndex(e=>e.id===eid);const target=index+direction;
  if(index<0||target<0||target>=draft.exercises.length)return;
  const [exercise]=draft.exercises.splice(index,1);draft.exercises.splice(target,0,exercise);markDirty();render();
}
function downloadFile(content,name) {
  const link=document.createElement('a');const url=URL.createObjectURL(new Blob([content],{type:'application/json'}));link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportBackup() { try {downloadFile(serializeBackup(state),`form-backup-${new Date().toISOString().slice(0,10)}.json`);toast('Backup downloaded. Keep it somewhere safe.');}catch(error){toast(error.message);} }

// Inputs update drafts immediately. Session values save after each valid change.
document.addEventListener('input',event=>{
  const input=event.target;if(input.id==='signin-email'){signInEmail=input.value;return;}const field=input.dataset.field;if(!field)return;
  if(view==='editor'&&draft){
    if(field==='name'||field==='description')draft[field]=input.value;
    else{const ex=draft.exercises.find(e=>e.id===input.dataset.eid);if(!ex)return;
      if(field==='exercise-name')ex.name=input.value;else if(field==='exercise-notes')ex.notes=input.value;
      else{const set=ex.sets.find(s=>s.id===input.dataset.sid);if(!set)return;const key=field.replace('set-','');set[key]=input.value===''?NaN:key==='weight'?toKg(Number(input.value),input.dataset.weightUnit || unit()):Number(input.value);}
    }markDirty();
  }else if(state.activeSession&&view==='session'){
    if(field==='session-notes')state.activeSession.notes=input.value;
    else {const ex=state.activeSession.exercises.find(e=>e.id===input.dataset.eid);if(!ex)return;
      if(field==='actual-notes')ex.notes=input.value;
      else{if(!input.validity.valid||input.value==='')return;const set=ex.sets.find(s=>s.id===input.dataset.sid);if(!set)return;const key=field.replace('actual-','');set[key]=key==='weight'?toKg(Number(input.value),input.dataset.weightUnit || unit()):Number(input.value);}
    }persist();updateLive();
  }
});
document.addEventListener('submit',event=>{event.preventDefault();if(event.target.id==='signin-form')sendSignInLink();});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
  event.preventDefault();const {action,id,eid,sid}=button.dataset;
  if(action==='dialog-cancel'){dialog.close('cancel');return;}
  if(action==='dialog-confirm'){dialog.close('confirm');return;}
  if(await handleSyncAction(action,button))return;
  if(action==='nav'){await navigate(button.dataset.view);return;}
  if(action==='resume'){await navigate('session');return;}
  if(action==='unit'){
    if(!validFields())return;
    state.settings.unit=button.dataset.unit;persist();render();return;
  }
  if(action==='new'){
    if(dirty&&!(await confirmAction('Leave the workout builder?','Your unsaved changes will be lost.','Leave builder')))return;
    const routine=createRoutine('');routine.exercises=[createExercise('')];editRoutine(routine);return;
  }
  if(action==='edit'){const r=state.routines.find(r=>r.id===id);if(r)editRoutine(r);return;}
  if(action==='save'){saveRoutine();return;}
  if(action==='add-exercise'){
    if(draft.exercises.length>=200){toast('This workout has reached the 200 exercise limit.');return;}
    draft.exercises.push(createExercise(''));markDirty();render();const inputs=document.querySelectorAll('[data-field="exercise-name"]');inputs[inputs.length-1]?.focus();return;
  }
  if(action==='add-set'){
    const ex=draft.exercises.find(e=>e.id===eid);if(!ex)return;if(ex.sets.length>=100){toast('An exercise can have up to 100 sets.');return;}
    ex.sets.push({...ex.sets.at(-1),id:uid()});markDirty();render();return;
  }
  if(action==='remove-set'){const ex=draft.exercises.find(e=>e.id===eid);if(ex&&ex.sets.length>1){ex.sets=ex.sets.filter(s=>s.id!==sid);markDirty();render();}return;}
  if(action==='remove-exercise'){
    const ex=draft.exercises.find(e=>e.id===eid);if(!ex)return;
    if(ex.name&&!(await confirmAction('Remove this exercise?',`${ex.name} and its set targets will be removed from this programme draft.`,'Remove exercise')))return;
    draft.exercises=draft.exercises.filter(e=>e.id!==eid);markDirty();render();return;
  }
  if(action==='move-up'||action==='move-down'){moveExercise(eid,action==='move-up'?-1:1);return;}
  if(action==='copy'){
    const source=state.routines.find(r=>r.id===id);if(!source)return;
    const copy=structuredClone(source);copy.id=uid();copy.name=`${copy.name.slice(0,185)} (copy)`;copy.exercises.forEach(e=>{e.id=uid();e.sets.forEach(s=>s.id=uid());});
    editRoutine(copy);markDirty();toast('A fresh copy. Make it your own, then save.');return;
  }
  if(action==='delete-routine'){
    const actionOwner=owner?.id||null;
    if(!(await confirmAction('Delete this workout?','This removes the programme from your library. Your recorded sessions stay in History. Export a backup first if you want to keep the programme.','Delete workout',true)))return;
    if((owner?.id||null)!==actionOwner){safeRender();toast('The open library changed. Nothing was deleted.');return;}
    state.routines=state.routines.filter(r=>r.id!==id);persist();dirty=false;draft=null;view='workouts';render();toast(memoryUnsaved?'Workout removed in this tab. Export a backup to keep your changes.':'Workout deleted. Your history is still here.');return;
  }
  if(action==='start'){
    if(state.activeSession){toast('You have a session in progress. Finish or discard it first.');view='session';render();return;}
    const routine=state.routines.find(r=>r.id===id);if(!routine)return;
    if(!routine.exercises.length||routine.exercises.some(e=>!e.sets.length)){toast('Add exercises and set targets before starting.');editRoutine(routine);return;}
    try{state.activeSession=startSession(routine);persist();view='session';render();window.scrollTo({top:0});}catch(error){toast(error.message);}return;
  }
  if(action==='complete-set'){
    const row=button.closest('tr');if([...row.querySelectorAll('input')].some(input=>!input.reportValidity()))return;
    const set=state.activeSession?.exercises.find(e=>e.id===eid)?.sets.find(s=>s.id===sid);if(!set)return;set.completed=!set.completed;
    if(set.completed&&set.rest>0)restUntil=Date.now()+set.rest*1000;
    persist();button.classList.toggle('checked',set.completed);button.setAttribute('aria-pressed',String(set.completed));row.classList.toggle('completed',set.completed);updateLive();return;
  }
  if(action==='finish'){
    if(!state.activeSession||!validFields())return;const sessionId=state.activeSession.id;const actionOwner=owner?.id||null;const stats=sessionStats(state.activeSession);
    if(!stats.completedSets){toast('Log at least one set before finishing your workout.');return;}
    if(!(await confirmAction('A session worth recording.',`${stats.completedSets} of ${stats.totalSets} sets completed. Save this workout to your history? Any unchecked sets will be marked as skipped.`,'Save session')))return;
    if((owner?.id||null)!==actionOwner||state.activeSession?.id!==sessionId){safeRender();toast('The active workout changed on another device. Review the current session before continuing.');return;}
    try{const session=finishSession(state.activeSession);state.sessions.push(session);state.activeSession=null;restUntil=0;persist();view='detail';detailId=session.id;render();window.scrollTo({top:0});toast(memoryUnsaved?'Session recorded in this tab. Export a backup to keep it.':'Session saved. Good work showing up.');}catch(error){toast(error.message);}return;
  }
  if(action==='discard-session'){
    const actionOwner=owner?.id||null;const sessionId=state.activeSession?.id;if(!sessionId){safeRender();return;}
    if(!(await confirmAction('Discard this session?','The sets and notes recorded in this session will be removed. Your workout programme stays in your library.','Discard session',true)))return;
    if((owner?.id||null)!==actionOwner||state.activeSession?.id!==sessionId){safeRender();toast('The active workout changed on another device. Nothing was discarded.');return;}
    state.activeSession=null;restUntil=0;persist();view='workouts';render();return;
  }
  if(action==='detail'){detailId=id;view='detail';render();window.scrollTo({top:0});return;}
  if(action==='rest-add'){restUntil=Math.max(Date.now(),restUntil)+30000;updateLive();return;}
  if(action==='rest-stop'){restUntil=0;updateLive();return;}
  if(action==='export'){exportBackup();return;}
  if(action==='import'){document.querySelector('#backup-file').click();return;}
  if(action==='recover-raw'){downloadFile(unreadableBackup,'form-saved-data-recovery.json');return;}
  if(action==='reset-corrupt'){
    if(!(await confirmAction(owner?'Reload the saved account library?':'Start a new library?',owner?'This replaces the unreadable device copy with the saved sync queue. Download the unreadable data first if you want to keep it.':'This replaces unreadable browser data. Download it first if you want to try recovering it later.',owner?'Reload account data':'Start new library',true)))return;
    unreadableBackup=null;if(owner&&syncEngine.hasAccount(owner.id)){await syncEngine.connect(owner.id);}else{state=owner?emptyLibrary():createDefaultState();persist();}view=state.activeSession?'session':'workouts';render();return;
  }
  if(action==='reload-data'){
    if((dirty||memoryUnsaved)&&!(await confirmAction('Load the other tab’s data?','Unsaved changes and records held only in this tab will be lost. Export a backup first if you want to keep them.','Reload data')))return;
    dirty=false;memoryUnsaved=false;window.location.reload();return;
  }
});
document.querySelector('#backup-file').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  const importOwner=owner?.id||null;
  try{
    if(file.size>20*1024*1024)throw new Error('Choose a backup smaller than 20 MB.');
    const incoming=parseBackup(await file.text());
    if((owner?.id||null)!==importOwner){toast('The open library changed. Choose the backup again in the intended library.');return;}
    if(!(await confirmAction('Restore this backup?',`Replace the open ${owner?'account':'device'} library with ${plural(incoming.routines.length,'workout')} and ${plural(incoming.sessions.length,'recorded session')}? Download a backup first. ${owner?'This replacement will also be queued for your account sync.':''}`,'Replace data')))return;
    if((owner?.id||null)!==importOwner){toast('The open library changed. Nothing was replaced.');return;}
    state=incoming;unreadableBackup=null;externalChange=false;storageError='';draft=null;draftBaseState=null;dirty=false;restUntil=0;persist();view=state.activeSession?'session':'workouts';render();toast(memoryUnsaved?'Backup opened in this tab. Browser storage is unavailable; export to keep changes.':'Backup restored. Your training space is ready.');
  }catch(error){toast(error.message);}
});
// Native drag reordering has keyboard/touch alternatives on every exercise card.
document.addEventListener('dragstart',event=>{
  const handle=event.target.closest('[data-drag]');if(!handle)return;dragId=handle.dataset.drag;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',dragId);handle.closest('.exercise-editor').classList.add('dragging');
});
document.addEventListener('dragover',event=>{const target=event.target.closest('.exercise-editor');if(!target||!dragId)return;event.preventDefault();document.querySelectorAll('.drag-over').forEach(e=>e.classList.remove('drag-over'));target.classList.add('drag-over');});
document.addEventListener('drop',event=>{const target=event.target.closest('.exercise-editor');if(!target||!dragId)return;event.preventDefault();const from=draft.exercises.findIndex(e=>e.id===dragId);const to=draft.exercises.findIndex(e=>e.id===target.dataset.exercise);if(from>=0&&to>=0){const [ex]=draft.exercises.splice(from,1);draft.exercises.splice(to,0,ex);markDirty();}dragId=null;render();});
document.addEventListener('dragend',()=>{dragId=null;document.querySelectorAll('.dragging,.drag-over').forEach(e=>e.classList.remove('dragging','drag-over'));});
function updateLive() {
  if(view!=='session'||!state.activeSession)return;
  const stats=sessionStats(state.activeSession);const timer=document.querySelector('#elapsed-time');if(timer)timer.textContent=elapsed(stats.elapsedSeconds);
  const count=document.querySelector('#set-count');if(count)count.innerHTML=`${stats.completedSets}<span> / ${stats.totalSets}</span>`;
  const fill=document.querySelector('#progress-fill');if(fill)fill.style.width=`${stats.totalSets?stats.completedSets/stats.totalSets*100:0}%`;
  const rest=document.querySelector('#rest-time');if(rest)rest.textContent=restUntil?elapsed(Math.max(0,Math.ceil((restUntil-Date.now())/1000))):'Ready';
  if(restUntil&&restUntil<=Date.now()){restUntil=0;if(rest)rest.textContent='All rested';toast('Rest complete. Ready for your next set.');}
}
setInterval(updateLive,1000);
window.addEventListener('beforeunload',event=>{if(dirty||memoryUnsaved){event.preventDefault();event.returnValue='';}});
window.addEventListener('storage',event=>{
  const ownQueue = owner ? SYNC_PREFIX + encodeURIComponent(owner.id) : null;
  if(event.key!==dataKey()&&event.key!==ownQueue&&event.key!==OWNER_KEY)return;
  externalChange=true;showStorageError();updateSyncUI();
});
document.addEventListener('focusout',()=>setTimeout(flushDeferredRender,0));
dialog.addEventListener('close',()=>setTimeout(()=>{flushDeferredRender();scheduleSync();},0));
window.addEventListener('online',()=>{updateSyncUI();initializeCloud();scheduleSync(200);});
window.addEventListener('offline',updateSyncUI);
window.addEventListener('focus',()=>{flushDeferredRender();scheduleSync(200);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){flushDeferredRender();scheduleSync(200);}});
setInterval(()=>{if(!document.hidden)runSync(false);},30000);

function loadOwner() {
  try {
    const raw = browserStorage.getItem(OWNER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,200}$/.test(value.id)) throw new Error('Invalid saved account');
    return { id: value.id, email: typeof value.email === 'string' ? value.email.slice(0,320) : '' };
  } catch {
    storageError = 'The saved account could not be identified. Sign in again to find its records, or export this device’s library.';
    return null;
  }
}
function dataKey(id = owner?.id) { return id ? `${KEY}:account:${encodeURIComponent(id)}` : KEY; }
function hasSavedData(key) { try { return browserStorage.getItem(key) !== null; } catch { return false; } }
function emptyLibrary() { return { schemaVersion: 1, settings: { unit: 'kg' }, routines: [], sessions: [], activeSession: null }; }
function rememberOwner() {
  try {
    if (owner) browserStorage.setItem(OWNER_KEY, JSON.stringify(owner));
    else browserStorage.removeItem(OWNER_KEY);
    return true;
  } catch {
    memoryUnsaved = true;
    storageError = 'Your account selection could not be saved on this device. Export a backup before closing.';
    showStorageError();
    return false;
  }
}
function cloudConfigured() { return Boolean(cloudConfig?.url && cloudConfig?.publishableKey); }
function matchingAccount() { return Boolean(owner && cloud && confirmedUserId === owner.id && syncEngine?.getStatus().userId === owner.id); }
function fieldFocused() { return document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]') || false; }
function sessionFieldsValid() {
  return [...document.querySelectorAll('#session-form input, #session-form textarea')].every(input => input.checkValidity());
}
function syncDescription() {
  if (memoryUnsaved) return { label: 'Backup needed', tone: 'warning', message: 'Some changes could not be saved on this device. Export a backup before closing.' };
  if (externalChange || syncStatus.code === 'other-tab') return { label: 'Reload needed', tone: 'warning', message: 'Another tab changed your library. Export this tab’s records, then reload the latest data.' };
  if (pendingAccount && authUser) return { label: 'Open account', tone: 'pending', message: 'You are signed in. Open your account library in Settings when you are ready.' };
  if (!owner) {
    if (cloudStarting) return { label: 'Connecting…', tone: 'neutral', message: 'Local recording is ready while cloud sign-in starts.' };
    return { label: cloudConfigured() ? 'Sign in to sync' : 'Device only', tone: 'neutral', message: cloudError || 'Your workouts are saved in this browser. Sign in to use the same library across devices.' };
  }
  if (syncStatus.phase === 'error') return { label: 'Sync needs attention', tone: 'warning', message: syncStatus.message || 'Sync needs attention. Export a backup before reloading.' };
  if (syncStatus.conflict) return { label: 'Choose a version', tone: 'warning', message: 'Changes on two devices need your choice. Both versions are retained on this device.' };
  if (!navigator.onLine) return { label: syncStatus.pending ? 'Offline · pending' : 'Offline', tone: 'pending', message: 'Keep recording. Your changes stay on this device and sync can resume when you reconnect.' };
  if (confirmedUserId !== owner.id) return { label: cloudStarting ? 'Restoring sign-in…' : 'Sign in to sync', tone: 'pending', message: 'Your account library is available on this device. Sign in to the same account to resume syncing.' };
  if (cloudError) return { label: 'Sync unavailable', tone: 'warning', message: cloudError };
  if (syncStatus.phase === 'syncing') return { label: 'Syncing…', tone: 'syncing', message: 'Checking your latest workouts…' };
  if (syncStatus.phase === 'offline') return { label: 'Saved on device', tone: 'pending', message: 'Cloud sync is unavailable. Your changes stay here. It may be a connection issue or a paused project; sync will retry when available.' };
  if (syncStatus.pending) return { label: 'Waiting to sync', tone: 'pending', message: dirty ? 'Your recorded changes are saved locally. Save or leave the workout builder to sync.' : 'Your changes are saved on this device and waiting to sync.' };
  if (syncStatus.lastSyncedAt) return { label: 'Up to date', tone: 'success', message: `Last synced ${new Date(syncStatus.lastSyncedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}.` };
  return { label: 'Ready to sync', tone: 'neutral', message: 'Ready to check for your latest workouts.' };
}
function syncChip() {
  const status = syncDescription();
  return `<button class="sync-chip ${status.tone}" data-action="sync-settings" title="${esc(status.message)}" aria-label="Sync status: ${esc(status.label)}. Open Settings.">${icon(status.tone === 'success' ? 'check' : 'cloud')}<span>${esc(status.label)}</span></button>`;
}
function syncNotice() {
  if (externalChange || memoryUnsaved) return '';
  if (syncStatus.conflict) return `<div class="notice sync-notice"><strong>Changes on two devices need your choice.</strong> Download or compare the saved versions in <button data-action="sync-settings">Settings</button>.</div>`;
  if (owner && (syncStatus.phase === 'offline' || !navigator.onLine || confirmedUserId !== owner.id || syncStatus.phase === 'error')) {
    return `<div class="notice sync-notice">${esc(syncDescription().message)} <button data-action="sync-settings">Sync settings</button></div>`;
  }
  if (deferredRender) return '<div class="sync-update-note">Updates are ready. Finish this field or save your programme to refresh the view.</div>';
  return '';
}
function syncStatusMarkup() {
  const status = syncDescription();
  return `<div class="account-sync-label ${status.tone}">${icon(status.tone === 'success' ? 'check' : 'cloud')}<strong>${esc(status.label)}</strong></div><p class="sync-description">${esc(status.message)}</p>`;
}
function snapshotSummary(snapshot) {
  const completed = snapshot.sessions.reduce((n,s) => n + sessionStats(s).completedSets, 0);
  return `${plural(snapshot.routines.length,'workout')} · ${plural(snapshot.sessions.length,'recorded session')} · ${plural(completed,'logged set')}${snapshot.activeSession ? ' · workout in progress' : ''}`;
}
function conflictMarkup() {
  const conflict = syncEngine?.getConflict();
  if (!conflict) return '';
  return `<section class="sync-conflict"><h3>Choose the library to continue with.</h3><p>These changes overlap. Export both versions before choosing. The other version will also remain in recovery backups on this device.</p><div class="version-grid"><div><strong>This device</strong><p>${esc(snapshotSummary(conflict.local))}</p>${listButton('export-conflict','Download device version','download','data-side="local"')}</div><div><strong>Cloud version</strong><p>${esc(snapshotSummary(conflict.remote))}</p>${listButton('export-conflict','Download cloud version','download','data-side="remote"')}</div></div><div class="sync-actions">${listButton('resolve-conflict','Keep this device','', 'data-choice="local"', 'btn-primary')}${listButton('resolve-conflict','Use cloud version','', 'data-choice="remote"')}</div></section>`;
}
function recoveryMarkup() {
  const recoveries = syncEngine?.getRecoveries() || [];
  if (!recoveries.length) return '';
  return `<section class="sync-recovery"><h3>Recovery backups</h3><p>Previous conflict versions remain on this device. Each download is a regular Form backup that can be restored later.</p>${recoveries.map((entry,index) => `<div class="recovery-row"><div><strong>Saved ${esc(new Date(entry.savedAt).toLocaleString())}</strong><p>${entry.choice === 'local' ? 'Kept this device’s version' : 'Used the cloud version'}</p></div><div class="sync-actions">${listButton('export-recovery','Device copy','download',`data-index="${index}" data-side="local"`)}${listButton('export-recovery','Cloud copy','download',`data-index="${index}" data-side="remote"`)}</div></div>`).join('')}</section>`;
}
function signInForm() {
  return `<form id="signin-form" class="signin-form"><label class="field"><span>Email address</span><input id="signin-email" class="input" type="email" autocomplete="email" inputmode="email" maxlength="320" value="${esc(signInEmail || owner?.email || '')}" placeholder="you@example.com" required aria-label="Email address for sign-in" /></label>${listButton('send-signin','Email me a sign-in link','mail','type="submit"','btn-primary')}<p id="auth-feedback" role="status" class="auth-feedback">${esc(authFeedback)}</p><p class="small muted">Use the same email on every device. Open the emailed link in this browser. No password is needed.</p></form>`;
}
function accountPanel() {
  let identity;
  if (owner) {
    const signedIn = confirmedUserId === owner.id;
    identity = `<div class="account-heading"><span class="icon-box">${icon('cloud')}</span><div><h2>${signedIn ? 'Your training, across devices.' : 'Your account on this device.'}</h2><p class="account-email">${esc(owner.email || 'Saved workout account')}</p></div></div><p>Programmes, notes, history, and your active workout belong to this account. Local changes wait safely in the sync queue when cloud access is unavailable.</p><div id="account-sync-status">${syncStatusMarkup()}</div><div class="sync-actions">${listButton('sync-now','Sync now','cloud','id="manual-sync"','btn-primary')}${listButton('signout',signedIn ? 'Sign out on this device' : 'Return to device library','','id="signout-button"')}</div>${pendingAccount && authUser && pendingAccount.id!==owner.id ? `<div class="pending-account"><strong>Signed in as ${esc(authUser.email || 'another account')}</strong><p>Your current library stays open until you choose to switch.</p>${listButton('open-account','Open signed-in account','cloud','','btn-primary')}</div>` : !signedIn && cloudConfigured() ? signInForm() : ''}`;
  } else if (authUser && pendingAccount) {
    identity = `<div class="account-heading"><span class="icon-box">${icon('cloud')}</span><div><h2>Your account is ready.</h2><p class="account-email">${esc(authUser.email || 'Signed-in account')}</p></div></div><p>Open your account library when you are ready. This device’s guest library will stay separate unless you choose to transfer it.</p>${listButton('open-account','Open account library','cloud','','btn-primary')}`;
  } else {
    identity = `<div class="account-heading"><span class="icon-box">${icon('cloud')}</span><div><h2>Take your training with you.</h2><p>Sign in to the same library on your phone and computer.</p></div></div><p>Your device library stays available. Before any existing device records are transferred to an account, you’ll be asked to choose.</p>${cloudConfigured() ? signInForm() : '<p>Cloud sync has not been configured for this app yet. Local recording and backups are available.</p>'}`;
  }
  return `<section id="account-panel" class="panel account-panel">${identity}${cloudError ? `<p class="sync-error" role="status">${esc(cloudError)}</p>${listButton('retry-cloud','Retry connection','cloud')}` : ''}<div id="sync-conflicts">${conflictMarkup()}</div><div id="sync-recoveries">${recoveryMarkup()}</div></section>`;
}
function updateSyncUI() {
  const header = document.querySelector('#cloud-status');
  if (header) header.innerHTML = syncChip();
  const warning = document.querySelector('#sync-warning');
  if (warning) warning.innerHTML = syncNotice();
  const account = document.querySelector('#account-sync-status');
  if (account) account.innerHTML = syncStatusMarkup();
  const conflicts = document.querySelector('#sync-conflicts');
  if (conflicts) conflicts.innerHTML = conflictMarkup();
  const recoveries = document.querySelector('#sync-recoveries');
  if (recoveries) recoveries.innerHTML = recoveryMarkup();
  const manual = document.querySelector('#manual-sync');
  if (manual) manual.disabled = !matchingAccount() || syncStatus.phase === 'syncing' || externalChange || memoryUnsaved;
  const send = document.querySelector('[data-action="send-signin"]');
  if (send) { send.disabled = authBusy || cloudStarting; send.innerHTML = `${icon('mail')}${authBusy ? 'Sending…' : 'Email me a sign-in link'}`; }
  const feedback = document.querySelector('#auth-feedback');
  if (feedback) feedback.textContent = authFeedback;
}
function safeRender() {
  if (!uiReady) return;
  if (dirty || dialog.open || fieldFocused()) { deferredRender = true; updateSyncUI(); return; }
  deferredRender = false;
  if (view === 'session' && !state.activeSession) view = 'history';
  render();
}
function flushDeferredRender() { if (deferredRender && !dirty && !dialog.open && !fieldFocused()) safeRender(); }
function scheduleSync(delay = 1100) {
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => runSync(false), delay);
}
async function runSync(manual = false) {
  if (!matchingAccount()) { if (manual) toast('Sign in to the same account to sync this library.'); updateSyncUI(); return false; }
  if (dirty || dialog.open || !sessionFieldsValid()) {
    if (manual) toast('Save your programme and complete any invalid fields before syncing.');
    return false;
  }
  if (externalChange || memoryUnsaved) { if (manual) toast('Export a backup and reload before syncing.'); return false; }
  const result = await syncEngine.sync();
  flushDeferredRender();
  if (manual && result) toast('Your training library is up to date.');
  return result;
}
function queueAuth(event, session) {
  const user = session?.user?.id ? { id: session.user.id, email: session.user.email || '' } : null;
  authUser = user;
  confirmedUserId = user?.id || null;
  const identity = user?.id || 'signed-out';
  if (identity === lastQueuedAuth && !(event === 'SIGNED_OUT' && explicitSignOut)) { updateSyncUI(); return; }
  lastQueuedAuth = identity;
  const ticket = ++authSequence;
  authQueue = authQueue.then(() => handleAuth(user, event, ticket)).catch(() => {
    cloudError = 'The account library could not be opened. Your device records remain available.';
    updateSyncUI();
  });
}
async function handleAuth(user, event, ticket, force = false) {
  if (ticket !== authSequence) return;
  if (!user) {
    pendingAccount = null;
    if (explicitSignOut) restoreGuestLibrary();
    else { cloudError = ''; safeRender(); }
    return;
  }
  if (owner?.id === user.id && syncEngine.getStatus().userId === user.id) {
    owner.email = user.email; rememberOwner(); cloudError = ''; pendingAccount = null;
    safeRender(); scheduleSync(0); return;
  }
  if (pendingAccount?.id === user.id && !force) { updateSyncUI(); return; }
  if (dialog.open || fieldFocused()) { pendingAccount=user; updateSyncUI(); return; }
  if (dirty || memoryUnsaved) {
    const leave = await confirmAction('Open your signed-in library?', 'Unsaved programme edits or records held only in memory will be left behind. Download a backup or save your programme first if you want to keep them.', 'Open account');
    if (ticket !== authSequence) return;
    if (!leave) { pendingAccount = user; updateSyncUI(); return; }
  }
  const previousOwner = owner?.id || null;
  const previousState = state;
  const existingQueue = syncEngine.hasAccount(user.id);
  const ownLocalCopy = previousOwner === user.id && hasSavedData(dataKey(user.id));
  const guestLocalCopy = previousOwner === null && hasSavedData(KEY);
  let adoptLocal = false;
  if (!existingQueue && (guestLocalCopy || ownLocalCopy)) {
    adoptLocal = await confirmAction('Bring this library into your account?', `${snapshotSummary(previousState)}. Transfer it to this account, or choose Cancel to keep it separate and load the cloud library. Your guest backup stays on this device.`, 'Transfer library');
    if (ticket !== authSequence) return;
  }
  syncEngine.disconnect();
  owner = user; pendingAccount = null; draft = null; draftBaseState = null; dirty = false; memoryUnsaved = false;
  externalChange = false; unreadableBackup = null; storageError = ''; deferredRender = false; restUntil = 0;
  state = adoptLocal ? previousState : loadState();
  await syncEngine.connect(user.id, { adoptLocal });
  if (ticket !== authSequence || confirmedUserId !== user.id) return;
  cloudError = ''; rememberOwner(); view = state.activeSession ? 'session' : 'workouts';
  document.activeElement?.blur?.();
  safeRender(); scheduleSync(0);
}
function restoreGuestLibrary() {
  clearTimeout(syncTimeout); syncEngine.disconnect(); owner = null; pendingAccount = null;
  dirty = false; draft = null; draftBaseState = null; deferredRender = false;
  externalChange = false; unreadableBackup = null; storageError = ''; memoryUnsaved = false; restUntil = 0;
  rememberOwner(); state = loadState(); view = state.activeSession ? 'session' : 'workouts';
  if (uiReady) render();
}
async function initializeCloud() {
  if (cloudPromise) return cloudPromise;
  cloudStarting = true; cloudError = ''; updateSyncUI();
  cloudPromise = (async () => {
    try {
      if (!cloud) {
        cloud = await createCloudClient(cloudConfig);
        if (!cloud) return;
        cloud.onAuthChange((event, session) => {
          authEventVersion++;
          // Auth changes block mismatched uploads immediately. Keep the current
          // owner's queue writable until an account switch is actually accepted.
          const nextUser = session?.user?.id ? {id:session.user.id,email:session.user.email||''} : null;
          authUser = nextUser; confirmedUserId = nextUser?.id || null;
          // Defer work until Supabase has released its auth callback lock.
          setTimeout(() => queueAuth(event, session), 0);
        });
      }
      const version = authEventVersion;
      const session = await cloud.getSession();
      if (version === authEventVersion) queueAuth('RESTORED_SESSION', session);
    } catch (error) { cloudError = error?.message || 'Cloud sync could not start. Local recording is still available.'; }
    finally { cloudStarting = false; cloudPromise = null; safeRender(); updateSyncUI(); }
  })();
  return cloudPromise;
}
async function sendSignInLink() {
  const input = document.querySelector('#signin-email');
  if (!input || !input.reportValidity() || authBusy) return;
  signInEmail = input.value.trim();
  if (!navigator.onLine) { authFeedback = 'Connect to the internet to request a sign-in link.'; updateSyncUI(); return; }
  if (!cloud) await initializeCloud();
  if (!cloud) { toast(cloudError || 'Cloud sync has not been configured yet.'); return; }
  authBusy = true; authFeedback = ''; updateSyncUI();
  try {
    const returnUrl = new URL('./', window.location.href); returnUrl.search = ''; returnUrl.hash = '';
    await cloud.sendSignInLink(signInEmail, returnUrl.href);
    authFeedback = `Check ${signInEmail} for your sign-in link. Open it in this browser. Delivery may take a moment.`;
  } catch (error) { authFeedback = error?.message || 'The sign-in email could not be sent. Try again later.'; }
  finally { authBusy = false; updateSyncUI(); }
}
async function signOutAccount() {
  if (dirty || memoryUnsaved) {
    if (!await confirmAction('Sign out on this device?', 'Save your programme or export a backup before leaving any records held only in memory. Saved account records and pending changes remain on this device for your next sign-in.', 'Sign out')) return;
  }
  explicitSignOut = true;
  try {
    if (cloud) await cloud.signOut();
    else if (confirmedUserId) throw new Error('Reconnect before signing out of the cloud session.');
    confirmedUserId = null; authUser = null; lastQueuedAuth = 'signed-out';
    if (owner) restoreGuestLibrary();
    toast('Signed out here. Your device library is separate.');
  } catch (error) {
    if (!confirmedUserId) { if (owner) restoreGuestLibrary(); toast('Signed out on this device.'); }
    else toast(error?.message || 'Sign-out could not finish. Try again when connected.');
  } finally { explicitSignOut = false; updateSyncUI(); }
}


async function handleSyncAction(action, button) {
  if(action==='sync-settings'){await navigate('settings');return true;}
  if(action==='send-signin'){await sendSignInLink();return true;}
  if(action==='sync-now'){await runSync(true);return true;}
  if(action==='retry-cloud'){await initializeCloud();scheduleSync(0);return true;}
  if(action==='open-account'){
    if(authUser){pendingAccount=null;await handleAuth(authUser,'OPEN_ACCOUNT',authSequence,true);}return true;
  }
  if(action==='signout'){await signOutAccount();return true;}
  if(action==='export-conflict'){
    const conflict=syncEngine.getConflict();if(conflict){const side=button.dataset.side;downloadFile(serializeBackup(conflict[side]),`form-conflict-${side}-${new Date().toISOString().slice(0,10)}.json`);}return true;
  }
  if(action==='export-recovery'){
    const recovery=syncEngine.getRecoveries()[Number(button.dataset.index)];
    if(recovery){const side=button.dataset.side;downloadFile(serializeBackup(recovery[side]),`form-recovery-${side}-${Number(button.dataset.index)+1}.json`);}return true;
  }
  if(action==='resolve-conflict'){
    const choice=button.dataset.choice;if(!['local','remote'].includes(choice)||!syncEngine.getConflict())return true;
    if(dirty||!sessionFieldsValid()){toast('Save your programme and complete invalid fields before choosing a version.');return true;}
    if(!await confirmAction(choice==='local'?'Keep this device’s library?':'Use the cloud library?',choice==='local'?'The device version will be queued for cloud sync. Both versions remain in recovery backups on this device.':'The cloud version will replace this device’s open library. Both versions remain in recovery backups on this device.',choice==='local'?'Keep device version':'Use cloud version'))return true;
    await syncEngine.resolveConflict(choice);safeRender();return true;
  }
  return false;
}

const remoteProxy = {
  read() {
    const expected = syncEngine.getStatus().userId;
    if(!expected||owner?.id!==expected||confirmedUserId!==expected||!cloud){const error=new Error('Sign in to the same account before syncing.');error.code='AUTH_REQUIRED';throw error;}
    return cloud.read(expected);
  },
  write(revision,value) {
    const expected = syncEngine.getStatus().userId;
    if(!expected||owner?.id!==expected||confirmedUserId!==expected||!cloud){const error=new Error('Sign in to the same account before syncing.');error.code='AUTH_REQUIRED';throw error;}
    return cloud.write(revision,value,expected);
  },
};
syncEngine=createSyncEngine({
  storage:browserStorage,keyPrefix:SYNC_PREFIX,getState:()=>state,remote:remoteProxy,
  onApply(value){
    state=validateState(value);
    const saved=persist({fromCloud:true});
    if(uiReady){deferredRender=true;safeRender();}
    return saved;
  },
  onStatus(value){syncStatus=value;if(value.code==='other-tab'){externalChange=true;showStorageError();}updateSyncUI();},
});
async function boot() {
  if(owner&&syncEngine.hasAccount(owner.id))await syncEngine.connect(owner.id);
  uiReady=true;render();
  if('serviceWorker' in navigator){navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{});}
  initializeCloud();
}
boot();
