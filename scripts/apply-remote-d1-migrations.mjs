import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const databaseName = process.argv[2];
const envName = process.argv[3] ?? 'production';
const configPath = process.argv[4] ?? 'apps/api/wrangler.toml';
const migrationsDir = process.argv[5] ?? 'apps/api/migrations';

if (!databaseName) {
  throw new Error('Usage: node scripts/apply-remote-d1-migrations.mjs <database-name> [env] [wrangler-config] [migrations-dir]');
}

function runWrangler(args, options = {}) {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: options.stdio ?? 'pipe' });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function getAppliedMigrations() {
  try {
    const output = runWrangler([
      'd1',
      'execute',
      databaseName,
      '--remote',
      '--env',
      envName,
      '--config',
      configPath,
      '--command',
      'SELECT name FROM d1_migrations ORDER BY id;'
    ]);
    const payload = JSON.parse(output.slice(output.indexOf('[')));
    return new Set((payload[0]?.results ?? []).map((row) => row.name));
  } catch {
    runWrangler([
      'd1',
      'execute',
      databaseName,
      '--remote',
      '--env',
      envName,
      '--config',
      configPath,
      '--command',
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);'
    ], { stdio: 'inherit' });
    return new Set();
  }
}

const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const applied = getAppliedMigrations();

for (const file of migrationFiles) {
  if (applied.has(file)) {
    console.log(`Skipping ${file}`);
    continue;
  }
  const filePath = join(migrationsDir, file);
  console.log(`Applying ${file}`);
  runWrangler([
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--env',
    envName,
    '--config',
    configPath,
    '--file',
    filePath
  ], { stdio: 'inherit' });
  runWrangler([
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--env',
    envName,
    '--config',
    configPath,
    '--command',
    `INSERT INTO d1_migrations (name) SELECT ${sqlString(basename(file))} WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ${sqlString(basename(file))});`
  ], { stdio: 'inherit' });
}

console.log(`D1 migrations complete for ${databaseName}.`);
