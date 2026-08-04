import { signOut } from "@/auth";
import { catalogMetadata } from "@/lib/delivery-quotes/catalog";

import { DeliveryQuoteConsole } from "./delivery-quote-console";
import styles from "./delivery-quotes.module.css";

export default function DeliveryQuotesPage() {
  const metadata = catalogMetadata();
  return (
    <section className={styles.workspace} data-testid="delivery-quote-console">
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>DirectDelivery · Admin V2</p>
          <h1>Котировки доставки</h1>
          <p>
            Серверный OSRM-расчёт, утверждённый checkpoint и неизменяемый снимок тарифа.
          </p>
        </div>
        <div className={styles.heroActions}>
          <span className={styles.secureBadge}>● защищённая сессия</span>
          <form action={async () => {
            "use server";
            await signOut({ redirectTo: "/admin/delivery-quote-login" });
          }}>
            <button className={styles.secondaryButton} type="submit">Выйти</button>
          </form>
        </div>
      </header>
      <DeliveryQuoteConsole metadata={metadata} />
    </section>
  );
}
