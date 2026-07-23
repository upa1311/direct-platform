import type { DriverProfile } from "@/prototype/models";

/**
 * Прототипный вход водителя по имени и номеру телефона (без SMS/OTP/пароля).
 * Чистые функции: без localStorage и React — их можно проверить доменным тестом.
 *
 * Идентификация fail-closed: при пустых данных, несовпадении или любой
 * неоднозначности возвращается null, а UI показывает ОДНУ общую ошибку, не
 * раскрывающую существование имени или телефона (нельзя перебирать профили).
 */

/** Начальный префикс доменного имени сид-водителей. */
const NAME_PREFIX = "Водитель ";

/**
 * Нормализация имени: trim, схлопывание пробелов, locale-aware нижний регистр.
 * Доменное имя водителя не меняется — это только форма для сравнения.
 */
export function normalizeDriverName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

/** Нормализация телефона: только цифры (формат и разделители игнорируются). */
export function normalizeDriverPhone(value: string): string {
  return (value.match(/\d/g) ?? []).join("");
}

/**
 * Отображаемое имя без технического префикса «Водитель ». Убирает ТОЛЬКО
 * начальный префикс; остальные имена не меняет. Доменное имя остаётся прежним.
 */
export function getDriverDisplayName(driver: DriverProfile): string {
  return driver.name.startsWith(NAME_PREFIX)
    ? driver.name.slice(NAME_PREFIX.length)
    : driver.name;
}

/** Допустимые нормализованные формы имени водителя для входа. */
function acceptedNames(driver: DriverProfile): string[] {
  const full = normalizeDriverName(driver.name);
  const withoutPrefix = normalizeDriverName(getDriverDisplayName(driver));
  return full === withoutPrefix ? [full] : [full, withoutPrefix];
}

/**
 * Находит водителя по имени и телефону. Совпадение требуется ОДНОВРЕМЕННО по
 * обоим полям. При пустом вводе, отсутствии совпадений или более чем одном
 * совпадении — null (первый профиль не выбирается).
 */
export function authenticateDriver(
  drivers: readonly DriverProfile[],
  name: string,
  phone: string,
): DriverProfile | null {
  const nName = normalizeDriverName(name);
  const nPhone = normalizeDriverPhone(phone);
  if (nName === "" || nPhone === "") return null;

  const matches = drivers.filter(
    (driver) =>
      normalizeDriverPhone(driver.phone) === nPhone &&
      acceptedNames(driver).includes(nName),
  );
  return matches.length === 1 ? matches[0] : null;
}
