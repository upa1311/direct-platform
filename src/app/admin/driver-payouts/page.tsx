"use client";

import { useMemo, useState } from "react";

import { PageHeading } from "@/components/workspaces/route-content";
import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney } from "@/prototype/selectors";
import {
  getAdminDriverPayoutsView,
  type AdminDriverPayoutRow,
  type AdminDriverPayoutEligibleEarning,
  type DriverPayoutBatchView,
} from "@/prototype/driver-payouts";
import {
  getLocalDateParts,
  shiftCalendarDate,
  compareLocalDate,
} from "@/prototype/local-calendar";
import { addChecked, isSafeCents } from "@/prototype/bank-fee";
import own from "./driver-payouts.module.css";

const TZ = "Europe/Chisinau";

/** Безопасная сумма выбранных доставок: null при переполнении/невалидной сумме. */
function checkedSum(amounts: number[]): number | null {
  let total = 0;
  for (const a of amounts) {
    if (!isSafeCents(a)) return null;
    const next = addChecked(total, a);
    if (next === null) return null;
    total = next;
  }
  return total;
}

/**
 * Выплаты водителям (v26/v27). Администратор выбирает невыплаченные
 * DIRECT_PAYOUT_DUE заработки и фиксирует ФАКТ отправки (на карту) или передачи
 * (наличными). Сумму считает домен по earning IDs — UI её не передаёт. Получение
 * подтверждает только сам водитель; кнопки «подтвердить за водителя» здесь нет.
 */
export default function AdminDriverPayoutsPage() {
  const { state, isHydrated } = usePrototype();
  const rows = useMemo(
    () => (isHydrated ? getAdminDriverPayoutsView(state) : []),
    [state, isHydrated],
  );

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Выплаты водителям"
        description="Отметьте отправку или передачу выплаты по завершённым безналичным доставкам. Реального перевода денег система не выполняет — водитель подтверждает фактическое получение сам."
      />
      {!isHydrated ? (
        <p className={own.muted}>Загрузка…</p>
      ) : rows.length === 0 ? (
        <p className={own.muted}>Водители не добавлены.</p>
      ) : (
        <div className={own.list}>
          {rows.map((row) => (
            <DriverPayoutSection key={row.driverId} row={row} />
          ))}
        </div>
      )}
    </>
  );
}

