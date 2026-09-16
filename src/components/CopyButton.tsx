"use client";

import { useState } from "react";

type CopyButtonProps = {
  text: string;
  label?: string;
  className?: string;
};

export default function CopyButton({ text, label = "Copy", className = "" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may be unavailable (e.g. insecure context). Silently ignore.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors ${
        copied
          ? "border-emerald-400/50 bg-emerald-950/40 text-emerald-200"
          : "border-slate-600 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-white"
      } ${className}`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
