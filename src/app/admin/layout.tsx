import type { ReactNode } from "react";

import { AdminHeader } from "@/components/workspaces/admin-header";
import { AdminSidebar } from "@/components/workspaces/admin-sidebar";
import styles from "@/components/workspaces/workspace-shell.module.css";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.adminShell}>
      <AdminSidebar />
      <div className={styles.adminMain}>
        <AdminHeader />
        <main className={styles.adminContent}>{children}</main>
      </div>
    </div>
  );
}
