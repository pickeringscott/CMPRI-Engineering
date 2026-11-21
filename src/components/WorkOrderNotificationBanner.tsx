"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { translateNotificationMessage } from "@/lib/i18n/notification-text";
import { formatWorkOrderNotification } from "@/lib/work-order-reference.js";
import Link from "next/link";
import type { WorkOrderNotification } from "@/lib/dashboard/work-order-notifications";

export default function WorkOrderNotificationBanner({
  notifications,
  onDismiss,
  dismissLabel,
}: {
  notifications: WorkOrderNotification[];
  onDismiss: () => void;
  dismissLabel: string;
}) {
  const { t } = useUiLanguage();
  const workOrderNotifications = notifications.filter(
    (notification): notification is WorkOrderNotification & { work_order_id: string } => !!notification.work_order_id,
  );
  if (!workOrderNotifications.length) return null;
  return (
    <section role="alert" aria-live="assertive" className="my-4 rounded-lg border border-sky-400/40 bg-sky-950/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-sky-100">
          {workOrderNotifications.length === 1 ? t("{count} work-order update", { count: workOrderNotifications.length }) : t("{count} work-order updates", { count: workOrderNotifications.length })}
        </h2>
        <button type="button" onClick={onDismiss} className="rounded-md border border-sky-400/40 px-2.5 py-1 text-xs font-semibold text-sky-100">
          {t(dismissLabel)}
        </button>
      </div>
      <ul className="mt-2 divide-y divide-sky-400/20">
        {workOrderNotifications.slice(0, 6).map((notification) => (
          <li key={notification.id}>
            <Link href={`/work-orders/${encodeURIComponent(notification.work_order_id)}`} className="block py-2 text-sm text-sky-100 hover:underline">
              {translateNotificationMessage(formatWorkOrderNotification(notification), t)}
            </Link>
          </li>
        ))}
      </ul>
      {workOrderNotifications.length > 6 && (
        <p className="mt-1 text-xs text-sky-200/80">{t("Showing 6 of {count} updates.", { count: workOrderNotifications.length })}</p>
      )}
    </section>
  );
}