function DriverPayoutSection({ row }: { row: AdminDriverPayoutRow }) {
  const { createDriverPayoutBatch } = usePrototype();
  const guard = useMutationGuard();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [method, setMethod] = useState<"BANK_TRANSFER" | "CASH">("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const eligible = row.eligibleEarnings;
  const selectedList = eligible.filter((e) => selected.has(e.id));
  // Превью суммы — checked arithmetic: number | null. Домен всё равно остаётся
  // финальным источником истины (UI не передаёт amountCents в action).
  const previewCents = checkedSum(selectedList.map((e) => e.amountCents));
  const previewOverflow = selected.size > 0 && previewCents === null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectByFilter = (filter: "today" | "last3" | "all") =>
    setSelected(new Set(pickEarnings(eligible, filter).map((e) => e.id)));

  const submit = () => {
    if (
      guard.pending ||
      row.reviewRequired ||
      selected.size === 0 ||
      previewCents === null
    )
      return;
    void guard.run(async () => {
      const r = await createDriverPayoutBatch({
        driverId: row.driverId,
        earningEntryIds: [...selected],
        method,
        externalReference: reference.trim() === "" ? null : reference.trim(),
        note: note.trim() === "" ? null : note.trim(),
      });
      if (r.ok) {
        setSelected(new Set());
        setReference("");
        setNote("");
      }
      return { ok: r.ok, error: r.error, changed: r.ok };
    });
  };

  return (
    <section className={own.driverCard} aria-label={`Выплаты: ${row.driverName}`}>
      <header className={own.driverHead}>
        <h2 className={own.driverName}>{row.driverName}</h2>
        {row.statusNote ? (
          <p className={own.noteBubble} aria-label="Заметка водителя">
            💬 {row.statusNote}
          </p>
        ) : null}
      </header>

      <dl className={own.totals}>
        <Total label="Direct должен" cents={row.dueFromDirectCents} />
        <Total label="Ждёт подтверждения" cents={row.sentAwaitingConfirmationCents} />
        <Total label="Подтверждено водителем" cents={row.confirmedReceivedCents} />
      </dl>

      {row.reviewRequired ? (
        <p className={own.review} role="alert">
          Данные выплат водителя требуют проверки Direct.
        </p>
      ) : eligible.length === 0 ? (
        <p className={own.muted}>Нет доставок, ожидающих выплаты.</p>
      ) : (
        <fieldset className={own.selector}>
          <legend className={own.selectorLegend}>
            Доступно к выплате: {eligible.length}
          </legend>
          <div className={own.filters}>
            <button type="button" className={own.filterButton} onClick={() => selectByFilter("today")}>
              Сегодня
            </button>
            <button type="button" className={own.filterButton} onClick={() => selectByFilter("last3")}>
              Последние 3 дня
            </button>
            <button type="button" className={own.filterButton} onClick={() => selectByFilter("all")}>
              Все невыплаченные
            </button>
            <button type="button" className={own.filterButton} onClick={() => setSelected(new Set())}>
              Снять выбор
            </button>
          </div>
          <ul className={own.earningList}>
            {eligible.map((e) => (
              <li key={e.id}>
                <label className={own.earningRow}>
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    onChange={() => toggle(e.id)}
                  />
                  <span className={own.earningText}>
                    Заказ №{e.orderPublicNumber} · {e.restaurantName}
                    <span className={own.earningMeta}>{formatDate(e.recognizedAt)}</span>
                  </span>
                  <span className={own.earningAmount}>{formatMoney(e.amountCents)}</span>
                </label>
              </li>
            ))}
          </ul>

          <div className={own.methodRow} role="radiogroup" aria-label="Способ выплаты">
            <label className={own.methodOption}>
              <input
                type="radio"
                name={`method-${row.driverId}`}
                checked={method === "BANK_TRANSFER"}
                onChange={() => setMethod("BANK_TRANSFER")}
              />
              На карту / банковский счёт
            </label>
            <label className={own.methodOption}>
              <input
                type="radio"
                name={`method-${row.driverId}`}
                checked={method === "CASH"}
                onChange={() => setMethod("CASH")}
              />
              Наличными
            </label>
          </div>

          <label className={own.field}>
            <span>Номер операции / чека (необязательно)</span>
            <input
              type="text"
              value={reference}
              maxLength={120}
              onChange={(ev) => setReference(ev.target.value)}
            />
          </label>
          <label className={own.field}>
            <span>Комментарий (необязательно)</span>
            <input
              type="text"
              value={note}
              maxLength={300}
              onChange={(ev) => setNote(ev.target.value)}
            />
          </label>

          {previewOverflow ? (
            <p className={own.error} role="alert">
              Сумма выбранных доставок требует проверки Direct.
            </p>
          ) : null}
          {guard.error ? (
            <p className={own.error} role="alert">
              {guard.error}
            </p>
          ) : null}

          <button
            type="button"
            className={own.submit}
            disabled={guard.pending || selected.size === 0 || previewCents === null}
            onClick={submit}
          >
            {method === "BANK_TRANSFER" ? "Выплата отправлена" : "Наличные переданы водителю"}
            {selected.size > 0 && previewCents !== null
              ? ` — ${formatMoney(previewCents)}`
              : ""}
          </button>
        </fieldset>
      )}

      {row.batches.length > 0 ? (
        <div className={own.batchHistory}>
          <h3 className={own.historyTitle}>История выплат</h3>
          <ul className={own.batchList}>
            {row.batches.map((batch) => (
              <li key={batch.id}>
                <BatchRow batch={batch} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Total({ label, cents }: { label: string; cents: number | null }) {
  return (
    <div className={own.totalItem}>
      <dt className={own.totalLabel}>{label}</dt>
      <dd className={own.totalValue}>
        {cents === null ? (
          <span aria-label="Итог недоступен и требует проверки Direct">—</span>
        ) : (
          formatMoney(cents)
        )}
      </dd>
    </div>
  );
}

function BatchRow({ batch }: { batch: DriverPayoutBatchView }) {
  const isBank = batch.method === "BANK_TRANSFER";
  const confirmed = batch.status === "CONFIRMED_RECEIVED";
  const methodText = isBank ? "на карту" : "наличными";
  return (
    <article className={own.batchCard}>
      <div className={own.batchHead}>
        <span className={own.batchAmount}>{formatMoney(batch.amountCents)}</span>
        <span className={own.batchDate}>{formatDate(batch.sentAt)}</span>
      </div>
      <span className={own.batchMeta}>
        {isBank ? "На карту" : "Наличными"} · доставок {batch.earningCount} · заработок{" "}
        {formatDate(batch.firstEarningAt)} — {formatDate(batch.lastEarningAt)}
      </span>
      <span className={confirmed ? own.batchConfirmed : own.batchAwaiting}>
        {confirmed
          ? isBank
            ? `Водитель подтвердил получение ${methodText}${
                batch.confirmedAt ? ` — ${formatDate(batch.confirmedAt)}` : ""
              }`
            : `Рассчитались наличными${
                batch.confirmedAt ? ` — ${formatDate(batch.confirmedAt)}` : ""
              }`
          : "Ожидает подтверждения водителя"}
      </span>
    </article>
  );
}

/** Выбор невыплаченных заработков по локальному календарю (Europe/Chisinau). */
function pickEarnings(
  eligible: readonly AdminDriverPayoutEligibleEarning[],
  filter: "today" | "last3" | "all",
): AdminDriverPayoutEligibleEarning[] {
  if (filter === "all") return [...eligible];
  const nowMs = Date.now();
  const now = getLocalDateParts(nowMs, TZ);
  const threshold = filter === "today" ? now : shiftCalendarDate(now, -2);
  return eligible.filter((e) => {
    const ms = Date.parse(e.recognizedAt);
    if (Number.isNaN(ms)) return false;
    const p = getLocalDateParts(ms, TZ);
    if (filter === "today") {
      return p.year === now.year && p.month === now.month && p.day === now.day;
    }
    return compareLocalDate(p, threshold) >= 0 && compareLocalDate(p, now) <= 0;
  });
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
