# FORM — Workout journal

A personal workout planner and training log. Create routines, arrange exercises in the order you want to train, set targets, and record what you actually lift.

## Features

- Programme routines with ordered exercises, individual sets, reps, weights, rest times, and notes.
- Start a workout from a routine and log actual reps and weights as you complete each set.
- Keep completed sessions in your history. Editing a routine does not rewrite previous workouts.
- Switch between kilograms and pounds.
- Export your data as a JSON backup and restore a backup later.
- Use a responsive interface on a phone or computer.

The app has no server, account system, analytics, or third-party dependencies. Workout data is saved in this browser on this device. It does **not** sync across devices, browsers, or different site addresses. Clearing site data or using a private browsing session can remove your records. Export backups regularly, and restore them on another device when needed. Backups contain your workout records and notes; store them somewhere you trust.

GitHub hosts the app's source and static files. Your workouts stay in your browser and are not committed to the repository.

## Run locally

Install [Node.js](https://nodejs.org/) 22 or later, open a terminal in this folder, and run:

```sh
npm run dev
```

Open the local URL printed in the terminal. There is no dependency installation step. Use a local server rather than opening `index.html` directly, because the app uses JavaScript modules.

To verify the source:

```sh
npm run check
npm test
```

## Host on GitHub Pages

1. Create a GitHub repository and push this folder's contents to its `main` branch. `index.html`, `package.json`, and `.github` should be at the repository root.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open **Actions → Deploy FORM to GitHub Pages → Run workflow** for the first deployment. Future pushes to `main` deploy automatically.
4. Open the site URL shown in the successful deployment or in **Settings → Pages**. It normally has the form `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

The included workflow checks the JavaScript and tests the workout model before publishing only the static app files. It uses the repository's built-in `GITHUB_TOKEN`; no personal access token or other secret is needed. The app uses relative asset paths, so it works under a repository URL.

GitHub Pages is available for public repositories on GitHub Free; private repository availability depends on your GitHub plan. The hosted site may be public even when the source repository is private. See GitHub's [Pages publishing documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) and [custom workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Project files

- `index.html`, `styles.css`, `app.js`: interface and browser persistence.
- `model.js`: workout state, sessions, units, and backup validation.
- `model.test.js`: automated data model tests using Node's built-in test runner.
- `server.mjs`: local development server.
- `.github/workflows/deploy.yml`: verification and GitHub Pages deployment.

To change the design or behavior, edit the source and run the checks. No build tool is required.
