"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  acceptRestaurantOrder,
  addCartItem,
  adminCancelOrder,
  adminSetPreparationMinutes,
  assignDriverToOrder,
  cancelOrderByClient,
  completePickupWithCode,
  correctOrderStatus,
  createOrderFromCart,
  createRestaurant,
  issuePickupWithoutCode,
  markOrderArriving,
  markOrderDelivered,
  markOrderDeliveredByDriver,
  markOrderOutForDelivery,
  markOrderReady,
  markPickupNoShow as runPickupNoShow,
  reassignDriverForOrder,
  rejectRestaurantOrder,
  repeatOrderToCart,
  resetPrototypeState,
  restoreDefaultTariffs,
  saveTariffs,
  setCartFulfillmentChoice,
  setCartItemComment,
  setCartItemQuantity,
  setCartPaymentMethod,
  setPromotionEnabled,
  setRestaurantAcceptingOrders,
  simulateSuccessfulOnlinePayment,
  unassignDriverFromOrder,
  updateCartAddress,
  updateCustomerProfile,
  updateMenuItemVariants,
  updateRestaurant,
  upsertPromotion,
  type AddCartItemResult,
  type AdminActionResult,
  type ClientCancelResult,
  type CompletePickupResult,
  type CreateOrderResult,
  type CreateRestaurantResult,
  type OrderActionActor,
  type RepeatOrderResult,
  type RestaurantFormInput,
  type UpdateRestaurantResult,
} from "./actions";
import { createDefaultState } from "./default-state";
import type {
  DeliveryAddress,
  FulfillmentChoice,
  MenuItemVariant,
  OrderStatus,
  PaymentMethod,
  Promotion,
  PrototypeState,
  TariffMatrix,
} from "./models";
import {
  isNewerState,
  isPrototypeState,
  LEGACY_V2_PROTOTYPE_STORAGE_KEY,
  LEGACY_V3_PROTOTYPE_STORAGE_KEY,
  LEGACY_V4_PROTOTYPE_STORAGE_KEY,
  LEGACY_V5_PROTOTYPE_STORAGE_KEY,
  normalizePrototypeState,
  parseLegacyStoredState,
  parseStoredState,
  PROTOTYPE_CHANNEL_NAME,
  PROTOTYPE_STORAGE_KEY,
} from "./prototype-store";

