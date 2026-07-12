"use client";

import { useState } from "react";
import { AdminConsole } from "@/components/admin/admin-console";
import { CustomerApp } from "@/components/customer/customer-app";
import { DemoHeader } from "@/components/prototype/demo-header";
import type { AppMode } from "@/types/prototype";

export function DirectPrototype() {
  const [mode, setMode] = useState<AppMode>("customer");
  const [resetVersion, setResetVersion] = useState(0);

  return (
    <div className={`prototype-root mode-${mode}`}>
      <DemoHeader
        mode={mode}
        onModeChange={setMode}
        onReset={() => setResetVersion((version) => version + 1)}
      />
      {mode === "customer" ? (
        <CustomerApp key={`customer-${resetVersion}`} />
      ) : (
        <AdminConsole key={`admin-${resetVersion}`} />
      )}
    </div>
  );
}
