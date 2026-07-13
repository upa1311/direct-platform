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
  createOrderFromCart,
  markOrderReady,
  rejectRestaurantOrder,
  resetPrototypeState,
  restoreDefaultTariffs,
  saveTariffs,
  setCartItemComment,
  setCartItemQuantity,
  setCartPaymentMethod,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
  updateCustomerProfile,
  type AddCartItemResult,
  type CreateOrderResult,
} from "./actions";
import { createDefaultState } from "./default-state";
import type {
  DeliveryAddress,
  PaymentMethod,
  PrototypeState,
  TariffMatrix,
} from "./models";
import {
  isNewerState,
  isPrototypeState,
  LEGACY_PROTOTYPE_STORAGE_KEY,
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
    replaceRestaurant?: boolean,
  ) => AddCartItemResult;
  setItemQuantity: (menuItemId: string, quantity: number) => void;
  setItemComment: (menuItemId: string, comment: string) => void;
  updateAddress: (
    patch: Partial<Omit<DeliveryAddress, "zoneId">>,
  ) => void;
  updateCustomer: (
    patch: Partial<Pick<PrototypeState["customer"], "name" | "phone">>,
  ) => void;
  setPaymentMethod: (paymentMethod: PaymentMethod) => void;
  createOrder: () => CreateOrderResult;
  acceptOrder: (orderId: string, preparationMinutes: number) => void;
  rejectOrder: (orderId: string, reason: string) => void;
  simulateOnlinePayment: (orderId: string) => void;
  markReady: (orderId: string) => void;
  saveTariffMatrix: (tariffs: TariffMatrix) => void;
  restoreTariffs: () => void;
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

    const storedV3State = parseStoredState(
      window.localStorage.getItem(PROTOTYPE_STORAGE_KEY),
    );
    const storedState =
      storedV3State ??
      parseLegacyStoredState(
        window.localStorage.getItem(LEGACY_PROTOTYPE_STORAGE_KEY),
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
    (menuItemId: string, replaceRestaurant = false) => {
      const action = addCartItem(
        stateRef.current,
        menuItemId,
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
    (menuItemId: string, quantity: number) => {
      replaceState(
        setCartItemQuantity(stateRef.current, menuItemId, quantity),
      );
    },
    [replaceState],
  );

  const setItemComment = useCallback(
    (menuItemId: string, comment: string) => {
      replaceState(setCartItemComment(stateRef.current, menuItemId, comment));
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

  const createOrder = useCallback(() => {
    const action = createOrderFromCart(stateRef.current);
    if (action.state !== stateRef.current) {
      replaceState(action.state);
    }
    return action.result;
  }, [replaceState]);

  const acceptOrder = useCallback(
    (orderId: string, preparationMinutes: number) => {
      replaceState(
        acceptRestaurantOrder(
          stateRef.current,
          orderId,
          preparationMinutes,
        ),
      );
    },
    [replaceState],
  );

  const rejectOrder = useCallback(
    (orderId: string, reason: string) => {
      replaceState(rejectRestaurantOrder(stateRef.current, orderId, reason));
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
    (orderId: string) => {
      replaceState(markOrderReady(stateRef.current, orderId));
    },
    [replaceState],
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
      createOrder,
      acceptOrder,
      rejectOrder,
      simulateOnlinePayment,
      markReady,
      saveTariffMatrix,
      restoreTariffs,
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
      createOrder,
      acceptOrder,
      rejectOrder,
      simulateOnlinePayment,
      markReady,
      saveTariffMatrix,
      restoreTariffs,
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
