import { redirect } from "next/navigation";

/**
 * Старый маршрут «Текущий заказ» больше не существует как отдельная страница:
 * активный заказ теперь на едином рабочем экране `/driver`.
 */
export default function DriverCurrentOrderPage() {
  redirect("/driver");
}
