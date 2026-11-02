import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests-pwa',
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox','--disable-dev-shm-usage'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: { command: 'node scripts/serve-pwa-test.mjs', url: 'http://127.0.0.1:4174', reuseExistingServer: false },
})
