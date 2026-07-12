"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./workspace-shell.module.css";

export interface WorkspaceNavItem {
  href: string;
  label: string;
}

interface WorkspaceNavProps {
  ariaLabel: string;
  items: readonly WorkspaceNavItem[];
  variant?: "header" | "sidebar";
}

export function WorkspaceNav({
  ariaLabel,
  items,
  variant = "header",
}: WorkspaceNavProps) {
  const pathname = usePathname();

  return (
    <nav
      className={
        variant === "sidebar" ? styles.sidebarNav : styles.headerNav
      }
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const isActive = pathname === item.href;

        return (
          <Link
            className={
              variant === "sidebar"
                ? `${styles.sidebarNavLink} ${isActive ? styles.navLinkActive : ""}`
                : `${styles.headerNavLink} ${isActive ? styles.navLinkActive : ""}`
            }
            href={item.href}
            key={item.href}
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
