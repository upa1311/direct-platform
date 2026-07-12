import Image from "next/image";
import Link from "next/link";

import styles from "./workspace-shell.module.css";

interface BrandLinkProps {
  applicationName: string;
  href: string;
  priority?: boolean;
}

export function BrandLink({
  applicationName,
  href,
  priority = false,
}: BrandLinkProps) {
  return (
    <Link className={styles.brandLink} href={href}>
      <Image
        className={styles.brandLogo}
        src="/brand/direct-logo.jpg"
        width={56}
        height={56}
        priority={priority}
        alt="Логотип Direct"
      />
      <span className={styles.brandCopy}>
        <strong>Direct</strong>
        <span>{applicationName}</span>
      </span>
    </Link>
  );
}
