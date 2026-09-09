import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

const required = [
  'index.html',
  'products/mavic-4-pro-wide-angle/index.html',
  'warranty.html',
  'support/index.html',
  'support/policy.html',
  'repair-pricing/index.html',
  'downloads/index.html',
  'content/site.js',
  'content/product.js',
  'script.js',
  'warranty.js',
  'styles.css',
  'assets/optimized/hero-poster-desktop.jpg',
  'assets/optimized/hero-poster-desktop.webp',
  'assets/optimized/hero-poster-desktop.avif',
  'assets/optimized/hero-poster-mobile.jpg',
  'assets/optimized/hero-poster-mobile.webp',
  'assets/optimized/hero-poster-mobile.avif',
  'assets/optimized/product-wide-angle.png',
  'assets/optimized/product-wide-angle.webp',
  'assets/optimized/product-wide-angle.avif',
  'assets/optimized/optics-detail.jpg',
  'assets/optimized/optics-detail.webp',
  'assets/optimized/optics-detail.avif',
  'assets/optimized/engineering.jpg',
  'assets/optimized/engineering.webp',
  'assets/optimized/engineering.avif',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi.jpg',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi.webp',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi.avif',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi-mobile.jpg',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi-mobile.webp',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi-mobile.avif'
];

function urlFor(path) {
  return new URL(path, root);
}

function read(path) {
  return readFileSync(urlFor(path), 'utf8');
}

for (const file of required) {
  if (!existsSync(urlFor(file))) {
    throw new Error(`Missing website file: ${file}`);
  }
}

const textFiles = [
  'index.html',
  'products/mavic-4-pro-wide-angle/index.html',
  'warranty.html',
  'support/index.html',
  'support/policy.html',
  'repair-pricing/index.html',
  'downloads/index.html',
  'booking.html',
  'support/activate.html',
  'content/site.js',
  'content/product.js',
  'script.js',
  'warranty.js',
  'styles.css'
];

const combined = textFiles.map((file) => `\n/* ${file} */\n${read(file)}`).join('\n');

const forbiddenPatterns = [
  [/picsum\.photos/i, 'Do not use Picsum or unrelated placeholder image services.'],
  [/formspree\.io/i, 'Do not bring legacy Formspree flows into V2.'],
  [/fetch\(["'`][^"'`]*data\/[^"'`]*\.json/i, 'Do not use legacy static JSON serial-number lookup.'],
  [/assets\/firstpage\.jpg/i, 'Do not load the 14MB hero original directly in V2 pages.'],
  [/assets\/2\.jpg/i, 'Do not load the large original optics image directly in V2 pages.'],
  [/assets\/second\.jpg/i, 'Do not load the large original engineering image directly in V2 pages.'],
  [/\/products\/anamorphic/i, 'Product detail URL must not use anamorphic naming.']
];

for (const [pattern, message] of forbiddenPatterns) {
  if (pattern.test(combined)) {
    throw new Error(message);
  }
}

const warrantyJs = read('warranty.js');
for (const token of [
  'https://dealersystem.maxcine.cn/api',
  '/public/warranty/challenges',
  '/public/warranty/challenges/${encodeURIComponent(challengeId)}/complete',
  '/public/warranty/${encodeURIComponent(normalized)}',
  'challengeId',
  'sliderToken'
]) {
  if (!warrantyJs.includes(token)) {
    throw new Error(`Warranty frontend no longer matches Public Warranty API contract: ${token}`);
  }
}

for (const token of ['data/', 'admin_private', 'object_key', 'factory photos', 'Internal Warranty']) {
  if (warrantyJs.includes(token)) {
    throw new Error(`Warranty frontend must not request or expose ${token}.`);
  }
}

const siteContent = read('content/site.js');
for (const token of [
  'hero-desktop.mp4',
  'hero-mobile.mp4',
  'sample-desktop.mp4',
  'sample-mobile.mp4',
  'type="image/avif"',
  'type="image/webp"',
  'CG.W101',
  'CG.W102',
  'CG.W103'
]) {
  if (!combined.includes(token) && !siteContent.includes(token)) {
    throw new Error(`Missing V2 reserved content token: ${token}`);
  }
}

for (const file of [
  'assets/optimized/hero-poster-desktop.jpg',
  'assets/optimized/hero-poster-desktop.webp',
  'assets/optimized/hero-poster-desktop.avif',
  'assets/optimized/hero-poster-mobile.jpg',
  'assets/optimized/hero-poster-mobile.webp',
  'assets/optimized/hero-poster-mobile.avif',
  'assets/optimized/optics-detail.jpg',
  'assets/optimized/optics-detail.webp',
  'assets/optimized/optics-detail.avif',
  'assets/optimized/engineering.jpg',
  'assets/optimized/engineering.webp',
  'assets/optimized/engineering.avif',
  'assets/optimized/product-wide-angle.png',
  'assets/optimized/product-wide-angle.webp',
  'assets/optimized/product-wide-angle.avif',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi.jpg',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi.webp',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi.avif',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi-mobile.jpg',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi-mobile.webp',
  'assets/product/hero/maxcine-mavic-4-pro-sci-fi-mobile.avif'
]) {
  const size = statSync(urlFor(file)).size;
  if (size > 900 * 1024) {
    throw new Error(`Optimized asset is too large for staging: ${relative(rootPath, fileURLToPath(urlFor(file)))} (${size} bytes)`);
  }
}

console.log('Website V2 static files verified.');
