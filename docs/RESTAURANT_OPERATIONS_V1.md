# Restaurant Operations V1

**Статус: DONE** — финальный regression/smoke-аудит пройден, blocking-дефектов нет.

Завершающий контроль перед переходом к ресторанным расчётам и бухгалтерии.
Этот документ фиксирует итог; новых функций в нём нет.

## Рабочие режимы и роли

Ресторан работает в одном из двух режимов (`orderWorkflowMode`):

- **COMBINED** — один общий экран «Заказы», роль `COMBINED` выполняет всё.
- **SPLIT_OPERATOR_KITCHEN** — раздельные экраны, роли `OPERATOR` и `KITCHEN`.

Права — единая fail-closed матрица (`restaurant-workflow.ts`): `KITCHEN_ACTIONS`,
`OPERATOR_ACTIONS`, COMBINED = объединение. SPLIT без явной роли → доступа нет.

## Готовые рабочие flows

**COMBINED (общий экран).** Новый заказ → приём с initial preparation minutes →
PREPARING (позиции, варианты, cooking comments, ETA, countdown, изменение
времени, production ticket) → «Не можем приготовить» / решение проблемы /
запрос отмены у Direct → READY/READY_FOR_PICKUP (обе печати, код клиента,
оплата, выдача, невыкуп по времени). DELIVERY: онлайн-оплата → PREPARING →
READY → переходы доставки по delivery mode, назначение водителя Direct.

**SPLIT OPERATOR.** Первым получает новый заказ; принимает/отклоняет; видит
клиента, телефон, адрес, оплату и полный состав; видит read-only ETA кухни;
решает preparation problem; отправляет restaurant cancellation request;
package label только для READY/READY_FOR_PICKUP; выполняет pickup handoff и
доступные delivery actions.

**SPLIT KITCHEN.** Не принимает/не отклоняет заказ; не видит клиента, телефон,
адрес, pickup code, финансовую разбивку; получает заказ после принятия/оплаты;
видит позиции, варианты, cooking comments; меняет ETA; сообщает preparation
problem, но не решает её и не запрашивает отмену; OPEN-проблема блокирует
«Готово»; печатает только production ticket (package label отсутствует полностью).

## Две печати и их privacy-контракты

| | Production ticket (кухня) | Package label (оператор / COMBINED) |
|---|---|---|
| Назначение | техдокумент кухни | физическая наклейка на пакет |
| Видимость | кухня, COMBINED; статусы с готовностью и раньше | только `OPERATOR`/`COMBINED`, только READY/READY_FOR_PICKUP |
| Содержит | позиции, варианты, **cooking comments**, время готовности | позиции, варианты, безопасный payment marker |
| Не содержит | PII, адрес, оплату/суммы, pickup code, водителя | PII, адрес, pickup code, суммы, payment enum, **cooking comments**, водителя, internal id |

Payment marker наклейки — только «ОПЛАЧЕНО» либо «ОПЛАТА ПРИ ПОЛУЧЕНИИ» (без
сумм, валюты и enum). Отдельные print root/marker
(`kitchen-production-print-root` / `data-kitchen-production-print` и
`operator-package-label-print-root` / `data-operator-package-label-print`) не
конфликтуют; обычный Ctrl+P не печатает пустой лист. Печать — не бизнес-мутация.

## Preparation problem / cancellation lifecycle

- Кухня сообщает проблему → событие `PREPARATION_PROBLEM` со статусом
  `OPEN`/`RESOLVED` (id проблемы = id OPEN-события; legacy = OPEN).
- OPEN блокирует mark-ready. Оператор/COMBINED подтверждает решение
  (`RESOLVE_PREPARATION_PROBLEM`) → RESOLVED → ready снова доступен.
- Restaurant cancellation request идёт через существующий `CancellationRequest`
  pipeline (никакой второй модели): `requestedBy: RESTAURANT`, один запрос на
  заказ. PENDING ресторанный запрос блокирует resolve. Admin REJECTED → заказ
  остаётся PREPARING, проблема OPEN, resolve снова возможен; APPROVED → CANCELED.
- Внутренние причины ресторана и комментарии Direct не попадают в клиентскую
  историю/статусы; admin видит инициатора, причину клиента/ресторана, рабочий
  экран, исходную проблему кухни, resolutionNote, оплату и статус заказа.

## Основные инварианты (покрыты тестами)

Двойное принятие; двойной mark-ready; resolve/ready race; cancellation request
duplicate; resolve при PENDING restaurant request; approve/reject; pickup
handoff / no-show; печать read-only (state/revision/order/history/status/
payment/financials/settlements/pickupCode не меняются); неуспешный domain action
возвращает исходный `state` тем же объектом; отсутствие дублей history/status.
Финансы, settlements и financial snapshots при отмене/отклонении не меняются;
refund автоматически не выполняется.

## Выполненные команды

```
npm.cmd test        → 680 pass / 0 fail (44 файла)
npm.cmd run lint    → 0
npx.cmd tsc --noEmit→ 0
npm.cmd run build   → OK
git diff --check    → 0
```

## Browser widths

Проверяются operator и kitchen на 390 / 360 / 320 px: без горизонтального
scroll, длинные номера/названия/адреса переносятся, обе кнопки печати в COMBINED
не ломают строку, console без новых ошибок.

## Известные не-blocking ограничения

- Пакетная наклейка не содержит адрес даже для доставки — адрес и телефон
  оператор/курьер берут из интерфейса (сознательное privacy-решение).
- QR/штрихкод, счётчик печати и автопечать не реализованы (вне scope V1).
- Полный кликабельный browser-E2E print-preview в текущей среде нестабилен;
  приватность и видимость гарантированы структурно (модели без PII) и покрыты
  unit-тестами с privacy-sentinel и visibility-helper.

## Следующий трек

**RESTAURANT SETTLEMENTS / ACCOUNTING** — расчёты, бухгалтерия, statements,
ledger, export. В V1 сознательно не начаты.
