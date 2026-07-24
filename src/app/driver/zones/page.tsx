"use client";

import { useState } from "react";

import { resolveAddressZone } from "@/lib/zones/address-resolver";
import {
  listZones,
  zoneColor,
  zoneRelease,
} from "@/lib/zones/zone-registry";
import type { ZoneResolution } from "@/lib/zones/types";

/**
 * Driver-facing zones reference: the four zones and a prominent Varnița
 * no-delivery warning, plus a quick address check. Read-only, no prices.
 */
export default function DriverZonesPage() {
  const zones = listZones();
  const [street, setStreet] = useState("");
  const [house, setHouse] = useState("");
  const [settlement, setSettlement] = useState("Бендеры");
  const [result, setResult] = useState<ZoneResolution | null>(null);

  return (
    <main style={{ padding: "20px", maxWidth: 620 }}>
      <h1 style={{ fontSize: 20 }}>Зоны доставки</h1>
      <p style={{ color: "#666", fontSize: 13 }}>
        Набор зон: <code>{zoneRelease()}</code>. Цены здесь не показываются.
      </p>

      <div
        role="alert"
        style={{
          margin: "12px 0",
          padding: "10px 12px",
          background: "#fde8e8",
          border: "1px solid #d62828",
          borderRadius: 8,
          color: "#7f1d1d",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Варница — без доставки. Дороги через Варницу разрешены только как транзит;
        заказы по адресам Варницы не выполняются.
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "8px 0" }}>
        {zones.map((z) => (
          <span
            key={z.zone_id}
            style={{
              background: zoneColor(z.zone_id) ?? "#999",
              color: z.zone_id === 2 ? "#333" : "#fff",
              padding: "4px 12px",
              borderRadius: 12,
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            {z.zone_name}
          </span>
        ))}
      </div>
      <p style={{ color: "#666", fontSize: 13 }}>
        Северный — отдельный анклав Zone 4.
      </p>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 15 }}>Проверить адрес</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <input
            aria-label="населённый пункт"
            value={settlement}
            onChange={(e) => setSettlement(e.target.value)}
            placeholder="Населённый пункт"
          />
          <input
            aria-label="улица"
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            placeholder="Улица"
          />
          <input
            aria-label="дом"
            value={house}
            onChange={(e) => setHouse(e.target.value)}
            placeholder="Дом"
            style={{ width: 80 }}
          />
          <button
            type="button"
            onClick={() =>
              setResult(
                resolveAddressZone({ settlement, street, house: house || null }),
              )
            }
          >
            Проверить
          </button>
        </div>
        {result && (
          <div style={{ marginTop: 10, fontSize: 14 }}>
            {result.status === "no_delivery" ? (
              <b style={{ color: "#b91c1c" }}>Без доставки</b>
            ) : result.zoneNumber != null ? (
              <b style={{ color: zoneColor(result.zoneNumber) ?? "#333" }}>
                Zone {result.zoneNumber}
              </b>
            ) : (
              <span>Зона не определена ({result.status})</span>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
