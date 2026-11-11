import type { NextConfig } from "next";

const CANONICAL_APP_URL = "https://cmpri-engineering.com";
const OCR_RUNTIME = ["node_modules/tesseract.js/**/*", "node_modules/tesseract.js-core/**/*", "node_modules/@tesseract.js-data/eng/4.0.0_best_int/**/*"];

const nextConfig: NextConfig = {
	// PDF.js uses createRequire(import.meta.url) for its native canvas runtime
	// and resolves its worker relative to the package. Preserve that boundary.
	serverExternalPackages: ["pdfjs-dist/legacy", "@napi-rs/canvas", "tesseract.js", "tesseract.js-core"],
	outputFileTracingIncludes: {
        "/api/preventive-maintenance/export": [".bridge/Copy of Preventative Maintenance Tracking - CMPRI.xlsx"],
        "/api/integrations/drive-po/*": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
        "/api/engineering/po-scan-review": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
        "/api/engineering/po-import-reviewed": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
		"/api/engineering/po-pdf-review": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
		"/*": [".next/server/chunks/**/*"],
		"/api/assets/documentation/ocr/dispatch": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/pdfjs-dist/package.json", "node_modules/pdfjs-dist/standard_fonts/**/*", "node_modules/pdfjs-dist/cmaps/**/*", "node_modules/pdfjs-dist/wasm/**/*", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*", ...OCR_RUNTIME],
		"/api/maintenance-reference": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/pdfjs-dist/package.json", "node_modules/pdfjs-dist/standard_fonts/**/*", "node_modules/pdfjs-dist/cmaps/**/*", "node_modules/pdfjs-dist/wasm/**/*", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*", ...OCR_RUNTIME],
		"/api/work-orders/*/troubleshooting": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/pdfjs-dist/package.json", "node_modules/pdfjs-dist/standard_fonts/**/*", "node_modules/pdfjs-dist/cmaps/**/*", "node_modules/pdfjs-dist/wasm/**/*", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*", ...OCR_RUNTIME],
		"/api/assets": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*"],
		"/api/assets/documentation": ["node_modules/pdfjs-dist/legacy/build/*.mjs", "node_modules/@napi-rs/canvas/**/*", "node_modules/@napi-rs/canvas-*/**/*", ...OCR_RUNTIME],
	},
	outputFileTracingExcludes: {
		"/*": [".env.example", ".env.local"],
	},
	async headers() {
		const immutable = [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }];
		const revalidate = [{ key: "Cache-Control", value: "no-cache" }];
		return [
			{ source: "/sw.js", headers: revalidate },
			// Assets are generated from pinned packages and the URL changes with their versions.
			{ source: "/local-ocr/tesseract-7.0.0-core-7.0.0-eng-1.0.0-pdf-6.3.289-app-v1/:path*", headers: immutable },
			{ source: "/backgrounds/thanksgiving-animated/cache-worker.js", headers: revalidate },
			{ source: "/backgrounds/thanksgiving-animated/index.html", headers: revalidate },
			{ source: "/backgrounds/thanksgiving-animated/:asset((?:index|scene|leaves)\\.[a-f0-9]{16}\\.(?:html|css|js))", headers: immutable },
			{ source: "/backgrounds/thanksgiving-animated/assets/:asset([a-z-]+\\.[a-f0-9]{16}\\.png)", headers: immutable },
		];
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
