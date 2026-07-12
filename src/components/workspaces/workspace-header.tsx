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
  showWorkspaceLink?: boolean;
  brandHref?: string;
}

export function WorkspaceHeader({
  applicationName,
  navAriaLabel,
  navItems,
  rightSlot,
  showWorkspaceLink = true,
  brandHref,
}: WorkspaceHeaderProps) {
  return (
    <header className={styles.workspaceHeader}>
      <div className={styles.headerTopline}>
        <BrandLink
          applicationName={applicationName}
          href={brandHref ?? navItems[0]?.href ?? "/workspaces"}
          priority
        />
        <div className={styles.headerActions}>
          {rightSlot}
          {showWorkspaceLink ? (
            <Link className={styles.quietLink} href="/workspaces">
              Выбрать другую роль
            </Link>
          ) : null}
        </div>
      </div>
      <WorkspaceNav ariaLabel={navAriaLabel} items={navItems} />
    </header>
  );
}
