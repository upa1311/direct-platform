"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import { isAddressReady } from "@/prototype/selectors";

interface ClientAddressConfirmationValue {
  isAddressConfirmed: boolean;
  isConfirmationHydrated: boolean;
  confirmAddress: () => void;
  beginAddressEdit: () => void;
}

const ADDRESS_CONFIRMATION_KEY = "direct-catalog-address-confirmed";
const ADDRESS_REQUEST_EVENT = "direct:open-delivery-address";

const ClientAddressConfirmationContext =
  createContext<ClientAddressConfirmationValue | null>(null);

function getAddressKey(street: string, house: string): string {
  return JSON.stringify([
    street.trim().toLocaleLowerCase("ru-RU"),
    house.trim().toLocaleLowerCase("ru-RU"),
  ]);
}

export function ClientAddressConfirmationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { state, isHydrated } = usePrototype();
  const [confirmedAddressKey, setConfirmedAddressKey] = useState<string | null>(
    null,
  );
  const [isConfirmationHydrated, setIsConfirmationHydrated] = useState(false);
  const addressKey = getAddressKey(
    state.cart.address.street,
    state.cart.address.house,
  );
  const addressIsValid = isAddressReady(state.cart.address, state);

  useEffect(() => {
    if (!isHydrated) return;

    const frame = window.requestAnimationFrame(() => {
      setConfirmedAddressKey(
        window.sessionStorage.getItem(ADDRESS_CONFIRMATION_KEY),
      );
      setIsConfirmationHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isHydrated]);

  useEffect(() => {
    if (
      !isConfirmationHydrated ||
      confirmedAddressKey === null ||
      confirmedAddressKey === addressKey
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      window.sessionStorage.removeItem(ADDRESS_CONFIRMATION_KEY);
      setConfirmedAddressKey(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [addressKey, confirmedAddressKey, isConfirmationHydrated]);

  const confirmAddress = useCallback(() => {
    if (!addressIsValid) return;
    window.sessionStorage.setItem(ADDRESS_CONFIRMATION_KEY, addressKey);
    setConfirmedAddressKey(addressKey);
  }, [addressIsValid, addressKey]);

  const beginAddressEdit = useCallback(() => {
    window.sessionStorage.removeItem(ADDRESS_CONFIRMATION_KEY);
    setConfirmedAddressKey(null);
  }, []);

  const value = useMemo<ClientAddressConfirmationValue>(
    () => ({
      isAddressConfirmed:
        isConfirmationHydrated &&
        addressIsValid &&
        confirmedAddressKey === addressKey,
      isConfirmationHydrated,
      confirmAddress,
      beginAddressEdit,
    }),
    [
      addressIsValid,
      addressKey,
      beginAddressEdit,
      confirmAddress,
      confirmedAddressKey,
      isConfirmationHydrated,
    ],
  );

  return (
    <ClientAddressConfirmationContext.Provider value={value}>
      {children}
    </ClientAddressConfirmationContext.Provider>
  );
}

export function useClientAddressConfirmation(): ClientAddressConfirmationValue {
  const context = useContext(ClientAddressConfirmationContext);
  if (!context) {
    throw new Error(
      "useClientAddressConfirmation must be used inside ClientAddressConfirmationProvider",
    );
  }
  return context;
}

export { ADDRESS_REQUEST_EVENT };
