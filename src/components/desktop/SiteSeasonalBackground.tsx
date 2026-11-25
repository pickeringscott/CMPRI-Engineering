"use client";

import { SITE_SEASONAL_THEME } from "@/lib/ui/site-seasonal-theme";
import type { ReactNode } from "react";
import { SeasonalAnimationControlProvider } from "./seasonal-animation-controls";
import ThanksgivingBackground from "./ThanksgivingBackground";
import FootballBackground from "./FootballBackground";

// Register future seasonal artwork here so sign-in and the desktop change together.
const backgrounds = { thanksgiving: ThanksgivingBackground, "illinois-iowa": FootballBackground };

export default function SiteSeasonalBackground({ children }: { children: ReactNode }) {
  const Background = backgrounds[SITE_SEASONAL_THEME];
  return <SeasonalAnimationControlProvider><Background />{children}</SeasonalAnimationControlProvider>;
}
