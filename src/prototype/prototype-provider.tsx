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
  acceptRestaurantOrderWithResult,
  addCartItem,
  adjustOrderEtaFromIntent,
  adminCancelOrder,
  adminSetPreparationMinutes,
  approveCancellationRequest,
  assignDriverToOrder,
  cancelOrderByClient,
  completePickupWithCode,
  correctOrderStatus,
  createOrderFromCart,
  createRestaurant,
  expireUnansweredRestaurantOrders,
  issuePickupWithoutCode,
  pauseCategoryItems,
  pauseRestaurantOrders,
  restoreCategoryItems,
  restoreMenuItemAvailability,
  resumeExpiredOperationalPauses,
  resumeRestaurantOrders,
  setMenuItemOperationallyUnavailable,
  markOrderArriving,
  markOrderDelivered,
  markOrderDeliveredByDriver,
  markOrderOutForDelivery,
  markOrderReady,
  markPickupNoShow as runPickupNoShow,
  reportRestaurantPreparationProblem,
  setRestaurantWorkflowMode,
  reassignDriverForOrder,
  rejectCancellationRequest,
  rejectRestaurantOrderWithResult,
  repeatOrderToCart,
  requestOrderCancellationByClient,
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
  type AcceptRestaurantOrderResult,
  type AddCartItemResult,
  type AdjustOrderEtaResult,
  type AdminActionResult,
  type BulkOperationalResult,
  type ClientCancelResult,
  type CompletePickupResult,
  type CreateOrderResult,
  type CreateRestaurantResult,
  type OperationalActionResult,
  type OrderActionActor,
  type PickupNoShowResult,
  type PreparationProblemResult,
  type RejectRestaurantOrderResult,
  type RepeatOrderResult,
  type RequestCancellationResult,
  type RestaurantFormInput,
  type UpdateRestaurantResult,
} from "./actions";
import type { EtaAdjustmentIntent } from "./order-eta";
import { createDefaultState } from "./default-state";
import type {
  DeliveryAddress,
  FulfillmentChoice,
  MenuItemVariant,
  OperationalActor,
  OperationalPauseMode,
  OrderStatus,
  PaymentMethod,
  PickupPaymentMethod,
  Promotion,
  PrototypeState,
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceRole,
  TariffMatrix,
} from "./models";
import {
  isNewerState,
  isPrototypeState,
  LEGACY_V2_PROTOTYPE_STORAGE_KEY,
  LEGACY_V3_PROTOTYPE_STORAGE_KEY,
  LEGACY_V4_PROTOTYPE_STORAGE_KEY,
  LEGACY_V5_PROTOTYPE_STORAGE_KEY,
  LEGACY_V6_PROTOTYPE_STORAGE_KEY,
  normalizePrototypeState,
  parseLegacyStoredState,
  parseStoredState,
  PROTOTYPE_CHANNEL_NAME,
  PROTOTYPE_SAVE_FAILED_ERROR,
  PROTOTYPE_STORAGE_KEY,
  SAFE_TAB_SYNC_UNAVAILABLE_ERROR,
  executeSerializedPrototypeMutation,
} from "./prototype-store";

/** Общее имя Web Lock для сериализации мутаций заказа между вкладками. */
const PROTOTYPE_MUTATION_LOCK_NAME = "direct-prototype-state-v7-mutation";

/** Результат сериализованной state-only мутации (Исправление 2.2). */
export type MutationAck = Promise<{ ok: boolean; error: string | null }>;

