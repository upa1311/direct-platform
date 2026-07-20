"use client";

import { Suspense } from "react";

import { DishBuilderPageShell } from "@/components/menu/dish-builder-page";
import { RestaurantDishBuilder } from "@/components/menu/restaurant-dish-builder";
import { dishBuilderBackHref } from "@/components/menu/dish-builder-form";

/**
 * Новый черновик блюда. Черновик НЕ создаётся при открытии страницы — только
 * первым «Сохранить черновик»/«Отправить», после чего конструктор переводит на
 * маршрут существующей заявки. Один общий RestaurantDishBuilder на все роли.
 */
export default function NewDishPage() {
  return (
    <Suspense>
      <DishBuilderPageShell screenTitle="Новое блюдо">
        {({ restaurant, workspaceRole }) => (
          <RestaurantDishBuilder
            restaurant={restaurant}
            workspaceRole={workspaceRole}
            submissionId={null}
            returnHref={dishBuilderBackHref(workspaceRole)}
          />
        )}
      </DishBuilderPageShell>
    </Suspense>
  );
}
