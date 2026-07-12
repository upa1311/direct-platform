export type AppMode = "customer" | "admin";

export type CustomerScreen =
  | "catalog"
  | "restaurant"
  | "cart"
  | "checkout"
  | "order"
  | "history";

export type DeliveryMode =
  | "PLATFORM_DRIVER"
  | "RESTAURANT_DELIVERY"
  | "PICKUP";

export type FoodArtworkKind =
  | "pizza"
  | "salad"
  | "noodles"
  | "kitchen"
  | "drink"
  | "dessert";

export type PaymentMethod = "QR" | "CASH";

export type PublicationStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "PUBLISHED"
  | "HIDDEN"
  | "ARCHIVED";

export type OrderStage = "review" | "replacement" | "payment" | "active";

export interface DemoRestaurant {
  id: string;
  name: string;
  description: string;
  address: string;
  phone: string;
  email: string;
  hours: string;
  lastOrderTime: string;
  preparationMinutes: number;
  zone: number;
  status: PublicationStatus;
  isAcceptingOrders: boolean;
  modes: DeliveryMode[];
  coverTone: "coral" | "violet" | "green" | "amber" | "blue";
  artwork: FoodArtworkKind;
  promo: string;
}

export interface DemoMenuItem {
  id: string;
  category: string;
  name: string;
  description: string;
  priceCents: number;
  weight: string;
  artwork: FoodArtworkKind;
  tone: DemoRestaurant["coverTone"];
  available: boolean;
}

export interface CartLine {
  itemId: string;
  quantity: number;
  unitPriceCents: number;
  variant: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  timestamp: string;
  entity: string;
  previousValue: string;
  newValue: string;
  reason: string;
}