interface PrototypeContextValue {
  state: PrototypeState;
  isHydrated: boolean;
  addItem: (
    menuItemId: string,
    variantId?: string | null,
    replaceRestaurant?: boolean,
  ) => AddCartItemResult;
  setItemQuantity: (
    menuItemId: string,
    variantId: string | null,
    quantity: number,
  ) => void;
  setItemComment: (
    menuItemId: string,
    variantId: string | null,
    comment: string,
  ) => void;
  updateAddress: (patch: Partial<Omit<DeliveryAddress, "zoneId">>) => void;
  updateCustomer: (
    patch: Partial<Pick<PrototypeState["customer"], "name" | "phone">>,
  ) => void;
  setPaymentMethod: (paymentMethod: PaymentMethod) => void;
  setFulfillmentChoice: (fulfillmentChoice: FulfillmentChoice) => void;
  createOrder: () => CreateOrderResult;
  repeatOrder: (orderId: string) => RepeatOrderResult;
  cancelClientOrder: (orderId: string, reason: string) => ClientCancelResult;
  acceptOrder: (
    orderId: string,
    preparationMinutes: number,
    actor?: OrderActionActor,
  ) => void;
  rejectOrder: (
    orderId: string,
    reason: string,
    actor?: OrderActionActor,
  ) => void;
  simulateOnlinePayment: (orderId: string) => void;
  markReady: (orderId: string, actor?: OrderActionActor) => void;
  completePickup: (
    orderId: string,
    code: string,
    actor?: OrderActionActor,
  ) => CompletePickupResult;
  markPickupNoShow: (
    orderId: string,
    reason: string,
    actor?: OrderActionActor,
  ) => void;
  markOutForDelivery: (orderId: string, actor?: OrderActionActor) => void;
  markArriving: (orderId: string, actor?: OrderActionActor) => void;
  markDelivered: (orderId: string, actor?: OrderActionActor) => void;
  markDeliveredByDriver: (orderId: string) => void;
  setPreparationMinutes: (orderId: string, minutes: number) => void;
  setRestaurantAccepting: (restaurantId: string, accepting: boolean) => void;
  assignDriver: (orderId: string, driverId: string) => AdminActionResult;
  reassignDriver: (
    orderId: string,
    newDriverId: string,
    reason: string,
  ) => AdminActionResult;
  unassignDriver: (orderId: string, reason: string) => AdminActionResult;
  cancelOrderByAdmin: (orderId: string, reason: string) => AdminActionResult;
  correctStatus: (
    orderId: string,
    newStatus: OrderStatus,
    reason: string,
  ) => AdminActionResult;
  issuePickupNoCode: (orderId: string, reason: string) => AdminActionResult;
  saveTariffMatrix: (tariffs: TariffMatrix) => void;
  restoreTariffs: () => void;
  createRestaurantEntry: (input: RestaurantFormInput) => CreateRestaurantResult;
  updateRestaurantEntry: (
    restaurantId: string,
    patch: Partial<RestaurantFormInput>,
  ) => UpdateRestaurantResult;
  setMenuItemVariants: (
    menuItemId: string,
    variants: MenuItemVariant[] | null,
  ) => void;
  savePromotion: (promotion: Promotion) => void;
  togglePromotion: (promotionId: string, enabled: boolean) => void;
  resetPrototype: () => void;
}

interface PrototypeChannelMessage {
  sourceId: string;
  state: PrototypeState;
}

const PrototypeContext = createContext<PrototypeContextValue | null>(null);

