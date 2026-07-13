import type { ReactNode } from "react";

import { ActiveOrderStrip } from "@/components/order-flow/active-order-strip";
import { ClientAddressConfirmationProvider } from "@/components/order-flow/client-address-confirmation";
import { ClientCartUiProvider } from "@/components/order-flow/client-cart-ui";
import { ClientGuidedFlow } from "@/components/order-flow/client-guided-flow";
import { ClientHeader } from "@/components/workspaces/client-header";
import styles from "@/components/workspaces/workspace-shell.module.css";

export default function ClientLayout({ children }: { children: ReactNode }) {
  return (
    <ClientCartUiProvider>
      <ClientAddressConfirmationProvider>
        <div className={styles.workspaceShell}>
          <ClientHeader />
          <ActiveOrderStrip />
          <main className={styles.workspaceContent}>
            <ClientGuidedFlow />
            {children}
          </main>
        </div>
      </ClientAddressConfirmationProvider>
    </ClientCartUiProvider>
  );
}
