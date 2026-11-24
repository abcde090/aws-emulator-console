import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The AWS SDK clients run on the server only; load them with Node's own require.
  serverExternalPackages: Object.keys(pkg.dependencies).filter((name) => name.startsWith("@aws-sdk/")),
  experimental: {
    serverActions: {
      // S3 uploads go through a server action.
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
