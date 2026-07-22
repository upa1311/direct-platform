import type { ReactNode } from "react";

import { DriverHeader } from "@/components/workspaces/driver-header";
import { DriverOfferRuntime } from "@/components/driver/driver-offer-runtime";
import { DriverOfferSoundPlayer } from "@/components/driver/driver-offer-sound";
import styles from "@/components/workspaces/workspace-shell.module.css";

export default function DriverLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.workspaceShell}>
      <DriverHeader />
      {/* Невидимые сервисы кабинета: работают на всех маршрутах /driver/*.
          Runtime актуализирует предложения и держит таймер истечения; player —
          единственный планировщик звукового сигнала. */}
      <DriverOfferRuntime />
      <DriverOfferSoundPlayer />
      <main className={styles.workspaceContent}>{children}</main>
    </div>
  );
}
