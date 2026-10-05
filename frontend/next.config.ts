import type { NextConfig } from "next";

function getBackendUrl(): string {
  const raw = (process.env.BACKEND_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").trim();
  const unquoted = raw.replace(/^["']|["']$/g, "").trim();
  if (!unquoted) return "http://localhost:4000";
  let formatted = unquoted;
  if (!formatted.startsWith("http://") && !formatted.startsWith("https://") && !formatted.startsWith("/")) {
    formatted = `https://${formatted}`;
  }
  return formatted.replace(/\/+$/, "");
}

const nextConfig: NextConfig = {
  async rewrites() {
    const backendUrl = getBackendUrl();

    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/health",
        destination: `${backendUrl}/health`,
      },
    ];
  },
};

export default nextConfig;
