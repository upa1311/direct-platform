import { redirect } from "next/navigation";

// Отдельного актуального обзора пока нет — ведём на единый экран кухни (§6).
export default function RestaurantPage() {
  redirect("/restaurant/kitchen");
}
