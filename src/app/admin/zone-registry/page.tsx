"use client";

import { useMemo, useState } from "react";

import { resolveAddressZone } from "@/lib/zones/address-resolver";
import {
  listZones,
  streetCount,
  zoneColor,
  zoneDatasetVersion,
  zoneEdgesKm,
  zoneRelease,
} from "@/lib/zones/zone-registry";
import type { ZoneResolution } from "@/lib/zones/types";

/**
 * Read-only zone registry for admins. Shows the versioned zone dataset and lets
 * an admin resolve an exact address to a zone. It does NOT touch tariffs — the
 * money editor stays at /admin/zones. Zones only, no prices.
 */
export default function AdminZoneRegistryPage() {
  const zones = useMemo(() => listZones(), []);
  const edges = useMemo(() => zoneEdgesKm(), []);
  const [settlement, setSettlement] = useState("Бендеры");
  const [district, setDistrict] = useState("");
  const [street, setStreet] = useState("");
  const [house, setHouse] = useState("");
  const [result, setResult] = useState<ZoneResolution | null>(null);

  const lookup = () => {
    setResult(
      resolveAddressZone({
        settlement,
        district: district || null,
        street,
        house: house || null,
      }),
    );
  };

  return (
    <main style={{ padding: "24px", maxWidth: 760 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Реестр зон</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Версия набора зон: <code>{zoneRelease()}</code> · источник:{" "}
        <code>{zoneDatasetVersion()}</code> · улиц: {streetCount()}. Только зоны,
        без цен. Тарифы — на отдельном экране «Зоны и тарифы».
      </p>

      <section style={{ margin: "16px 0" }}>
        <h2 style={{ fontSize: 16 }}>Зоны (K=4)</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
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
        <p style={{ color: "#666", fontSize: 13, marginTop: 8 }}>
          Границы (км): {edges.join(" / ")}. Северный — отдельный компонент Zone 4.
        </p>
      </section>

      <section style={{ margin: "16px 0" }}>
        <h2 style={{ fontSize: 16 }}>Поиск зоны по адресу</h2>
        <p style={{ color: "#666", fontSize: 13 }}>
          Источник истины — конкретный дом. Для разрезанной улицы без дома —
          неоднозначно.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <input
            aria-label="населённый пункт"
            value={settlement}
            onChange={(e) => setSettlement(e.target.value)}
            placeholder="Населённый пункт"
          />
          <input
            aria-label="район"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
            placeholder="Район (необяз.)"
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
            style={{ width: 90 }}
          />
          <button onClick={lookup} type="button">
            Найти
          </button>
        </div>

        {result && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              border: "1px solid #ddd",
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            <div>
              Статус: <b>{result.status}</b>
            </div>
            <div>
              Зона:{" "}
              {result.zoneNumber != null ? (
                <b style={{ color: zoneColor(result.zoneNumber) ?? "#333" }}>
                  Zone {result.zoneNumber}
                </b>
              ) : (
                "—"
              )}
            </div>
            {result.zones.length > 1 && (
              <div>Возможные зоны: {result.zones.join(", ")}</div>
            )}
            {result.status === "no_delivery" && (
              <div style={{ color: "#b91c1c", fontWeight: 700 }}>
                Без доставки (напр. Варница). Дороги — только транзит.
              </div>
            )}
            <div style={{ color: "#888", marginTop: 4 }}>
              Стоимость доставки здесь не показывается.
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
