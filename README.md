# Form — Workout journal

[Open Form](https://jonathanli2513.github.io/form-workout-journal/) · [Source repository](https://github.com/jonathanli2513/form-workout-journal)

Plan workouts, arrange exercises, set individual rep and weight targets, and record what you actually do. Form includes exercise and session notes, rest timers, kg/lb conversion, completed-session history, progress summaries, and JSON backup/restore.

## Local recording and optional sync

Form saves your training library in this browser. When the Supabase project is configured and you sign in, it can also sync your programmes and workout records to the same account on another device. The project configuration and account sign-in must be completed before cloud sync is available; the app reports its connection status.

Local changes are retained while the network or cloud project is unavailable. Reconnect and sync to send pending changes. Changes made on different devices are checked against the last shared version. Independent changes can merge; conflicting changes require a choice rather than silently overwriting another device's work. Keep a backup before choosing between conflicting versions.

When first connecting an account, review the prompt about transferring this browser's existing library. Use the same account on each device. Account-specific sync metadata is kept separate so a different account does not silently receive the preceding account's records. Sign out on shared devices and follow any prompt about the locally retained library.

After one successful online visit, Form caches its app files for later offline use. Browser storage availability and eviction can affect this cache and local records. Closing every open Form tab and reopening the app allows a downloaded update to activate without interrupting a workout. A first visit on a new device and signing in require a connection.

**Export backups regularly.** Clearing browser/site data, private browsing, device loss, or a storage failure can remove local records and changes that have not synced. JSON exports include your workout notes and records; keep them somewhere you trust. The service worker caches only the static app files, never database responses or authentication requests.

GitHub Pages hosts the public app files. Signed-in workout records belong in the private Supabase database; they are not committed to this repository. Browser configuration contains only the public project URL and publishable key. Never add a service-role key, secret API key, database password, or user session token to the app or repository.

See [Supabase setup](supabase/SETUP.md) for project configuration, email sign-in, access controls, and pause recovery.

## Run locally

Use Node.js 22 or later:

```sh
npm ci
npm run dev
```

Open the URL printed by the local server. The dev command builds `dist/`, including the pinned Supabase browser SDK, before starting the server. Repeat the command after source changes. JavaScript modules need HTTP; opening `index.html` directly is not supported.

Run verification and build the production files with:

```sh
npm run check
npm test
npm run build
```

The build copies only the app's public assets into `dist/` and creates an offline cache version from their contents. Dependency versions are pinned in `package.json` and `package-lock.json`. The interface uses optional Google Fonts and falls back to system fonts when they are unavailable.

## GitHub Pages deployment

The repository's **Settings → Pages → Build and deployment → Source** should be **GitHub Actions**. Pushing `main` runs the included workflow, which installs the locked dependencies, checks JavaScript, runs the tests, builds the app, and deploys `dist/`. You can also start it manually from **Actions → Deploy FORM to GitHub Pages → Run workflow**.

The deployment uses the repository's built-in `GITHUB_TOKEN`; no personal access token is required. All asset paths and the service worker scope are relative to the repository URL. A changed cloud configuration requires a new build/deployment.

GitHub Pages is available for public repositories on GitHub Free. See [GitHub's publishing documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Project files

- `app.js`, `index.html`, `styles.css`: interface and local recording.
- `model.js`: workout data validation and statistics.
- `sync-engine.js`: durable pending changes, revisions, merges, and conflict handling.
- `cloud.js`, `cloud-config.js`: Supabase authentication and private state access.
- `supabase/schema.sql`: database schema and access rules.
- `sw.js`, `manifest.webmanifest`: offline app shell and install metadata.
- `scripts/build.mjs`: static asset build and SDK bundle.
- `*.test.js`: automated tests.
- `server.mjs`: local preview server.
- `.github/workflows/deploy.yml`: checks, build, and deployment.
