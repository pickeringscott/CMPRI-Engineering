import type { NextConfig } from "next";

const CANONICAL_APP_URL = "https://cmpri-engineering.com";

const nextConfig: NextConfig = {
	outputFileTracingIncludes: {
		"/*": [".next/server/chunks/**/*"],
	},
	outputFileTracingExcludes: {
		"/*": [".env.example", ".env.local"],
	},
	async redirects() {
		return [
			{
				source: "/:path*",
				has: [{ type: "host", value: ".*\\.vercel\\.app" }],
				missing: [{ type: "header", key: "x-vercel-cron-schedule" }],
				destination: `${CANONICAL_APP_URL}/:path*`,
				permanent: true,
			},
		];
	},
};

export default nextConfig;
