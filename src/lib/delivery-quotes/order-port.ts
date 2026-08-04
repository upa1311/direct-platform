import type { StoredQuote } from "./types";

/**
 * Deliberately unimplemented application boundary for the next phase. A future
 * order service may consume an immutable confirmed quote snapshot, but this V2
 * never pretends that a Direct order has been created.
 */
export interface DeliveryQuoteToOrderPort {
  createOrderFromConfirmedQuote(quote: StoredQuote): Promise<{ orderId: string }>;
}
