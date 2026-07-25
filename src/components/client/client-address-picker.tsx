"use client";

import { useMemo } from "react";

import type { DeliveryAddress } from "@/prototype/models";
import { resolveAddressZone } from "@/lib/zones/address-resolver";
import {
  isDatasetValid,
  registryDistrictsForSettlement,
  registryHouses,
  registrySettlements,
  registryStreets,
} from "@/lib/zones/zone-registry";
import flowStyles from "@/components/order-flow/order-flow.module.css";

/**
 * Клиентский выбор адреса из verified registry (bender-zones-v1.1). Клиент может
 * указать только подтверждённый населённый пункт / район / улицу / дом: улицы и
 * дома предлагаются исключительно из реестра, одинаковые улицы разных районов
 * разделяются, а зона показывается только для точного подтверждённого дома.
 * Стоимость доставки здесь не вычисляется и не показывается.
 */
export function ClientAddressPicker({
  address,
  onChange,
  streetRef,
  houseRef,
}: {
  address: DeliveryAddress;
  onChange: (partial: Partial<Omit<DeliveryAddress, "zoneId">>) => void;
  streetRef?: React.Ref<HTMLInputElement>;
  houseRef?: React.Ref<HTMLInputElement>;
}) {
  const datasetValid = isDatasetValid();
  const settlement = address.settlement?.trim() || "Бендеры";
  const district = address.district ?? "";

  const settlements = useMemo(() => registrySettlements(), []);
  const districts = useMemo(
    () => registryDistrictsForSettlement(settlement),
    [settlement],
  );
  const streets = useMemo(
    () => registryStreets(settlement, district || null),
    [settlement, district],
  );
  const houses = useMemo(
    () =>
      address.street.trim()
        ? registryHouses(settlement, address.street, district || null)
        : [],
    [settlement, district, address.street],
  );

  const resolution = useMemo(() => {
    if (!address.street.trim() || !address.house.trim()) return null;
    return resolveAddressZone({
      settlement,
      district: district || null,
      street: address.street,
      house: address.house,
    });
  }, [settlement, district, address.street, address.house]);

  if (!datasetValid) {
    return (
      <div className={flowStyles.warningNotice} role="alert">
        Каталог адресов недоступен (DATASET_INVALID). Оформление доставки временно
        невозможно.
      </div>
    );
  }

  const statusText = (): { text: string; ok: boolean } => {
    if (!resolution) return { text: "Выберите улицу и дом из каталога.", ok: false };
    switch (resolution.status) {
      case "RESOLVED":
        return { text: `Адрес подтверждён · Zone ${resolution.zoneNumber}`, ok: true };
      case "NO_DELIVERY":
        return { text: "По этому адресу доставка не выполняется.", ok: false };
      case "DISPUTED":
        return { text: "Адрес спорный — доставка недоступна.", ok: false };
      case "UNVERIFIED_ADDRESS":
        return {
          text:
            resolution.zoneNumber != null
              ? `Адрес не подтверждён в каталоге (территория Zone ${resolution.zoneNumber}).`
              : "Адрес не подтверждён в каталоге.",
          ok: false,
        };
      case "AMBIGUOUS":
        return { text: "Уточните район — улица встречается в нескольких районах.", ok: false };
      case "NOT_FOUND":
        return { text: "Такого дома нет в каталоге подтверждённых адресов.", ok: false };
      default:
        return { text: "Каталог адресов недоступен.", ok: false };
    }
  };
  const status = statusText();

  return (
    <>
      <label className={flowStyles.field}>
        <span>Населённый пункт</span>
        <select
          value={settlement}
          onChange={(e) =>
            onChange({
              settlement: e.target.value,
              district: null,
              street: "",
              house: "",
            })
          }
        >
          {settlements.map((s) => (
            <option value={s} key={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {districts.length > 0 ? (
        <label className={flowStyles.field}>
          <span>Район</span>
          <select
            value={district}
            onChange={(e) =>
              onChange({ district: e.target.value || null, street: "", house: "" })
            }
          >
            <option value="">— весь город —</option>
            {districts.map((d) => (
              <option value={d} key={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
        <span>Улица</span>
        <input
          ref={streetRef}
          list="registry-street-list"
          value={address.street}
          placeholder="Начните вводить улицу"
          onChange={(e) => onChange({ street: e.target.value, house: "" })}
        />
        <datalist id="registry-street-list">
          {streets.map((s) => (
            <option value={s} key={s} />
          ))}
        </datalist>
      </label>

      <label className={flowStyles.field}>
        <span>Дом</span>
        <input
          ref={houseRef}
          list="registry-house-list"
          value={address.house}
          placeholder="№ дома"
          disabled={!address.street.trim()}
          onChange={(e) => onChange({ house: e.target.value })}
        />
        <datalist id="registry-house-list">
          {houses.map((h) => (
            <option value={h} key={h} />
          ))}
        </datalist>
      </label>

      <div
        className={flowStyles.fieldFull}
        role="status"
        style={{ fontSize: 13, color: status.ok ? "#166534" : "#92400e" }}
      >
        {status.text}
        {resolution?.status === "RESOLVED" && resolution.canonicalAddressKey ? (
          <span style={{ color: "#6b7280" }}>
            {" "}
            · {settlement}
            {district ? `, ${district}` : ""}, {address.street}, дом {address.house}
          </span>
        ) : null}
      </div>
    </>
  );
}
