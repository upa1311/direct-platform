"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import kds from "@/components/kitchen/kitchen.module.css";
import { MenuMediaImage } from "@/components/menu/menu-media-image";
import mediaStyles from "@/components/menu/menu-media.module.css";
import builderStyles from "@/components/menu/dish-builder.module.css";
import {
  buildDishBuilderPatch,
  createVariantFormRow,
  DISH_DESCRIPTION_MAX_LENGTH,
  dishSubmissionHref,
  dishSubmissionsHref,
  emptyDishBuilderFormState,
  submissionToFormState,
  type DishBuilderFieldErrors,
  type DishBuilderFormState,
  type DishVariantFormRow,
} from "@/components/menu/dish-builder-form";
import {
  deleteMenuMediaBlob,
  processAndSaveMenuImage,
} from "@/prototype/media-store";
import { PORTION_UNIT_LABELS } from "@/prototype/menu-catalog";
import type {
  MenuPortionUnit,
  Restaurant,
  RestaurantWorkspaceRole,
} from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  getRestaurantMenuCategories,
  menuSubmissionStatusLabels,
} from "@/prototype/selectors";

/**
 * Единый конструктор нового блюда для ВСЕХ ресторанных ролей: OPERATOR и
 * KITCHEN в SPLIT и общий экран COMBINED открывают один и тот же компонент —
 * отдельных форм по ролям нет. Реальная workspaceRole приходит снаружи и
 * передаётся в каждое доменное действие; домен повторно проверяет право
 * MANAGE_MENU_CATALOG — URL и props не являются доказательством права.
 *
 * Черновик создаётся РОВНО один раз: id создания запоминается и все дальнейшие
 * сохранения обновляют ту же заявку. Фото хранится в отдельном media store
 * (IndexedDB), в заявку попадает только imageMediaId.
 */

const PORTION_UNITS: MenuPortionUnit[] = ["G", "ML", "PCS", "CM"];

interface DishBuilderProps {
  restaurant: Restaurant;
  workspaceRole: RestaurantWorkspaceRole;
  submissionId: string | null;
  returnHref: string;
}

