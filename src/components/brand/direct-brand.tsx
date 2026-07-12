import Image from "next/image";

interface DirectBrandProps {
  className?: string;
  compact?: boolean;
  inverted?: boolean;
}

export function DirectBrand({
  className = "",
  compact = false,
  inverted = false,
}: DirectBrandProps) {
  return (
    <span
      className={`direct-brand ${compact ? "is-compact" : ""} ${inverted ? "is-inverted" : ""} ${className}`.trim()}
      aria-label="Direct"
    >
      <span className="direct-brand-speed" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <strong><b>D</b>irect</strong>
    </span>
  );
}

interface DirectLogoImageProps {
  priority?: boolean;
}

export function DirectLogoImage({ priority = false }: DirectLogoImageProps) {
  return (
    <Image
      className="direct-logo-image"
      src="/brand/direct-logo.jpg"
      width={1254}
      height={1254}
      sizes="(max-width: 720px) 82vw, 460px"
      priority={priority}
      alt="Логотип Direct с оранжевым автомобилем доставки"
    />
  );
}
