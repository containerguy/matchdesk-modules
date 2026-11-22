import { defineConfig, devices } from "@playwright/test";

/**
 * Ende-zu-Ende-Test über alle drei Repos: Matchdesk (Kern), dieses Modul-Repo (arena) und den
 * Billard-Server. Die Pfade zu den Nachbar-Repos kommen aus MATCHDESK_DIR und BILLIARD_DIR
 * (Standard: Geschwisterordner ../Matchdesk und ../matchdesk-billiard).
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    ...devices["Desktop Chrome"],
    locale: "de-DE",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure"
  },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]] : [["list"]],
  outputDir: "../test-results"
});
