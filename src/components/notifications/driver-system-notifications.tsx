"use client";

import { useMemo } from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import { buildDriverNotificationIntents } from "@/prototype/direct-notifications";
import { useNowMs } from "@/components/util/use-now";
import { useDirectSystemNotifications } from "./use-direct-system-notifications";
import { SystemNotificationControl } from "./system-notification-control";

/**
 * Driver system-notification control + delivery. A separate channel from the
 * offer sound bell; the offer sound keeps working independently. Intents come
 * only from the canonical getOpenDriverOffersForDriver selector.
 */
export function DriverSystemNotifications({ driverId }: { driverId: string }) {
  const { state } = usePrototype();
  const nowMs = useNowMs(3000);
  const intents = useMemo(
    () => (nowMs > 0 ? buildDriverNotificationIntents(state, driverId, nowMs) : []),
    [state, driverId, nowMs],
  );
  const { capability, enable, disable } = useDirectSystemNotifications({
    audience: { type: "DRIVER", driverId },
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