interface PrototypeContextValue {
  state: PrototypeState;
  isHydrated: boolean;
  addItem: (
    menuItemId: string,
    variantId?: string | null,
    replaceRestaurant?: boolean,
  ) => Promise<AddCartItemResult>;
  setItemQuantity: (
    menuItemId: string,
    variantId: string | null,
    quantity: number,
  ) => MutationAck;
  setItemComment: (
    menuItemId: string,
    variantId: string | null,
    comment: string,
  ) => MutationAck;
  updateAddress: (patch: Partial<Omit<DeliveryAddress, "zoneId">>) => MutationAck;
  updateCustomer: (
    patch: Partial<Pick<PrototypeState["customer"], "name" | "phone">>,
  ) => MutationAck;
  setPaymentMethod: (paymentMethod: PaymentMethod) => MutationAck;
  setFulfillmentChoice: (fulfillmentChoice: FulfillmentChoice) => MutationAck;
  createOrder: () => Promise<CreateOrderResult>;
  repeatOrder: (orderId: string) => Promise<RepeatOrderResult>;
  cancelClientOrder: (
    orderId: string,
    reason: string,
  ) => Promise<ClientCancelResult>;
  requestCancellation: (
    orderId: string,
    reason: string,
  ) => Promise<RequestCancellationResult>;
  approveCancellation: (
    requestId: string,
    note: string,
  ) => Promise<AdminActionResult>;
  rejectCancellation: (
    requestId: string,
    note: string,
  ) => Promise<AdminActionResult>;
  pauseRestaurant: (
    restaurantId: string,
    reason: string,
    mode: OperationalPauseMode,
    resumeAt: string | null,
    actor: OperationalActor,
  ) => Promise<OperationalActionResult>;
  resumeRestaurant: (
    restaurantId: string,
    actor: OperationalActor,
  ) => Promise<OperationalActionResult>;
  setMenuItemUnavailable: (
    restaurantId: string,
    menuItemId: string,
    reason: string,
    mode: OperationalPauseMode,
    resumeAt: string | null,
    actor: OperationalActor,
  ) => Promise<OperationalActionResult>;
  restoreMenuItem: (
    restaurantId: string,
    menuItemId: string,
    actor: OperationalActor,
  ) => Promise<OperationalActionResult>;
  pauseCategory: (
    restaurantId: string,
    category: string,
    reason: string,
    mode: OperationalPauseMode,
    resumeAt: string | null,
    actor: OperationalActor,
  ) => Promise<BulkOperationalResult>;
  restoreCategory: (
    restaurantId: string,
    category: string,
    actor: OperationalActor,
  ) => Promise<BulkOperationalResult>;
  acceptOrder: (
    orderId: string,
    preparationMinutes: number,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<AcceptRestaurantOrderResult>;
  rejectOrder: (
    orderId: string,
    reason: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<RejectRestaurantOrderResult>;
  simulateOnlinePayment: (orderId: string) => MutationAck;
  markReady: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAck;
  adjustOrderEta: (
    orderId: string,
    intent: EtaAdjustmentIntent,
    reason: string,
    actor?: "RESTAURANT" | "ADMIN",
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<AdjustOrderEtaResult>;
  reportPreparationProblem: (
    orderId: string,
    reason: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<PreparationProblemResult>;
  completePickup: (
    orderId: string,
    code: string,
    paidWith: PickupPaymentMethod,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<CompletePickupResult>;
  markPickupNoShow: (
    orderId: string,
    reason: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<PickupNoShowResult>;
  setRestaurantWorkflow: (
    restaurantId: string,
    mode: RestaurantOrderWorkflowMode,
  ) => MutationAck;
  markOutForDelivery: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAck;
  markArriving: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAck;
  markDelivered: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAck;
  markDeliveredByDriver: (orderId: string) => MutationAck;
  setPreparationMinutes: (orderId: string, minutes: number) => MutationAck;
  setRestaurantAccepting: (
    restaurantId: string,
    accepting: boolean,
  ) => MutationAck;
  assignDriver: (
    orderId: string,
    driverId: string,
  ) => Promise<AdminActionResult>;
  reassignDriver: (
    orderId: string,
    newDriverId: string,
    reason: string,
  ) => Promise<AdminActionResult>;
  unassignDriver: (
    orderId: string,
    reason: string,
  ) => Promise<AdminActionResult>;
  cancelOrderByAdmin: (
    orderId: string,
    reason: string,
  ) => Promise<AdminActionResult>;
  correctStatus: (
    orderId: string,
    newStatus: OrderStatus,
    reason: string,
  ) => Promise<AdminActionResult>;
  issuePickupNoCode: (
    orderId: string,
    reason: string,
    paidWith: PickupPaymentMethod,
  ) => Promise<AdminActionResult>;
  saveTariffMatrix: (tariffs: TariffMatrix) => MutationAck;
  restoreTariffs: () => MutationAck;
  createRestaurantEntry: (
    input: RestaurantFormInput,
  ) => Promise<CreateRestaurantResult>;
  updateRestaurantEntry: (
    restaurantId: string,
    patch: Partial<RestaurantFormInput>,
  ) => Promise<UpdateRestaurantResult>;
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

  /** Запись состояния в localStorage; исключение — транзакция НЕ успешна. */
  const persistState = useCallback((nextState: PrototypeState) => {
    window.localStorage.setItem(
      PROTOTYPE_STORAGE_KEY,
      JSON.stringify(nextState),
    );
  }, []);

  const broadcastState = useCallback((nextState: PrototypeState) => {
    channelRef.current?.postMessage({
      sourceId: sourceIdRef.current,
      state: nextState,
    } satisfies PrototypeChannelMessage);
  }, []);

  /**
   * Исправление 1–3: ЕДИНСТВЕННЫЙ путь сохранения изменённого PrototypeState.
   * BroadcastChannel — не блокировка: две вкладки могут одновременно мутировать
   * одну ревизию N, и поздний updatedAt молча перезапишет чужую операцию. Поэтому
   * каждая сохраняемая мутация выполняется под общим Web Lock: внутри lock
   * перечитывается авторитетный persisted state, мутация применяется к самому
   * свежему base (executeSerializedPrototypeMutation), результат СНАЧАЛА
   * записывается в localStorage, и только затем принимается локально и
   * рассылается — до освобождения lock. Ошибка записи возвращает русскую
   * инфраструктурную ошибку без ложного успеха. Без Web Locks критические
   * lifecycle-мутации работают fail-closed (никакого spin-lock/busy-wait);
   * production-backend заменит это серверной транзакцией и optimistic
   * concurrency по ревизии.
   */
  const runSerializedActionMutation = useCallback(
    async <T,>({
      mutation,
      infrastructureFailure,
      critical = true,
    }: {
      mutation: (
        baseState: PrototypeState,
      ) => { state: PrototypeState; result: T };
      infrastructureFailure: (error: string) => T;
      critical?: boolean;
    }): Promise<T> => {
      const execute = (): T => {
        const stored = parseStoredState(
          window.localStorage.getItem(PROTOTYPE_STORAGE_KEY),
        );
        try {
          const outcome = executeSerializedPrototypeMutation({
            localState: stateRef.current,
            storedState: stored,
            mutation,
            persist: persistState,
            broadcast: broadcastState,
          });
          if (outcome.nextState !== stateRef.current) {
            // Принимаем локально либо rebased base, либо уже СОХРАНЁННЫЙ результат.
            stateRef.current = outcome.nextState;
            setState(outcome.nextState);
          }
          return outcome.result;
        } catch {
          // localStorage.setItem бросил: state не подтверждён — не принимаем его
          // и не объявляем успех.
          return infrastructureFailure(PROTOTYPE_SAVE_FAILED_ERROR);
        }
      };

      const locks =
        typeof navigator !== "undefined" ? navigator.locks : undefined;
      if (locks?.request) {
        try {
          return await locks.request(
            PROTOTYPE_MUTATION_LOCK_NAME,
            async () => execute(),
          );
        } catch {
          return infrastructureFailure(PROTOTYPE_SAVE_FAILED_ERROR);
        }
      }
      if (critical) {
        // Исправление 7: без Web Locks конкурентную запись честно блокируем.
        return infrastructureFailure(SAFE_TAB_SYNC_UNAVAILABLE_ERROR);
      }
      return execute();
    },
    [broadcastState, persistState],
  );

  /**
   * Исправление 2.2: обёртка для legacy-функций вида (state) => PrototypeState.
   * No-op не увеличивает revision и ничего не записывает.
   */
  const runSerializedStateMutation = useCallback(
    ({
      mutation,
      critical = true,
    }: {
      mutation: (baseState: PrototypeState) => PrototypeState;
      critical?: boolean;
    }): Promise<{ ok: boolean; error: string | null }> =>
      runSerializedActionMutation<{ ok: boolean; error: string | null }>({
        mutation: (baseState) => ({
          state: mutation(baseState),
          result: { ok: true, error: null },
        }),
        infrastructureFailure: (error) => ({ ok: false, error }),
        critical,
      }),
    [runSerializedActionMutation],
  );

  useEffect(() => {
    sourceIdRef.current = crypto.randomUUID();

    const storedV7State = parseStoredState(
      window.localStorage.getItem(PROTOTYPE_STORAGE_KEY),
    );
    const storedState =
      storedV7State ??
      parseLegacyStoredState(
        window.localStorage.getItem(LEGACY_V6_PROTOTYPE_STORAGE_KEY),
      ) ??
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
        // Исправление 4: одноразовый bootstrap миграции. Если v7-ключа не было,
        // а состояние пришло из legacy-версии — сохраняем его как v7 один раз.
        // Более свежий уже существующий v7 state НЕ перезаписывается.
        if (!storedV7State) {
          try {
            window.localStorage.setItem(
              PROTOTYPE_STORAGE_KEY,
              JSON.stringify(storedState),
            );
          } catch {
            // Гидратация не должна падать из-за недоступного хранилища.
          }
        }
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

  // Исправление 4: опасный безусловный persistence-effect УДАЛЁН. Транзакционные
  // мутации сами записывают state внутри Web Lock; входящие storage/Broadcast-
  // обновления только обновляют локальное представление и не пишутся обратно.

  // Исправление 6: системный maintenance sweep (автоотмена 7 минут + снятие
  // истёкших пауз) идёт через ТОТ ЖЕ общий Web Lock: внутри перечитывается
  // свежий persisted state, обе функции применяются последовательно, запись —
  // только при фактическом изменении. Повторный sweep не стартует поверх уже
  // выполняющегося; принятие/отклонение заказа перезаписать он не может.
  const sweepInFlightRef = useRef(false);
  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    const sweep = async () => {
      if (sweepInFlightRef.current) {
        return;
      }
      sweepInFlightRef.current = true;
      try {
        await runSerializedStateMutation({
          mutation: (baseState) => {
            const nowIso = new Date().toISOString();
            let next = expireUnansweredRestaurantOrders(baseState, nowIso);
            next = resumeExpiredOperationalPauses(next, nowIso);
            return next;
          },
        });
      } finally {
        sweepInFlightRef.current = false;
      }
    };
    void sweep();
    const intervalId = window.setInterval(() => void sweep(), 5000);
    return () => window.clearInterval(intervalId);
  }, [isHydrated, runSerializedStateMutation]);

  const addItem = useCallback(
    (
      menuItemId: string,
      variantId: string | null = null,
      replaceRestaurant = false,
    ) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          addCartItem(baseState, menuItemId, variantId, replaceRestaurant),
        // Инфраструктурный сбой отображается как недоступность позиции.
        infrastructureFailure: () => "NOT_AVAILABLE" as const,
      }),
    [runSerializedActionMutation],
  );

  const setItemQuantity = useCallback(
    (menuItemId: string, variantId: string | null, quantity: number) =>
      runSerializedStateMutation({
        mutation: (baseState) => setCartItemQuantity(baseState, menuItemId, variantId, quantity),
      }),
    [runSerializedStateMutation],
  );

  const setItemComment = useCallback(
    (menuItemId: string, variantId: string | null, comment: string) =>
      runSerializedStateMutation({
        mutation: (baseState) => setCartItemComment(baseState, menuItemId, variantId, comment),
      }),
    [runSerializedStateMutation],
  );

  const updateAddress = useCallback(
    (patch: Partial<Omit<DeliveryAddress, "zoneId">>) =>
      runSerializedStateMutation({
        mutation: (baseState) => updateCartAddress(baseState, patch),
      }),
    [runSerializedStateMutation],
  );

  const updateCustomer = useCallback(
    (patch: Partial<Pick<PrototypeState["customer"], "name" | "phone">>) =>
      runSerializedStateMutation({
        mutation: (baseState) => updateCustomerProfile(baseState, patch),
      }),
    [runSerializedStateMutation],
  );

  const setPaymentMethod = useCallback(
    (paymentMethod: PaymentMethod) =>
      runSerializedStateMutation({
        mutation: (baseState) => setCartPaymentMethod(baseState, paymentMethod),
      }),
    [runSerializedStateMutation],
  );

  const setFulfillmentChoice = useCallback(
    (fulfillmentChoice: FulfillmentChoice) =>
      runSerializedStateMutation({
        mutation: (baseState) => setCartFulfillmentChoice(baseState, fulfillmentChoice),
      }),
    [runSerializedStateMutation],
  );

  const createOrder = useCallback(
    () =>
      // Критично: две клиентские вкладки не должны создать одинаковый orderId
      // или publicNumber — nextOrderNumber растёт только под общим lock.
      runSerializedActionMutation({
        mutation: (baseState) => createOrderFromCart(baseState),
        infrastructureFailure: (error) => ({ orderId: null, error }),
      }),
    [runSerializedActionMutation],
  );

  const repeatOrder = useCallback(
    (orderId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) => repeatOrderToCart(baseState, orderId),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          unavailableItems: [],
          pricesChanged: false,
          fulfillmentChanged: false,
        }),
      }),
    [runSerializedActionMutation],
  );

