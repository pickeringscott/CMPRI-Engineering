import type { MetadataRoute } from "next";
import { SITE_THEME_COLOR } from "@/lib/ui/site-seasonal-theme";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CMPRI Engineering",
    short_name: "CMPRI Engineering",
    description: "CMPRI Engineering work orders",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: SITE_THEME_COLOR,
    theme_color: SITE_THEME_COLOR,
    icons: [
      { src: "/cmpri-engineering-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/cmpri-engineering-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
