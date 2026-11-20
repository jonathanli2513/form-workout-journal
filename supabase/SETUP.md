# Supabase setup for Form

The app can run as a local journal without Supabase. To enable cross-device sync, configure a project you own, apply its database access rules, deploy the public project settings, and sign in to the same account on your devices. This guide describes the required setup; it does not establish that a particular project has been configured or verified.

## Create or select the free project

Create a project in your Supabase organization on the Free plan, or select an existing project intended for this app. Keep the generated database password in your password manager; it is never needed in the browser app. Project creation and provisioning can take a few minutes.

Supabase's current [Free plan](https://supabase.com/pricing) includes a 500 MB database. Free projects can pause after a period of low activity; paid projects do not automatically pause for inactivity. Usage limits and policies may change.

## Apply the database schema

Review `schema.sql`, then apply it to the selected project through the SQL editor or the Supabase integration. Do not apply it to an unrelated database.

The app stores one versioned workout document per authenticated user. Row Level Security restricts reads to that user's document. Writes use an authenticated, owner-checked operation with an expected revision, so an older device cannot blindly overwrite a newer document. A conflict returns control to the client for merging or an explicit choice.

After applying the schema, check Supabase's security advisors and verify that an unsigned request cannot read workout records. Verify isolation using two distinct signed-in test users: neither should be able to read or modify the other's document. Do not broaden table permissions or disable RLS to work around a configuration error.

## Configure email sign-in

Enable the Email provider in **Authentication**. Under the project's authentication URL settings, set the Site URL to:

```text
https://jonathanli2513.github.io/form-workout-journal/
```

Allow that exact URL as a redirect URL. If testing locally, also allow the local server URL you actually use, such as `http://127.0.0.1:4173/`. Avoid broad production wildcard redirects.

Form signs in by email link. Keep the default magic-link email template, or retain its valid confirmation link if you customize it. Open a sign-in link in the same browser where you requested it. The sign-in session is retained by the Supabase SDK so you do not need an email for every workout.

Supabase's built-in mail service currently sends only to email addresses belonging to the project's organization team, with a limit of two emails per hour across the project. For a personal project, use your organization-member email. For other users or greater mail volume, configure a suitable custom SMTP service before inviting them. See [Supabase's SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp).

## Set the public browser configuration

Copy the project's HTTPS URL and **publishable** API key from its API settings into `cloud-config.js`:

```js
export const cloudConfig = {
  url: 'https://YOUR-PROJECT.supabase.co',
  publishableKey: 'YOUR-PUBLIC-PUBLISHABLE-KEY',
};
export default cloudConfig;
```

The URL and publishable key are public browser configuration; they do not replace sign-in or the database access rules.

Never paste a secret key, legacy `service_role` key, database password, management token, or user session token into this file. Those values bypass or administer security and must not appear in a public repository.

Build and deploy after changing the configuration:

```sh
npm run check
npm test
npm run build
```

Push the source to `main` for GitHub Actions to publish it. `dist/` is generated and stays out of Git.

## Move the existing library and verify sync

1. On the device with your existing workouts, export a JSON backup from **Settings**.
2. Sign in to Form and review its prompt before transferring local data to your account.
3. Wait for the app to confirm sync; sign in to the same account on another device.
4. Check that a test workout, its set targets, and a completed session appear on both devices.
5. Go offline on one device, make a small change, reconnect, and confirm that it reaches the other device.
6. Make competing changes only with disposable test data. Verify that the conflict flow preserves an explicit choice and that a backup can be exported before replacing a version.

A successful login alone does not prove database sync works. A configuration, permission, paused-project, or network error should leave local records available and show pending changes instead of claiming the cloud is up to date.

## If the free project pauses

Resume the project from the [Supabase Dashboard](https://supabase.com/dashboard), then reconnect Form and retry sync. The app keeps local recording available and retains pending changes while cloud access fails. A paused project still prevents initial sign-in or fetching records onto a new device.

Supabase currently emails the project owner about pausing and provides a one-year window to resume a paused project with its data and configuration. Check the current [project-pausing policy](https://supabase.com/docs/guides/platform/free-project-pausing). Keep independent JSON backups; do not rely on the cloud or browser as your only copy.
