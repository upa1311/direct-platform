import type { CartLine } from "@/types/prototype";

export const deliveryFeeCents = 300;
export const cashMinimumFoodSubtotalCents = 700;
export const smallOrderThresholdCents = 667;

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function getFoodSubtotal(lines: CartLine[]): number {
  return lines.reduce(
    (total, line) => total + line.unitPriceCents * line.quantity,
    0,
  );
}

export function getSmallOrderFee(foodSubtotalCents: number): number {
  const commissionCents = Math.round(foodSubtotalCents * 0.15);
  return Math.max(0, 100 - commissionCents);
}

export function getSmallOrderMissingAmount(foodSubtotalCents: number): number {
  return Math.max(0, smallOrderThresholdCents - foodSubtotalCents);
}