  const cancelClientOrder = useCallback(
    (orderId: string, reason: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          cancelOrderByClient(baseState, orderId, reason),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const requestCancellation = useCallback(
    (orderId: string, reason: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          requestOrderCancellationByClient(
            baseState,
            orderId,
            reason,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const approveCancellation = useCallback(
    (requestId: string, note: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          approveCancellationRequest(
            baseState,
            requestId,
            note,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const rejectCancellation = useCallback(
    (requestId: string, note: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          rejectCancellationRequest(
            baseState,
            requestId,
            note,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const pauseRestaurant = useCallback(
    (
      restaurantId: string,
      reason: string,
      mode: OperationalPauseMode,
      resumeAt: string | null,
      actor: OperationalActor,
    ) => {
      return runSerializedActionMutation({
        mutation: (baseState) =>
          pauseRestaurantOrders(
            baseState,
            restaurantId,
            reason,
            mode,
            resumeAt,
            actor,
            // Экран паузы — кухонный; в COMBINED роль резолвится в COMBINED.
            "KITCHEN",
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  const resumeRestaurant = useCallback(
    (restaurantId: string, actor: OperationalActor) => {
      return runSerializedActionMutation({
        mutation: (baseState) =>
          resumeRestaurantOrders(baseState, restaurantId, actor, "", "KITCHEN"),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  const setMenuItemUnavailable = useCallback(
    (
      restaurantId: string,
      menuItemId: string,
      reason: string,
      mode: OperationalPauseMode,
      resumeAt: string | null,
      actor: OperationalActor,
    ) => {
      return runSerializedActionMutation({
        mutation: (baseState) =>
          setMenuItemOperationallyUnavailable(
            baseState,
            restaurantId,
            menuItemId,
            reason,
            mode,
            resumeAt,
            actor,
            "KITCHEN",
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  const restoreMenuItem = useCallback(
    (restaurantId: string, menuItemId: string, actor: OperationalActor) => {
      return runSerializedActionMutation({
        mutation: (baseState) =>
          restoreMenuItemAvailability(
            baseState,
            restaurantId,
            menuItemId,
            actor,
            "",
            "KITCHEN",
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  const pauseCategory = useCallback(
    (
      restaurantId: string,
      category: string,
      reason: string,
      mode: OperationalPauseMode,
      resumeAt: string | null,
      actor: OperationalActor,
    ) => {
      return runSerializedActionMutation({
        mutation: (baseState) =>
          pauseCategoryItems(
            baseState,
            restaurantId,
            category,
            reason,
            mode,
            resumeAt,
            actor,
            "KITCHEN",
          ),
        infrastructureFailure: (error) => ({ ok: false, error, affected: 0 }),
      });
    },
    [runSerializedActionMutation],
  );

  const restoreCategory = useCallback(
    (restaurantId: string, category: string, actor: OperationalActor) => {
      return runSerializedActionMutation({
        mutation: (baseState) =>
          restoreCategoryItems(baseState, restaurantId, category, actor, "KITCHEN"),
        infrastructureFailure: (error) => ({ ok: false, error, affected: 0 }),
      });
    },
    [runSerializedActionMutation],
  );

  const acceptOrder = useCallback(
    (
      orderId: string,
      preparationMinutes: number,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          acceptRestaurantOrderWithResult(
            baseState,
            orderId,
            preparationMinutes,
            actor,
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const rejectOrder = useCallback(
    (
      orderId: string,
      reason: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          rejectRestaurantOrderWithResult(
            baseState,
            orderId,
            reason,
            actor,
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const simulateOnlinePayment = useCallback(
    (orderId: string) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          simulateSuccessfulOnlinePayment(baseState, orderId),
      }),
    [runSerializedStateMutation],
  );

  const markReady = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          markOrderReady(baseState, orderId, actor, workspaceRole),
      }),
    [runSerializedStateMutation],
  );

  const adjustOrderEta = useCallback(
    (
      orderId: string,
      intent: EtaAdjustmentIntent,
      reason: string,
      actor: "RESTAURANT" | "ADMIN" = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) => {
      // §1: один общий nowIso и для расчёта из intent, и для валидации.
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          adjustOrderEtaFromIntent(
            baseState,
            orderId,
            intent,
            reason,
            actor,
            nowIso,
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          previousExpectedReadyAt: null,
          nextExpectedReadyAt: null,
        }),
      });
    },
    [runSerializedActionMutation],
  );

  const reportPreparationProblem = useCallback(
    (
      orderId: string,
      reason: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) => {
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          reportRestaurantPreparationProblem(
            baseState,
            orderId,
            reason,
            actor,
            nowIso,
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  const completePickup = useCallback(
    (
      orderId: string,
      code: string,
      paidWith: PickupPaymentMethod,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) => {
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          completePickupWithCode(
            baseState,
            orderId,
            code,
            paidWith,
            actor,
            nowIso,
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          paidWith: null,
        }),
      });
    },
    [runSerializedActionMutation],
  );

  const markPickupNoShow = useCallback(
    (
      orderId: string,
      reason: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) => {
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          runPickupNoShow(
            baseState,
            orderId,
            reason,
            actor,
            nowIso,
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          eligibleAt: null,
        }),
      });
    },
    [runSerializedActionMutation],
  );

  const setRestaurantWorkflow = useCallback(
    (restaurantId: string, mode: RestaurantOrderWorkflowMode) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          setRestaurantWorkflowMode(baseState, restaurantId, mode),
      }),
    [runSerializedStateMutation],
  );

  const markOutForDelivery = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          markOrderOutForDelivery(baseState, orderId, actor, workspaceRole),
      }),
    [runSerializedStateMutation],
  );

  const markArriving = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          markOrderArriving(baseState, orderId, actor, workspaceRole),
      }),
    [runSerializedStateMutation],
  );

  const markDelivered = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          markOrderDelivered(baseState, orderId, actor, workspaceRole),
      }),
    [runSerializedStateMutation],
  );

  const markDeliveredByDriver = useCallback(
    (orderId: string) =>
      runSerializedStateMutation({
        mutation: (baseState) => markOrderDeliveredByDriver(baseState, orderId),
      }),
    [runSerializedStateMutation],
  );

  const setPreparationMinutes = useCallback(
    (orderId: string, minutes: number) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          adminSetPreparationMinutes(baseState, orderId, minutes),
      }),
    [runSerializedStateMutation],
  );

  const setRestaurantAccepting = useCallback(
    (restaurantId: string, accepting: boolean) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          setRestaurantAcceptingOrders(baseState, restaurantId, accepting),
      }),
    [runSerializedStateMutation],
  );

  const runAdminOrderAction = useCallback(
    (
      action: (state: PrototypeState) => {
        state: PrototypeState;
        result: AdminActionResult;
      },
    ): Promise<AdminActionResult> =>
      runSerializedActionMutation({
        mutation: action,
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
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
    (orderId: string, reason: string, paidWith: PickupPaymentMethod) =>
      runAdminOrderAction((s) =>
        issuePickupWithoutCode(
          s,
          orderId,
          reason,
          paidWith,
          new Date().toISOString(),
        ),
      ),
    [runAdminOrderAction],
  );

  const saveTariffMatrix = useCallback(
    (tariffs: TariffMatrix) =>
      runSerializedStateMutation({
        mutation: (baseState) => saveTariffs(baseState, tariffs),
      }),
    [runSerializedStateMutation],
  );

  const restoreTariffs = useCallback(
    () =>
      runSerializedStateMutation({
        mutation: (baseState) => restoreDefaultTariffs(baseState),
      }),
    [runSerializedStateMutation],
  );

  const createRestaurantEntry = useCallback(
    (input: RestaurantFormInput) =>
      runSerializedActionMutation({
        mutation: (baseState) => createRestaurant(baseState, input),
        infrastructureFailure: (error) => ({ restaurantId: null, error }),
      }),
    [runSerializedActionMutation],
  );

  const updateRestaurantEntry = useCallback(
    (restaurantId: string, patch: Partial<RestaurantFormInput>) =>
      runSerializedActionMutation({
        mutation: (baseState) => updateRestaurant(baseState, restaurantId, patch),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const setMenuItemVariants = useCallback(
    (menuItemId: string, variants: MenuItemVariant[] | null) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          updateMenuItemVariants(baseState, menuItemId, variants),
      }),
    [runSerializedStateMutation],
  );

  const savePromotion = useCallback(
    (promotion: Promotion) =>
      runSerializedStateMutation({
        mutation: (baseState) => upsertPromotion(baseState, promotion),
      }),
    [runSerializedStateMutation],
  );

  const togglePromotion = useCallback(
    (promotionId: string, enabled: boolean) =>
      runSerializedStateMutation({
        mutation: (baseState) =>
          setPromotionEnabled(baseState, promotionId, enabled),
      }),
    [runSerializedStateMutation],
  );

  const resetPrototype = useCallback(
    () =>
      runSerializedStateMutation({
        mutation: (baseState) => resetPrototypeState(baseState),
      }),
    [runSerializedStateMutation],
  );

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
      requestCancellation,
      approveCancellation,
      rejectCancellation,
      pauseRestaurant,
      resumeRestaurant,
      setMenuItemUnavailable,
      restoreMenuItem,
      pauseCategory,
      restoreCategory,
      acceptOrder,
      rejectOrder,
      simulateOnlinePayment,
      markReady,
      adjustOrderEta,
      reportPreparationProblem,
      completePickup,
      markPickupNoShow,
      markOutForDelivery,
      markArriving,
      markDelivered,
      markDeliveredByDriver,
      setPreparationMinutes,
      setRestaurantAccepting,
      setRestaurantWorkflow,
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
      requestCancellation,
      approveCancellation,
      rejectCancellation,
      pauseRestaurant,
      resumeRestaurant,
      setMenuItemUnavailable,
      restoreMenuItem,
      pauseCategory,
      restoreCategory,
      acceptOrder,
      rejectOrder,
      simulateOnlinePayment,
      markReady,
      adjustOrderEta,
      reportPreparationProblem,
      completePickup,
      markPickupNoShow,
      markOutForDelivery,
      markArriving,
      markDelivered,
      markDeliveredByDriver,
      setPreparationMinutes,
      setRestaurantAccepting,
      setRestaurantWorkflow,
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
