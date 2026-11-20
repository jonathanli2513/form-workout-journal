import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudClient, validateCloudConfig, createTimeoutFetch, CloudError } from './cloud.js';
import { createDefaultState } from './model.js';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const config = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test_public_key' };
function mockAdapter(overrides = {}) {
  const calls = [];
  const session = { user: { id: 'user-a', email: 'owner@example.test' }, access_token: 'test-token' };
  const mock = {
    session,
    sessionError: null,
    row: null,
    readError: null,
    writeRows: [],
    writeError: null,
    authCallback: null,
    unsubscribeCalled: false,
    ...overrides,
  };
  const client = {
    auth: {
      async getSession() { return { data: { session: mock.session }, error: mock.sessionError }; },
      onAuthStateChange(callback) { mock.authCallback = callback; return { data: { subscription: { unsubscribe() { mock.unsubscribeCalled = true; } } } }; },
      async signInWithOtp(params) { calls.push(['otp', params]); return { error: mock.signInError }; },
      async signOut(params) { calls.push(['signOut', params]); return { error: mock.signOutError }; },
    },
    from(table) {
      calls.push(['table', table]);
      return { select(columns) {
        calls.push(['select', columns]);
        return { eq(column, value) {
          calls.push(['eq', column, value]);
          return { maybeSingle() { return { setHeader(name, value) { calls.push(['read-header', name, value]); return { data: mock.row, error: mock.readError }; } }; } };
        } };
      } };
    },
    rpc(name, parameters) { calls.push(['rpc', name, parameters]); return { setHeader(name, value) { calls.push(['write-header', name, value]); return { data: mock.writeRows, error: mock.writeError }; } }; },
  };
  return {
    mock, calls,
    async adapter() {
      return createCloudClient(config, { createClient(url, key, options) { calls.push(['create', url, key, options]); return client; } });
    },
  };
}

test('blank config leaves the local app independent of the cloud SDK', async () => {
  let imported = false;
  assert.equal(await createCloudClient({ url: '', publishableKey: '' }, { createClient() { imported = true; } }), null);
  assert.equal(imported, false);
  assert.throws(() => validateCloudConfig({ url: config.url }), { code: 'INVALID_CONFIG' });
});

test('static client configuration rejects privileged keys and unsafe project URLs', () => {
  for (const key of ['sb_secret_superprivate', 'service_role', 'random-secret']) {
    assert.throws(() => validateCloudConfig({ ...config, publishableKey: key }), { code: 'INVALID_CONFIG' });
  }
  const jwt = role => ['header', Buffer.from(JSON.stringify({ role })).toString('base64url'), 'signature'].join('.');
  assert.throws(() => validateCloudConfig({ ...config, publishableKey: jwt('service_role') }), { code: 'INVALID_CONFIG' });
  assert.equal(validateCloudConfig({ ...config, publishableKey: jwt('anon') }).publishableKey, jwt('anon'));
  for (const url of ['http://example.supabase.co', 'https://owner:password@example.supabase.co', 'https://example.supabase.co/rest/v1', 'https://example.supabase.co/?secret=value']) {
    assert.throws(() => validateCloudConfig({ ...config, url }), { code: 'INVALID_CONFIG' });
  }
  assert.equal(validateCloudConfig({ ...config, url: 'http://127.0.0.1:54321' }).url, 'http://127.0.0.1:54321');
});

test('auth uses independent device sessions and local-scope sign-out', async () => {
  const harness = mockAdapter();
  const adapter = await harness.adapter();
  assert.equal((await adapter.getSession()).user.id, 'user-a');
  const seen = [];
  const unsubscribe = adapter.onAuthChange((event, session) => seen.push([event, session?.user.id]));
  harness.mock.authCallback('SIGNED_IN', harness.mock.session);
  assert.deepEqual(seen, [['SIGNED_IN', 'user-a']]);
  unsubscribe();
  assert.equal(harness.mock.unsubscribeCalled, true);
  await adapter.sendSignInLink(' owner@example.test ', 'https://owner.github.io/form/');
  assert.deepEqual(harness.calls.find(call => call[0] === 'otp')[1], { email: 'owner@example.test', options: { emailRedirectTo: 'https://owner.github.io/form/', shouldCreateUser: true } });
  await adapter.signOut();
  assert.deepEqual(harness.calls.find(call => call[0] === 'signOut')[1], { scope: 'local' });
  const factoryOptions = harness.calls.find(call => call[0] === 'create')[3];
  assert.equal(factoryOptions.auth.persistSession, true);
  assert.equal(factoryOptions.auth.storageKey, 'form-cloud-auth-example.supabase.co');
});

test('local sign-out remains successful when only server revocation is offline', async () => {
  const harness = mockAdapter({ session: null, signOutError: { code: 'NETWORK_ERROR' } });
  const adapter = await harness.adapter();
  assert.deepEqual(await adapter.signOut(), { revocationPending: true });
  harness.mock.session = { user: { id: 'still-signed-in' } };
  await assert.rejects(adapter.signOut(), { code: 'NETWORK_ERROR' });
});

test('sign-in validation and provider errors do not expose raw network details', async () => {
  const harness = mockAdapter({ signInError: { code: 'over_email_send_rate_limit', message: 'RAW TOKEN secret' } });
  const adapter = await harness.adapter();
  await assert.rejects(adapter.sendSignInLink('bad address', 'https://owner.github.io/form/'), { code: 'INVALID_EMAIL' });
  await assert.rejects(adapter.sendSignInLink('owner@example.test', 'javascript:alert(1)'), { code: 'INVALID_REDIRECT' });
  await assert.rejects(adapter.sendSignInLink('owner@example.test', 'https://owner.github.io/form/'), error => error.code === 'over_email_send_rate_limit' && !error.message.includes('RAW TOKEN'));
});

