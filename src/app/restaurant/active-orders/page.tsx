import { redirect } from "next/navigation";

// Единый рабочий экран кухни заменяет отдельные «Активные заказы» (§12).
export default function RestaurantActiveOrdersPage() {
  redirect("/restaurant/kitchen");
}
