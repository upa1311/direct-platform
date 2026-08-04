import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } },
    },
  ],
  webServer: {
    command: `${npm} run build && ${npm} run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/admin/delivery-quote-login`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      ...process.env,
      AUTH_URL: baseURL,
      AUTH_SECRET: "local-e2e-auth-material-000000000000000000000000",
      AUTH_GITHUB_ID: "disabled-in-e2e",
      AUTH_GITHUB_SECRET: "disabled-in-e2e",
      ADMIN_GITHUB_USER_IDS: "424242",
      AUTH_E2E_CREDENTIAL_SECRET: "local-browser-flow",
      QUOTE_TOKEN_SECRET: "local-e2e-quote-material-0000000000000000000000",
      DATABASE_URL: "pglite://e2e",
      QUOTE_E2E_MODE: "1",
      OSRM_BASE_URL: `${baseURL}/api/e2e-osrm`,
    },
  },
});
