import { validateState } from './model.js';

const DEFAULT_TIMEOUT_MS = 15000;

export class CloudError extends Error {
  constructor(message, code = 'CLOUD_UNAVAILABLE', cause, retryAfterSeconds) {
    super(message, { cause });
    this.name = 'CloudError';
    this.code = code;
    if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= 3600) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

// Only public client keys may enter the static build. Legacy anon keys are
// accepted for existing projects; privileged/service-role keys are rejected.
export function validateCloudConfig(config = {}) {
  const urlText = typeof config?.url === 'string' ? config.url.trim() : '';
  const key = typeof config?.publishableKey === 'string' ? config.publishableKey.trim() : '';
  if (!urlText && !key) return null;
  if (!urlText || !key) throw new CloudError('Cloud sync setup is incomplete.', 'INVALID_CONFIG');
  let url;
  try { url = new URL(urlText); } catch { throw new CloudError('Cloud sync needs a valid project URL.', 'INVALID_CONFIG'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new CloudError('Cloud sync needs a secure project URL without credentials or a path.', 'INVALID_CONFIG');
  }
  let validKey = key.startsWith('sb_publishable_') && key.length > 'sb_publishable_'.length;
  if (!validKey && key.split('.').length === 3) {
    try {
      const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      validKey = JSON.parse(atob(payload)).role === 'anon';
    } catch { validKey = false; }
  }
  if (!validKey) throw new CloudError('Use the project’s public publishable key for cloud sync. Secret keys must never be used in this app.', 'INVALID_CONFIG');
  return { url: url.origin, publishableKey: key };
}

function revisionNumber(value) {
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) throw new CloudError('Cloud sync returned an invalid version.', 'INVALID_CLOUD_DATA');
  const revision = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new CloudError('Cloud sync returned an invalid version.', 'INVALID_CLOUD_DATA');
  return revision;
}

function documentRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new CloudError('Cloud sync returned an invalid record.', 'INVALID_CLOUD_DATA');
  try { return { revision: revisionNumber(row.revision), state: validateState(row.state) }; }
  catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError('The cloud backup could not be read. Your local records have not been replaced.', 'INVALID_CLOUD_DATA', error);
  }
}

function cloudFailure(error, fallback = 'Cloud sync is unavailable. Your changes remain saved on this device.') {
  if (error instanceof CloudError) return error;
  const code = typeof error?.code === 'string' ? error.code : 'CLOUD_UNAVAILABLE';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
    // Read only Supabase's documented cooldown sentence. Never echo arbitrary
    // provider text, which can contain addresses, request URLs, or credentials.
    const match = typeof error?.message === 'string'
      ? /^For security purposes, you can only request this after (\d+) seconds\.?$/i.exec(error.message.trim())
      : null;
    const seconds = match ? Number(match[1]) : 0;
    if (Number.isSafeInteger(seconds) && seconds > 0) {
      const retryAfterSeconds = Math.min(seconds, 3600);
      return new CloudError(
        `Please wait ${retryAfterSeconds} seconds before requesting another sign-in link. Check your most recent sign-in email.`,
        code, error, retryAfterSeconds,
      );
    }
    if (code === 'over_email_send_rate_limit') {
      return new CloudError(
        'The built-in email service allows two emails per hour. Sending may take up to an hour to become available. Check your most recent sign-in email before requesting another.',
        code, error, 60,
      );
    }
    return new CloudError('Too many sign-in requests. Wait a few minutes before trying again.', code, error, 60);
  }
  const authMessages = {
    email_address_not_authorized: 'This email service can send only to your Supabase organisation’s member email. Use the email linked to your Supabase account.',
    email_address_invalid: 'Enter a deliverable email address. Example and test addresses are not supported.',
    otp_disabled: 'Email sign-in is not enabled for this app. The app owner needs to enable it.',
    email_provider_disabled: 'Email sign-in is not enabled for this app. The app owner needs to enable it.',
    otp_expired: 'This sign-in link is no longer valid. Request a new link and use the latest email.',
  };
  if (Object.hasOwn(authMessages, code)) return new CloudError(authMessages[code], code, error);
  // Keep provider codes for handling/review, without exposing tokens, request
  // URLs, or raw provider response details in the product's error messages.
  return new CloudError(fallback, code, error);
}

export function createTimeoutFetch(fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const inheritedSignal = init.signal || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
    const abort = () => controller.abort(inheritedSignal?.reason);
    if (inheritedSignal?.aborted) abort();
    else inheritedSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Cloud request timed out.', 'TimeoutError')), timeoutMs);
    try { return await fetchImpl(input, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); inheritedSignal?.removeEventListener('abort', abort); }
  };
}

/**
 * Supabase adapter used by sync-engine.js. SDK loading is optional and lazy:
 * local workouts remain usable with blank config or unavailable cloud assets.
 * options.createClient is injectable for tests; no SDK global is required.
 */
