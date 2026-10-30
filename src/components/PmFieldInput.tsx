"use client";
import type { PmFormField } from "@/lib/pm/catalog";
export default function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: PmFormField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const base = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-400 disabled:opacity-50";
  return (
    <label className="block min-w-0">
      <span className="text-xs font-semibold text-slate-300">{field.label}{field.required ? " *" : ""}</span>
      {field.type === "textarea" ? (
        <textarea required={field.required} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} rows={3} className={base} />
      ) : field.type === "select" || field.type === "yes-no" ? (
        <select required={field.required} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} className={base}>
          <option value="">Select…</option>
          {(field.type === "yes-no" ? ["Yes", "No"] : field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : (
        <input required={field.required} disabled={disabled} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} value={value} onChange={(event) => onChange(event.target.value)} className={base} />
      )}
    </label>
  );
}

