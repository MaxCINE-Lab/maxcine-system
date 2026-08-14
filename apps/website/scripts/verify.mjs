import { existsSync } from 'node:fs';

const required = ['index.html', 'warranty.html', 'warranty.js', 'styles.css'];
for (const file of required) {
  if (!existsSync(new URL(`../${file}`, import.meta.url))) {
    throw new Error(`Missing website file: ${file}`);
  }
}

console.log('Website static files verified.');
