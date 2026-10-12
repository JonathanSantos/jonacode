// End-to-end tests in real engines: Chromium, Firefox and WebKit (desktop), plus mobile Chromium for touch.
//   npm run e2e | e2e:chromium | e2e:firefox | e2e:webkit      (browsers once: npm run e2e:install)
//   E2E_SHOW_BUGS=1 npm run e2e    also runs the tests marked as known library bugs (knownBug → fixme)
//   E2E_PORT=5200 npm run e2e      another port for the fixture server (default 5199)
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT) || 5199
const CI = !!process.env.CI
const touchOnly = /touch\.spec\.ts$/

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: CI,
  // One retry on CI: a test that only passes on retry is reported as flaky (fix it), not hidden.
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // `npm run e2e:report` opens the HTML report of the last run.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1000, height: 700 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/dev.js --no-watch',
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/e2e/fixture.html`,
    reuseExistingServer: !CI,
    stdout: 'ignore',
  },
  projects: [
    // Real user agents (no device descriptors): the library picks Cmd vs Ctrl from the platform.
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: touchOnly },
    { name: 'firefox', use: { browserName: 'firefox' }, testIgnore: touchOnly },
    { name: 'webkit', use: { browserName: 'webkit' }, testIgnore: touchOnly },
    // Touch-specific specs only: emulated phone (isMobile, hasTouch) on Chromium.
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, testMatch: touchOnly },
  ],
})
