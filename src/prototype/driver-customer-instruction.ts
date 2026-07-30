import type { Order } from "./models";

/**
 * Priority delivery instruction shown to the assigned driver. The only source of
 * truth is the immutable order snapshot field `order.address.comment` — never the
 * customer profile, cart, saved addresses, order history, cooking comments or any
 * mutable driver note. Editing the customer's profile or cart after checkout does
 * not change an existing order, because this reads the order's own snapshot.
 *
 * Fail-closed and pure: it never mutates state and never invents text.
 *  - NONE            — no instruction to show (missing/blank comment).
 *  - PRESENT         — a real, non-blank comment; `text` is the verbatim snapshot.
 *  - REVIEW_REQUIRED — an impossible/corrupt shape (a delivery order whose address
 *                      snapshot is missing or whose comment is not a string).
 */
export type DriverCustomerInstructionView =
  | { status: "NONE"; text: null }
  | { status: "PRESENT"; text: string }
  | { status: "REVIEW_REQUIRED"; text: null };

export function getDriverCustomerInstructionView(
  order: Order,
): DriverCustomerInstructionView {
  const address = order.address;
  // A PLATFORM_DRIVER order must carry an address snapshot; a missing/corrupt one
  // is an impossible form — surface it, do not invent an instruction.
  if (address === null || typeof address !== "object") {
    return { status: "REVIEW_REQUIRED", text: null };
  }
  const comment = (address as { comment?: unknown }).comment;
  if (typeof comment !== "string") {
    return { status: "REVIEW_REQUIRED", text: null };
  }
  // `.trim()` decides emptiness only; the displayed text stays verbatim so
  // internal line breaks and the client's exact wording are preserved.
  if (comment.trim() === "") {
    return { status: "NONE", text: null };
  }
  return { status: "PRESENT", text: comment };
}
