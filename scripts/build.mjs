import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/app.js', 'src/color-check-worker.js', 'src/model-worker.js', 'src/fill-worker.js', 'src/matching-worker.js'],
  bundle: true,
  minify: true,
  target: 'chrome130',
  outdir: 'dist',
  legalComments: 'eof',
});
await Promise.all([
  copyFile('src/index.html', 'dist/index.html'),
  copyFile('src/style.css', 'dist/style.css'),
  copyFile('assets/icon.ico', 'dist/icon.ico'),
  copyFile('assets/juniper.stlp', 'dist/juniper.stlp'),
]);
const notices = [];
for (const [name, file] of [
  ['three', 'LICENSE'],
  ['three-mesh-bvh', 'LICENSE'],
  ['fflate', 'LICENSE'],
  ['lucide', 'LICENSE'],
]) {
  notices.push(name + '\n\n' + (await readFile('node_modules/' + name + '/' + file, 'utf8')));
}
notices.push('Prusa FDM Mixer\n\n' + await readFile('src/vendor/prusa-fdm-mixer/LICENSE', 'utf8'));
await writeFile('dist/THIRD-PARTY-NOTICES.txt', notices.join('\n\n'));

await build({ entryPoints: ['desktop/file-writer.mjs'], outfile: 'dist/file-writer.cjs', platform: 'node', format: 'cjs', bundle: true });
