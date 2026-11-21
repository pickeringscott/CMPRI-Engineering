"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import type { ReactNode } from "react";

export default function ModalNavigationButton({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useUiLanguage();
  return (
    <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href={href} className={className}>
      {typeof children === "string" ? t(children) : children}
    </button>
  );
}
