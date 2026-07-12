import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { PrototypeProvider } from "@/prototype/prototype-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Direct — рабочий прототип платформы",
  description: "Маршрутный каркас приложений Direct для клиента, ресторана, водителя и администратора.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      data-scroll-behavior="smooth"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body>
        <PrototypeProvider>{children}</PrototypeProvider>
      </body>
    </html>
  );
}
