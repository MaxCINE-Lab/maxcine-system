import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'roles.spec.mjs',
  timeout: 45_000,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'retain-on-failure' },
  reporter: [['list']]
});
