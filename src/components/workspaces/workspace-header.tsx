import type { ReactNode } from "react";
import Link from "next/link";

import { BrandLink } from "./brand-link";
import { WorkspaceNav, type WorkspaceNavItem } from "./workspace-nav";
import styles from "./workspace-shell.module.css";

interface WorkspaceHeaderProps {
  applicationName: string;
  navAriaLabel: string;
  navItems: readonly WorkspaceNavItem[];
  rightSlot?: ReactNode;
}

export function WorkspaceHeader({
  applicationName,
  navAriaLabel,
  navItems,
  rightSlot,
}: WorkspaceHeaderProps) {
  return (
    <header className={styles.workspaceHeader}>
      <div className={styles.headerTopline}>
        <BrandLink
          applicationName={applicationName}
          href={navItems[0]?.href ?? "/"}
          priority
        />
        <div className={styles.headerActions}>
          {rightSlot}
          <Link className={styles.quietLink} href="/">
            Выбрать другую роль
          </Link>
        </div>
      </div>
      <WorkspaceNav ariaLabel={navAriaLabel} items={navItems} />
    </header>
  );
}
