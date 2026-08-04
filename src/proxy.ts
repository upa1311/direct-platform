export { auth as proxy } from "@/auth";

export const config = {
  matcher: [
    "/admin/delivery-quotes/:path*",
  ],
};
