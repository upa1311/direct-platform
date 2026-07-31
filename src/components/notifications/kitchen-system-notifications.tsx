"use client";

import { useMemo } from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import { buildKitchenNotificationIntents } from "@/prototype/direct-notifications";
import type { RestaurantWorkspaceRole } from "@/prototype/models";
import { useNowMs } from "@/components/util/use-now";
import { useDirectSystemNotifications } from "./use-direct-system-notifications";
import { SystemNotificationControl } from "./system-notification-control";

/**
 * Kitchen system-notification control + delivery. A separate channel from the
 * kitchen sound; preference is scoped by restaurant AND workspace role. Intents
 * come only from the canonical getAudibleKitchenReviewOrders selector, the same
 * definition of actionable work the sound uses. `active` mirrors the sound gate
 * (only the screen that owns the decision drives notifications).
 */
export function KitchenSystemNotifications({
  restaurantId,
  workspaceRole,
  active,
}: {
  restaurantId: string;
  workspaceRole: RestaurantWorkspaceRole;
  active: boolean;
}) {
  const { state } = usePrototype();
  const nowMs = useNowMs(3000);
  const intents = useMemo(
    () =>
      active && nowMs > 0
        ? buildKitchenNotificationIntents(state, restaurantId, workspaceRole, nowMs)
        : [],
    [state, restaurantId, workspaceRole, active, nowMs],
  );
  const { capability, enable, disable } = useDirectSystemNotifications({
    audience: { type: "KITCHEN", restaurantId, workspaceRole },
    intents,
    nowMs,
  });
  return (
    <SystemNotificationControl
      capability={capability}
      onEnable={() => void enable()}
      onDisable={disable}
    />
  );
}
