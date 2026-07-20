"use client";

import Link from "next/link";
import { Suspense, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import builderStyles from "@/components/menu/dish-builder.module.css";
import mediaStyles from "@/components/menu/menu-media.module.css";
import { DishBuilderPageShell } from "@/components/menu/dish-builder-page";
import { MenuMediaImage } from "@/components/menu/menu-media-image";
import {
  dishBuilderBackHref,
  dishBuilderNewHref,
  dishSubmissionHref,
} from "@/components/menu/dish-builder-form";
import { formatMenuPortion } from "@/prototype/menu-catalog";
import type {
  MenuItemSubmission,
  MenuItemSubmissionStatus,
  RestaurantWorkspaceRole,
} from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatDateTime,
  formatMoney,
  getRestaurantMenuSubmissions,
  menuSubmissionStatusLabels,
} from "@/prototype/selectors";

/** Порядок секций списка заявок. */
const SECTION_ORDER: {
  status: MenuItemSubmissionStatus;
  title: string;
}[] = [
  { status: "DRAFT", title: "Черновики" },
  { status: "PENDING_REVIEW", title: "На проверке Direct" },
  { status: "REJECTED", title: "Нужно исправить" },
  { status: "APPROVED", title: "Опубликованные" },
];

function SubmissionCard({
  submission,
  workspaceRole,
}: {
  submission: MenuItemSubmission;
  workspaceRole: RestaurantWorkspaceRole;
}) {
  const { submitMenuItemDraft } = usePrototype();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const openHref = dishSubmissionHref(submission.id, workspaceRole);
  const portionText = formatMenuPortion(submission.portion);

  const handleSubmit = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await submitMenuItemDraft(submission.id, workspaceRole);
      if (!result.ok) {
        setError(result.error ?? "Не удалось отправить заявку.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <article className={`${flowStyles.card} ${builderStyles.submissionCard}`}>
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
            {menuSubmissionStatusLabels[submission.status]}
          </span>
        </div>
        <div className={builderStyles.submissionMetaRow}>
          <span>
            {submission.priceCents !== null
              ? formatMoney(submission.priceCents, submission.currencyCode)
              : "Цена не указана"}
          </span>
          {submission.category ? <span>{submission.category}</span> : null}
          {portionText ? <span>{portionText}</span> : null}
          <span>Обновлено: {formatDateTime(submission.updatedAt)}</span>
        </div>
        {submission.status === "PENDING_REVIEW" ? (
          <p className={flowStyles.summaryHint}>Direct проверяет блюдо.</p>
        ) : null}
        {submission.status === "APPROVED" ? (
          <p className={flowStyles.summaryHint}>Блюдо опубликовано.</p>
        ) : null}
        {submission.status === "REJECTED" && submission.rejectionReason ? (
          <div className={flowStyles.warningNotice} role="alert">
            <strong>Нужно исправить:</strong> {submission.rejectionReason}
          </div>
        ) : null}
        {error ? (
          <p className={flowStyles.errorText} role="alert">
            {error}
          </p>
        ) : null}
        <div className={flowStyles.buttonRow}>
          {submission.status === "DRAFT" || submission.status === "REJECTED" ? (
            <>
              <Link className={flowStyles.secondaryButton} href={openHref}>
                Редактировать
              </Link>
              <button
                className={flowStyles.primaryButton}
                type="button"
                disabled={pending}
                onClick={() => void handleSubmit()}
              >
                {pending
                  ? "Отправляем…"
                  : submission.status === "REJECTED"
                    ? "Повторно отправить"
                    : "Отправить на проверку"}
              </button>
            </>
          ) : (
            <Link className={flowStyles.secondaryButton} href={openHref}>
              Открыть
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * «Мои заявки»: один канонический список заявок выбранного ресторана для всех
 * ролей (оператор, кухня, общий экран) — данные из общего state.
 */
export default function DishSubmissionsPage() {
  return (
    <Suspense>
      <DishBuilderPageShell screenTitle="Мои заявки">
        {({ restaurant, workspaceRole }) => (
          <SubmissionsList
            restaurantId={restaurant.id}
            workspaceRole={workspaceRole}
          />
        )}
      </DishBuilderPageShell>
    </Suspense>
  );
}

function SubmissionsList({
  restaurantId,
  workspaceRole,
}: {
  restaurantId: string;
  workspaceRole: RestaurantWorkspaceRole;
}) {
  const { state } = usePrototype();
  const submissions = getRestaurantMenuSubmissions(state, restaurantId);

  return (
    <div className={flowStyles.panelStack}>
      <div className={builderStyles.builderTop}>
        <Link
          className={flowStyles.backLink}
          href={dishBuilderBackHref(workspaceRole)}
        >
          ← Назад к меню
        </Link>
        <Link
          className={flowStyles.primaryLink}
          href={dishBuilderNewHref(workspaceRole)}
        >
          Добавить новое блюдо
        </Link>
      </div>
      {submissions.length === 0 ? (
        <div className={flowStyles.emptyState}>
          Заявок пока нет. Добавьте новое блюдо — после проверки Direct оно
          появится у клиентов.
        </div>
      ) : (
        SECTION_ORDER.map(({ status, title }) => {
          const section = submissions.filter(
            (submission) => submission.status === status,
          );
          if (section.length === 0) return null;
          return (
            <section key={status}>
              <h2 className={flowStyles.sectionTitle}>{title}</h2>
              <div className={flowStyles.orderList}>
                {section.map((submission) => (
                  <SubmissionCard
                    submission={submission}
                    workspaceRole={workspaceRole}
                    key={submission.id}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
