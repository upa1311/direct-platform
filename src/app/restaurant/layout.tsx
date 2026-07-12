import type { ReactNode } from "react";

import { RestaurantHeader } from "@/components/workspaces/restaurant-header";
import styles from "@/components/workspaces/workspace-shell.module.css";

export default function RestaurantLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className={styles.workspaceShell}>
      <RestaurantHeader />
      <main className={styles.workspaceContent}>{children}</main>
    </div>
  );
}
