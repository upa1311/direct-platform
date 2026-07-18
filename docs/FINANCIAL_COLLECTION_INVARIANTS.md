# Financial Collection Invariants — аудит перед CSV/PDF exports

**Вердикт: MIXED_UNREACHABLE.**

Все штатные builders создают ровно одного получателя денег (collector) на заказ.
Одновременное `restaurantCollectedFromCustomerCents > 0` **и**
`platformCollectedFromCustomerCents > 0` недостижимо валидным новым заказом —
только через повреждённое/ручное состояние. Текущие statements и accounting
могут продолжаться без изменений. Runtime-финансы, pricing, small-order fee и UI
в этом коммите не менялись.

## Прослеженный путь

`resolveDeliveryMode` (pricing-engine) → `getCartDeliveryMode` (selectors) →
`createOrderFromCart` (actions) строит неизменяемый `FinancialSnapshot`:
`computeDirectFinancials` / `computeRestaurantDeliveryFinancials` /
`computePickupSettlement` (pricing-engine) → snapshot →
`computeCompletedOrderAccountingEntries` (restaurant-accounting) →
`buildRestaurantSettlementOverview` / statement core.

`deliveryMode` детерминирован и ограничен тремя значениями:

- `fulfillmentChoice === "PICKUP"` → **PICKUP**;
- иначе `deliveryProvider === "RESTAURANT"` → **RESTAURANT_DELIVERY**;
- иначе → **PLATFORM_DRIVER**.

`paymentMethod` **производный** от `deliveryMode` (клиент не выбирает его
независимо), поэтому клиент не может смешать collector.

## Таблица режимов, оплаты и collector

| deliveryMode | paymentMethod | paymentStatus | Физический получатель денег клиента | restaurantCollected | platformCollected | platformCommissionReceivable | restaurantNetAfterPlatformCommission | Accounting entry при завершении |
|---|---|---|---|---|---|---|---|---|
| PICKUP | PAY_AT_RESTAURANT | DUE_AT_PICKUP | Ресторан (на точке) | `customerTotal` | `0` | `commission + smallOrderFee` | `customerTotal − (commission + smallOrderFee)` | RESTAURANT_OWES_DIRECT / PLATFORM_COMMISSION |
| RESTAURANT_DELIVERY | CASH_TO_RESTAURANT_COURIER | DUE_TO_RESTAURANT_COURIER | Ресторан (курьер ресторана) | `customerTotal` | `0` | `commission` | `customerTotal − commission` | RESTAURANT_OWES_DIRECT / PLATFORM_COMMISSION |
| PLATFORM_DRIVER | ONLINE | NOT_STARTED | Direct (онлайн) | `0` | `customerTotal` | `0` | `restaurantPayoutBeforeBankFee` (= `foodSubtotal − commission`) | DIRECT_OWES_RESTAURANT / RESTAURANT_PAYOUT |

Во всех трёх строках одно из двух collected-полей равно `customerTotal`, второе —
`0`. Никогда оба не положительны.

## Ответы на вопросы аудита

**1. Может ли валидный новый заказ получить оба collected > 0?**
Нет. В `createOrderFromCart`:
`platformCollected = (pickup || isRestaurantDelivery) ? 0 : customerTotal`;
`restaurantCollected = pickup ? customerTotal : isRestaurantDelivery ? customerTotal : 0`.
Поля взаимоисключающие по построению для всех трёх режимов.

**2. Какие комбинации deliveryMode + paymentMethod создают каждый collector?**
См. таблицу. Ресторан-collector: PICKUP (PAY_AT_RESTAURANT) и RESTAURANT_DELIVERY
(CASH_TO_RESTAURANT_COURIER). Direct-collector: PLATFORM_DRIVER (ONLINE). Другие
комбинации paymentMethod невозможны — он выводится из deliveryMode.

**3. Выполняется ли `customerTotal === restaurantCollected + platformCollected`?**
Да, точно, для каждого валидного снимка. Для PICKUP это верно, потому что
`pricing.customerTotalCents = foodSubtotal + smallOrderFee` (доставка = 0) и
`computePickupSettlement.customerTotalCents = foodSubtotal + smallOrderFee`
совпадают. Подтверждено тестом.

