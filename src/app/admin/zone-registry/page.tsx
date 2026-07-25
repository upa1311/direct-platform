"use client";

import { useMemo, useState } from "react";

import { ZonePolygonMap } from "@/components/admin/zone-polygon-map";
import { resolveAddressZone } from "@/lib/zones/address-resolver";
import {
  datasetInvalidReason,
  isDatasetValid,
  isSevernyCatalogComplete,
  listZones,
  manifest,
  qaCounts,
  streetCount,
  verifiedAddressCount,
  verifiedHousesForStreet,
  zoneColor,
  zoneDatasetVersion,
  zoneEdgesKm,
  zoneRelease,
} from "@/lib/zones/zone-registry";
import type { ZoneResolution } from "@/lib/zones/types";

/**
 * Read-only zone registry for admins over the versioned, fail-closed release.
 * Shows the manifest/checksum validation status, the exact-address search, the
 * verified houses on a street (split streets included), and the QA readiness
 * counts (disputed / unaddressed / no_delivery / Северный). It does NOT touch
 * tariffs — the money editor stays at /admin/zones. Zones only, no prices.
 */
export default function AdminZoneRegistryPage() {
  const zones = useMemo(() => listZones(), []);
  const edges = useMemo(() => zoneEdgesKm(), []);
  const valid = isDatasetValid();
  const invalidReason = datasetInvalidReason();
  const m = manifest();
  const counts = useMemo(() => (valid ? qaCounts() : null), [valid]);
  const [settlement, setSettlement] = useState("Бендеры");
  const [district, setDistrict] = useState("");
  const [street, setStreet] = useState("");
  const [house, setHouse] = useState("");
  const [result, setResult] = useState<ZoneResolution | null>(null);

  const streetHouses = useMemo(
    () => (valid && street.trim() ? verifiedHousesForStreet(settlement, street) : []),
    [valid, settlement, street],
  );
  const streetZones = useMemo(
    () => [...new Set(streetHouses.map((h) => h.zone_id))].sort((a, b) => a - b),
    [streetHouses],
  );

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
    <main style={{ padding: "24px", maxWidth: 820 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Реестр зон</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Версия набора зон: <code>{zoneRelease()}</code> · источник:{" "}
        <code>{zoneDatasetVersion()}</code>. Только зоны, без цен. Тарифы — на
        отдельном экране «Зоны и тарифы» (<code>/admin/zones</code>).
      </p>

      {/* --- fail-closed validation status --- */}
      <section
        style={{
          margin: "14px 0",
          padding: 12,
          borderRadius: 8,
          border: `1px solid ${valid ? "#16a34a" : "#d62828"}`,
          background: valid ? "#f0fdf4" : "#fef2f2",
          fontSize: 13,
        }}
      >
        <b style={{ color: valid ? "#166534" : "#b91c1c" }}>
          {valid ? "Релиз проверен (manifest + SHA-256)" : "DATASET_INVALID"}
        </b>
        {valid && m ? (
          <div style={{ marginTop: 4, color: "#444" }}>
            release_id <code>{m.release_id}</code> · версия <code>{m.version}</code> ·
            K={m.decided_k} · prices_included={String(m.prices_included)} ·
            подтверждённых адресов: <b>{verifiedAddressCount()}</b> · улиц: {streetCount()} ·
            QA-объектов: {m.qa_object_count}
          </div>
        ) : (
          <div style={{ marginTop: 4, color: "#b91c1c" }}>
            Причина: {invalidReason ?? "неизвестна"}. Заказы с доставкой создать нельзя.
          </div>
        )}
        {valid && (
          <div style={{ marginTop: 4, color: "#92400e" }}>
            Каталог Северного {isSevernyCatalogComplete() ? "полный" : "неполный"} —
            адреса Северного показываются как QA и в доставку не принимаются.
          </div>
        )}
      </section>

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
        {valid && (
          <div style={{ marginTop: 10 }}>
            <ZonePolygonMap />
            <p style={{ color: "#666", fontSize: 12, marginTop: 6 }}>
              Заливка — зоны 1–4 (Северный — отдельный анклав Zone 4). Серая
              область — Варница (село), без доставки. Пунктир — административная
              граница Варницы (справочно, транзит разрешён). Карта читает
              vendored GeoJSON, без обращений к сети.
            </p>
          </div>
        )}
      </section>

      {/* --- QA readiness --- */}
      {counts && (
        <section style={{ margin: "16px 0" }}>
          <h2 style={{ fontSize: 16 }}>Готовность каталога (QA)</h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, marginTop: 6 }}>
            <span>Всего QA-объектов: <b>{m?.qa_object_count ?? 0}</b></span>
            <span>Спорные: <b>{counts.disputed}</b></span>
            <span>Без доставки: <b>{counts.no_delivery}</b></span>
            <span>Без адреса: <b>{counts.unaddressed}</b></span>
            <span>Tier C / исключено: <b>{counts.excluded}</b></span>
            <span>На проверке владельца: <b>{counts.ownerReview}</b></span>
            <span>Северный: <b>{counts.severny}</b></span>
          </div>
          <p style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
            Варница (село) — без доставки, разрешён только транзит. Tier C —
            объекты ручной проверки, исключённые из клиентского каталога.
            QA-объекты рабочей зоны не образуют.
          </p>
        </section>
      )}

      <section style={{ margin: "16px 0" }}>
        <h2 style={{ fontSize: 16 }}>Поиск зоны по точному адресу</h2>
        <p style={{ color: "#666", fontSize: 13 }}>
          Источник истины — конкретный подтверждённый дом. Улица без дома или дом
          вне реестра зону не получают.
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

        {street.trim() && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#444" }}>
            {streetHouses.length > 0 ? (
              <>
                Подтверждённых домов на улице: <b>{streetHouses.length}</b>
                {streetZones.length > 1 && (
                  <span style={{ color: "#b45309" }}>
                    {" "}· разрезанная улица (зоны {streetZones.join(", ")})
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: "#888" }}>Улицы нет в реестре подтверждённых домов.</span>
            )}
          </div>
        )}

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
                  {result.status !== "RESOLVED" ? " (территория, не подтверждён)" : ""}
                </b>
              ) : (
                "—"
              )}
            </div>
            {result.canonicalAddressKey && (
              <div style={{ color: "#666" }}>
                Ключ: <code>{result.canonicalAddressKey}</code>
              </div>
            )}
            {result.status === "NO_DELIVERY" && (
              <div style={{ color: "#b91c1c", fontWeight: 700 }}>
                Без доставки (напр. Варница). Дороги — только транзит.
              </div>
            )}
            {result.status === "DISPUTED" && (
              <div style={{ color: "#7c3aed", fontWeight: 700 }}>
                Спорный адрес — требует решения владельца.
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
