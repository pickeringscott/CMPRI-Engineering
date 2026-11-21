import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import WorkOrderMentionsInbox from "@/components/WorkOrderMentionsInbox";
import StaffNotesUnread from "@/components/StaffNotesUnread";
import ProfileNotificationInbox from "@/components/ProfileNotificationInbox";
import GlobalModalHost from "@/components/GlobalModalHost";
import UserPresence from "@/components/UserPresence";
import ModalTheme from "@/components/ModalTheme";
import SiteSeasonalBackground from "@/components/desktop/SiteSeasonalBackground";
import UiLanguageProvider from "@/components/UiLanguageProvider";
import { SITE_SEASONAL_THEME, SITE_THEME_COLOR } from "@/lib/ui/site-seasonal-theme";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CMPRI Engineering",
  applicationName: "CMPRI Engineering",
  description: "Hotel Engineering & Maintenance",
  openGraph: {
    title: "CMPRI Engineering",
    description: "Hotel Engineering & Maintenance",
  },
  twitter: {
    title: "CMPRI Engineering",
    description: "Hotel Engineering & Maintenance",
  },
};

export const viewport: Viewport = {
  themeColor: SITE_THEME_COLOR,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-cmpri-site-theme={SITE_SEASONAL_THEME} className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <UiLanguageProvider>
        <SiteSeasonalBackground />
        <ModalTheme />
        <UserPresence />
        {children}
        <GlobalModalHost />
        <StaffNotesUnread />
        <WorkOrderMentionsInbox />
        <ProfileNotificationInbox />
        </UiLanguageProvider>
      </body>
    </html>
  );
}
