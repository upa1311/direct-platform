import kds from "@/components/kitchen/kitchen.module.css";
import { DriverWorkspace } from "@/components/driver/driver-workspace";
import styles from "./driver.module.css";

/**
 * Единый рабочий экран водителя «Заказы». Вход по имени и телефону, затем на
 * одном экране: профиль, статус/зона, счётчики «Новые / В работе», колокольчик,
 * новые предложения и активный заказ. Отдельных страниц «Предложения» и
 * «Текущий заказ» больше нет.
 */
export default function DriverPage() {
  // Заголовок «Заказы» уже есть в верхней навигации — второй крупный h1 на
  // телефоне только съедал бы высоту. Рабочий контент начинается сразу с
  // профиля/quick controls (до входа — с заголовка формы «Вход водителя»).
  return (
    <div className={kds.screen}>
      <div className={styles.container}>
        <DriverWorkspace />
      </div>
    </div>
  );
}
