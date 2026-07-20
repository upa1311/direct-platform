"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";

import { DishBuilderPageShell } from "@/components/menu/dish-builder-page";
import { RestaurantDishBuilder } from "@/components/menu/restaurant-dish-builder";
import { dishBuilderBackHref } from "@/components/menu/dish-builder-form";

/**
 * Просмотр и редактирование существующей заявки на блюдо. Тот же единый
 * RestaurantDishBuilder: DRAFT/REJECTED редактируются, PENDING_REVIEW и
 * APPROVED открываются read-only.
 */
export default function DishSubmissionPage() {
  const params = useParams<{ submissionId: string }>();
  return (
    <Suspense>
      <DishBuilderPageShell screenTitle="Заявка на блюдо">
        {({ restaurant, workspaceRole }) => (
          <RestaurantDishBuilder
            restaurant={restaurant}
            workspaceRole={workspaceRole}
            submissionId={params.submissionId}
            returnHref={dishBuilderBackHref(workspaceRole)}
          />
        )}
      </DishBuilderPageShell>
    </Suspense>
  );
}
