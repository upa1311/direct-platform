import type { DriverDeliveryStage } from "./driver-delivery";
import { getDriverCustomerInstructionView } from "./driver-customer-instruction";
import type { Order } from "./models";

/**
 * Delivery handoff policy shown to the driver on the way to the customer.
 *
 * This is an OPERATIONAL policy, not a text classifier. Direct's default is to
 * hand the order directly to the customer; the client's own instruction (from
 * the immutable snapshot, surfaced by getDriverCustomerInstructionView) takes
 * priority. We deliberately do NOT parse the free-text comment — no NLP, no
 * regex, no language/synonym lists, no negation handling, no leave-at-door enum —
 * because free text may contain negations, conditions, quotes, several
 * instructions, typos, another language or ambiguity, and must not be
 * misclassified. The driver reads the exact client text in the existing
 * "Инструкция клиента" card; here we only state that it takes priority.
 *
 * Pure and fail-closed. Adds no persisted state and no schema field.
 *  - DEFAULT_HAND_TO_CUSTOMER     — no client instruction; default hand-to-customer.
 *  - CUSTOMER_INSTRUCTION_PRIORITY — a real instruction exists (verbatim text);
 *                                    default is still hand-to-customer unless the
 *                                    client instruction changes it.
 *  - REVIEW_REQUIRED              — the instruction view is corrupt; no plausible
 *                                    default method is invented.
 */
export type DriverDeliveryHandoffPolicyView =
  | {
      status: "DEFAULT_HAND_TO_CUSTOMER";
      defaultMethod: "HAND_TO_CUSTOMER";
      customerInstruction: null;
    }
  | {
      status: "CUSTOMER_INSTRUCTION_PRIORITY";
      defaultMethod: "HAND_TO_CUSTOMER";
      customerInstruction: string;
    }
  | {
      status: "REVIEW_REQUIRED";
      defaultMethod: null;
      customerInstruction: null;
    };

export function getDriverDeliveryHandoffPolicyView(
  order: Order,
): DriverDeliveryHandoffPolicyView {
  const instruction = getDriverCustomerInstructionView(order);
  switch (instruction.status) {
    case "NONE":
      return {
        status: "DEFAULT_HAND_TO_CUSTOMER",
        defaultMethod: "HAND_TO_CUSTOMER",
        customerInstruction: null,
      };
    case "PRESENT":
      return {
        status: "CUSTOMER_INSTRUCTION_PRIORITY",
        defaultMethod: "HAND_TO_CUSTOMER",
        // Verbatim client text; the full comment is displayed by the existing
        // priority card, not repeated inside the handoff card.
        customerInstruction: instruction.text,
      };
    case "REVIEW_REQUIRED":
      return {
        status: "REVIEW_REQUIRED",
        defaultMethod: null,
        customerInstruction: null,
      };
  }
}

/**
 * The handoff policy is relevant only once the driver has the order and is
 * heading to the customer. Pure stage-visibility predicate reused by the UI.
 */
export function isDeliveryHandoffStage(stage: DriverDeliveryStage): boolean {
  return stage === "GO_TO_CUSTOMER" || stage === "ARRIVING_TO_CUSTOMER";
}
