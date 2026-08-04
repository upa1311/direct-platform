import catalogDocument from "../../vendor/bender-delivery-v2/address-catalog.generated.json" with { type: "json" };

import { CANONICAL_CATALOG_METRICS } from "./constants";

type CatalogTuple = readonly [
  uid: string,
  address: string,
  lon: number,
  lat: number,
  status: "routed" | "duplicate",
  zoneId: number,
];

export interface DeliveryAddress {
  readonly id: string;
  readonly label: string;
  readonly lon: number;
  readonly lat: number;
  readonly status: "routed" | "duplicate";
  readonly zoneId: number;
  readonly settlement: string;
  readonly street: string;
  readonly house: string;
}

export interface AddressSearchInput {
  query?: string;
  settlement?: string;
  street?: string;
  house?: string;
  zoneId?: number;
  offset?: number;
  limit?: number;
}

function parseLabel(label: string): Pick<DeliveryAddress, "settlement" | "street" | "house"> {
  const parts = label.split(",").map((part) => part.trim());
  return {
    settlement: parts[0] ?? "",
    street: parts.slice(1, -1).join(", "),
    house: parts.at(-1) ?? "",
  };
}

function toAddress(row: CatalogTuple): DeliveryAddress {
  return Object.freeze({
    id: row[0],
    label: row[1],
    lon: row[2],
    lat: row[3],
    status: row[4],
    zoneId: row[5],
    ...parseLabel(row[1]),
  });
}

const rows = (catalogDocument.addresses as unknown as CatalogTuple[]).map(toAddress);
const byId = new Map(rows.map((address) => [address.id, address]));

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase("ru");
}

export function catalogMetadata() {
  return Object.freeze({
    source: catalogDocument.source,
    canonical: CANONICAL_CATALOG_METRICS,
  });
}

export function allDeliveryAddresses(): readonly DeliveryAddress[] {
  return rows;
}

export function findDeliveryAddress(id: string): DeliveryAddress | null {
  return byId.get(id) ?? null;
}

export function requireRoutableAddress(id: string): DeliveryAddress {
  const address = findDeliveryAddress(id);
  if (!address) throw new Error(`Unknown canonical address: ${id}`);
  if (address.status !== "routed") {
    throw new Error(`Canonical address is not routable: ${id}`);
  }
  return address;
}

export function searchDeliveryAddresses(input: AddressSearchInput) {
  const query = normalized(input.query);
  const settlement = normalized(input.settlement);
  const street = normalized(input.street);
  const house = normalized(input.house);
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.max(1, Math.min(100, input.limit ?? 50));
  const filtered = rows.filter((address) => (
    (!query || normalized(address.label).includes(query) || normalized(address.id).includes(query))
    && (!settlement || normalized(address.settlement) === settlement)
    && (!street || normalized(address.street).includes(street))
    && (!house || normalized(address.house).includes(house))
    && (!input.zoneId || address.zoneId === input.zoneId)
  ));
  return Object.freeze({
    total: filtered.length,
    offset,
    limit,
    items: filtered.slice(offset, offset + limit),
  });
}
