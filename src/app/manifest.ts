import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CMPRI Engineering",
    short_name: "CMPRI",
    description: "CMPRI Engineering work orders",
    start_url: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      { src: "/cmpri-push-icon.svg", sizes: "192x192", type: "image/svg+xml" },
      { src: "/cmpri-push-icon.svg", sizes: "512x512", type: "image/svg+xml" },
    ],
  };
}
