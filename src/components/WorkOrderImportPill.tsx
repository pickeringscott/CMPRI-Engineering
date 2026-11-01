import { workOrderImportLabel, workOrderSourceTitle, type WorkOrderImportProvenance } from "@/lib/work-order-import-provenance";

export default function WorkOrderImportPill({ order }: { order: WorkOrderImportProvenance }) {
  const label = workOrderImportLabel(order);
  if (!label) return null;
  return (
    <span
      data-work-order-import-pill
      title={workOrderSourceTitle(order)}
      className="inline-flex max-w-full items-center rounded-full border border-sky-400/40 bg-sky-950/40 px-2 py-0.5 text-[10px] font-semibold leading-tight text-sky-200"
    >
      {label}
    </span>
  );
}
