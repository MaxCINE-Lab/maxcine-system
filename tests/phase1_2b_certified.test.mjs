import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';

function migratedDatabase() {
  const database = new DatabaseSync(':memory:');
  const migrationRoot = new URL('../apps/api/migrations/', import.meta.url);
  for (const filename of readdirSync(migrationRoot).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(new URL(filename, migrationRoot), 'utf8'));
  }
  return database;
}

test('0033 stores exact Certified V1 display grades additively and preserves foreign keys', () => {
  const database = migratedDatabase();
  database.prepare(`INSERT INTO assets (id, asset_code) VALUES ('cert-asset', 'MC-26-CERT-000001')`).run();
  const insert = database.prepare(`INSERT INTO asset_inspection_tasks (id, asset_id, status, grade, grade_display) VALUES (?, 'cert-asset', 'completed', ?, ?)`);
  for (const [index, grade] of ['A+', 'A', 'B+', 'B', 'Parts / Repair'].entries()) insert.run(`task-${index}`, grade.startsWith('A') ? 'A' : grade.startsWith('B') ? 'B' : 'D', grade);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM asset_inspection_tasks WHERE asset_id = 'cert-asset'`).get().count, 5);
  assert.deepEqual(database.prepare(`SELECT grade_display AS grade FROM asset_inspection_tasks WHERE asset_id = 'cert-asset' ORDER BY id`).all().map((row) => row.grade), ['A+', 'A', 'B+', 'B', 'Parts / Repair']);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('Final QC permission is not granted to ordinary Certified operators', () => {
  const database = migratedDatabase();
  const rows = database.prepare(`SELECT roles.code AS roleCode FROM role_permissions JOIN roles ON roles.id = role_permissions.role_id WHERE permission_code = 'certified:final-qc' ORDER BY roles.code`).all();
  assert.deepEqual(rows.map((row) => row.roleCode), ['international_operator']);
  database.close();
});

test('Inspector completion and Final QC certification use separate server routes', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/certified\/tasks\/:id'/);
  assert.match(source, /app\.post\('\/certified\/tasks\/:id\/complete'/);
  assert.match(source, /app\.post\('\/certified\/tasks\/:id\/final-qc'/);
  assert.match(source, /assertCertifiedFinalQcPermission\(user\)/);
  assert.match(source, /requireInspectionAssignment\(user, task\.assignedTo\)/);
  assert.match(source, /final_qc = 1/);
  assert.match(source, /'certification_issued'/);
});

test('Certified workspace exposes the complete browser workflow and centralized checklist', () => {
  const source = readFileSync(new URL('../apps/web/src/InternationalPortal.tsx', import.meta.url), 'utf8');
  for (const code of ['appearance', 'power', 'screen', 'buttons', 'usb_c', 'camera', 'recording', 'gimbal', 'microphone', 'wireless', 'battery', 'firmware']) assert.match(source, new RegExp(`code: '${code}'`));
  assert.match(source, /const taskMatch = path\.match/);
  assert.match(source, /uploadFormData<Evidence>/);
  assert.match(source, /Photo Evidence 上传成功/);
  assert.match(source, /完成检测/);
  assert.match(source, /Approve & Certify/);
  assert.match(source, /FAIL \/ ADVISORY 必须填写说明/);
});
