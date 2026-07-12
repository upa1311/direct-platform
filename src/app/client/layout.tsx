import type { ReactNode } from "react";

import { ActiveOrderStrip } from "@/components/order-flow/active-order-strip";
import { ClientHeader } from "@/components/workspaces/client-header";
import styles from "@/components/workspaces/workspace-shell.module.css";

export default function ClientLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.workspaceShell}>
      <ClientHeader />
      <ActiveOrderStrip />
      <main className={styles.workspaceContent}>{children}</main>
    </div>
  );
}
