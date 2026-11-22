import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CMPRI Engineering",
    short_name: "CMPRI Engineering",
    description: "CMPRI Engineering work orders",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      { src: "/cmpri-engineering-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/cmpri-engineering-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
