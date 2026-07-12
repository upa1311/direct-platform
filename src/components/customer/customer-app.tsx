"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { CartScreen } from "@/components/customer/cart-screen";
import { CatalogScreen } from "@/components/customer/catalog-screen";
import { CheckoutScreen } from "@/components/customer/checkout-screen";
import { CustomerHeader } from "@/components/customer/customer-header";
import { HistoryScreen } from "@/components/customer/history-screen";
import { OrderScreen } from "@/components/customer/order-screen";
import { RestaurantScreen } from "@/components/customer/restaurant-screen";
import { Modal } from "@/components/ui/modal";
import { Toast } from "@/components/ui/toast";
import { menuItems, restaurants } from "@/data/demo-data";
import {
  deliveryFeeCents,
  getFoodSubtotal,
  getSmallOrderFee,
} from "@/lib/demo-calculations";
import type {
  CartLine,
  CustomerScreen,
  DeliveryMode,
  DemoMenuItem,
  OrderStage,
  PaymentMethod,
} from "@/types/prototype";

export function CustomerApp() {
  const publicRestaurants = restaurants.filter(
    (restaurant) => restaurant.status === "PUBLISHED",
  );
  const [screen, setScreen] = useState<CustomerScreen>("catalog");
  const [selectedRestaurantId, setSelectedRestaurantId] = useState(
    publicRestaurants[0].id,
  );
  const [cartLines, setCartLines] = useState<CartLine[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("PLATFORM_DRIVER");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("QR");
  const [phoneConfirmed, setPhoneConfirmed] = useState(false);
  const [orderStage, setOrderStage] = useState<OrderStage>("review");
  const [toast, setToast] = useState("");
  const [decisionModalOpen, setDecisionModalOpen] = useState(false);

  const selectedRestaurant =
    publicRestaurants.find((restaurant) => restaurant.id === selectedRestaurantId) ??
    publicRestaurants[0];

  const cartCount = cartLines.reduce((total, line) => total + line.quantity, 0);
  const foodSubtotalCents = getFoodSubtotal(cartLines);
  const currentSmallOrderFee =
    paymentMethod === "QR" ? getSmallOrderFee(foodSubtotalCents) : 0;
  const orderTotalCents =
    foodSubtotalCents + deliveryFeeCents + currentSmallOrderFee;

  const cartViewLines = useMemo(
    () =>
      cartLines.flatMap((line) => {
        const item = menuItems.find((menuItem) => menuItem.id === line.itemId);
        return item ? [{ ...line, item }] : [];
      }),
    [cartLines],
  );

  function openRestaurant(restaurantId: string) {
    if (cartLines.length > 0 && restaurantId !== selectedRestaurantId) {
      setDecisionModalOpen(true);
      return;
    }
    setSelectedRestaurantId(restaurantId);
    setScreen("restaurant");
  }

  function addItem(item: DemoMenuItem, unitPriceCents: number, variant: string) {
    setCartLines((currentLines) => {
      const existingLine = currentLines.find(
        (line) => line.itemId === item.id && line.variant === variant,
      );
      if (existingLine) {
        return currentLines.map((line) =>
          line.itemId === item.id && line.variant === variant
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        );
      }
      return [
        ...currentLines,
        { itemId: item.id, quantity: 1, unitPriceCents, variant },
      ];
    });
    setToast(`${item.name} добавлена в корзину`);
  }

  function changeQuantity(itemId: string, variant: string, quantity: number) {
    setCartLines((currentLines) => {
      if (quantity <= 0) {
        return currentLines.filter(
          (line) => !(line.itemId === itemId && line.variant === variant),
        );
      }
      return currentLines.map((line) =>
        line.itemId === itemId && line.variant === variant
          ? { ...line, quantity }
          : line,
      );
    });
  }

  function changeDeliveryMode(mode: DeliveryMode) {
    setDeliveryMode(mode);
    if (mode !== "PLATFORM_DRIVER") {
      setToast("Полный кликабельный поток пока доступен только для доставки Direct");
    }
  }

  function cancelOrder() {
    setCartLines([]);
    setOrderStage("review");
    setScreen("catalog");
    setToast("Демонстрационный заказ отменён — деньги не списывались");
  }

  return (
    <div className="customer-app">
      <CustomerHeader
        screen={screen}
        cartCount={cartCount}
        onHome={() => setScreen("catalog")}
        onHistory={() => setScreen("history")}
        onCart={() => setScreen("cart")}
      />

      {screen === "catalog" ? (
        <CatalogScreen
          restaurants={publicRestaurants}
          onOpenRestaurant={openRestaurant}
        />
      ) : null}

      {screen === "restaurant" ? (
        <RestaurantScreen
          restaurant={selectedRestaurant}
          items={menuItems}
          cartCount={cartCount}
          onBack={() => setScreen("catalog")}
          onOpenCart={() => setScreen("cart")}
          onAddItem={addItem}
        />
      ) : null}

      {screen === "cart" ? (
        <CartScreen
          restaurant={selectedRestaurant}
          lines={cartViewLines}
          foodSubtotalCents={foodSubtotalCents}
          deliveryMode={deliveryMode}
          onDeliveryModeChange={changeDeliveryMode}
          onQuantityChange={changeQuantity}
          onBack={() => setScreen("restaurant")}
          onCheckout={() => setScreen("checkout")}
        />
      ) : null}

      {screen === "checkout" ? (
        <CheckoutScreen
          foodSubtotalCents={foodSubtotalCents}
          paymentMethod={paymentMethod}
          phoneConfirmed={phoneConfirmed}
          onPaymentMethodChange={setPaymentMethod}
          onConfirmPhone={() => {
            setPhoneConfirmed(true);
            setToast("Телефон подтверждён в демо-режиме");
          }}
          onBack={() => setScreen("cart")}
          onSubmit={() => {
            setOrderStage("review");
            setScreen("order");
          }}
        />
      ) : null}

      {screen === "order" ? (
        <OrderScreen
          stage={orderStage}
          totalCents={orderTotalCents}
          onStageChange={setOrderStage}
          onCancel={cancelOrder}
          onHistory={() => setScreen("history")}
          onCallDemo={() => setToast("Звонок не выполняется — это безопасный локальный прототип")}
        />
      ) : null}

      {screen === "history" ? (
        <HistoryScreen
          hasActiveOrder={orderStage === "active"}
          onOpenActiveOrder={() => setScreen("order")}
        />
      ) : null}

      <Modal
        open={decisionModalOpen}
        onClose={() => setDecisionModalOpen(false)}
        title="Нужное правило ещё не утверждено"
        eyebrow="Корзина другого ресторана"
        size="small"
      >
        <div className="decision-message">
          <span><AlertTriangle size={24} /></span>
          <p>В корзине уже есть позиции {selectedRestaurant.name}. Поведение при переходе в другой ресторан записано как открытый вопрос.</p>
        </div>
        <div className="demo-note"><Info size={17} /> Прототип не очищает корзину молча и не закрепляет отсутствующее бизнес-правило.</div>
        <button className="primary-button wide-button" type="button" onClick={() => setDecisionModalOpen(false)}>Понятно</button>
      </Modal>

      {toast ? <Toast message={toast} onClose={() => setToast("")} /> : null}
    </div>
  );
}
