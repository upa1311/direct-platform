import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatOperatorAddressAccess,
  formatOperatorAddressComment,
  formatOperatorAddressMain,
  formatOperatorDeliveryAddress,
} from "./operator-delivery-address.ts";
import type {
  DeliveryAddress,
  DeliveryMode,
  Order,
} from "../../prototype/models.ts";

/**
 * Форматирование адреса доставки для оператора. Чистая логика: пустые поля не
 * выводятся, лишних запятых нет, самовывоз адреса не имеет, вход не мутируется.
 */

function addr(overrides: Partial<DeliveryAddress> = {}): DeliveryAddress {
  return {
    street: "Штефан чел Маре",
    house: "10",
    apartment: "24",
    entrance: "2",
    floor: "6",
    comment: "Код домофона 248, позвонить при подъезде",
    zoneId: "zone-1",
    ...overrides,
  };
}

function order(
  deliveryMode: DeliveryMode,
  address: DeliveryAddress | null,
): Order {
  return { deliveryMode, address } as unknown as Order;
}

test("полный адрес: улица, дом, квартира, подъезд, этаж, комментарий", () => {
  const o = order("PLATFORM_DRIVER", addr());
  const lines = formatOperatorDeliveryAddress(o);
  assert.ok(lines);
  assert.equal(lines.main, "Штефан чел Маре, дом 10, кв. 24");
  assert.equal(lines.access, "подъезд 2 · этаж 6");
  assert.equal(lines.comment, "Код домофона 248, позвонить при подъезде");
});

test("RESTAURANT_DELIVERY форматируется так же, как доставка Direct", () => {
  const o = order("RESTAURANT_DELIVERY", addr());
  const lines = formatOperatorDeliveryAddress(o);
  assert.ok(lines);
  assert.equal(lines.main, "Штефан чел Маре, дом 10, кв. 24");
  assert.equal(lines.access, "подъезд 2 · этаж 6");
});

test("частичный адрес: только street + house — без лишних запятых и разделителей", () => {
  const o = order(
    "PLATFORM_DRIVER",
    addr({ apartment: "", entrance: "", floor: "", comment: "" }),
  );
  const lines = formatOperatorDeliveryAddress(o);
  assert.ok(lines);
  assert.equal(lines.main, "Штефан чел Маре, дом 10");
  assert.equal(lines.access, null);
  assert.equal(lines.comment, null);
});

test("только подъезд либо только этаж — без висячего разделителя", () => {
  const onlyEntrance = order("PLATFORM_DRIVER", addr({ floor: "" }));
  assert.equal(formatOperatorAddressAccess(onlyEntrance), "подъезд 2");

  const onlyFloor = order("PLATFORM_DRIVER", addr({ entrance: "" }));
  assert.equal(formatOperatorAddressAccess(onlyFloor), "этаж 6");
});

test("строки из пробелов считаются пустыми и не отображаются", () => {
  const o = order(
    "PLATFORM_DRIVER",
    addr({ apartment: "   ", entrance: " ", floor: "\t", comment: "   " }),
  );
  const lines = formatOperatorDeliveryAddress(o);
  assert.ok(lines);
  // apartment из пробелов не добавляет «, кв. »
  assert.equal(lines.main, "Штефан чел Маре, дом 10");
  assert.equal(lines.access, null);
  assert.equal(lines.comment, null);
});

test("PICKUP: блок адреса не показывается, даже если address заполнен", () => {
  const o = order("PICKUP", addr());
  assert.equal(formatOperatorDeliveryAddress(o), null);
  assert.equal(formatOperatorAddressMain(o), null);
  assert.equal(formatOperatorAddressAccess(o), null);
  assert.equal(formatOperatorAddressComment(o), null);
});

test("доставка без снимка адреса даёт null", () => {
  const o = order("PLATFORM_DRIVER", null);
  assert.equal(formatOperatorDeliveryAddress(o), null);
});

test("read-only: форматирование не мутирует order.address", () => {
  const address = addr();
  const snapshot = JSON.stringify(address);
  const o = order("PLATFORM_DRIVER", address);

  formatOperatorDeliveryAddress(o);
  formatOperatorAddressMain(o);
  formatOperatorAddressAccess(o);
  formatOperatorAddressComment(o);

  assert.equal(JSON.stringify(address), snapshot, "address не изменился");
  assert.equal(JSON.stringify(o.address), snapshot);
});
