import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist/vendor', { recursive: true });
await build({ entryPoints: ['src/exporter.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, outfile: 'dist/vendor/exporter.js', legalComments: 'linked' });
for (const family of ['noto-sans-jp', 'noto-serif-jp', 'm-plus-1', 'inter']) {
  const from = `node_modules/@fontsource-variable/${family}`;
  const css = await readFile(`${from}/index.css`, 'utf8');
  await mkdir(`dist/fonts/${family}/files`, { recursive: true });
  // Canvas has no writing-mode. Expose the font's vertical alternates through
  // a separate family while sharing exactly the same cached font files.
  const verticalCss = css.replace(/@font-face\s*\{([^}]+)\}/g, (rule, body) => rule + '\n@font-face {' + body.replace(/font-family:\s*'([^']+)'/, "font-family: '$1 Vertical'") + '\n  font-feature-settings: "vert" 1, "vrt2" 1;\n}');
  await writeFile(`dist/fonts/${family}/index.css`, family === 'inter' ? css : verticalCss);
  for (const [, file] of css.matchAll(/url\(\.\/files\/([^)]*)\)/g)) await copyFile(`${from}/files/${file}`, `dist/fonts/${family}/files/${file}`);
  await copyFile(`${from}/LICENSE`, `dist/fonts/${family}/LICENSE`);
}
await mkdir('dist/licenses', { recursive: true });
for (const [name, dir] of [['mediabunny', 'mediabunny'], ['aac-encoder', '@mediabunny/aac-encoder']]) {
  await copyFile(`node_modules/${dir}/LICENSE`, `dist/licenses/${name}.txt`);
}
// GitHub Pages serves main at /: keep the app entry there and assets under dist/.
// Generate from the local entry so markup stays identical across both URLs.
const appHtml = await readFile('dist/index.html', 'utf8');
const pagesHtml = appHtml.replace(/(<(?:link|script)\b[^>]*\b(?:href|src)=")\.\//g, '$1./dist/');
await writeFile('index.html', pagesHtml);
console.log('Built local MP4 encoder, bundled fonts and GitHub Pages entry.');
