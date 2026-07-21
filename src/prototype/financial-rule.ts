// Версионированное финансовое правило Direct.
//
// Базовый модуль без зависимостей: чистые типы, immutable registry и validator.
// Смысл — provenance: каждый заказ хранит СНИМОК правила, по которому были
// посчитаны его банковские суммы, поэтому старый заказ всегда объясняется и
// проверяется по своему правилу, а не по текущим константам кода. Смена
// активного правила в будущем не переписывает историю задним числом.

/** Известные версии финансового правила. */
export type FinancialRuleVersion = "DIRECT_FINANCIAL_RULE_V1";

/** Снимок правила, сохраняемый в финансовом снимке заказа. */
export interface FinancialRuleSnapshot {
  version: FinancialRuleVersion;
  /** Продуктовая дата начала применения правила (не время создания заказа). */
  effectiveAt: string;
  /** Ставка банковской комиссии карточной транзакции, базисные пункты. */
  bankCardFeeRateBps: number;
}

/**
 * Immutable registry правил. Опубликованная запись НЕ меняется: правка ставки
 * существующей версии переписала бы историю всех заказов с этим снимком —
 * вместо этого добавляется новая версия.
 */
export const FINANCIAL_RULES: Readonly<
  Record<FinancialRuleVersion, FinancialRuleSnapshot>
> = Object.freeze({
  DIRECT_FINANCIAL_RULE_V1: Object.freeze({
    version: "DIRECT_FINANCIAL_RULE_V1",
    effectiveAt: "2026-07-20T00:00:00.000Z",
    bankCardFeeRateBps: 100,
  }),
});

/** Правило, применяемое к НОВЫМ заказам. Историю не затрагивает. */
export const ACTIVE_FINANCIAL_RULE_VERSION: FinancialRuleVersion =
  "DIRECT_FINANCIAL_RULE_V1";

/**
 * Канонический ISO-8601 timestamp с обязательным часовым поясом. Локальная
 * копия проверки: financial-rule — базовый модуль без зависимостей, чтобы не
 * образовывать цикл импортов с доменом расчётов.
 */
const CANONICAL_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!CANONICAL_ISO_PATTERN.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Известна ли версия правила. */
export function isKnownFinancialRuleVersion(
  value: unknown,
): value is FinancialRuleVersion {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(FINANCIAL_RULES, value)
  );
}

export type FinancialRuleValidationResult =
  | { ok: true; rule: FinancialRuleSnapshot }
  | { ok: false; error: string };

/**
 * Проверка снимка правила: известная версия, канонический effectiveAt,
 * положительная целая ставка И точное совпадение с записью registry для этой
 * версии. Повреждённый или незнакомый снимок НЕ «дочинивается» текущими
 * значениями — иначе исторический заказ молча получил бы актуальную ставку.
 */
export function validateFinancialRuleSnapshot(
  value: unknown,
): FinancialRuleValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Снимок финансового правила повреждён." };
  }
  const raw = value as Record<string, unknown>;
  if (!isKnownFinancialRuleVersion(raw.version)) {
    return { ok: false, error: "Неизвестная версия финансового правила." };
  }
  if (!isCanonicalIso(raw.effectiveAt)) {
    return { ok: false, error: "Некорректная дата финансового правила." };
  }
  const rate = raw.bankCardFeeRateBps;
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    !Number.isInteger(rate) ||
    !Number.isSafeInteger(rate) ||
    rate <= 0
  ) {
    return { ok: false, error: "Некорректная ставка финансового правила." };
  }
  // Снимок обязан совпадать с опубликованной записью своей версии.
  const registry = FINANCIAL_RULES[raw.version];
  if (
    registry.effectiveAt !== raw.effectiveAt ||
    registry.bankCardFeeRateBps !== rate
  ) {
    return {
      ok: false,
      error: "Снимок правила не соответствует известной версии.",
    };
  }
  return {
    ok: true,
    rule: {
      version: raw.version,
      effectiveAt: raw.effectiveAt,
      bankCardFeeRateBps: rate,
    },
  };
}

/** Снимок активного правила для НОВОГО заказа (копия, не ссылка на registry). */
export function getActiveFinancialRule(): FinancialRuleSnapshot {
  const rule = FINANCIAL_RULES[ACTIVE_FINANCIAL_RULE_VERSION];
  return {
    version: rule.version,
    effectiveAt: rule.effectiveAt,
    bankCardFeeRateBps: rule.bankCardFeeRateBps,
  };
}
