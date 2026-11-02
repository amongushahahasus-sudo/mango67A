import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests-accounts',
  outputDir: './.local/test-results/accounts',
  workers: 2,
  retries: 0,
  use: { baseURL:'http://127.0.0.1:5175', headless:true, launchOptions:{executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']}, screenshot:'only-on-failure',trace:'retain-on-failure' },
  webServer:{
    command:'npm run build -- --outDir .local/account-dist && node scripts/serve-pwa-test.mjs',
    env:{VITE_EMAIL_REGISTRATION_READY:'true',VITE_SUPABASE_URL:'https://testproject.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test_public_key_1234567890',MANGO_PWA_TEST_PORT:'5175',MANGO_PWA_TEST_ROOT:'.local/account-dist'},
    url:'http://127.0.0.1:5175',reuseExistingServer:false,
  },
})
