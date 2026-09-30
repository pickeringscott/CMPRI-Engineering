import type { NextConfig } from "next";

const CANONICAL_APP_URL = "https://cmpri-engineering.com";

const nextConfig: NextConfig = {
	async redirects() {
		return [
			{
				source: "/:path*",
				has: [{ type: "host", value: ".*\\.vercel\\.app" }],
				destination: `${CANONICAL_APP_URL}/:path*`,
				permanent: true,
			},
		];
	},
};

export default nextConfig;
