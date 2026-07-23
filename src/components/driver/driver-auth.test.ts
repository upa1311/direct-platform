import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "../../prototype/default-state.ts";
import type { DriverProfile } from "../../prototype/models.ts";
import {
  authenticateDriver,
  getDriverDisplayName,
  normalizeDriverName,
  normalizeDriverPhone,
} from "./driver-auth.ts";

/**
 * Прототипный вход водителя по имени и телефону. Идентификация fail-closed:
 * несовпадение или неоднозначность → null, ошибка не раскрывает существование
 * имени или телефона.
 */

const drivers = createDefaultState().drivers;
const peter = drivers.find((d) => d.name === "Водитель Пётр") as DriverProfile;

test("1: имя и телефон обязательны", () => {
  assert.equal(authenticateDriver(drivers, "", "+373 777 40001"), null);
  assert.equal(authenticateDriver(drivers, "Пётр", ""), null);
  assert.equal(authenticateDriver(drivers, "   ", "   "), null);
});

test("2: «Пётр» совпадает с «Водитель Пётр»", () => {
  assert.equal(authenticateDriver(drivers, "Пётр", peter.phone)?.id, peter.id);
  assert.equal(
    authenticateDriver(drivers, "Водитель Пётр", peter.phone)?.id,
    peter.id,
  );
});

test("3: сравнение имени без учёта регистра", () => {
  assert.equal(
    authenticateDriver(drivers, "водитель пётр", peter.phone)?.id,
    peter.id,
  );
  assert.equal(authenticateDriver(drivers, "ПЁТР", peter.phone)?.id, peter.id);
});

test("4: лишние пробелы не мешают", () => {
  assert.equal(
    authenticateDriver(drivers, "  Водитель   Пётр  ", peter.phone)?.id,
    peter.id,
  );
});

test("5: форматирование телефона не мешает", () => {
  for (const phone of ["+373 777 40001", "37377740001", "+373-777-40001"]) {
    assert.equal(authenticateDriver(drivers, "Пётр", phone)?.id, peter.id);
  }
});

test("6: неверное имя не проходит", () => {
  assert.equal(authenticateDriver(drivers, "Иван", peter.phone), null);
});

test("7: неверный телефон не проходит", () => {
  assert.equal(authenticateDriver(drivers, "Пётр", "+373 000 00000"), null);
  assert.equal(authenticateDriver(drivers, "Пётр", "буквы"), null);
});

test("8: совпадение только по имени не проходит", () => {
  assert.equal(authenticateDriver(drivers, "Пётр", "37300000000"), null);
});

test("9: совпадение только по телефону не проходит", () => {
  assert.equal(authenticateDriver(drivers, "Кто-то", peter.phone), null);
});

test("10: неоднозначное совпадение fail-closed", () => {
  // Два профиля с одинаковыми именем и телефоном → вход запрещён.
  const twin: DriverProfile = { ...peter, id: "driver-twin" };
  assert.equal(authenticateDriver([peter, twin], "Пётр", peter.phone), null);
});

test("11: одна общая ошибка (проверяется в UI) — здесь просто null, без деталей", () => {
  // Функция не сообщает, ЧТО именно неверно: и неверное имя, и неверный телефон
  // дают одинаковый null.
  assert.equal(authenticateDriver(drivers, "Нет", peter.phone), null);
  assert.equal(authenticateDriver(drivers, "Пётр", "37300000000"), null);
});

test("12: alias «Водитель» отдельным словом не входит (иначе неоднозначно)", () => {
  // «Водитель» без имени не совпадает ни с полным, ни с усечённым именем.
  assert.equal(authenticateDriver(drivers, "Водитель", peter.phone), null);
});

test("нормализация имени: trim, схлопывание пробелов, нижний регистр", () => {
  assert.equal(normalizeDriverName("  Водитель   Пётр "), "водитель пётр");
});

test("нормализация телефона: только цифры", () => {
  assert.equal(normalizeDriverPhone("+373-777 40001"), "37377740001");
  assert.equal(normalizeDriverPhone("нет цифр"), "");
});

test("getDriverDisplayName убирает только начальный префикс «Водитель »", () => {
  assert.equal(getDriverDisplayName(peter), "Пётр");
  const custom: DriverProfile = { ...peter, name: "Пётр Водитель" };
  assert.equal(getDriverDisplayName(custom), "Пётр Водитель");
});
