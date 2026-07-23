import { redirect } from "next/navigation";

/**
 * Старый маршрут «Предложения» больше не существует как отдельная страница:
 * новые предложения теперь на едином рабочем экране `/driver`.
 */
export default function DriverOffersPage() {
  redirect("/driver");
}
