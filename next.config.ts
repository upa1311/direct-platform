import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Восстановление: страница, открытая по LAN-адресу (http://192.168.x.x:3000),
  // без этого списка не получает dev-ресурсы Next (блокируются как cross-origin),
  // и клиентская часть не оживает. Только для локальной разработки.
  allowedDevOrigins: ["192.168.1.45", "192.168.1.*"],
};

export default nextConfig;