test('an absent cloud row is distinct from a missing table or permission error', async () => {
  const harness = mockAdapter();
  const adapter = await harness.adapter();
  assert.equal(await adapter.read(), null);
  assert.deepEqual(harness.calls.find(call => call[0] === 'eq'), ['eq', 'user_id', 'user-a']);
  harness.mock.readError = { code: 'PGRST205', message: 'Missing table' };
  await assert.rejects(adapter.read(), { code: 'PGRST205' });
  harness.mock.readError = null;
  harness.mock.row = { revision: '7', state: createDefaultState() };
  const found = await adapter.read();
  assert.equal(found.revision, 7);
  assert.notEqual(found.state, harness.mock.row.state);
});

test('corrupt cloud data and unsafe revisions never replace local records', async () => {
  const harness = mockAdapter({ row: { revision: '9007199254740993', state: createDefaultState() } });
  const adapter = await harness.adapter();
  await assert.rejects(adapter.read(), { code: 'INVALID_CLOUD_DATA' });
  harness.mock.row = { revision: 2, state: { schemaVersion: 99 } };
  await assert.rejects(adapter.read(), { code: 'INVALID_CLOUD_DATA' });
  harness.mock.row = { revision: null, state: createDefaultState() };
  await assert.rejects(adapter.read(), { code: 'INVALID_CLOUD_DATA' });
});

test('CAS writes preserve owner isolation, validate snapshots, and expose conflicts', async () => {
  const harness = mockAdapter();
  const adapter = await harness.adapter();
  const state = createDefaultState();
  assert.equal(await adapter.write(0, state), null);
  const call = harness.calls.find(call => call[0] === 'rpc');
  assert.equal(call[1], 'save_workout_state');
  assert.equal(call[2].p_expected_revision, 0);
  assert.deepEqual(Object.keys(call[2]).sort(), ['p_expected_revision', 'p_state']);
  assert.notEqual(call[2].p_state, state);
  harness.mock.writeRows = [{ revision: 1, state }];
  assert.equal((await adapter.write(0, state)).revision, 1);
  harness.mock.writeRows = null;
  await assert.rejects(adapter.write(1, state), { code: 'INVALID_CLOUD_DATA' });
  await assert.rejects(adapter.write(-1, state), { code: 'INVALID_REVISION' });
  harness.mock.session = null;
  await assert.rejects(adapter.read(), { code: 'AUTH_REQUIRED' });
  await assert.rejects(adapter.write(0, state), { code: 'AUTH_REQUIRED' });
});

test('cloud requests honor caller aborts and have bounded timeouts', async () => {
  const waitingFetch = (_input, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(createTimeoutFetch(waitingFetch, 8)('https://example.test'), { name: 'TimeoutError' });
  const controller = new AbortController();
  const promise = createTimeoutFetch(waitingFetch, 1000)('https://example.test', { signal: controller.signal });
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(await createTimeoutFetch(async () => 'ok', 100)('https://example.test'), 'ok');
});


test('expected account mismatches stop a cloud request before reading or writing', async () => {
  const harness = mockAdapter();
  const adapter = await harness.adapter();
  await assert.rejects(adapter.read('different-account'), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(adapter.write(0, createDefaultState(), 'different-account'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(harness.calls.some(call => call[0] === 'table' || call[0] === 'rpc'), false);
});

test('real SDK database requests pin the captured owner JWT across an account switch', async () => {
  const ownerA = { user: { id: 'owner-a' }, access_token: 'test-only-owner-a-token' };
  const ownerB = { user: { id: 'owner-b' }, access_token: 'test-only-owner-b-token' };
  let currentSession = ownerA;
  const state = createDefaultState();
  const requests = [];
  const adapter = await createCloudClient(config, {
    createClient(url, key, options) {
      // The real PostgREST SDK will obtain account B's token when it sends the
      // request. The adapter must override that with its captured account A JWT.
      const database = createSupabaseClient(url, key, {
        ...options,
        accessToken: async () => currentSession.access_token,
      });
      return {
        auth: {
          async getSession() {
            const captured = currentSession;
            currentSession = ownerB;
            return { data: { session: captured }, error: null };
          },
        },
        from: database.from.bind(database),
        rpc: database.rpc.bind(database),
      };
    },
    fetch: async (input, init) => {
      const headers = new Headers(init.headers);
      requests.push({ authorization: headers.get('authorization'), url: String(input), body: init.body });
      return new Response(JSON.stringify([{ revision: 1, state }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal((await adapter.read('owner-a')).revision, 1);
  assert.equal(currentSession.user.id, 'owner-b');
  assert.equal(requests[0].authorization, 'Bearer test-only-owner-a-token');
  assert.equal(new URL(requests[0].url).searchParams.get('user_id'), 'eq.owner-a');
  currentSession = ownerA;
  assert.equal((await adapter.write(0, state, 'owner-a')).revision, 1);
  assert.equal(currentSession.user.id, 'owner-b');
  assert.equal(requests[1].authorization, 'Bearer test-only-owner-a-token');
  assert.equal(JSON.parse(requests[1].body).p_state.routines[0].id, state.routines[0].id);
  assert.equal(requests.length, 2);
});
