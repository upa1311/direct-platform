"use client";

import { usePathname } from "next/navigation";

import { usePrototype } from "@/prototype/prototype-provider";
import { isAddressReady } from "@/prototype/selectors";
import styles from "./order-flow.module.css";

const steps = ["Адрес", "Ресторан", "Блюда", "Оформление", "Статус"] as const;

export function ClientGuidedFlow() {
  const pathname = usePathname();
  const { state, isHydrated } = usePrototype();
  const restaurantRoute = pathname.startsWith("/client/restaurants/");
  const cartRoute = pathname === "/client/cart";
  const orderMatch = pathname.match(/^\/client\/orders\/([^/]+)$/);
  const existingOrder = orderMatch
    ? state.orders.some((order) => order.id === decodeURIComponent(orderMatch[1]))
    : false;
  const catalogRoute = pathname === "/client/catalog";
  const hasCreatedOrder = state.orders.some(
    (order) => order.customer.id === state.customer.id,
  );

  if (
    !isHydrated ||
    (!catalogRoute && !restaurantRoute && !cartRoute && !orderMatch)
  ) {
    return null;
  }

  const validAddress = isAddressReady(state.cart.address, state);
  const currentStep = existingOrder
    ? 5
    : cartRoute
      ? 4
      : restaurantRoute
        ? 3
        : validAddress
          ? 2
          : 1;
  const completed = [
    hasCreatedOrder || validAddress,
    hasCreatedOrder || restaurantRoute || cartRoute || Boolean(state.cart.restaurantId),
    hasCreatedOrder || state.cart.items.length > 0,
    hasCreatedOrder,
    false,
  ];

  return (
    <nav className={styles.guidedFlow} aria-label="Путь оформления заказа">
      <ol className={styles.guidedFlowDesktop}>
        {steps.map((step, index) => {
          const stepNumber = index + 1;
          const isCurrent = stepNumber === currentStep;
          const isCompleted = completed[index] && !isCurrent;
          return (
            <li
              className={`${isCurrent ? styles.guidedStepCurrent : ""} ${isCompleted ? styles.guidedStepCompleted : ""}`}
              aria-current={isCurrent ? "step" : undefined}
              key={step}
            >
              <span aria-hidden="true">{isCompleted ? "✓" : stepNumber}</span>
              {step}
            </li>
          );
        })}
      </ol>
      <p className={styles.guidedFlowMobile}>
        Шаг {currentStep} из 5 · {steps[currentStep - 1]}
      </p>
    </nav>
  );
}
