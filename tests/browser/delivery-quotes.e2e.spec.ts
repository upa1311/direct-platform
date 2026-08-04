import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function login(page: Page) {
  await page.goto("/admin/delivery-quotes");
  await expect(page).toHaveURL(/delivery-quote-login/);
  await page.getByText("Локальный E2E-вход").click();
  await page.getByLabel("GitHub user ID").fill("424242");
  await page.getByLabel("E2E secret").fill("local-browser-flow");
  await page.getByRole("button", { name: "Войти локально" }).click();
  await expect(page).toHaveURL(/\/admin\/delivery-quotes$/);
  await expect(page.getByTestId("delivery-quote-console")).toBeVisible();
}

async function chooseAddress(page: Page, field: "Адрес A" | "Адрес B", query: string) {
  await page.getByLabel(field).fill(query);
  const options = page.getByRole("option");
  await expect.poll(async () => options.count()).toBeGreaterThan(0);
  await options.first().click();
}

test("unauthorized APIs reveal neither history nor address registry", async ({ request }) => {
  const history = await request.get("/api/quotes");
  expect(history.status()).toBe(401);
  expect(await history.json()).toEqual({ error: "Требуется авторизация администратора." });
  const addresses = await request.get("/api/delivery-addresses?q=Бендеры");
  expect(addresses.status()).toBe(401);
});

test("authenticated quote flow persists, edits and exports immutable snapshot", async ({ page }) => {
  await login(page);
  await chooseAddress(page, "Адрес A", "Титова, 80");
  await chooseAddress(page, "Адрес B", "Протягайловка");
  await page.getByRole("button", { name: "Рассчитать на сервере" }).click();
  await expect.poll(async () => page.getByTestId("quote-summary").count(), { timeout: 20_000 }).toBe(1);
  await expect(page.getByTestId("quote-summary")).toContainText("8.00 км");
  await page.getByLabel("Заметка").fill("Проверено браузерным E2E");
  await page.getByRole("button", { name: "Явно сохранить котировку" }).click();
  await expect(page.getByRole("status")).toContainText(/Сохранено: DQ-/);

  await page.getByRole("button", { name: "История" }).click();
  await expect.poll(async () => page.locator("tbody tr").count()).toBeGreaterThan(0);
  await page.locator("tbody tr").first().click();
  await expect(page.getByTestId("quote-detail")).toContainText("Проверено браузерным E2E");

  const jsonDownloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "JSON" }).click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonPath = await jsonDownload.path();
  expect(jsonPath).toBeTruthy();
  const exported = JSON.parse(await readFile(jsonPath!, "utf8"));
  expect(exported.quoteNumber).toMatch(/^DQ-/);
  expect(exported.totalPriceCents).toBe(exported.basePriceCents + exported.externalSurchargeCents);
  expect(exported.tariffVersion).toBe("bender-reference-v3");
  expect(exported.checkpoint.status).toBe("owner_approved");
  expect(exported.routeGeometry.type).toBe("LineString");

  const csvDownloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Скачать CSV" }).click();
  const csvPath = await (await csvDownloadPromise).path();
  const csv = await readFile(csvPath!, "utf8");
  expect(csv).toContain("quote_number,created_at,status");
  expect(csv).toContain(exported.quoteNumber);

  await page.getByTestId("quote-detail").getByRole("combobox").selectOption("confirmed");
  await expect(page.getByTestId("quote-detail")).toContainText(exported.quoteNumber);
  await page.reload();
  await page.getByRole("button", { name: "История" }).click();
  await expect.poll(async () => page.locator("tbody tr").count()).toBeGreaterThan(0);
  await expect(page.locator("tbody")).toContainText(exported.quoteNumber);
});

test("registry, responsive map layout, swap and logout work", async ({ page }, testInfo) => {
  await login(page);
  await chooseAddress(page, "Адрес A", "Титова, 80");
  await chooseAddress(page, "Адрес B", "Протягайловка");
  const firstA = await page.getByLabel("Адрес A").inputValue();
  const firstB = await page.getByLabel("Адрес B").inputValue();
  await page.getByRole("button", { name: "Поменять адреса местами" }).click();
  expect(await page.getByLabel("Адрес A").inputValue()).toBe(firstB);
  expect(await page.getByLabel("Адрес B").inputValue()).toBe(firstA);

  const panel = await page.getByTestId("calculator-panel").boundingBox();
  const map = await page.getByTestId("quote-map").boundingBox();
  const legend = await page.getByTestId("map-legend").boundingBox();
  expect(panel && map && legend).toBeTruthy();
  const overlaps = panel!.x < map!.x + map!.width
    && panel!.x + panel!.width > map!.x
    && panel!.y < map!.y + map!.height
    && panel!.y + panel!.height > map!.y;
  expect(overlaps, `${testInfo.project.name}: calculator panel overlaps map`).toBe(false);
  expect(legend!.x).toBeGreaterThanOrEqual(map!.x);
  expect(legend!.y).toBeGreaterThanOrEqual(map!.y);
  expect(legend!.x + legend!.width).toBeLessThanOrEqual(map!.x + map!.width + 1);
  expect(legend!.y + legend!.height).toBeLessThanOrEqual(map!.y + map!.height + 1);

  await page.getByRole("button", { name: "Адресный реестр" }).click();
  await expect(page.getByText("9 216 адресов")).toBeVisible();
  await page.getByLabel("Поиск по адресному реестру").fill("Титова, 80");
  await expect.poll(async () => page.locator("button", { hasText: "Титова, 80" }).count()).toBeGreaterThan(0);
  const addressCsvPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Скачать CSV" }).click();
  const addressCsvPath = await (await addressCsvPromise).path();
  expect(await readFile(addressCsvPath!, "utf8")).toContain("id,address,lon,lat,status,zone_id");

  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page).toHaveURL(/delivery-quote-login/);
  const response = await page.request.get("/api/quotes");
  expect(response.status()).toBe(401);
});