export async function createCloudClient(config, options = {}) {
  const settings = validateCloudConfig(config);
  if (!settings) return null;
  let factory = options.createClient;
  if (!factory) {
    try { ({ createClient: factory } = await import('./vendor/supabase.js')); }
    catch (error) { throw new CloudError('Cloud sync could not start. You can keep recording workouts on this device.', 'SDK_UNAVAILABLE', error); }
  }
  const fetchImpl = options.fetch || globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new CloudError('This browser cannot connect to cloud sync.', 'FETCH_UNAVAILABLE');
  let client;
  try {
    client = factory(settings.url, settings.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // This is a browser-only app; Supabase consumes the magic-link fragment
        // and maintains a separate session on every signed-in device.
        flowType: 'implicit',
        storageKey: `form-cloud-auth-${new URL(settings.url).hostname}`,
      },
      global: { fetch: createTimeoutFetch(fetchImpl, options.timeoutMs || DEFAULT_TIMEOUT_MS) },
    });
  } catch (error) { throw cloudFailure(error, 'Cloud sync could not start. Your local workouts are still available.'); }

  async function getSession() {
    try {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data?.session || null;
    } catch (error) { throw cloudFailure(error, 'Your cloud sign-in could not be restored. Your local workouts are still available.'); }
  }
  async function signedInContext(expectedUserId) {
    const session = await getSession();
    if (!session?.user?.id || !session.access_token) throw new CloudError('Sign in to sync your workouts.', 'AUTH_REQUIRED');
    if (expectedUserId !== undefined && session.user.id !== expectedUserId) {
      throw new CloudError('Your signed-in account changed. Reconnect before syncing this library.', 'ACCOUNT_CHANGED');
    }
    // Snapshot primitive values together. Every database request pins this JWT
    // rather than allowing the SDK to choose a newly signed-in account later.
    return { userId: session.user.id, accessToken: session.access_token };
  }

  return {
    getSession,
    onAuthChange(callback) {
      // Supabase holds its auth lock while notifying subscribers. Do not call
      // another asynchronous Auth method from inside this callback.
      const { data } = client.auth.onAuthStateChange((event, session) => callback(event, session));
      return () => data.subscription.unsubscribe();
    },
    async sendSignInLink(email, redirectUrl) {
      const address = String(email || '').trim();
      if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new CloudError('Enter a valid email address.', 'INVALID_EMAIL');
      let destination;
      try { destination = new URL(redirectUrl); } catch { throw new CloudError('The sign-in return address is invalid.', 'INVALID_REDIRECT'); }
      if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password) throw new CloudError('The sign-in return address is invalid.', 'INVALID_REDIRECT');
      try {
        const { error } = await client.auth.signInWithOtp({ email: address, options: { emailRedirectTo: destination.href, shouldCreateUser: true } });
        if (error) throw error;
      } catch (error) {
        throw cloudFailure(error, 'The sign-in email could not be sent. Please try again later.');
      }
    },
    async signOut() {
      try {
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) {
          // Current SDKs clear local-scope sessions before best-effort server
          // revocation. Offline revocation failure is still a local sign-out.
          const current = await client.auth.getSession();
          if (!current.error && !current.data?.session) return { revocationPending: true };
          throw error;
        }
        return { revocationPending: false };
      } catch (error) { throw cloudFailure(error, 'Sign-out could not finish. Try again when the connection returns.'); }
    },
    async read(expectedUserId) {
      const { userId, accessToken } = await signedInContext(expectedUserId);
      try {
        const { data, error } = await client.from('workout_states').select('revision,state').eq('user_id', userId).maybeSingle().setHeader('Authorization', `Bearer ${accessToken}`);
        if (error) throw error;
        // An absent row is a new account. A missing table/permission error must
        // be surfaced, never treated as an empty cloud backup.
        return data === null ? null : documentRow(data);
      } catch (error) { throw cloudFailure(error); }
    },
    async write(expectedRevision, state, expectedUserId) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new CloudError('The saved cloud version is invalid. Reload your data before syncing.', 'INVALID_REVISION');
      const { accessToken } = await signedInContext(expectedUserId);
      const clean = validateState(state);
      try {
        const { data, error } = await client.rpc('save_workout_state', { p_expected_revision: expectedRevision, p_state: clean }).setHeader('Authorization', `Bearer ${accessToken}`);
        if (error) throw error;
        if (!Array.isArray(data) || data.length > 1) throw new CloudError('Cloud sync returned an invalid save response.', 'INVALID_CLOUD_DATA');
        // The RPC returns zero rows when another device won the CAS race.
        return data.length ? documentRow(data[0]) : null;
      } catch (error) { throw cloudFailure(error); }
    },
  };
}
