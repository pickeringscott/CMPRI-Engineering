"use client";

import { SITE_SEASONAL_THEME } from "@/lib/ui/site-seasonal-theme";
import ThanksgivingBackground from "./ThanksgivingBackground";

// Register future seasonal artwork here so sign-in and the desktop change together.
const backgrounds = { thanksgiving: ThanksgivingBackground };

export default function SiteSeasonalBackground() {
  const Background = backgrounds[SITE_SEASONAL_THEME];
  return <Background />;
}
