import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const fromRoot = (name) => new URL(name, root);
const manifest = JSON.parse(await readFile(fromRoot('manifest.json'), 'utf8'));
const archiveName = manifest.id + '-' + manifest.version + '.boboplugin';
const artifact = fromRoot('artifacts/' + archiveName);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readText = async (file) => (await readFile(fromRoot(file), 'utf8')).replace(/\r\n/g, '\n');

async function bundle(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(fromRoot('src/' + entry))], absWorkingDir: fileURLToPath(root),
    write: false, bundle: true, format: 'esm', platform: 'browser', target: 'chrome130',
    minify: true, legalComments: 'inline'
  });
  return result.outputFiles[0].contents;
}

async function css() {
  const base = (await readFile(fromRoot('node_modules/temml/dist/Temml.woff2'))).toString('base64');
  const math = (await readText('node_modules/temml/dist/Temml-Local.css'))
    .replace("url('Temml.woff2')", "url('data:font/woff2;base64," + base + "')");
  return (await readText('src/view.css')) + '\n' + math;
}

async function notices() {
  const licenses = [
    'temml/LICENSE', 'markdown-it/LICENSE', '@mdit/plugin-tex/LICENSE', '@mdit/helper/LICENSE',
    'dompurify/LICENSE-MPL', 'lucide/LICENSE', 'argparse/LICENSE', 'entities/LICENSE',
    'linkify-it/LICENSE', 'mdurl/LICENSE', 'punycode.js/LICENSE-MIT.txt', 'uc.micro/LICENSE.txt',
    'highlight.js/LICENSE', 'jsonc-parser/LICENSE.md'
  ];
  return (await Promise.all(licenses.map(async (file) => file + '\n' + await readText('node_modules/' + file)))).join('\n\n');
}

async function buildArchive() {
  const packageJson = JSON.parse(await readText('package.json'));
  assert.equal(manifest.version, packageJson.version, 'manifest and package versions must agree');
  const [extension, notebook, stylesheet, licenses] = await Promise.all([
    bundle('extension.js'), bundle('notebook.js'), css(), notices()
  ]);
  const payload = {
    'dist/extension.js': extension,
    'dist/notebook.js': notebook,
    'dist/view.css': Buffer.from(stylesheet),
    'THIRD-PARTY.txt': Buffer.from(licenses)
  };
  for (const file of new Set(Object.values(manifest.localization))) payload[file] = Buffer.from(await readText(file));
  const names = Object.keys(payload).sort();
  for (const name of names) assert.ok(payload[name].length < 8 * 1024 * 1024, name);
  const integrity = { algorithm: 'sha256', files: Object.fromEntries(names.map((name) => [name, sha256(payload[name])])) };
  const entries = {
    'manifest.json': Buffer.from(JSON.stringify({ ...manifest, integrity }, null, 2) + '\n'),
    ...Object.fromEntries(names.map((name) => [name, payload[name]]))
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [
    name, [value, { mtime: new Date(2026, 0, 1, 0, 0, 0) }]
  ])), { level: 9 }));
}

const bytes = await buildArchive();
const sum = sha256(bytes) + '  ' + archiveName + '\n';
if (process.argv.includes('--check')) {
  if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, 'v' + manifest.version);
  assert.ok(bytes.equals(await readFile(artifact)), 'committed artifact differs from the rebuilt artifact');
  assert.equal(await readText('artifacts/' + archiveName + '.sha256'), sum);
} else {
  await mkdir(fromRoot('artifacts/'), { recursive: true });
  await writeFile(artifact, bytes);
  await writeFile(fromRoot('artifacts/' + archiveName + '.sha256'), sum);
}
console.log(sum.trim());
