"use client";

import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import builderStyles from "@/components/menu/dish-builder.module.css";
import mediaStyles from "@/components/menu/menu-media.module.css";
import { MenuMediaImage } from "@/components/menu/menu-media-image";
import { PageHeading } from "@/components/workspaces/route-content";
import {
  effectiveMenuItemVariantPortion,
  formatMenuPortion,
} from "@/prototype/menu-catalog";
import type { MenuItemSubmission, PrototypeState } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatDateTime,
  formatMoney,
  getPendingMenuSubmissions,
  getRestaurant,
} from "@/prototype/selectors";

/** Быстрые причины отклонения; администратор может написать собственную. */
const QUICK_REJECT_REASONS = [
  "Добавьте более чёткое фото",
  "Уточните описание",
  "Укажите порцию",
  "Проверьте цену",
  "Исправьте варианты блюда",
] as const;

function restaurantName(state: PrototypeState, restaurantId: string): string {
  return getRestaurant(state, restaurantId)?.name ?? restaurantId;
}

function PendingSubmissionCard({
  submission,
}: {
  submission: MenuItemSubmission;
}) {
  const { state, approveMenuItemDraft, rejectMenuItemDraft } = usePrototype();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const basePortionText = formatMenuPortion(submission.portion);
  const priceText =
    submission.priceCents !== null
      ? formatMoney(submission.priceCents, submission.currencyCode)
      : "Цена не указана";
  const pastRejections = submission.reviewHistory.filter(
    (entry) => entry.action === "REJECTED",
  );

  const runReview = async (operation: () => Promise<{
    ok: boolean;
    error: string | null;
  }>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(result.error ?? "Не удалось выполнить действие.");
        return false;
      }
      return true;
    } finally {
      setPending(false);
    }
  };

  const handleApprove = async () => {
    const ok = await runReview(() => approveMenuItemDraft(submission.id));
    if (ok) setFeedback("Блюдо опубликовано.");
  };

  const handleReject = async () => {
    const normalized = reason.trim();
    if (!normalized) {
      setError("Укажите причину отклонения.");
      return;
    }
    await runReview(() => rejectMenuItemDraft(submission.id, normalized));
  };

  if (feedback) {
    return (
      <article className={flowStyles.card}>
        <p className={flowStyles.feedback} role="status">
          {feedback}
        </p>
      </article>
    );
  }

  return (
    <details className={flowStyles.card}>
      <summary className={builderStyles.submissionCard}>
        <MenuMediaImage
          mediaId={submission.imageMediaId}
          alt={
            submission.name.trim()
              ? `Фото: ${submission.name}`
              : "Фото блюда не загружено"
          }
          className={mediaStyles.mediaThumb}
        />
        <div className={builderStyles.submissionCardBody}>
          <div className={flowStyles.orderHeader}>
            <strong>{submission.name.trim() || "Без названия"}</strong>
            <span className={flowStyles.statusBadge}>
              {restaurantName(state, submission.restaurantId)}
            </span>
          </div>
          <div className={builderStyles.submissionMetaRow}>
            <span>{priceText}</span>
            {submission.category ? <span>{submission.category}</span> : null}
            {basePortionText ? <span>{basePortionText}</span> : null}
            <span>
              Отправлено:{" "}
              {formatDateTime(submission.submittedAt ?? submission.updatedAt)}
            </span>
          </div>
        </div>
      </summary>

      <div className={flowStyles.panelStack}>
        <MenuMediaImage
          mediaId={submission.imageMediaId}
          alt={
            submission.name.trim()
              ? `Фото: ${submission.name}`
              : "Фото блюда не загружено"
          }
          className={mediaStyles.mediaBuilderPreview}
        />
        <dl className={flowStyles.definitionList}>
          <div className={flowStyles.definitionRow}>
            <dt>Ресторан</dt>
            <dd>{restaurantName(state, submission.restaurantId)}</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Название</dt>
            <dd>{submission.name.trim() || "Без названия"}</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Описание</dt>
            <dd>{submission.description.trim() || "Без описания"}</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Категория</dt>
            <dd>{submission.category ?? "Не указана"}</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Основная цена</dt>
            <dd>{priceText}</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Базовая порция</dt>
            <dd>{basePortionText ?? "Не указана"}</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Дата отправки</dt>
            <dd>
              {formatDateTime(submission.submittedAt ?? submission.updatedAt)}
            </dd>
          </div>
        </dl>

        {submission.variants.length > 0 ? (
          <div>
            <h3 className={flowStyles.sectionTitle}>Варианты</h3>
            <dl className={flowStyles.definitionList}>
              {submission.variants.map((variant) => {
                const effectivePortion = formatMenuPortion(
                  effectiveMenuItemVariantPortion(
                    submission.portion,
                    variant.portion,
                  ),
                );
                const totalCents =
                  (submission.priceCents ?? 0) + variant.priceDeltaCents;
                return (
                  <div className={flowStyles.definitionRow} key={variant.id}>
                    <dt>
                      {variant.name}
                      {variant.isDefault ? " · основной" : ""}
                    </dt>
                    <dd>
                      Итог: {formatMoney(totalCents, submission.currencyCode)}
                      {effectivePortion ? ` · ${effectivePortion}` : ""}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ) : null}

        {pastRejections.length > 0 ? (
          <div>
            <h3 className={flowStyles.sectionTitle}>Прошлые отклонения</h3>
            <ul className={flowStyles.plainList}>
              {pastRejections.map((entry) => (
                <li key={entry.id}>
                  {formatDateTime(entry.occurredAt)} —{" "}
                  {entry.reason ?? "Без причины"}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? (
          <p className={flowStyles.errorText} role="alert">
            {error}
          </p>
        ) : null}

        {!rejectOpen ? (
          <div className={flowStyles.buttonRow}>
            <button
              className={flowStyles.primaryButton}
              type="button"
              disabled={pending}
              onClick={() => void handleApprove()}
            >
              {pending ? "Публикуем…" : "Одобрить и опубликовать"}
            </button>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              disabled={pending}
              onClick={() => {
                setRejectOpen(true);
                setError(null);
              }}
            >
              Нужно исправить
            </button>
          </div>
        ) : (
          <div className={flowStyles.cancelDialog} role="group" aria-label="Отклонение заявки">
            <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
              <span>Причина</span>
              <textarea
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setError(null);
                }}
                placeholder="Что нужно исправить ресторану"
              />
            </label>
            <div className={builderStyles.submissionMetaRow}>
              {QUICK_REJECT_REASONS.map((quick) => (
                <button
                  className={flowStyles.secondaryButton}
                  type="button"
                  key={quick}
                  onClick={() => {
                    setReason(quick);
                    setError(null);
                  }}
                >
                  {quick}
                </button>
              ))}
            </div>
            <div className={flowStyles.buttonRow}>
              <button
                className={flowStyles.dangerButton}
                type="button"
                disabled={pending || !reason.trim()}
                onClick={() => void handleReject()}
              >
                {pending ? "Отправляем…" : "Отклонить с причиной"}
              </button>
              <button
                className={flowStyles.secondaryButton}
                type="button"
                onClick={() => setRejectOpen(false)}
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * Очередь модерации новых блюд: самые старые ожидающие первыми. Использует
 * существующие approve/reject actions — публикация создаёт ровно один MenuItem,
 * отклонение обязано иметь причину.
 */
export default function AdminMenuReviewPage() {
  const { state, isHydrated } = usePrototype();
  const pending = getPendingMenuSubmissions(state);

  return (
    <>
      <PageHeading
        eyebrow="Direct"
        title="Меню на проверке"
        description={
          pending.length > 0
            ? `Заявок на проверке: ${pending.length}`
            : "Новых заявок нет"
        }
      />
      {!isHydrated ? (
        <div className={flowStyles.emptyState}>Загружаем заявки…</div>
      ) : pending.length === 0 ? (
        <div className={flowStyles.emptyState}>
          Все заявки ресторанов проверены.
        </div>
      ) : (
        <div className={flowStyles.orderList}>
          {pending.map((submission) => (
            <PendingSubmissionCard
              submission={submission}
              key={submission.id}
            />
          ))}
        </div>
      )}
    </>
  );
}
