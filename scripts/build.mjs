import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const assets = [
  'index.html', 'styles.css', 'app.js', 'model.js', 'cloud.js',
  'cloud-config.js', 'sync-engine.js', 'icon.svg', 'manifest.webmanifest', '.nojekyll',
];
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'vendor'), { recursive: true });
for (const name of assets) await cp(resolve(root, name), resolve(output, name));
await build({
  stdin: { contents: 'export { createClient } from "@supabase/supabase-js";', resolveDir: root, sourcefile: 'supabase-entry.js' },
  outfile: resolve(output, 'vendor/supabase.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'warning',
});
const hashes = {};
for (const name of [...assets.filter(name => name !== '.nojekyll'), 'vendor/supabase.js']) {
  hashes[`./${name}`] = createHash('sha256').update(await readFile(resolve(output, name))).digest('hex');
}
hashes['./'] = hashes['./index.html'];
const workerSource = await readFile(resolve(root, 'sw.js'), 'utf8');
const buildId = createHash('sha256').update(JSON.stringify(hashes)).update(workerSource).digest('hex').slice(0, 16);
const worker = workerSource
  .replace("const CACHE_VERSION = 'form-v2';", `const CACHE_VERSION = 'form-v2-${buildId}';`)
  .replace('const SHELL_HASHES = {};', `const SHELL_HASHES = ${JSON.stringify(hashes, null, 2)};`);
await writeFile(resolve(output, 'sw.js'), worker);
console.log(`Built Form (${buildId}) in dist/`);
