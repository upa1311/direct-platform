import type { ReactNode } from "react";

import { DriverHeader } from "@/components/workspaces/driver-header";
import styles from "@/components/workspaces/workspace-shell.module.css";

export default function DriverLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.workspaceShell}>
      <DriverHeader />
      <main className={styles.workspaceContent}>{children}</main>
    </div>
  );
}
