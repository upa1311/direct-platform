import { PrototypeResetButton } from "@/components/order-flow/prototype-reset-button";
import styles from "./workspace-shell.module.css";

export function AdminHeader() {
  return (
    <header className={styles.adminHeader}>
      <div>
        <p className={styles.eyebrow}>Direct</p>
        <strong>Панель управления</strong>
      </div>
      <div className={styles.headerActions}>
        <PrototypeResetButton />
        <span className={styles.adminRole}>Главный администратор</span>
      </div>
    </header>
  );
}
