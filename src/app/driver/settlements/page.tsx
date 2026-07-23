"use client";

import Link from "next/link";

import kds from "@/components/kitchen/kitchen.module.css";
import { PageHeading, SectionPanel } from "@/components/workspaces/route-content";
import { useAuthenticatedDriverId } from "@/components/driver/driver-session";
import styles from "../driver.module.css";

/**
 * Раздел «Расчёты» водителя. Доступен только при активной сессии; без входа —
 * приглашение войти. Честная заглушка без выдуманных сумм: финансовой модели
 * водителя пока нет.
 */
export default function DriverSettlementsPage() {
  const sessionDriverId = useAuthenticatedDriverId();

  if (sessionDriverId === null) {
    return (
      <div className={kds.screen}>
        <div className={styles.container}>
          <div className={styles.notice} role="status">
            Войдите в систему под своим именем и номером телефона, чтобы открыть
            кабинет водителя.
          </div>
          <Link className={styles.orderLink} href="/driver">
            Перейти ко входу
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeading
        eyebrow="Водитель"
        title="Расчёты"
        description="Здесь будут показаны выполненные доставки, заработок и история расчётов."
      />
      <SectionPanel
        title="Данных пока нет"
        description="Раздел появится вместе с учётом выполненных доставок."
      />
    </>
  );
}
