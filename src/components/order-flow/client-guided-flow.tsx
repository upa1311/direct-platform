"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent } from "react";

import {
  ADDRESS_REQUEST_EVENT,
  useClientAddressConfirmation,
} from "./client-address-confirmation";
import { usePrototype } from "@/prototype/prototype-provider";
import { getActiveCustomerOrder } from "@/prototype/selectors";
import styles from "./order-flow.module.css";

type StepState = "completed" | "current" | "available" | "locked";

interface GuidedStep {
  label: string;
  href: string | null;
  state: StepState;
}

const stepClassNames: Record<StepState, string> = {
  completed: styles.guidedStepCompleted,
  current: styles.guidedStepCurrent,
  available: styles.guidedStepAvailable,
  locked: styles.guidedStepLocked,
};

function getScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function getRouteId(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function ClientGuidedFlow() {
  const pathname = usePathname();
  const { state, isHydrated } = usePrototype();
  const {
    isAddressConfirmed,
    isConfirmationHydrated,
    beginAddressEdit,
  } = useClientAddressConfirmation();
  const restaurantRouteId = getRouteId(
    pathname,
    /^\/client\/restaurants\/([^/]+)$/,
  );
  const orderRouteId = getRouteId(pathname, /^\/client\/orders\/([^/]+)$/);
  const existingOrder = orderRouteId
    ? state.orders.find(
        (order) =>
          order.id === orderRouteId && order.customer.id === state.customer.id,
      ) ?? null
    : null;
  const activeOrder = getActiveCustomerOrder(state);
  const selectedRestaurantId =
    restaurantRouteId ??
    existingOrder?.restaurant.id ??
    state.cart.restaurantId ??
    null;
  const hasCartItems = state.cart.items.length > 0;
  const deliveryMode = existingOrder?.deliveryMode ?? state.cart.deliveryMode;
  const firstStepComplete = existingOrder
    ? true
    : deliveryMode === "PICKUP" ||
      (deliveryMode === "PLATFORM_DRIVER" && isAddressConfirmed);
  const firstStepLabel =
    deliveryMode === "PICKUP"
      ? "Самовывоз"
      : deliveryMode === "PLATFORM_DRIVER"
        ? "Куда доставить"
        : "Способ получения";
  const firstStepHref =
    deliveryMode === "PLATFORM_DRIVER"
      ? "/client/catalog#delivery-address"
      : "/client/catalog#fulfillment-method";

  if (
    !isHydrated ||
    !isConfirmationHydrated ||
    (!pathname.startsWith("/client/catalog") &&
      !pathname.startsWith("/client/restaurants/") &&
      pathname !== "/client/cart" &&
      !orderRouteId)
  ) {
    return null;
  }

  const currentStep = existingOrder
    ? 5
    : !firstStepComplete
      ? 1
      : hasCartItems
        ? 4
        : selectedRestaurantId
          ? 3
          : 2;

  const steps: GuidedStep[] = [
    {
      label: firstStepLabel,
      href: firstStepHref,
      state: currentStep === 1 ? "current" : "completed",
    },
    {
      label: "Выбор ресторана",
      href:
        existingOrder || firstStepComplete
          ? "/client/catalog#restaurant-list"
          : null,
      state:
        existingOrder
          ? "completed"
          : !firstStepComplete
            ? "locked"
          : currentStep === 2
            ? "current"
            : Boolean(selectedRestaurantId)
              ? "completed"
              : "available",
    },
    {
      label: "Выбор блюд",
      href:
        (existingOrder || firstStepComplete) && selectedRestaurantId
          ? `/client/restaurants/${selectedRestaurantId}#restaurant-menu`
          : null,
      state:
        existingOrder
          ? "completed"
          : !firstStepComplete
            ? "locked"
          : currentStep === 3
            ? "current"
            : hasCartItems
              ? "completed"
              : selectedRestaurantId
                ? "available"
                : "locked",
    },
    {
      label: "Оформление и оплата",
      href: existingOrder
        ? `/client/orders/${existingOrder.id}#order-status`
        : firstStepComplete && hasCartItems
          ? "/client/cart#checkout-cart"
          : null,
      state:
        existingOrder
          ? "completed"
          : !firstStepComplete
            ? "locked"
          : currentStep === 4
            ? "current"
            : hasCartItems
              ? "available"
              : "locked",
    },
    {
      label: "Статус заказа",
      href: existingOrder
        ? `/client/orders/${existingOrder.id}#order-status`
        : firstStepComplete && activeOrder
          ? `/client/orders/${activeOrder.id}#order-status`
          : null,
      state:
        existingOrder
          ? "current"
          : firstStepComplete && activeOrder
            ? "available"
            : "locked",
    },
  ];

  const handleStepClick = (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    const [targetPath, hash] = href.split("#");
    if (!hash) return;

    if (hash === "delivery-address") {
      beginAddressEdit();
    }

    if (targetPath !== pathname) return;

    if (hash === "delivery-address") {
      window.dispatchEvent(new Event(ADDRESS_REQUEST_EVENT));
    } else {
      document.getElementById(hash)?.scrollIntoView({
        behavior: getScrollBehavior(),
        block: "start",
      });
    }

    if (window.location.hash === `#${hash}`) {
      event.preventDefault();
    }
  };

  const current = steps[currentStep - 1];

  return (
    <nav className={styles.guidedFlow} aria-label="Путь оформления заказа">
      <ol className={styles.guidedFlowDesktop}>
        {steps.map((step, index) => {
          const stepNumber = index + 1;
          const className = `${styles.guidedStep} ${stepClassNames[step.state]}`;
          const content = (
            <>
              <span className={styles.guidedStepNumber} aria-hidden="true">
                {step.state === "completed" ? "✓" : stepNumber}
              </span>
              <span>{step.label}</span>
            </>
          );

          return (
            <li className={className} key={step.label}>
              {step.href ? (
                <Link
                  href={step.href}
                  aria-current={step.state === "current" ? "step" : undefined}
                  onClick={(event) => handleStepClick(event, step.href!)}
                >
                  {content}
                </Link>
              ) : (
                <span aria-disabled="true">{content}</span>
              )}
            </li>
          );
        })}
      </ol>
      <div className={styles.guidedFlowMobile}>
        <span>Шаг {currentStep} из 5</span>
        {current.href ? (
          <Link
            href={current.href}
            aria-current="step"
            onClick={(event) => handleStepClick(event, current.href!)}
          >
            {current.label}
          </Link>
        ) : (
          <strong>{current.label}</strong>
        )}
      </div>
    </nav>
  );
}
