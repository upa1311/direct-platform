"use client";

import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";

import { loadMenuMediaBlob } from "@/prototype/media-store";
import styles from "./menu-media.module.css";

/**
 * Object URL фотографии по media id. URL создаётся только для отображения и
 * освобождается в cleanup (revokeObjectURL) при смене id и размонтировании —
 * замена или удаление фотографии не оставляет бесконтрольных object URL.
 */
export function useMenuMediaUrl(mediaId: string | null): string | null {
  // URL хранится вместе с id, для которого он создан: при смене id устаревший
  // URL не показывается (он уже revoked в cleanup), а setState происходит
  // только асинхронно — после загрузки Blob.
  const [loaded, setLoaded] = useState<{
    mediaId: string;
    url: string;
  } | null>(null);

  useEffect(() => {
    if (!mediaId) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void loadMenuMediaBlob(mediaId).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ mediaId, url: objectUrl });
    });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [mediaId]);

  return mediaId && loaded?.mediaId === mediaId ? loaded.url : null;
}

/**
 * Безопасное отображение фотографии блюда по media id. Пока изображения нет
 * (нет id, Blob не найден или ещё грузится) — нейтральный placeholder, а не
 * сломанная картинка.
 */
export function MenuMediaImage({
  mediaId,
  alt,
  className,
}: {
  mediaId: string | null;
  alt: string;
  className?: string;
}) {
  const url = useMenuMediaUrl(mediaId);
  const outerClassName = className
    ? `${styles.mediaFrame} ${className}`
    : styles.mediaFrame;

  if (!url) {
    return (
      <div className={outerClassName} role="img" aria-label={alt}>
        <ImageOff className={styles.placeholderIcon} aria-hidden="true" />
      </div>
    );
  }
  return (
    // Blob-URL локального origin: next/image здесь не применим.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} className={outerClassName} />
  );
}
