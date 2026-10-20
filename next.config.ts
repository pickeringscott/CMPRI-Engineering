import type { NextConfig } from "next";

const CANONICAL_APP_URL = "https://cmpri-engineering.com";

const nextConfig: NextConfig = {
	// PDF.js uses createRequire(import.meta.url) for its native canvas runtime
	// and resolves its worker relative to the package. Preserve that boundary.
	serverExternalPackages: ["pdfjs-dist/legacy", "@napi-rs/canvas"],
	outputFileTracingIncludes: {
        "/api/integrations/drive-po/*": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
        "/api/engineering/po-scan-review": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
        "/api/engineering/po-import-reviewed": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
		"/api/engineering/po-pdf-review": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
		"/*": [".next/server/chunks/**/*"],
		"/api/maintenance-reference": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
		"/api/assets": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
		"/api/assets/documentation": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
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
