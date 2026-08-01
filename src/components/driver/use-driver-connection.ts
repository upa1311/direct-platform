"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import {
  createDriverConnectionController,
  driverConnectionReducer,
  getDriverConnectionView,
  INITIAL_DRIVER_CONNECTION_STATE,
  type DriverConnectionController,
  type DriverConnectionEnv,
  type DriverConnectionView,
} from "@/prototype/driver-connection";

/**
 * Driver offline / connection-recovery runtime. Thin React wrapper over the pure
 * controller + reducer: listens to browser online/offline/focus/visibility,
 * drives the fail-closed state machine, and refreshes the authoritative persisted
 * state via the provider's read-only refreshFromPersistedState. Connection state
 * is tab-local — it is never written to PrototypeState.
 */
export function useDriverConnection(): {
  view: DriverConnectionView;
  retry: () => void;
} {
  const { isHydrated, refreshFromPersistedState } = usePrototype();
  const [state, dispatch] = useReducer(
    driverConnectionReducer,
    INITIAL_DRIVER_CONNECTION_STATE,
  );
  const controllerRef = useRef<DriverConnectionController | null>(null);

  useEffect(() => {
    const env: DriverConnectionEnv = {
      addEventListener: (type, handler) => window.addEventListener(type, handler),
      removeEventListener: (type, handler) =>
        window.removeEventListener(type, handler),
      isOnline: () =>
        typeof navigator === "undefined" ? true : navigator.onLine,
      isVisible: () =>
        typeof document === "undefined"
          ? true
          : document.visibilityState === "visible",
    };
    const controller = createDriverConnectionController(env, {
      dispatch,
      refresh: async () => refreshFromPersistedState(),
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      controller.stop();
      controllerRef.current = null;
    };
  }, [refreshFromPersistedState]);

  // Once the provider has hydrated, let the controller establish the initial
  // status (RECOVERING → ONLINE after the first refresh, or OFFLINE).
  useEffect(() => {
    if (isHydrated) controllerRef.current?.hydrate();
  }, [isHydrated]);

  const retry = useCallback(() => {
    controllerRef.current?.retry();
  }, []);

  return { view: getDriverConnectionView(state), retry };
}
