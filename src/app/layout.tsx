import type { Metadata } from "next";
import type { ReactNode } from "react";
import DashboardAssistant from "@/components/DashboardAssistant";
import GlobalModalHost from "@/components/GlobalModalHost";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CMPRI-Engineering",
  description: "Hotel Engineering & Maintenance",
  openGraph: {
    title: "CMPRI-Engineering",
    description: "Hotel Engineering & Maintenance",
  },
  twitter: {
    title: "CMPRI-Engineering",
    description: "Hotel Engineering & Maintenance",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <DashboardAssistant />
        <GlobalModalHost />
      </body>
    </html>
  );
}
