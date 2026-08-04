import { signIn } from "@/auth";

import styles from "../delivery-quotes/delivery-quotes.module.css";

export default function DeliveryQuoteLoginPage() {
  const hasE2eLogin = Boolean(
    process.env.AUTH_E2E_CREDENTIAL_SECRET && process.env.VERCEL_ENV !== "production",
  );

  return (
    <section className={styles.loginCard} data-testid="quote-login">
      <p className={styles.eyebrow}>DirectDelivery · защищённый контур</p>
      <h1>Котировки доставки</h1>
      <p>
        Вход разрешён только GitHub-пользователям из серверного allowlist.
        История, адреса и расчёты не передаются неавторизованным посетителям.
      </p>
      <form action={async () => {
        "use server";
        await signIn("github", { redirectTo: "/admin/delivery-quotes" });
      }}>
        <button className={styles.primaryButton} type="submit">Войти через GitHub</button>
      </form>
      {hasE2eLogin ? (
        <details className={styles.testLogin}>
          <summary>Локальный E2E-вход</summary>
          <form action={async (formData) => {
            "use server";
            await signIn("e2e", {
              githubUserId: formData.get("githubUserId"),
              secret: formData.get("secret"),
              redirectTo: "/admin/delivery-quotes",
            });
          }}>
            <label>GitHub user ID<input name="githubUserId" required /></label>
            <label>E2E secret<input name="secret" type="password" required /></label>
            <button className={styles.secondaryButton} type="submit">Войти локально</button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
