import { defineConfig, devices } from '@playwright/test';

const commonLaunchArgs = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--disable-default-apps',
  '--disable-popup-blocking',
];

export default defineConfig({
  testDir: './tests/stripe-subs',
  workers: 2,
  fullyParallel: true,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  retries: 0,

  reporter: [
    ['list'],
    ['./dashboard/reporter.js'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    baseURL: 'https://pri-qa.insight.netgear.com',
    screenshot: 'on',
    trace: 'on',
    video: 'on',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    headless: false,
  },

  projects: [
    {
      name: 'demo',
      testMatch: /demo-e2e\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        launchOptions: { args: [...commonLaunchArgs, '--window-size=1280,900', '--window-position=100,50'] },
      },
    },
    {
      name: 'demo2',
      testMatch: /demo-final\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        launchOptions: { args: [...commonLaunchArgs, '--window-size=1280,900', '--window-position=100,50'] },
      },
    },
    {
      name: 'zephyr-ai-hk',
      testDir: './tests/zephyr-ai-hk',
      testMatch: /z-\d{2}-.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        launchOptions: { args: [...commonLaunchArgs, '--window-size=1920,1080'] },
      },
    },
    {
      name: 'explore-dpro',
      testMatch: /explore-direct-pro\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        launchOptions: { args: ['--window-size=1920,1080'] },
      },
    },
    // ── Hackathon Demo — Worker 1: 1-Year account on pri-qa ──
    {
      name: 'hackathon-demo',
      testMatch: /demo-hackathon\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        launchOptions: { args: [...commonLaunchArgs, '--window-size=1280,900', '--window-position=50,50'] },
      },
    },
    // ── Hackathon Demo — Worker 2: 3-Year account on maint-beta ──
    {
      name: 'hackathon-3yr',
      testMatch: /demo-hackathon-3yr\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        launchOptions: { args: [...commonLaunchArgs, '--window-size=1280,900', '--window-position=950,50'] },
      },
    },
    // ── Drop 5 production release suites ──
    {
      name: 'drop5-release',
      testMatch: /test-drop5-.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        launchOptions: { args: [...commonLaunchArgs, '--window-size=1920,1080'] },
      },
    },
    {
      name: 'drop5-1yr',
      testMatch: /test-drop5-1yr\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        launchOptions: { args: [...commonLaunchArgs, '--window-size=1920,1080'] },
      },
    },
    {
      name: 'drop5-3yr',
      testMatch: /test-drop5-3yr\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        launchOptions: { args: [...commonLaunchArgs, '--window-size=1920,1080'] },
      },
    },
  ],
});
