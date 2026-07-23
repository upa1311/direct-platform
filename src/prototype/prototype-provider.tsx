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
  approveCancellationRequest,
  assignDriverToOrder,
  cancelOrderByClient,
  completePickupAtRestaurant,
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
  adminSetPreparationMinutesWithResult,
  changeDriverZone,
  confirmDriverZone,
  goDriverOffline,
  goDriverOnline,
  pauseDriver,
  resumeDriver,
  type DriverActionResult,
  markOrderArrivingWithResult,
  markOrderDeliveredWithResult,
  markOrderOutForDeliveryWithResult,
  markOrderReadyWithResult,
  markPickupNoShow as runPickupNoShow,
  reportRestaurantPreparationProblem,
  resolveRestaurantPreparationProblem,
  approveMenuItemSubmission,
  createMenuItemSubmissionDraft,
  rejectMenuItemSubmission,
  submitMenuItemSubmission,
  updateMenuItemSubmissionDraft,
  type MenuItemSubmissionDraftPatch,
  type MenuItemSubmissionResult,
  setRestaurantWorkflowModeWithResult,
  simulateSuccessfulOnlinePaymentWithResult,
  startKitchenPreparationWithResult,
  setRestaurantAcceptingOrdersWithResult,
  reassignDriverForOrder,
  rejectCancellationRequest,
  rejectRestaurantOrderWithResult,
  repeatOrderToCart,
  requestOrderCancellationByClient,
  requestOrderCancellationByRestaurant,
  resetPrototypeState,
  restoreDefaultTariffs,
  saveTariffs,
  setCartFulfillmentChoice,
  setCartItemComment,
  setCartItemQuantity,
  setCartPaymentMethod,
  setPromotionEnabled,
  unassignDriverFromOrder,
  updateCartAddress,
  updateCustomerProfile,
  updateMenuItemVariants,
  updateRestaurant,
  upsertPromotion,
  type AcceptRestaurantOrderResult,
  type ActionResult,
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
  type OrderTransitionResult,
  type PickupNoShowResult,
  type PreparationProblemResult,
  type RejectRestaurantOrderResult,
  type RepeatOrderResult,
  type RequestCancellationResult,
  type RestaurantFormInput,
  type UpdateRestaurantResult,
} from "./actions";
import {
  acceptDriverOffer,
  declineDriverOffer,
  reconcileDriverOffers,
  type AcceptDriverOfferInput,
  type DriverOfferActionResult,
  type ReconcileDriverOffersResult,
} from "./driver-offers";
import {
  reportDriverCashHandoffToRestaurant,
  confirmRestaurantDriverCashReceipt,
  type PlatformDriverCashHandoffActionResult,
} from "./platform-driver-cash-handoff";
import {
  markDriverArrivedAtRestaurant,
  markDriverArrivingToCustomer,
  markDriverDeliveredOrder,
  markDriverPickedUpOrder,
  type DriverDeliveryActionResult,
} from "./driver-delivery";
import {
  resolveRestaurantAccountingEntry,
  type RestaurantAccountingOutcome,
  type RestaurantAccountingResolutionResult,
} from "./restaurant-accounting";
import {
  confirmFullRestaurantSettlement,
  confirmRestaurantSettlement,
  type ConfirmFullRestaurantSettlementInput,
  type ConfirmRestaurantSettlementInput,
  type FullRestaurantSettlementConfirmResult,
  type RestaurantSettlementConfirmResult,
} from "./restaurant-settlement-records";
import type { EtaAdjustmentIntent } from "./order-eta";
import {
  closePrototypeChannel,
  createPrototypeSourceId,
  getPrototypeLockManager,
  openPrototypeChannel,
} from "./browser-adapters";
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
  ZoneId,
} from "./models";
import {
  isNewerState,
  isPrototypeState,
  normalizePrototypeState,
  parseStoredState,
  PROTOTYPE_CHANNEL_NAME,
  PROTOTYPE_SAVE_FAILED_ERROR,
  PROTOTYPE_STORAGE_KEY,
  SAFE_TAB_SYNC_UNAVAILABLE_ERROR,
  executeSerializedPrototypeMutation,
  readLegacyPrototypeState,
  resolveBootstrapState,
  safeReadStoredState,
  type MutationAck,
} from "./prototype-store";

/** Общее имя Web Lock для сериализации мутаций заказа между вкладками. */
const PROTOTYPE_MUTATION_LOCK_NAME = "direct-prototype-state-v7-mutation";

