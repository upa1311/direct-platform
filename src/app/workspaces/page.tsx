import Image from "next/image";
import Link from "next/link";
import { Building2, Car, ShieldCheck, ShoppingBag } from "lucide-react";

import styles from "@/components/workspaces/workspace-shell.module.css";

const roles = [
  { href: "/client/catalog", title: "Клиент", description: "Каталог ресторанов и заказы", Icon: ShoppingBag },
  { href: "/restaurant", title: "Ресторан", description: "Новые и активные заказы", Icon: Building2 },
  { href: "/driver", title: "Водитель", description: "Предложения и текущий заказ", Icon: Car },
  { href: "/admin", title: "Администратор", description: "Управление платформой Direct", Icon: ShieldCheck },
] as const;

export default function WorkspacesPage() {
  return (
    <main className={styles.roleHome}>
      <div className={styles.roleContainer}>
        <section className={styles.roleIntro}>
          <div className={styles.homeBrand}>
            <Image className={styles.homeLogo} src="/brand/direct-logo.jpg" width={112} height={112} priority alt="Логотип Direct" />
            <span className={styles.homeBrandText}><strong>Direct</strong><span>Доставка еды в Бендерах</span></span>
          </div>
          <p className={styles.eyebrow}>Технический экран прототипа</p>
          <h1>Рабочие пространства</h1>
          <p>Выберите роль для ручной проверки текущего этапа проекта.</p>
        </section>
        <nav className={styles.roleGrid} aria-label="Выбор рабочего пространства">
          {roles.map(({ href, title, description, Icon }) => (
            <Link className={styles.roleCard} href={href} key={href}>
              <span className={styles.roleCardCopy}><strong>{title}</strong><span>{description}</span></span>
              <Icon className={styles.roleIcon} aria-hidden="true" />
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
