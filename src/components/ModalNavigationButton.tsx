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
  return (
    <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href={href} className={className}>
      {children}
    </button>
  );
}
