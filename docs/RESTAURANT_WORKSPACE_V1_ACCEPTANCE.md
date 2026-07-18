# Restaurant Workspace V1 — Acceptance

**Статус: RESTAURANT WORKSPACE V1 — DONE.**

- Проверенный HEAD: `59671219c6d1a3f63292b42d97d1fb29444841ee`.
- Дата приёмки: 2026-07-18.
- Тип батча: acceptance/finalization (без новых продуктовых функций).

Это официальная фиксация приёмки ресторанного кабинета V1. Документ не дублирует
спецификации — детали в [RESTAURANT_OPERATIONS_V1.md](RESTAURANT_OPERATIONS_V1.md),
[RESTAURANT_ACCOUNTING_V1.md](RESTAURANT_ACCOUNTING_V1.md) и
[FINANCIAL_COLLECTION_INVARIANTS.md](FINANCIAL_COLLECTION_INVARIANTS.md).

## Автоматические проверки на принятом HEAD

- `npm.cmd test` → 883 passed / 0 failed.
- `npm.cmd run lint` → 0.
- `npx.cmd tsc --noEmit` → 0.
- `npm.cmd run build` → OK.
- `git diff --check` → чисто.
- CI «Quality» (GitHub Actions) — success на серии предшествующих коммитов V1.

## Завершённые области

### Режимы кабинета

| Режим | Навигация | Проверено |
|---|---|---|
| COMBINED | Заказы · Меню и доступность · Расчёты | ✔ |
| SPLIT_OPERATOR_KITCHEN | Оператор заказов · Кухня · Меню и доступность · Расчёты | ✔ |

Переключение режима — через настройки режима работы; роль не влияет на финансовые
данные, оба режима используют одну страницу расчётов.

### Restaurant Operations V1 — DONE

Общий экран заказов, оператор заказов, кухня (KDS), меню и доступность, настройки
режима; приём/отклонение заказа, ETA-корректировки, приготовление, готовность,
отмены и проблемы приготовления, самовывоз и код выдачи, доставка ресторана
(собственный курьер), исторические заказы, privacy-разделение operator/kitchen.
Покрытие тестами: `restaurant-workflow`, `kitchen`, `kitchen-kds`,
`operator-timing`, `split-operator-acceptance`, `eta-adjust`,
`preparation-problem-*`, `pickup-*`, `restaurant-courier`, `cancellation*`,
`operational-pause`, `restaurant-availability`, `workflow-enforcement`,
`lifecycle-results`.

### Restaurant Accounting V1 — DONE

Двусторонний журнал обязательств (recognition/resolution), открытая позиция,
bilateral entries из неизменяемого `order.financials`. Покрытие:
`restaurant-accounting`, `restaurant-settlements`, `financial-collection-invariants`.

### Restaurant Statements V1 — DONE

Четыре внутренних представления: «По заказам», «По дням», «Обязательства»,
«Выписка». Проверено:

1. Финансовые значения — только из immutable `order.financials`; старые заказы не
   пересчитываются.
2. Валюты не смешиваются (отдельный bucket на валюту).
3. Opening / movements / closing сходятся (reconciliation-инвариант).
4. Restaurant switch не показывает stale statement (envelope-gate + key-remount).
5. Timezone switch не показывает stale statement.
6. Перевёрнутый период → типизированная ошибка без перестановки дат.
7. Default range = 30 включительных локальных календарных дней ресторана (DST-корректно).
8. Mixed snapshot → одно безопасное предупреждение, полностью исключён из rows и
   totals (recognition/resolution/opening/closing).
9. Mixed другого ресторана не влияет на текущую выписку (guard привязан к
   `order.restaurant.id === restaurantId`).
10. Recognition и resolutions не раскрывают внутренние ID или PII.

Покрытие: `restaurant-statements`, `restaurant-statement-view`,
`restaurant-statement-mixed-collection`, `statement-range`, `statement-snapshot`.

### CSV — DONE

Доступен только после успешной сформированной выписки; исчезает при смене
ресторана/timeZone; UTF-8 BOM; читаемый русский текст; CRLF; RFC 4180 escaping;
несколько валют раздельно; длинный многострочный comment; formula-injection защита
(`= + - @ TAB CR`); нет `restaurantId`/`orderId`/`entryKey`/`accountingEntryId` и
клиентских PII; тот же зафиксированный `asOf`, что экран и печать. Покрытие:
`restaurant-statement-csv`, `statement-csv-export`.

### Print / PDF — DONE

Кнопка «Печать / PDF» → один клик = один `window.print()`; без нового маршрута/
popup/мутаций/перегенерации. A4 landscape; документ начинается от верхнего поля
`@page`; внешний RestaurantHeader/навигация исключены из раскладки (не занимают
место); экранные формы, toolbar, кнопки и all-time блоки не печатаются; повтор
заголовков таблиц, неразрыв строк, перенос длинных comment/external reference,
суммы/колонки не обрезаются, integrity warnings присутствуют; несколько валют и
многостраничная пагинация (обычный поток, без absolute/fixed для всего документа).
После отмены диалога печати интерфейс полностью видим. Покрытие: `statement-print`
+ browser acceptance (эмуляция печатных селекторов).

## Privacy-инварианты

Во всём ресторанном кабинете не раскрываются: внутренний `orderId`,
`accountingEntryId`, `entryKey`, settlement/event IDs, pickup code вне нужной роли,
customer phone/address в kitchen-only режиме, admin actor, технические raw enums.
Presentation-model отдаёт только переведённые подписи и публичные номера заказов;
CSV и печать потребляют ту же модель. Проверено DOM-скан всех четырёх
представлений расчётов — сырых ID и enum нет.

## Финансовые инварианты

- Единственный источник сумм — неизменяемый `order.financials`; формулы pricing/
  комиссий/accounting не пересчитывают исторические заказы.
- Collector взаимоисключающий: `restaurantCollected` XOR `platformCollected` =
  `customerTotal` (MIXED недостижим штатным builder'ом; повреждённый MIXED
  фиксируется предупреждением и исключается).
- Валюты никогда не суммируются между собой.
- Opening + движения − закрытия = closing по каждой стороне и валюте.

## Responsive

Desktop (1280), 390, 360, 320 px — без горизонтального скролла всей страницы;
допускается локальный горизонтальный скролл только внутри широких таблиц
(`tableScroll`). Кнопки действий выписки переносятся на узких экранах.

## Явно отложенные будущие треки (вне Restaurant Workspace V1)

- Universal small-order fee — отдельное будущее решение.
- Реальные выплаты, payout batches, банковская интеграция.
- Partial settlement и automatic netting.
- Driver domain и payment integration (не входят в V1).
- Авторизация «пользователь ↔ его ресторан» (прототип не является моделью
  безопасности).

## Известное ограничение

Ресторанный кабинет V1 — это **операционная сверка (operational reconciliation)**,
а не банковская или нормативная (statutory) бухгалтерская система. Он не выполняет
фактических денежных переводов, списаний или автоматического взаимозачёта; выписка,
CSV и печать предназначены для сверки между Direct и рестораном.

---

PASS — RESTAURANT WORKSPACE V1 DONE.