**4. `restaurantNetAfterPlatformCommissionCents` — полное экономическое право
ресторана или сумма к перечислению платформой?**
Зависит от collector:
- когда собрал **ресторан** (PICKUP / RESTAURANT_DELIVERY) — это чистый остаток,
  который ресторан УЖЕ удержал у себя после долга Direct по комиссии; платформа
  его **не перечисляет**. Обязательство направлено RESTAURANT_OWES_DIRECT (комиссия);
- когда собрал **Direct** (PLATFORM_DRIVER) — это именно сумма, которую платформа
  ДОЛЖНА перечислить ресторану (`= restaurantPayoutBeforeBankFee`). Обязательство
  DIRECT_OWES_RESTAURANT (выплата).

Таким образом поле НЕ является единым «полным экономическим правом» с одинаковым
смыслом во всех режимах — его семантика меняется по collector.

**5. `platformCommissionReceivableCents` — полная комиссия Direct или задолженность
только при сборе рестораном?**
Это сумма, которую **ресторан должен Direct**, и она положительна только когда
деньги собрал ресторан (PICKUP: `commission + smallOrderFee`; RESTAURANT_DELIVERY:
`commission`). Когда собрал Direct (PLATFORM_DRIVER) — `0`, потому что Direct уже
удержал комиссию из собранной суммы, вычитая её из выплаты. Это не «полная
комиссия платформы вообще», а именно receivable-задолженность ресторана.

**6. Не создаёт ли bilateral accounting для теоретического mixed-снимка
одновременно полную комиссию и полную выплату (двойной учёт)?**
`computeCompletedOrderAccountingEntries`:
- A: `restaurantCollected > 0 && commissionReceivable > 0` → RESTAURANT_OWES_DIRECT /
  PLATFORM_COMMISSION;
- B: `platformCollected > 0 && restaurantNet > 0` → DIRECT_OWES_RESTAURANT /
  RESTAURANT_PAYOUT.

Для валидного снимка срабатывает ровно одно условие (второе collected-поле = 0),
поэтому создаётся ровно одна запись — двойного учёта нет. Для **теоретического**
mixed-снимка (оба collected > 0) сработали бы ОБА условия: полная комиссия И
полная выплата на пересекающиеся деньги — это был бы двойной учёт. Но такой снимок
builder не производит.

## Найденные риски

- **Латентный двойной учёт при повреждённом mixed-снимке.** Поля `restaurantNet`
  и `platformCommissionReceivable` рассчитаны для мира с ОДНИМ collector. Если
  повреждённое/ручное состояние внесёт снимок с обоими collected > 0, bilateral
  accounting создаст обе записи (тест это фиксирует). Защита сейчас — гарантия
  взаимной исключительности на уровне builder, а не в accounting.
- **Разная семантика `restaurantNetAfterPlatformCommissionCents`** по collector
  (см. п.4). Экспорты и любые будущие отчёты не должны трактовать это поле как
  единое «к перечислению» — интерпретация зависит от того, кто собрал деньги.

## Рекомендация для следующего трека (НЕ в этом коммите)

Перед CSV/PDF exports желательно добавить дешёвую integrity-проверку на mixed
(`restaurantCollected > 0 && platformCollected > 0`) как отдельный statement issue,
чтобы повреждённый снимок был заметен, а не молча удвоил позицию. Runtime-формулы,
pricing, комиссии и accounting-формулы менять не требуется — builder уже
гарантирует единственного collector.

## Проверенные инварианты (тесты)

`src/prototype/financial-collection-invariants.test.ts`:

1. `restaurantCollected + platformCollected === customerTotal` для PICKUP,
   RESTAURANT_DELIVERY, PLATFORM_DRIVER.
2. Штатный builder не создаёт mixed: ровно одно collected-поле > 0.
3. Accounting entries соответствуют collector: ресторан-collector → ровно одна
   PLATFORM_COMMISSION; Direct-collector → ровно одна RESTAURANT_PAYOUT; двойного
   учёта нет.
4. Исторический снимок не пересчитывается при изменении меню, комиссии, тарифов
   и platformSettings.
5. Явная фиксация: теоретический mixed недостижим штатно, но при повреждении
   accounting дал бы две записи (обоснование, что защита живёт в builder).

## Выполненные команды

```
npm.cmd test         → все зелёные
npm.cmd run lint     → 0
npx.cmd tsc --noEmit → 0
npm.cmd run build    → OK
git diff --check     → 0
```
