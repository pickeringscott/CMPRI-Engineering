import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import WorkOrderMentionsInbox from "@/components/WorkOrderMentionsInbox";
import StaffNotesUnread from "@/components/StaffNotesUnread";
import ProfileNotificationInbox from "@/components/ProfileNotificationInbox";
import GlobalModalHost from "@/components/GlobalModalHost";
import ModalTheme from "@/components/ModalTheme";
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
  themeColor: "#020617",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <ModalTheme />
        {children}
        <GlobalModalHost />
        <StaffNotesUnread />
        <WorkOrderMentionsInbox />
        <ProfileNotificationInbox />
      </body>
    </html>
  );
}