export function PrototypeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PrototypeState>(createDefaultState);
  const [isHydrated, setIsHydrated] = useState(false);
  const stateRef = useRef<PrototypeState>(state);
  const sourceIdRef = useRef<string>("");
  const channelRef = useRef<BroadcastChannel | null>(null);

  const replaceState = useCallback((nextState: PrototypeState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  useEffect(() => {
    sourceIdRef.current = crypto.randomUUID();

    const storedState =
      parseStoredState(window.localStorage.getItem(PROTOTYPE_STORAGE_KEY)) ??
      parseLegacyStoredState(
        window.localStorage.getItem(LEGACY_V5_PROTOTYPE_STORAGE_KEY),
      ) ??
      parseLegacyStoredState(
        window.localStorage.getItem(LEGACY_V4_PROTOTYPE_STORAGE_KEY),
      ) ??
      parseLegacyStoredState(
        window.localStorage.getItem(LEGACY_V3_PROTOTYPE_STORAGE_KEY),
      ) ??
      parseLegacyStoredState(
        window.localStorage.getItem(LEGACY_V2_PROTOTYPE_STORAGE_KEY),
      );
    let isActive = true;

    const handleIncomingState = (incomingState: PrototypeState) => {
      if (isNewerState(incomingState, stateRef.current)) {
        replaceState(incomingState);
      }
    };

    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(PROTOTYPE_CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent<PrototypeChannelMessage>) => {
        const message = event.data;
        if (
          message?.sourceId !== sourceIdRef.current &&
          isPrototypeState(message?.state)
        ) {
          handleIncomingState(normalizePrototypeState(message.state));
        }
      };
      channelRef.current = channel;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PROTOTYPE_STORAGE_KEY) {
        return;
      }
      const incomingState = parseStoredState(event.newValue);
      if (incomingState) {
        handleIncomingState(incomingState);
      }
    };

    window.addEventListener("storage", handleStorage);
    queueMicrotask(() => {
      if (!isActive) {
        return;
      }
      if (storedState) {
        replaceState(storedState);
      }
      setIsHydrated(true);
    });

    return () => {
      isActive = false;
      window.removeEventListener("storage", handleStorage);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [replaceState]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    window.localStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state));
    channelRef.current?.postMessage({
      sourceId: sourceIdRef.current,
      state,
    } satisfies PrototypeChannelMessage);
  }, [isHydrated, state]);

  const addItem = useCallback(
    (
      menuItemId: string,
      variantId: string | null = null,
      replaceRestaurant = false,
    ) => {
      const action = addCartItem(
        stateRef.current,
        menuItemId,
        variantId,
        replaceRestaurant,
      );
      if (action.state !== stateRef.current) {
        replaceState(action.state);
      }
      return action.result;
    },
    [replaceState],
  );

  const setItemQuantity = useCallback(
    (menuItemId: string, variantId: string | null, quantity: number) => {
      replaceState(
        setCartItemQuantity(stateRef.current, menuItemId, variantId, quantity),
      );
    },
    [replaceState],
  );

  const setItemComment = useCallback(
    (menuItemId: string, variantId: string | null, comment: string) => {
      replaceState(
        setCartItemComment(stateRef.current, menuItemId, variantId, comment),
      );
    },
    [replaceState],
  );

  const updateAddress = useCallback(
    (patch: Partial<Omit<DeliveryAddress, "zoneId">>) => {
      replaceState(updateCartAddress(stateRef.current, patch));
    },
    [replaceState],
  );

  const updateCustomer = useCallback(
    (patch: Partial<Pick<PrototypeState["customer"], "name" | "phone">>) => {
      replaceState(updateCustomerProfile(stateRef.current, patch));
    },
    [replaceState],
  );

  const setPaymentMethod = useCallback(
    (paymentMethod: PaymentMethod) => {
      replaceState(setCartPaymentMethod(stateRef.current, paymentMethod));
    },
    [replaceState],
  );

  const setFulfillmentChoice = useCallback(
    (fulfillmentChoice: FulfillmentChoice) => {
      replaceState(
        setCartFulfillmentChoice(stateRef.current, fulfillmentChoice),
      );
    },
    [replaceState],
  );

  const createOrder = useCallback(() => {
    const action = createOrderFromCart(stateRef.current);
    if (action.state !== stateRef.current) {
      replaceState(action.state);
    }
    return action.result;
  }, [replaceState]);

  const repeatOrder = useCallback(
    (orderId: string) => {
      const action = repeatOrderToCart(stateRef.current, orderId);
      if (action.state !== stateRef.current) {
        replaceState(action.state);
      }
      return action.result;
    },
    [replaceState],
  );

  const cancelClientOrder = useCallback(
    (orderId: string, reason: string) => {
      const action = cancelOrderByClient(stateRef.current, orderId, reason);
      if (action.state !== stateRef.current) {
        replaceState(action.state);
      }
      return action.result;
    },
    [replaceState],
  );

  const acceptOrder = useCallback(
    (
      orderId: string,
      preparationMinutes: number,
      actor: OrderActionActor = "RESTAURANT",
    ) => {
      replaceState(
        acceptRestaurantOrder(
          stateRef.current,
          orderId,
          preparationMinutes,
          actor,
        ),
      );
    },
    [replaceState],
  );

  const rejectOrder = useCallback(
    (orderId: string, reason: string, actor: OrderActionActor = "RESTAURANT") => {
      replaceState(
        rejectRestaurantOrder(stateRef.current, orderId, reason, actor),
      );
    },
    [replaceState],
  );

  const simulateOnlinePayment = useCallback(
    (orderId: string) => {
      replaceState(
        simulateSuccessfulOnlinePayment(stateRef.current, orderId),
      );
    },
    [replaceState],
  );

  const markReady = useCallback(
    (orderId: string, actor: OrderActionActor = "RESTAURANT") => {
      replaceState(markOrderReady(stateRef.current, orderId, actor));
    },
    [replaceState],
  );

  const completePickup = useCallback(
    (orderId: string, code: string, actor: OrderActionActor = "RESTAURANT") => {
      const action = completePickupWithCode(
        stateRef.current,
        orderId,
        code,
        actor,
      );
      if (action.state !== stateRef.current) {
        replaceState(action.state);
      }
      return action.result;
    },
    [replaceState],
  );

  const markPickupNoShow = useCallback(
    (orderId: string, reason: string, actor: OrderActionActor = "RESTAURANT") => {
      replaceState(runPickupNoShow(stateRef.current, orderId, reason, actor));
    },
    [replaceState],
  );

  const markOutForDelivery = useCallback(
    (orderId: string, actor: OrderActionActor = "RESTAURANT") => {
      replaceState(markOrderOutForDelivery(stateRef.current, orderId, actor));
    },
    [replaceState],
  );

  const markArriving = useCallback(
    (orderId: string, actor: OrderActionActor = "RESTAURANT") => {
      replaceState(markOrderArriving(stateRef.current, orderId, actor));
    },
    [replaceState],
  );

  const markDelivered = useCallback(
    (orderId: string, actor: OrderActionActor = "RESTAURANT") => {
      replaceState(markOrderDelivered(stateRef.current, orderId, actor));
    },
    [replaceState],
  );

  const markDeliveredByDriver = useCallback(
    (orderId: string) => {
      replaceState(markOrderDeliveredByDriver(stateRef.current, orderId));
    },
    [replaceState],
  );

  const setPreparationMinutes = useCallback(
    (orderId: string, minutes: number) => {
      replaceState(
        adminSetPreparationMinutes(stateRef.current, orderId, minutes),
      );
    },
    [replaceState],
  );

  const setRestaurantAccepting = useCallback(
    (restaurantId: string, accepting: boolean) => {
      replaceState(
        setRestaurantAcceptingOrders(
          stateRef.current,
          restaurantId,
          accepting,
        ),
      );
    },
    [replaceState],
  );

  const runAdminOrderAction = useCallback(
    (
      action: (state: PrototypeState) => {
        state: PrototypeState;
        result: AdminActionResult;
      },
    ): AdminActionResult => {
      const outcome = action(stateRef.current);
      if (outcome.state !== stateRef.current) {
        replaceState(outcome.state);
      }
      return outcome.result;
    },
    [replaceState],
  );

  const assignDriver = useCallback(
    (orderId: string, driverId: string) =>
      runAdminOrderAction((s) => assignDriverToOrder(s, orderId, driverId)),
    [runAdminOrderAction],
  );

  const reassignDriver = useCallback(
    (orderId: string, newDriverId: string, reason: string) =>
      runAdminOrderAction((s) =>
        reassignDriverForOrder(s, orderId, newDriverId, reason),
      ),
    [runAdminOrderAction],
  );

  const unassignDriver = useCallback(
    (orderId: string, reason: string) =>
      runAdminOrderAction((s) => unassignDriverFromOrder(s, orderId, reason)),
    [runAdminOrderAction],
  );

  const cancelOrderByAdmin = useCallback(
    (orderId: string, reason: string) =>
      runAdminOrderAction((s) => adminCancelOrder(s, orderId, reason)),
    [runAdminOrderAction],
  );

  const correctStatus = useCallback(
    (orderId: string, newStatus: OrderStatus, reason: string) =>
      runAdminOrderAction((s) =>
        correctOrderStatus(s, orderId, newStatus, reason),
      ),
    [runAdminOrderAction],
  );

  const issuePickupNoCode = useCallback(
    (orderId: string, reason: string) =>
      runAdminOrderAction((s) => issuePickupWithoutCode(s, orderId, reason)),
    [runAdminOrderAction],
  );

  const saveTariffMatrix = useCallback(
    (tariffs: TariffMatrix) => {
      replaceState(saveTariffs(stateRef.current, tariffs));
    },
    [replaceState],
  );

  const restoreTariffs = useCallback(() => {
    replaceState(restoreDefaultTariffs(stateRef.current));
  }, [replaceState]);

  const createRestaurantEntry = useCallback(
    (input: RestaurantFormInput) => {
      const action = createRestaurant(stateRef.current, input);
      if (action.state !== stateRef.current) {
        replaceState(action.state);
      }
      return action.result;
    },
    [replaceState],
  );

  const updateRestaurantEntry = useCallback(
    (restaurantId: string, patch: Partial<RestaurantFormInput>) => {
      const action = updateRestaurant(stateRef.current, restaurantId, patch);
      if (action.state !== stateRef.current) {
        replaceState(action.state);
      }
      return action.result;
    },
    [replaceState],
  );

  const setMenuItemVariants = useCallback(
    (menuItemId: string, variants: MenuItemVariant[] | null) => {
      replaceState(
        updateMenuItemVariants(stateRef.current, menuItemId, variants),
      );
    },
    [replaceState],
  );

  const savePromotion = useCallback(
    (promotion: Promotion) => {
      replaceState(upsertPromotion(stateRef.current, promotion));
    },
    [replaceState],
  );

  const togglePromotion = useCallback(
    (promotionId: string, enabled: boolean) => {
      replaceState(setPromotionEnabled(stateRef.current, promotionId, enabled));
    },
    [replaceState],
  );

  const resetPrototype = useCallback(() => {
    replaceState(resetPrototypeState(stateRef.current));
  }, [replaceState]);

  const value = useMemo<PrototypeContextValue>(
    () => ({
      state,
      isHydrated,
      addItem,
      setItemQuantity,
      setItemComment,
      updateAddress,
      updateCustomer,
      setPaymentMethod,
      setFulfillmentChoice,
      createOrder,
      repeatOrder,
      cancelClientOrder,
      acceptOrder,
      rejectOrder,
      simulateOnlinePayment,
      markReady,
      completePickup,
      markPickupNoShow,
      markOutForDelivery,
      markArriving,
      markDelivered,
      markDeliveredByDriver,
      setPreparationMinutes,
      setRestaurantAccepting,
      assignDriver,
      reassignDriver,
      unassignDriver,
      cancelOrderByAdmin,
      correctStatus,
      issuePickupNoCode,
      saveTariffMatrix,
      restoreTariffs,
      createRestaurantEntry,
      updateRestaurantEntry,
      setMenuItemVariants,
      savePromotion,
      togglePromotion,
      resetPrototype,
    }),
    [
      state,
      isHydrated,
      addItem,
      setItemQuantity,
      setItemComment,
      updateAddress,
      updateCustomer,
      setPaymentMethod,
      setFulfillmentChoice,
      createOrder,
      repeatOrder,
      cancelClientOrder,
      acceptOrder,
      rejectOrder,
      simulateOnlinePayment,
      markReady,
      completePickup,
      markPickupNoShow,
      markOutForDelivery,
      markArriving,
      markDelivered,
      markDeliveredByDriver,
      setPreparationMinutes,
      setRestaurantAccepting,
      assignDriver,
      reassignDriver,
      unassignDriver,
      cancelOrderByAdmin,
      correctStatus,
      issuePickupNoCode,
      saveTariffMatrix,
      restoreTariffs,
      createRestaurantEntry,
      updateRestaurantEntry,
      setMenuItemVariants,
      savePromotion,
      togglePromotion,
      resetPrototype,
    ],
  );

  return (
    <PrototypeContext.Provider value={value}>
      {children}
    </PrototypeContext.Provider>
  );
}

export function usePrototype(): PrototypeContextValue {
  const context = useContext(PrototypeContext);
  if (!context) {
    throw new Error("usePrototype must be used inside PrototypeProvider");
  }
  return context;
}
