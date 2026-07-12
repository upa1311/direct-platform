import type { ReactNode } from "react";
import Link from "next/link";

import styles from "./workspace-shell.module.css";

interface PageHeadingProps {
  eyebrow: string;
  title: string;
  description: string;
}

export function PageHeading({
  eyebrow,
  title,
  description,
}: PageHeadingProps) {
  return (
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

interface RouteCardItem {
  href: string;
  title: string;
  description: string;
}

export function RouteCards({ items }: { items: readonly RouteCardItem[] }) {
  return (
    <div className={styles.routeGrid}>
      {items.map((item) => (
        <Link className={styles.routeCard} href={item.href} key={item.href}>
          <span>
            <strong>{item.title}</strong>
            <small>{item.description}</small>
          </span>
          <span className={styles.routeArrow} aria-hidden="true">
            →
          </span>
        </Link>
      ))}
    </div>
  );
}

interface SectionPanelProps {
  title: string;
  description?: string;
  children?: ReactNode;
  action?: {
    href: string;
    label: string;
  };
}

export function SectionPanel({
  title,
  description,
  children,
  action,
}: SectionPanelProps) {
  return (
    <section className={styles.sectionPanel}>
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {children}
      {action ? (
        <Link className={styles.textAction} href={action.href}>
          {action.label}
          <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </section>
  );
}
