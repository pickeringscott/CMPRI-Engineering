// Presentation only. Server authorization must never rely on these signals.
export function isInstalledMobileApp(context: {
  standalone: boolean;
  iosStandalone?: boolean;
  mobile?: boolean;
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}) {
  const mobile = context.mobile === true || /Android|iPhone|iPad|iPod/i.test(context.userAgent)
    || (context.platform === "MacIntel" && (context.maxTouchPoints || 0) > 1);
  return mobile && (context.standalone || context.iosStandalone === true);
}
