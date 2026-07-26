import type { ReactNode } from "react";

import { DriverHeader } from "@/components/workspaces/driver-header";
import { DriverOfferSoundPlayer } from "@/components/driver/driver-offer-sound";
import styles from "@/components/workspaces/workspace-shell.module.css";

export default function DriverLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.workspaceShell}>
      <DriverHeader />
      {/* Player is the only scheduler for the local driver offer sound.
          Dispatch reconciliation is owned globally by PrototypeProvider. */}
      <DriverOfferSoundPlayer />
      <main className={styles.workspaceContent}>{children}</main>
    </div>
  );
}