export function RestaurantDishBuilder({
  restaurant,
  workspaceRole,
  submissionId,
  returnHref,
}: DishBuilderProps) {
  const router = useRouter();
  const {
    state,
    createMenuItemDraft,
    updateMenuItemDraft,
    submitMenuItemDraft,
  } = usePrototype();

  const submission = submissionId
    ? state.menuItemSubmissions.find(
        (candidate) =>
          candidate.id === submissionId &&
          candidate.restaurantId === restaurant.id,
      ) ?? null
    : null;

  const [form, setForm] = useState<DishBuilderFormState>(() =>
    submission ? submissionToFormState(submission) : emptyDishBuilderFormState(),
  );
  const [fieldErrors, setFieldErrors] = useState<DishBuilderFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  // Id уже созданного черновика: гарантирует «создаётся ровно один раз», даже
  // если навигация на маршрут заявки ещё не произошла.
  const draftIdRef = useRef<string | null>(submissionId);
  const busyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const formHeadingId = useId();

  if (submissionId && !submission) {
    return (
      <section className={flowStyles.card}>
        <p className={flowStyles.errorText} role="alert">
          Заявка не найдена или принадлежит другому ресторану.
        </p>
        <Link className={flowStyles.backLink} href={returnHref}>
          ← Назад к меню
        </Link>
      </section>
    );
  }

  const status = submission?.status ?? null;
  const readOnly = status === "PENDING_REVIEW" || status === "APPROVED";

  const heading =
    status === "PENDING_REVIEW"
      ? "Блюдо на проверке Direct"
      : status === "APPROVED"
        ? "Блюдо опубликовано"
        : submission
          ? "Редактирование блюда"
          : "Новое блюдо";

  const categories = getRestaurantMenuCategories(state, restaurant.id);
  const categoryListId = `${formHeadingId}-categories`;

  const updateForm = (patch: Partial<DishBuilderFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setFeedback(null);
  };

  const updateVariant = (id: string, patch: Partial<DishVariantFormRow>) => {
    setForm((current) => ({
      ...current,
      variants: current.variants.map((row) =>
        row.id === id ? { ...row, ...patch } : row,
      ),
    }));
    setFeedback(null);
  };

  const setDefaultVariant = (id: string) => {
    setForm((current) => ({
      ...current,
      variants: current.variants.map((row) => ({
        ...row,
        isDefault: row.id === id,
      })),
    }));
  };

  const addVariant = () => {
    setForm((current) => ({
      ...current,
      variants: [
        ...current.variants,
        createVariantFormRow(current.variants.length === 0),
      ],
    }));
  };

  const removeVariant = (id: string) => {
    setForm((current) => {
      const rest = current.variants.filter((row) => row.id !== id);
      // Инвариант «ровно один основной» держим в форме: если удалили основной,
      // основным становится первый оставшийся.
      if (rest.length > 0 && !rest.some((row) => row.isDefault)) {
        rest[0] = { ...rest[0], isDefault: true };
      }
      return { ...current, variants: rest };
    });
  };

  const handlePhotoFile = async (file: File | null) => {
    if (!file || photoBusy) return;
    setPhotoBusy(true);
    setPhotoError(null);
    const previousId = form.imageMediaId;
    try {
      const mediaId = await processAndSaveMenuImage(file);
      updateForm({ imageMediaId: mediaId });
      if (previousId) {
        void deleteMenuMediaBlob(previousId);
      }
    } catch (error) {
      setPhotoError(
        error instanceof Error
          ? error.message
          : "Не удалось обработать фотографию.",
      );
    } finally {
      setPhotoBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removePhoto = () => {
    const previousId = form.imageMediaId;
    updateForm({ imageMediaId: null });
    setPhotoError(null);
    if (previousId) {
      void deleteMenuMediaBlob(previousId);
    }
  };

  /**
   * Сохранение: для нового блюда сначала создаётся ОДИН черновик, затем поля
   * пишутся через update той же заявки. Возвращает id заявки либо null.
   */
  const persistDraft = async (forSubmit: boolean): Promise<string | null> => {
    const built = buildDishBuilderPatch(form, forSubmit);
    if (!built.ok) {
      setFieldErrors(built.errors);
      setFormError("Проверьте выделенные поля.");
      return null;
    }
    setFieldErrors({});
    setFormError(null);

    let id = draftIdRef.current;
    if (!id) {
      const created = await createMenuItemDraft(restaurant.id, workspaceRole);
      if (!created.ok || !created.submissionId) {
        setFormError(created.error ?? "Не удалось создать черновик.");
        return null;
      }
      id = created.submissionId;
      draftIdRef.current = id;
    }

    const updated = await updateMenuItemDraft(id, built.patch, workspaceRole);
    if (!updated.ok) {
      setFormError(updated.error ?? "Не удалось сохранить черновик.");
      return null;
    }
    return id;
  };

  const runGuarded = async (operation: () => Promise<void>) => {
    // Синхронный guard: двойной клик в одном tick не запускает вторую операцию.
    if (busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    try {
      await operation();
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const handleSaveDraft = () =>
    runGuarded(async () => {
      const id = await persistDraft(false);
      if (!id) return;
      setFeedback("Черновик сохранён");
      if (!submissionId) {
        router.replace(dishSubmissionHref(id, workspaceRole));
      }
    });

  const handleSubmit = () =>
    runGuarded(async () => {
      const id = await persistDraft(true);
      if (!id) return;
      const submitted = await submitMenuItemDraft(id, workspaceRole);
      if (!submitted.ok) {
        // Данные формы не теряются: остаёмся в форме с точной ошибкой.
        setFormError(submitted.error ?? "Не удалось отправить заявку.");
        return;
      }
      setFeedback("Отправлено на проверку Direct.");
      router.replace(dishSubmissionHref(id, workspaceRole));
    });

  return (
    <section
      className={`${flowStyles.card} ${builderStyles.builderCard}`}
      aria-labelledby={formHeadingId}
    >
      <div className={builderStyles.builderTop}>
        <Link className={flowStyles.backLink} href={returnHref}>
          ← Назад к меню
        </Link>
        <Link
          className={flowStyles.backLink}
          href={dishSubmissionsHref(workspaceRole)}
        >
          Мои заявки
        </Link>
      </div>
      <h1 className={flowStyles.sectionTitle} id={formHeadingId}>
        {heading}
      </h1>
      {!submission ? (
        <p className={flowStyles.summaryHint}>
          Заполните информацию. Блюдо появится у клиентов после проверки Direct.
        </p>
      ) : null}
      {status ? (
        <p className={flowStyles.statusBadge}>
          {menuSubmissionStatusLabels[status]}
        </p>
      ) : null}
      {status === "PENDING_REVIEW" ? (
        <p className={flowStyles.summaryHint}>
          Direct проверяет блюдо. Редактирование недоступно до решения.
        </p>
      ) : null}
      {status === "REJECTED" && submission?.rejectionReason ? (
        <div className={flowStyles.warningNotice} role="alert">
          <strong>Нужно исправить:</strong> {submission.rejectionReason}
        </div>
      ) : null}

      {/* 1. Фотография */}
      <fieldset className={builderStyles.builderSection} disabled={readOnly}>
        <legend className={builderStyles.sectionLegend}>Фотография</legend>
        <div className={builderStyles.photoZone}>
          <MenuMediaImage
            mediaId={form.imageMediaId}
            alt={form.name.trim() ? `Фото: ${form.name}` : "Фото блюда"}
            className={mediaStyles.mediaBuilderPreview}
          />
          <input
            ref={fileInputRef}
            className={builderStyles.hiddenFileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="Файл фотографии блюда"
            onChange={(event) =>
              void handlePhotoFile(event.target.files?.[0] ?? null)
            }
          />
          {!readOnly ? (
            <div className={flowStyles.buttonRow}>
              <button
                className={flowStyles.secondaryButton}
                type="button"
                disabled={photoBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {photoBusy
                  ? "Обрабатываем…"
                  : form.imageMediaId
                    ? "Заменить"
                    : "Выбрать фото"}
              </button>
              {form.imageMediaId ? (
                <button
                  className={flowStyles.secondaryButton}
                  type="button"
                  disabled={photoBusy}
                  onClick={removePhoto}
                >
                  Удалить
                </button>
              ) : null}
            </div>
          ) : null}
          <p className={flowStyles.summaryHint}>
            JPG, PNG или WEBP, до 10 МБ. Фото уменьшается автоматически.
          </p>
          {photoError ? (
            <p className={flowStyles.errorText} role="alert">
              {photoError}
            </p>
          ) : null}
        </div>
      </fieldset>

      {/* 2–5. Название, описание, категория, цена */}
      <fieldset className={builderStyles.builderSection} disabled={readOnly}>
        <legend className={builderStyles.sectionLegend}>О блюде</legend>
        <div className={flowStyles.fieldGrid}>
          <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
            <span>Название блюда</span>
            <input
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
              placeholder="Например: Пицца Пепперони"
            />
            {fieldErrors.name ? (
              <span className={flowStyles.fieldError} role="alert">
                {fieldErrors.name}
              </span>
            ) : null}
          </label>
          <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
            <span>Описание</span>
            <textarea
              value={form.description}
              maxLength={DISH_DESCRIPTION_MAX_LENGTH}
              onChange={(event) =>
                updateForm({ description: event.target.value })
              }
              placeholder="Тонкое тесто, томатный соус, моцарелла, пепперони и орегано."
            />
            <span className={builderStyles.charCounter}>
              Кратко опишите состав и особенности блюда.{" "}
              {form.description.length}/{DISH_DESCRIPTION_MAX_LENGTH}
            </span>
          </label>
          <label className={flowStyles.field}>
            <span>Категория</span>
            <input
              value={form.category}
              list={categoryListId}
              onChange={(event) => updateForm({ category: event.target.value })}
              placeholder="Например: Пицца"
            />
            <datalist id={categoryListId}>
              {categories.map((category) => (
                <option value={category} key={category} />
              ))}
            </datalist>
          </label>
          <label className={flowStyles.field}>
            <span>Цена ({state.platformSettings.currencyCode})</span>
            <input
              value={form.priceInput}
              inputMode="decimal"
              onChange={(event) =>
                updateForm({ priceInput: event.target.value })
              }
              placeholder="12.50"
            />
            {fieldErrors.price ? (
              <span className={flowStyles.fieldError} role="alert">
                {fieldErrors.price}
              </span>
            ) : null}
          </label>
        </div>
      </fieldset>

      {/* 6. Порция */}
      <fieldset className={builderStyles.builderSection} disabled={readOnly}>
        <legend className={builderStyles.sectionLegend}>Порция</legend>
        <div className={flowStyles.fieldGrid}>
          <label className={flowStyles.field}>
            <span>Количество</span>
            <input
              value={form.portionValueInput}
              inputMode="decimal"
              onChange={(event) =>
                updateForm({ portionValueInput: event.target.value })
              }
              placeholder="350"
            />
          </label>
          <label className={flowStyles.field}>
            <span>Единица</span>
            <select
              value={form.portionUnit}
              onChange={(event) =>
                updateForm({
                  portionUnit: event.target.value as MenuPortionUnit | "",
                })
              }
            >
              <option value="">Не указана</option>
              {PORTION_UNITS.map((unit) => (
                <option value={unit} key={unit}>
                  {PORTION_UNIT_LABELS[unit]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {fieldErrors.portion ? (
          <p className={flowStyles.errorText} role="alert">
            {fieldErrors.portion}
          </p>
        ) : null}
      </fieldset>

      {/* 7. Варианты и размеры */}
      <fieldset className={builderStyles.builderSection} disabled={readOnly}>
        <legend className={builderStyles.sectionLegend}>
          Варианты и размеры
        </legend>
        {form.variants.length === 0 ? (
          <p className={flowStyles.summaryHint}>
            Без вариантов блюдо продаётся по основной цене без выбора размера.
          </p>
        ) : null}
        {form.variants.map((variant, index) => {
          const variantError = fieldErrors.variants?.[variant.id];
          return (
            <div className={builderStyles.variantRow} key={variant.id}>
              <div className={flowStyles.fieldGrid}>
                <label className={flowStyles.field}>
                  <span>Название варианта</span>
                  <input
                    value={variant.name}
                    onChange={(event) =>
                      updateVariant(variant.id, { name: event.target.value })
                    }
                    placeholder={index === 0 ? "Стандартная" : "Большая"}
                  />
                </label>
                <label className={flowStyles.field}>
                  <span>Доплата ({state.platformSettings.currencyCode})</span>
                  <input
                    value={variant.deltaInput}
                    inputMode="decimal"
                    onChange={(event) =>
                      updateVariant(variant.id, {
                        deltaInput: event.target.value,
                      })
                    }
                    placeholder="0"
                  />
                </label>
                <label className={flowStyles.field}>
                  <span>Порция варианта</span>
                  <input
                    value={variant.portionValueInput}
                    inputMode="decimal"
                    onChange={(event) =>
                      updateVariant(variant.id, {
                        portionValueInput: event.target.value,
                      })
                    }
                    placeholder="350"
                  />
                </label>
                <label className={flowStyles.field}>
                  <span>Единица порции</span>
                  <select
                    value={variant.portionUnit}
                    onChange={(event) =>
                      updateVariant(variant.id, {
                        portionUnit: event.target.value as
                          | MenuPortionUnit
                          | "",
                      })
                    }
                  >
                    <option value="">Не указана</option>
                    {PORTION_UNITS.map((unit) => (
                      <option value={unit} key={unit}>
                        {PORTION_UNIT_LABELS[unit]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={builderStyles.variantControls}>
                <label className={flowStyles.sizeOption}>
                  <input
                    type="radio"
                    name={`${formHeadingId}-default-variant`}
                    checked={variant.isDefault}
                    onChange={() => setDefaultVariant(variant.id)}
                  />
                  <span>Основной вариант</span>
                </label>
                <button
                  className={flowStyles.secondaryButton}
                  type="button"
                  onClick={() => removeVariant(variant.id)}
                >
                  Удалить вариант
                </button>
              </div>
              {variantError ? (
                <p className={flowStyles.errorText} role="alert">
                  {variantError}
                </p>
              ) : null}
            </div>
          );
        })}
        {!readOnly ? (
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={addVariant}
          >
            Добавить вариант
          </button>
        ) : null}
      </fieldset>

      {formError ? (
        <p className={flowStyles.errorText} role="alert">
          {formError}
        </p>
      ) : null}
      {feedback ? (
        <p className={flowStyles.feedback} role="status">
          {feedback}
        </p>
      ) : null}

      {!readOnly ? (
        <div className={flowStyles.submitArea}>
          <div className={flowStyles.buttonRow}>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              disabled={saving}
              onClick={handleSaveDraft}
            >
              {saving ? "Сохраняем…" : "Сохранить черновик"}
            </button>
            <button
              className={flowStyles.primaryButton}
              type="button"
              disabled={saving}
              onClick={handleSubmit}
            >
              {saving ? "Отправляем…" : "Отправить на проверку Direct"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Обёртка экрана конструктора в стиле ресторанного кабинета. */
export function DishBuilderScreen({ children }: { children: React.ReactNode }) {
  return <div className={`${kds.screen} ${builderStyles.builderScreen}`}>{children}</div>;
}

/**
 * Fail-closed заглушка при неизвестной или повреждённой роли: ничего не
 * сохраняем, объясняем и предлагаем вернуться в рабочий кабинет.
 */
export function DishBuilderRoleError() {
  return (
    <section className={flowStyles.card}>
      <p className={flowStyles.errorText} role="alert">
        Не удалось определить рабочий экран. Откройте конструктор из кабинета
        оператора или кухни.
      </p>
      <div className={flowStyles.buttonRow}>
        <Link className={flowStyles.backLink} href="/restaurant/operator">
          Кабинет оператора
        </Link>
        <Link className={flowStyles.backLink} href="/restaurant/kitchen">
          Экран кухни
        </Link>
      </div>
    </section>
  );
}
