import { redirect } from "next/navigation";

// Раздел «Меню и акции» переехал в «Конструктор ресторанов» (вкладки «Меню»,
// «Размеры», «Акции»). Маршрут сохранён и перенаправляет, чтобы не было битых
// ссылок. Данные (блюда, размеры, акции) не меняются.
export default function AdminMenuRedirectPage() {
  redirect("/admin/restaurant-builder");
}
