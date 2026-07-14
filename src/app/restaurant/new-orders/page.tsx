import { redirect } from "next/navigation";

// Единый рабочий экран кухни заменяет отдельные «Новые заказы» (§12).
export default function RestaurantNewOrdersPage() {
  redirect("/restaurant/kitchen");
}
