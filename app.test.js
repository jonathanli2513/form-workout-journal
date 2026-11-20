import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as model from './model.js';
import { createSyncEngine, mergeStates } from './sync-engine.js';

const KEY = 'form-workout-v1';
const OWNER = { id: 'qa-account-a', email: 'a@example.invalid' };
const OTHER = { id: 'qa-account-b', email: 'b@example.invalid' };
const source = (await readFile(new URL('./app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/\nboot\(\);\s*$/, '\n');

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
async function accountFixture() {
  const storage = memoryStorage();
  const state = model.createDefaultState();
  state.activeSession = model.startSession(state.routines[0]);
  const engine = createSyncEngine({ storage, getState: () => state, remote: {} });
  await engine.connect(OWNER.id, { adoptLocal: true });
  storage.setItem(KEY + ':owner', JSON.stringify(OWNER));
  storage.setItem(KEY + ':account:' + OWNER.id, model.serializeBackup(state));
  return { storage, state };
}
async function appHarness(storage, options = {}) {
  const listeners = new Map();
  const dialogListeners = new Map();
  let focused = false;
  let engineOptions;
  const inertElement = () => ({ innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, addEventListener() {} });
  const app = inertElement(), toast = inertElement(), fileInput = inertElement();
  const emailInput = {value:'owner@example.invalid', reportValidity:()=>true};
  const NativeDate = Date;
  const TestDate = class extends NativeDate { static now() { return options.clock?.now ?? NativeDate.now(); } };
  const mockCloud = options.send ? {getSession:async()=>null,onAuthChange:()=>()=>{},sendSignInLink:options.send} : null;
  const dialog = {
    innerHTML: '', open: false, returnValue: '',
    setAttribute() {},
    addEventListener(type, fn) { if (!dialogListeners.has(type)) dialogListeners.set(type, new Set()); dialogListeners.get(type).add(fn); },
    removeEventListener(type, fn) { dialogListeners.get(type)?.delete(fn); },
    showModal() { if (this.open) throw new Error('A confirmation is already open'); this.open = true; },
    close(value) { this.returnValue = value; this.open = false; for (const fn of [...(dialogListeners.get('close') || [])]) fn(); },
  };
  const document = {
    hidden: false,
    activeElement: { matches: () => focused },
    querySelector(selector) { return ({ '#app': app, '#dialog': dialog, '#toast': toast, '#backup-file': fileInput, '#signin-email': emailInput })[selector] || null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
  };
  const context = vm.createContext({
    ...model, mergeStates,
    createSyncEngine(options) { engineOptions = options; return createSyncEngine(options); },
    createCloudClient: async () => mockCloud,
    cloudConfig: { url: '', publishableKey: '' },
    document, window: { localStorage: storage, addEventListener() {}, scrollTo() {}, location: { href: 'https://form.example/', reload() {} } },
    navigator: { onLine: Boolean(options.send) },
    Date: TestDate,
    structuredClone, URL, Blob, DOMException,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
  });
  vm.runInContext(source + `\n globalThis.qa = {
    boot, queueAuth, flushAuth: () => authQueue,
    sendSignInLink, initializeCloud, retrySeconds:signInRetrySeconds,
    state: () => structuredClone(state), owner: () => owner?.id || null,
    pending: () => pendingAccount?.id || null,
    engine: () => syncEngine,
    openPending: () => handleSyncAction('open-account', {dataset:{}}),
  };`, context);
  await context.qa.boot();
  return {
    ...context.qa, dialog, toast,
    focus(value) { focused = value; },
    applyRemote: value => engineOptions.onApply(value),
    input(target) { for (const fn of listeners.get('input') || []) fn({ target }); },
    click(action) {
      const button = { disabled: false, dataset: { action } };
      const event = { target: { closest: () => button }, preventDefault() {} };
      return Promise.all((listeners.get('click') || []).map(fn => fn(event)));
    },
  };
}

function recordWeight(app, value) {
  const exercise = app.state().activeSession.exercises[0];
  app.input({ id: '', dataset: { field: 'actual-weight', eid: exercise.id, sid: exercise.sets[0].id, weightUnit: 'kg' }, validity: { valid: true }, value: String(value) });
}

test('expired cloud sign-in leaves the cached account queue durable across a reload', async () => {
  const { storage } = await accountFixture();
  const app = await appHarness(storage);
  app.queueAuth('SIGNED_OUT', null);
  await app.flushAuth();
  assert.equal(app.owner(), OWNER.id);
  assert.equal(app.engine().getStatus().userId, OWNER.id);
  recordWeight(app, 72.5);
  assert.equal(app.engine().getStatus().pending, true);
  const reloaded = await appHarness(storage);
  assert.equal(reloaded.state().activeSession.exercises[0].sets[0].weight, 72.5);
});

test('a new account cannot take over a focused field or confirmation from another account', async () => {
  const { storage } = await accountFixture();
  const app = await appHarness(storage);
  app.focus(true);
  app.queueAuth('SIGNED_IN', { user: OTHER });
  await app.flushAuth();
  assert.equal(app.owner(), OWNER.id);
  assert.equal(app.pending(), OTHER.id);
  assert.equal(app.engine().getStatus().userId, OWNER.id);
  recordWeight(app, 77.5);
  app.focus(false);
  app.dialog.open = true;
  await app.openPending();
  assert.equal(app.owner(), OWNER.id);
  app.dialog.open = false;
  await app.openPending();
  assert.equal(app.owner(), OTHER.id);
  assert.equal(app.state().routines.length, 0, 'the new account must not receive the previous account library');
  const previous = JSON.parse(storage.getItem('form-sync-v1:' + OWNER.id));
  assert.equal(previous.current.activeSession.exercises[0].sets[0].weight, 77.5);
});

test('a discard confirmation cannot remove a different session received while the dialog is open', async () => {
  const { storage } = await accountFixture();
  const app = await appHarness(storage);
  const action = app.click('discard-session');
  // The original action yields through the async action dispatcher, then opens its dialog.
  for (let i = 0; i < 6 && !app.dialog.open; i++) await Promise.resolve();
  assert.equal(app.dialog.open, true);
  const incoming = app.state();
  incoming.activeSession = model.startSession(incoming.routines[1]);
  const incomingId = incoming.activeSession.id;
  app.applyRemote(incoming);
  app.dialog.close('confirm');
  await action;
  assert.equal(app.state().activeSession.id, incomingId);
  assert.match(app.toast.textContent, /Nothing was discarded/);
});

test('email send cooldown survives reload and allows a retry after it expires', async () => {
  const storage = memoryStorage(), clock = {now:Date.now()};
  let sent = 0;
  const options = {clock,send:async()=>{sent++;}};
  const app = await appHarness(storage,options);
  await app.initializeCloud();
  await app.sendSignInLink();
  await app.sendSignInLink();
  assert.equal(sent,1);
  assert.equal(app.retrySeconds(),60);
  const reopened=await appHarness(storage,options);
  await reopened.initializeCloud();
  await reopened.sendSignInLink();
  assert.equal(sent,1,'reopening the app must not bypass resend protection');
  clock.now+=61000;
  await reopened.sendSignInLink();
  assert.equal(sent,2);
});

test('simultaneous sign-in submissions send only one email, and rate errors retain their cooldown', async () => {
  const storage=memoryStorage();
  let release, sent=0;
  const app=await appHarness(storage,{send:async()=>{sent++;await new Promise(resolve=>{release=resolve;});throw Object.assign(new Error('Email sending is rate-limited.'),{retryAfterSeconds:21});}});
  await app.initializeCloud();
  const first=app.sendSignInLink();
  const second=app.sendSignInLink();
  await second;
  assert.equal(sent,1);
  release();await first;
  assert.ok(app.retrySeconds()>=20&&app.retrySeconds()<=21);
  await app.sendSignInLink();
  assert.equal(sent,1);
});
