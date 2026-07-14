import type { ReactNode } from "react";

import { RestaurantHeader } from "@/components/workspaces/restaurant-header";
import { RestaurantWorkspaceProvider } from "@/components/workspaces/restaurant-workspace";
import styles from "@/components/workspaces/workspace-shell.module.css";

export default function RestaurantLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <RestaurantWorkspaceProvider>
      <div className={styles.workspaceShell}>
        <RestaurantHeader />
        <main className={styles.workspaceContent}>{children}</main>
      </div>
    </RestaurantWorkspaceProvider>
  );
}