/** Исправление 2: подтверждение сериализованной мутации (см. prototype-store). */
export type { MutationAck } from "./prototype-store";

/** Promise-подтверждение мутации в API провайдера. */
type MutationAckPromise = Promise<MutationAck>;

export interface PrototypeContextValue {
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
  ) => MutationAckPromise;
  setItemComment: (
    menuItemId: string,
    variantId: string | null,
    comment: string,
  ) => MutationAckPromise;
  updateAddress: (patch: Partial<Omit<DeliveryAddress, "zoneId">>) => MutationAckPromise;
  updateCustomer: (
    patch: Partial<Pick<PrototypeState["customer"], "name" | "phone">>,
  ) => MutationAckPromise;
  setPaymentMethod: (paymentMethod: PaymentMethod) => MutationAckPromise;
  setFulfillmentChoice: (fulfillmentChoice: FulfillmentChoice) => MutationAckPromise;
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
  /**
   * Доступность меню ведут все три ресторанные роли. Реальная роль приходит от
   * экрана и попадает в аудит: операторское действие не записывается как KITCHEN.
   */
  setMenuItemUnavailable: (
    restaurantId: string,
    menuItemId: string,
    reason: string,
    mode: OperationalPauseMode,
    resumeAt: string | null,
    actor: OperationalActor,
    workspaceRole: RestaurantWorkspaceRole,
  ) => Promise<OperationalActionResult>;
  restoreMenuItem: (
    restaurantId: string,
    menuItemId: string,
    actor: OperationalActor,
    workspaceRole: RestaurantWorkspaceRole,
  ) => Promise<OperationalActionResult>;
  pauseCategory: (
    restaurantId: string,
    category: string,
    reason: string,
    mode: OperationalPauseMode,
    resumeAt: string | null,
    actor: OperationalActor,
    workspaceRole: RestaurantWorkspaceRole,
  ) => Promise<BulkOperationalResult>;
  restoreCategory: (
    restaurantId: string,
    category: string,
    actor: OperationalActor,
    workspaceRole: RestaurantWorkspaceRole,
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
  simulateOnlinePayment: (orderId: string) => MutationAckPromise;
  markReady: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAckPromise;
  startKitchenPreparation: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAckPromise;
  /** Каталог блюд: заявка ресторана и модерация Direct. */
  createMenuItemDraft: (
    restaurantId: string,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<MenuItemSubmissionResult>;
  updateMenuItemDraft: (
    submissionId: string,
    patch: MenuItemSubmissionDraftPatch,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<MenuItemSubmissionResult>;
  submitMenuItemDraft: (
    submissionId: string,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<MenuItemSubmissionResult>;
  approveMenuItemDraft: (
    submissionId: string,
  ) => Promise<MenuItemSubmissionResult>;
  rejectMenuItemDraft: (
    submissionId: string,
    reason: string,
  ) => Promise<MenuItemSubmissionResult>;
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
  resolvePreparationProblem: (
    orderId: string,
    preparationProblemId: string,
    reason: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<PreparationProblemResult>;
  requestRestaurantCancellation: (
    orderId: string,
    preparationProblemId: string,
    reason: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => Promise<RequestCancellationResult>;
  resolveAccountingEntry: (
    entryId: string,
    outcome: RestaurantAccountingOutcome,
    note: string,
    externalReference: string | null,
  ) => Promise<RestaurantAccountingResolutionResult>;
  /**
   * Групповой закрытый расчёт: одна запись RestaurantSettlementRecord на набор
   * выбранных открытых обязательств. Доменное действие внутри lock заново
   * строит канонический preview — UI-preview авторитетным не считается.
   */
  confirmSettlement: (
    input: Omit<ConfirmRestaurantSettlementInput, "nowIso">,
  ) => Promise<RestaurantSettlementConfirmResult>;
  /**
   * Полный расчёт всей открытой позиции ресторана (v15). Момент отсечки
   * создаётся ВНУТРИ сериализованной мутации над свежим состоянием — UI его не
   * передаёт, иначе закрывалась бы позиция на момент открытия экрана.
   */
  confirmFullSettlement: (
    input: ConfirmFullRestaurantSettlementInput,
  ) => Promise<FullRestaurantSettlementConfirmResult>;
  /** Выдача самовывоза после фактической оплаты на точке; код не требуется. */
  completePickup: (
    orderId: string,
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
  ) => MutationAckPromise;
  markOutForDelivery: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAckPromise;
  markArriving: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAckPromise;
  markDelivered: (
    orderId: string,
    actor?: OrderActionActor,
    workspaceRole?: RestaurantWorkspaceRole,
  ) => MutationAckPromise;
  /**
   * Рабочий путь назначенного водителя Direct (v18). Идентичность водителя
   * проверяется доменом на свежем state; identity-less завершение по одному
   * orderId в API провайдера намеренно отсутствует.
   */
  driverArriveAtRestaurant: (
    driverId: string,
    orderId: string,
  ) => Promise<DriverDeliveryActionResult>;
  driverPickUpOrder: (
    driverId: string,
    orderId: string,
  ) => Promise<DriverDeliveryActionResult>;
  driverMarkArriving: (
    driverId: string,
    orderId: string,
  ) => Promise<DriverDeliveryActionResult>;
  driverCompleteDelivery: (
    driverId: string,
    orderId: string,
  ) => Promise<DriverDeliveryActionResult>;
  setPreparationMinutes: (orderId: string, minutes: number) => MutationAckPromise;
  setRestaurantAccepting: (
    restaurantId: string,
    accepting: boolean,
  ) => MutationAckPromise;
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
  saveTariffMatrix: (tariffs: TariffMatrix) => MutationAckPromise;
  restoreTariffs: () => MutationAckPromise;
  /**
   * Кабинет водителя (v16). Зона всегда передаётся явно: система её не
   * определяет. BUSY_DIRECT ни одним из этих действий не снимается — он
   * принадлежит жизненному циклу назначения заказа.
   */
  driverGoOnline: (
    driverId: string,
    zoneId: ZoneId,
  ) => Promise<DriverActionResult>;
  driverPause: (driverId: string) => Promise<DriverActionResult>;
  driverResume: (driverId: string) => Promise<DriverActionResult>;
  driverGoOffline: (driverId: string) => Promise<DriverActionResult>;
  driverChangeZone: (
    driverId: string,
    zoneId: ZoneId,
  ) => Promise<DriverActionResult>;
  driverConfirmZone: (
    driverId: string,
    zoneId: ZoneId,
    nextAvailability: "AVAILABLE" | "PAUSED",
  ) => Promise<DriverActionResult>;
  /**
   * Актуализация предложений (v17): истёкшие закрываются, невалидные
   * отменяются, подходящим водителям создаются новые. Момент времени берётся
   * внутри мутации; UI сам driverOffers не меняет.
   */
  refreshDriverOffers: () => Promise<ReconcileDriverOffersResult>;
  driverAcceptOffer: (
    driverId: string,
    offerId: string,
    input: AcceptDriverOfferInput,
  ) => Promise<DriverOfferActionResult>;
  driverDeclineOffer: (
    driverId: string,
    offerId: string,
  ) => Promise<DriverOfferActionResult>;
  /** Водитель сообщает, что передал ресторану наличные (v21). Сумма — из snapshot. */
  driverReportCashHandoffToRestaurant: (
    driverId: string,
    orderId: string,
  ) => Promise<PlatformDriverCashHandoffActionResult>;
  /** Ресторан подтверждает фактическое получение наличных от водителя (v21). */
  restaurantConfirmDriverCashReceipt: (
    restaurantId: string,
    orderId: string,
    workspaceRole: RestaurantWorkspaceRole,
  ) => Promise<PlatformDriverCashHandoffActionResult>;
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
  ) => MutationAckPromise;
  savePromotion: (promotion: Promotion) => MutationAckPromise;
  togglePromotion: (
    promotionId: string,
    enabled: boolean,
  ) => MutationAckPromise;
  resetPrototype: () => MutationAckPromise;
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
  const runSerializedMutationCore = useCallback(
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
    }): Promise<{ result: T; committed: boolean }> => {
      const execute = (): { result: T; committed: boolean } => {
        // Исправление 1.2: чтение хранилища не должно бросать (SecurityError и
        // пр.) — при недоступном чтении мутация работает от локального base, а
        // недоступная ЗАПИСЬ честно завершит транзакцию инфраструктурной ошибкой.
        const stored = safeReadStoredState(PROTOTYPE_STORAGE_KEY);
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
          return { result: outcome.result, committed: outcome.committed };
        } catch {
          // localStorage.setItem бросил: state не подтверждён — не принимаем его
          // и не объявляем успех.
          return {
            result: infrastructureFailure(PROTOTYPE_SAVE_FAILED_ERROR),
            committed: false,
          };
        }
      };

      // Этап 4.3: доступ к LockManager защищён; недоступный Web Locks не роняет
      // страницу — критическая мутация возвращает fail-closed ошибку ниже.
      const locks = getPrototypeLockManager();
      if (locks) {
        try {
          return await locks.request(
            PROTOTYPE_MUTATION_LOCK_NAME,
            async () => execute(),
          );
        } catch {
          return {
            result: infrastructureFailure(PROTOTYPE_SAVE_FAILED_ERROR),
            committed: false,
          };
        }
      }
      if (critical) {
        // Исправление 7: без Web Locks конкурентную запись честно блокируем.
        return {
          result: infrastructureFailure(SAFE_TAB_SYNC_UNAVAILABLE_ERROR),
          committed: false,
        };
      }
      return execute();
    },
    [broadcastState, persistState],
  );

  const runSerializedActionMutation = useCallback(
    async <T,>(options: {
      mutation: (
        baseState: PrototypeState,
      ) => { state: PrototypeState; result: T };
      infrastructureFailure: (error: string) => T;
      critical?: boolean;
    }): Promise<T> => (await runSerializedMutationCore(options)).result,
    [runSerializedMutationCore],
  );

  /**
   * Исправление 2.2: обёртка для legacy-функций вида (state) => PrototypeState.
   * Ack строится ПОСЛЕ транзакции из фактического outcome.committed: успешное
   * изменение → changed:true; допустимый идемпотентный no-op → ok:true,
   * changed:false; инфраструктурная ошибка → ok:false + русская ошибка.
   */
  const runSerializedStateMutation = useCallback(
    async ({
      mutation,
      critical = true,
    }: {
      mutation: (baseState: PrototypeState) => PrototypeState;
      critical?: boolean;
    }): Promise<MutationAck> => {
      const outcome = await runSerializedMutationCore<string | null>({
        mutation: (baseState) => ({
          state: mutation(baseState),
          result: null,
        }),
        infrastructureFailure: (error) => error,
        critical,
      });
      return outcome.result !== null
        ? { ok: false, error: outcome.result, changed: false }
        : { ok: true, error: null, changed: outcome.committed };
    },
    [runSerializedMutationCore],
  );

  /**
   * Исправление 3: обёртка для result-based lifecycle-функций. Доменная ошибка
   * (в т.ч. no-op в неправильном статусе) → ok:false + русская ошибка; успех →
   * changed из фактического outcome.committed.
   */
  const runSerializedResultMutation = useCallback(
    async ({
      mutation,
      critical = true,
    }: {
      mutation: (baseState: PrototypeState) => ActionResult<OrderTransitionResult>;
      critical?: boolean;
    }): Promise<MutationAck> => {
      const outcome = await runSerializedMutationCore<OrderTransitionResult>({
        mutation,
        infrastructureFailure: (error) => ({ ok: false, error }),
        critical,
      });
      return {
        ok: outcome.result.ok,
        error: outcome.result.error,
        changed: outcome.committed,
      };
    },
    [runSerializedMutationCore],
  );

  useEffect(() => {
    // Этап 4.1: crypto.randomUUID отсутствует в небезопасном контексте (LAN-IP)
    // и не должен ронять гидратацию — безопасный helper с fallback.
    sourceIdRef.current = createPrototypeSourceId();
    // Нетронутый initial default: пока stateRef указывает на него, при legacy-
    // миграции приоритет отдаётся legacy-данным (Исправление 1.1, шаг 3).
    const initialLocalState = stateRef.current;
    let isActive = true;

    const handleIncomingState = (incomingState: PrototypeState) => {
      if (isNewerState(incomingState, stateRef.current)) {
        replaceState(incomingState);
      }
    };

    // Этап 4.2: конструктор BroadcastChannel тоже может бросить — без канала
    // приложение продолжает открываться, синхронизация идёт через `storage`
    // (без retry и без blank page); полной cross-tab синхронизацией это не
    // считается — критические мутации по-прежнему защищает Web Lock.
    const channel = openPrototypeChannel(PROTOTYPE_CHANNEL_NAME);
    if (channel) {
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

    /**
     * Исправление 1: bootstrap выполняется синхронным блоком с ПОВТОРНЫМ чтением
     * хранилища непосредственно перед решением (никаких snapshot'ов, сделанных
     * до lock/microtask). Существующий v7 никогда не перезаписывается legacy-
     * состоянием; входящий более свежий state (storage/BroadcastChannel) не
     * откатывается. Ошибки чтения/записи не роняют гидратацию.
     */
    const runBootstrap = () => {
      if (!isActive) {
        return;
      }
      const freshV7State = safeReadStoredState(PROTOTYPE_STORAGE_KEY);
      const legacyState = freshV7State ? null : readLegacyPrototypeState();
      const resolution = resolveBootstrapState({
        freshV7State,
        legacyState,
        localState: stateRef.current,
        localIsInitial: stateRef.current === initialLocalState,
      });
      if (resolution.shouldPersist) {
        try {
          // Запись только при отсутствии v7 (проверено в этом же синхронном
          // блоке); legacy принимается локально ТОЛЬКО после успешной записи.
          window.localStorage.setItem(
            PROTOTYPE_STORAGE_KEY,
            JSON.stringify(resolution.state),
          );
        } catch {
          // Хранилище недоступно: не принимаем незаписанный legacy state;
          // гидратация продолжается на текущем локальном состоянии.
          setIsHydrated(true);
          return;
        }
      }
      if (resolution.state !== stateRef.current) {
        replaceState(resolution.state);
      }
      setIsHydrated(true);
    };

    const bootstrap = async () => {
      // Этап 4.3: защищённый доступ к LockManager (см. browser-adapters).
      const locks = getPrototypeLockManager();
      if (locks) {
        try {
          // Тот же общий lock, что и у мутаций: bootstrap не гоняется ни с
          // мутациями других вкладок, ни с их bootstrap-миграцией.
          await locks.request(PROTOTYPE_MUTATION_LOCK_NAME, async () =>
            runBootstrap(),
          );
          return;
        } catch {
          // Падение самого Web Locks API — ниже безопасный путь без lock.
        }
      }
      // Без Web Locks: runBootstrap перечитывает v7 в том же синхронном блоке,
      // где принимает решение о записи, — слепой записи legacy нет, появившийся
      // v7 используется, spin-lock не применяется.
      runBootstrap();
    };
    void bootstrap();

    return () => {
      isActive = false;
      window.removeEventListener("storage", handleStorage);
      closePrototypeChannel(channelRef.current);
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
        // Исправление 6: инфраструктурный сбой НЕ маскируется под недоступное
        // блюдо — клиент получает честный статус (нет Web Locks / ошибка записи).
        infrastructureFailure: (error) =>
          error === SAFE_TAB_SYNC_UNAVAILABLE_ERROR
            ? ("SYNC_UNAVAILABLE" as const)
            : ("SAVE_FAILED" as const),
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
      workspaceRole: RestaurantWorkspaceRole,
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
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  // --- Каталог блюд: заявки ресторана и модерация Direct --------------------
  // Все пять действий идут через ту же сериализованную мутацию под Web Lock,
  // что и остальной домен: UI state напрямую не мутирует.

  const createMenuItemDraft = useCallback(
    (restaurantId: string, workspaceRole?: RestaurantWorkspaceRole) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          createMenuItemSubmissionDraft(
            baseState,
            restaurantId,
            "RESTAURANT",
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          submissionId: null,
        }),
      }),
    [runSerializedActionMutation],
  );

  const updateMenuItemDraft = useCallback(
    (
      submissionId: string,
      patch: MenuItemSubmissionDraftPatch,
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          updateMenuItemSubmissionDraft(
            baseState,
            submissionId,
            patch,
            "RESTAURANT",
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          submissionId: null,
        }),
      }),
    [runSerializedActionMutation],
  );

  const submitMenuItemDraft = useCallback(
    (submissionId: string, workspaceRole?: RestaurantWorkspaceRole) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          submitMenuItemSubmission(
            baseState,
            submissionId,
            "RESTAURANT",
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          submissionId: null,
        }),
      }),
    [runSerializedActionMutation],
  );

  const approveMenuItemDraft = useCallback(
    (submissionId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          approveMenuItemSubmission(baseState, submissionId, "ADMIN"),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          submissionId: null,
        }),
      }),
    [runSerializedActionMutation],
  );

  const rejectMenuItemDraft = useCallback(
    (submissionId: string, reason: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          rejectMenuItemSubmission(baseState, submissionId, reason, "ADMIN"),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          submissionId: null,
        }),
      }),
    [runSerializedActionMutation],
  );

  const restoreMenuItem = useCallback(
    (
      restaurantId: string,
      menuItemId: string,
      actor: OperationalActor,
      workspaceRole: RestaurantWorkspaceRole,
    ) => {
      return runSerializedActionMutation({
        mutation: (baseState) =>
          restoreMenuItemAvailability(
            baseState,
            restaurantId,
            menuItemId,
            actor,
            "",
            workspaceRole,
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
      workspaceRole: RestaurantWorkspaceRole,
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
            workspaceRole,
          ),
        infrastructureFailure: (error) => ({ ok: false, error, affected: 0 }),
      });
    },
    [runSerializedActionMutation],
  );

  const restoreCategory = useCallback(
    (
      restaurantId: string,
      category: string,
      actor: OperationalActor,
      workspaceRole: RestaurantWorkspaceRole,
    ) => {
      return runSerializedActionMutation({
        mutation: (baseState) =>
          restoreCategoryItems(
            baseState,
            restaurantId,
            category,
            actor,
            workspaceRole,
          ),
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
      runSerializedResultMutation({
        mutation: (baseState) =>
          simulateSuccessfulOnlinePaymentWithResult(baseState, orderId),
      }),
    [runSerializedResultMutation],
  );

  const markReady = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedResultMutation({
        mutation: (baseState) =>
          markOrderReadyWithResult(baseState, orderId, actor, workspaceRole),
      }),
    [runSerializedResultMutation],
  );

  const startKitchenPreparation = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedResultMutation({
        mutation: (baseState) =>
          startKitchenPreparationWithResult(
            baseState,
            orderId,
            actor,
            workspaceRole,
          ),
      }),
    [runSerializedResultMutation],
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

  const resolvePreparationProblem = useCallback(
    (
      orderId: string,
      preparationProblemId: string,
      reason: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) => {
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          resolveRestaurantPreparationProblem(
            baseState,
            orderId,
            preparationProblemId,
            reason,
            actor,
            workspaceRole,
            nowIso,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  const resolveAccountingEntry = useCallback(
    (
      entryId: string,
      outcome: RestaurantAccountingOutcome,
      note: string,
      externalReference: string | null,
    ) => {
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          resolveRestaurantAccountingEntry(
            baseState,
            entryId,
            outcome,
            note,
            externalReference,
            nowIso,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  const confirmSettlement = useCallback(
    (input: Omit<ConfirmRestaurantSettlementInput, "nowIso">) => {
      // Один канонический момент операции на всю транзакцию: он попадёт в
      // запись расчёта, закрытые обязательства, audit-события и её id.
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          confirmRestaurantSettlement(baseState, { ...input, nowIso }),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          settlementRecordId: null,
        }),
      });
    },
    [runSerializedActionMutation],
  );

  const confirmFullSettlement = useCallback(
    (input: ConfirmFullRestaurantSettlementInput) => {
      return runSerializedActionMutation({
        // Отсечка берётся уже под lock и от актуального baseState: расчёт
        // закрывает позицию на момент подтверждения, а не на момент открытия
        // экрана. Один и тот же момент попадёт в запись, закрытые
        // обязательства, audit-события и id расчёта.
        mutation: (baseState) =>
          confirmFullRestaurantSettlement(baseState, {
            ...input,
            cutoffAt: new Date().toISOString(),
          }),
        // Инфраструктурный отказ тоже обязан вернуть полный контракт: момента
        // отсечки не было, поэтому cutoffAt строго null.
        infrastructureFailure: (error) => ({
          ok: false as const,
          error,
          settlementRecordId: null,
          cutoffAt: null,
        }),
      });
    },
    [runSerializedActionMutation],
  );

  const requestRestaurantCancellation = useCallback(
    (
      orderId: string,
      preparationProblemId: string,
      reason: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) => {
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          requestOrderCancellationByRestaurant(
            baseState,
            orderId,
            preparationProblemId,
            reason,
            actor,
            workspaceRole,
            nowIso,
          ),
        infrastructureFailure: (error) => ({ ok: false, error }),
      });
    },
    [runSerializedActionMutation],
  );

  const completePickup = useCallback(
    (
      orderId: string,
      paidWith: PickupPaymentMethod,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) => {
      const nowIso = new Date().toISOString();
      return runSerializedActionMutation({
        mutation: (baseState) =>
          completePickupAtRestaurant(
            baseState,
            orderId,
            paidWith,
            actor,
            workspaceRole,
            nowIso,
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
      runSerializedResultMutation({
        mutation: (baseState) =>
          setRestaurantWorkflowModeWithResult(baseState, restaurantId, mode),
      }),
    [runSerializedResultMutation],
  );

  const markOutForDelivery = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedResultMutation({
        mutation: (baseState) =>
          markOrderOutForDeliveryWithResult(
            baseState,
            orderId,
            actor,
            workspaceRole,
          ),
      }),
    [runSerializedResultMutation],
  );

  const markArriving = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedResultMutation({
        mutation: (baseState) =>
          markOrderArrivingWithResult(baseState, orderId, actor, workspaceRole),
      }),
    [runSerializedResultMutation],
  );

  const markDelivered = useCallback(
    (
      orderId: string,
      actor: OrderActionActor = "RESTAURANT",
      workspaceRole?: RestaurantWorkspaceRole,
    ) =>
      runSerializedResultMutation({
        mutation: (baseState) =>
          markOrderDeliveredWithResult(
            baseState,
            orderId,
            actor,
            workspaceRole,
          ),
      }),
    [runSerializedResultMutation],
  );

  // v18: рабочие переходы водителя. Момент времени создаётся ВНУТРИ мутации над
  // свежим state; идентичность проверяет домен, а не React.
  const driverArriveAtRestaurant = useCallback(
    (driverId: string, orderId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          markDriverArrivedAtRestaurant(
            baseState,
            driverId,
            orderId,
            new Date().toISOString(),
          ),
        infrastructureFailure: (error) => ({ ok: false, error, orderId: null }),
      }),
    [runSerializedActionMutation],
  );

  const driverPickUpOrder = useCallback(
    (driverId: string, orderId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          markDriverPickedUpOrder(
            baseState,
            driverId,
            orderId,
            new Date().toISOString(),
          ),
        infrastructureFailure: (error) => ({ ok: false, error, orderId: null }),
      }),
    [runSerializedActionMutation],
  );

  const driverMarkArriving = useCallback(
    (driverId: string, orderId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          markDriverArrivingToCustomer(
            baseState,
            driverId,
            orderId,
            new Date().toISOString(),
          ),
        infrastructureFailure: (error) => ({ ok: false, error, orderId: null }),
      }),
    [runSerializedActionMutation],
  );

  const driverCompleteDelivery = useCallback(
    (driverId: string, orderId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          markDriverDeliveredOrder(
            baseState,
            driverId,
            orderId,
            new Date().toISOString(),
          ),
        infrastructureFailure: (error) => ({ ok: false, error, orderId: null }),
      }),
    [runSerializedActionMutation],
  );

  const setPreparationMinutes = useCallback(
    (orderId: string, minutes: number) =>
      runSerializedResultMutation({
        mutation: (baseState) =>
          adminSetPreparationMinutesWithResult(baseState, orderId, minutes),
      }),
    [runSerializedResultMutation],
  );

  const setRestaurantAccepting = useCallback(
    (restaurantId: string, accepting: boolean) =>
      runSerializedResultMutation({
        mutation: (baseState) =>
          setRestaurantAcceptingOrdersWithResult(
            baseState,
            restaurantId,
            accepting,
          ),
      }),
    [runSerializedResultMutation],
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

  // --- Кабинет водителя: доступность и текущая зона ---------------------------
  // Все шесть действий идут через ту же сериализованную мутацию под Web Lock,
  // что и остальные операции: компонент водителя состояние напрямую не меняет.

  const driverGoOnline = useCallback(
    (driverId: string, zoneId: ZoneId) =>
      runSerializedActionMutation({
        mutation: (baseState) => goDriverOnline(baseState, driverId, zoneId),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const driverPause = useCallback(
    (driverId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) => pauseDriver(baseState, driverId),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const driverResume = useCallback(
    (driverId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) => resumeDriver(baseState, driverId),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const driverGoOffline = useCallback(
    (driverId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) => goDriverOffline(baseState, driverId),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const driverChangeZone = useCallback(
    (driverId: string, zoneId: ZoneId) =>
      runSerializedActionMutation({
        mutation: (baseState) => changeDriverZone(baseState, driverId, zoneId),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  const driverConfirmZone = useCallback(
    (
      driverId: string,
      zoneId: ZoneId,
      nextAvailability: "AVAILABLE" | "PAUSED",
    ) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          confirmDriverZone(baseState, driverId, zoneId, nextAvailability),
        infrastructureFailure: (error) => ({ ok: false, error }),
      }),
    [runSerializedActionMutation],
  );

  // --- Кабинет водителя: предложения заказов (v17) ----------------------------
  // Момент времени создаётся ВНУТРИ сериализованной мутации над свежим state, а
  // не передаётся из UI: только так гонка двух водителей и срок предложения
  // считаются от актуального состояния под общим Web Lock.

  const refreshDriverOffers = useCallback(
    () =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          reconcileDriverOffers(baseState, new Date().toISOString()),
        infrastructureFailure: (error) => ({
          ok: false,
          error,
          createdCount: 0,
          expiredCount: 0,
          canceledCount: 0,
        }),
      }),
    [runSerializedActionMutation],
  );

  const driverAcceptOffer = useCallback(
    (driverId: string, offerId: string, input: AcceptDriverOfferInput) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          acceptDriverOffer(
            baseState,
            driverId,
            offerId,
            new Date().toISOString(),
            input,
          ),
        infrastructureFailure: (error) => ({ ok: false, error, orderId: null }),
      }),
    [runSerializedActionMutation],
  );

  const driverDeclineOffer = useCallback(
    (driverId: string, offerId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          declineDriverOffer(baseState, driverId, offerId, new Date().toISOString()),
        infrastructureFailure: (error) => ({ ok: false, error, orderId: null }),
      }),
    [runSerializedActionMutation],
  );

  const driverReportCashHandoffToRestaurant = useCallback(
    (driverId: string, orderId: string) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          reportDriverCashHandoffToRestaurant(
            baseState,
            driverId,
            orderId,
            new Date().toISOString(),
          ),
        infrastructureFailure: (error) => ({ ok: false, error, orderId: null }),
      }),
    [runSerializedActionMutation],
  );

  const restaurantConfirmDriverCashReceipt = useCallback(
    (
      restaurantId: string,
      orderId: string,
      workspaceRole: RestaurantWorkspaceRole,
    ) =>
      runSerializedActionMutation({
        mutation: (baseState) =>
          confirmRestaurantDriverCashReceipt(
            baseState,
            restaurantId,
            orderId,
            workspaceRole,
            new Date().toISOString(),
          ),
        infrastructureFailure: (error) => ({ ok: false, error, orderId: null }),
      }),
    [runSerializedActionMutation],
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
      startKitchenPreparation,
      createMenuItemDraft,
      updateMenuItemDraft,
      submitMenuItemDraft,
      approveMenuItemDraft,
      rejectMenuItemDraft,
      adjustOrderEta,
      reportPreparationProblem,
      resolvePreparationProblem,
      requestRestaurantCancellation,
      resolveAccountingEntry,
      confirmSettlement,
      confirmFullSettlement,
      completePickup,
      markPickupNoShow,
      markOutForDelivery,
      markArriving,
      markDelivered,
      driverArriveAtRestaurant,
      driverPickUpOrder,
      driverMarkArriving,
      driverCompleteDelivery,
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
      driverGoOnline,
      driverPause,
      driverResume,
      driverGoOffline,
      driverChangeZone,
      driverConfirmZone,
      refreshDriverOffers,
      driverAcceptOffer,
      driverDeclineOffer,
      driverReportCashHandoffToRestaurant,
      restaurantConfirmDriverCashReceipt,
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
      startKitchenPreparation,
      createMenuItemDraft,
      updateMenuItemDraft,
      submitMenuItemDraft,
      approveMenuItemDraft,
      rejectMenuItemDraft,
      adjustOrderEta,
      reportPreparationProblem,
      resolvePreparationProblem,
      requestRestaurantCancellation,
      resolveAccountingEntry,
      confirmSettlement,
      confirmFullSettlement,
      completePickup,
      markPickupNoShow,
      markOutForDelivery,
      markArriving,
      markDelivered,
      driverArriveAtRestaurant,
      driverPickUpOrder,
      driverMarkArriving,
      driverCompleteDelivery,
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
      driverGoOnline,
      driverPause,
      driverResume,
      driverGoOffline,
      driverChangeZone,
      driverConfirmZone,
      refreshDriverOffers,
      driverAcceptOffer,
      driverDeclineOffer,
      driverReportCashHandoffToRestaurant,
      restaurantConfirmDriverCashReceipt,
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
