"use client";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";

export default function AdminDriversPage() {
  const { state } = usePrototype();

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Водители"
        description="Список зарезервирован в общем состоянии, но водители ещё не подключены к заказам."
      />
      {state.drivers.length === 0 ? (
        <div className={flowStyles.emptyState}>
          Водители на этом этапе не добавлены.
        </div>
      ) : null}
    </>
  );
}
