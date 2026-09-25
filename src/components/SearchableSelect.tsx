"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type SearchableSelectOption = {
  value: string;
  label: string;
  group?: string;
  keywords?: string[];
};

type Props = {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  topSuggestions?: number;
  noMatchesText?: string;
  onDismiss?: () => void;
  footerActionLabel?: string;
  onFooterAction?: () => void;
  showSuggestionsOnOpen?: boolean;
};

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreText(text: string, query: string, isLabel: boolean) {
  if (!text || !query) return -1;
  if (text === query) return isLabel ? 1400 : 1300;
  if (text.startsWith(query)) return isLabel ? 1250 : 1150;
  const words = text.split(/\s+/);
  if (words.some((word) => word === query)) return isLabel ? 1150 : 1050;
  if (words.some((word) => word.startsWith(query))) return isLabel ? 1050 : 950;
  if (query.length < 2) return -1;
  const index = text.indexOf(query);
  return index >= 0 ? (isLabel ? 850 : 750) - Math.min(index, 100) : -1;
}

function scoreOption(option: SearchableSelectOption, rawQuery: string) {
  const query = normalize(rawQuery);
  if (!query) return 1;
  const label = normalize(option.label);
  const group = normalize(option.group || "");
  const keywords = (option.keywords || []).map(normalize).filter(Boolean);
  let best = scoreText(label, query, true);
  best = Math.max(best, scoreText(group, query, false));
  for (const keyword of keywords) best = Math.max(best, scoreText(keyword, query, false));
  return best;
}

export default function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = "Type to search...",
  disabled = false,
  required = false,
  topSuggestions = 2,
  noMatchesText,
  onDismiss,
  footerActionLabel,
  onFooterAction,
  showSuggestionsOnOpen = true,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const selected = useMemo(() => options.find((option) => option.value === value), [options, value]);

  const browsingCurrentValue = !!selected && normalize(query) === normalize(selected.label);

  const ranked = useMemo(() => {
    // When the field first opens with its saved value visible, browse the full
    // option set instead of filtering down to only the current value. This is
    // what makes the two best choices + See more pattern work consistently.
    const q = browsingCurrentValue ? "" : query.trim();
    return options
      .map((option, originalIndex) => ({ option, originalIndex, score: scoreOption(option, q) }))
      .filter((item) => !q || item.score >= 0)
      .sort((a, b) => {
        if (!q) return a.originalIndex - b.originalIndex;
        if (b.score !== a.score) return b.score - a.score;
        return a.originalIndex - b.originalIndex;
      })
      .map((item) => item.option);
  }, [browsingCurrentValue, options, query]);

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
        setExpanded(false);
        setQuery(selected?.label || "");
        onDismiss?.();
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [onDismiss, selected?.label]);


  function positionMenu() {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof window === "undefined") return;

    const rect = wrapper.getBoundingClientRect();
    const padding = 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const available = Math.max(40, Math.min(320, spaceBelow - 12));

    setMenuStyle({
      position: "fixed",
      left: Math.max(padding, Math.min(rect.left, window.innerWidth - padding - rect.width)),
      width: Math.max(160, Math.min(rect.width, window.innerWidth - padding * 2)),
      maxHeight: available,
      zIndex: 2147483000,
      top: rect.bottom + 4,
      bottom: "auto",
    });
  }

  useEffect(() => {
    if (!open) return;
    positionMenu();
    const reposition = () => positionMenu();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  function commit(option?: SearchableSelectOption) {
    if (!option) return;
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
    setExpanded(false);
  }

  function openBrowse() {
    if (disabled) return;
    setOpen(true);
    setExpanded(false);
    setHighlightedIndex(0);
    // Keep the current selection visible when entering edit/browse mode.
    // Typing replaces/refines it; simply opening and clicking away is a no-op.
    setQuery(selected?.label || "");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function toggleOpen() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      setExpanded(false);
      setQuery(selected?.label || "");
      onDismiss?.();
    } else {
      openBrowse();
    }
  }

  const browseOptions = useMemo(() => {
    if (!showSuggestionsOnOpen && !query.trim() && !expanded) return [];
    if ((query.trim() && !browsingCurrentValue) || expanded) return ranked;
    return ranked.slice(0, Math.max(topSuggestions, 1));
  }, [browsingCurrentValue, expanded, query, ranked, showSuggestionsOnOpen, topSuggestions]);

  const visibleOptions = (query.trim() && !browsingCurrentValue) || expanded ? ranked : browseOptions;
  const canSeeMore = showSuggestionsOnOpen && (!query.trim() || browsingCurrentValue) && !expanded && ranked.length > visibleOptions.length;

  useEffect(() => {
    if (open && expanded && selectedRowRef.current) {
      requestAnimationFrame(() => selectedRowRef.current?.scrollIntoView({ block: "center" }));
    }
  }, [expanded, open]);

  const inferredNoMatch = useMemo(() => {
    if (noMatchesText) return noMatchesText;
    const p = placeholder.toLowerCase();
    if (p.includes("room") || p.includes("location")) {
      return /^\s*\d{2,4}\s*$/.test(query) ? "Room does not exist" : "Location does not exist";
    }
    return "No matches";
  }, [noMatchesText, placeholder, query]);

  return (
    <div ref={wrapperRef} className="relative w-full">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={open ? query : selected?.label || ""}
          required={required}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-label={placeholder}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && visibleOptions[highlightedIndex] ? `${listId}-${highlightedIndex}` : undefined}
          onClick={() => { if (!open) openBrowse(); }}
          onFocus={() => { if (!open) openBrowse(); }}
          onChange={(event) => { setQuery(event.target.value); setHighlightedIndex(0); setOpen(true); setExpanded(true); }}
          onBlur={(event) => {
            if (!wrapperRef.current?.contains(event.relatedTarget as Node | null)) {
              setOpen(false); setExpanded(false); onDismiss?.();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" && open) {
              if (!event.shiftKey && query.trim() && !browsingCurrentValue && ranked.length) {
                commit(ranked[Math.min(highlightedIndex, ranked.length - 1)]);
              } else {
                setOpen(false); setExpanded(false);
              }
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault(); setOpen(true); setExpanded(true);
              setHighlightedIndex((index) => Math.min(index + 1, Math.max(ranked.length - 1, 0))); return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault(); setOpen(true); setExpanded(true);
              setHighlightedIndex((index) => Math.max(index - 1, 0)); return;
            }
            if (event.key === "Enter" && open && ranked.length) {
              event.preventDefault(); commit(ranked[Math.min(highlightedIndex, ranked.length - 1)]); return;
            }
            if (event.key === "Escape") {
              event.preventDefault(); setOpen(false); setExpanded(false); setQuery(selected?.label || ""); onDismiss?.(); return;
            }
          }}
          className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 pr-8 text-[15px] text-white outline-none placeholder:text-slate-500 focus:border-sky-400"
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label={open ? "Hide choices" : "Show choices"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleOpen}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-slate-300 hover:text-white"
        >
          <span aria-hidden="true" className="text-[14px] leading-none">{open ? "▲" : "▼"}</span>
        </button>
      </div>

      {open && !disabled && (
        <div id={listId} role="listbox" style={menuStyle} className="overflow-y-auto rounded-lg border border-slate-600 bg-slate-900 py-0.5 shadow-2xl">
          {visibleOptions.length ? (
            <>
              {visibleOptions.map((option, optionIndex) => {
                const highlighted = optionIndex === highlightedIndex;
                const selectedOption = option.value === value;
                const previousGroup = optionIndex > 0 ? visibleOptions[optionIndex - 1]?.group : undefined;
                const showGroup = Boolean(option.group && option.group !== previousGroup);
                return (
                  <div key={`${option.value}-${optionIndex}`}>
                    {showGroup && (
                      <div className="border-t border-slate-800 bg-slate-950/70 px-2 py-1 text-[13px] font-bold leading-4 text-slate-300 first:border-t-0">
                        {option.group}
                      </div>
                    )}
                    <button
                      ref={selectedOption ? selectedRowRef : undefined}
                      type="button"
                      role="option"
                      id={`${listId}-${optionIndex}`}
                      tabIndex={-1}
                      aria-selected={selectedOption}
                      onMouseEnter={() => setHighlightedIndex(optionIndex)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => commit(option)}
                      className={`block w-full px-2.5 py-1 text-left text-[13px] leading-[1.15] ${
                        highlighted
                          ? "bg-sky-500/35 text-sky-50"
                          : selectedOption
                            ? "bg-sky-950/70 text-sky-100"
                            : "bg-slate-900 text-white hover:bg-sky-900/45"
                      }`}
                    >
                      <span className="block truncate">{option.label}</span>
                    </button>
                  </div>
                );
              })}
              {canSeeMore && (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { setExpanded(true); setQuery(selected?.label || ""); }}
                  className="block w-full border-t border-slate-700 px-2 py-1 text-left text-[13px] font-semibold leading-5 text-sky-300 hover:bg-sky-500/15 hover:text-sky-200"
                >
                  See more…
                </button>
              )}
              {footerActionLabel && onFooterAction && (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    setExpanded(false);
                    setQuery(selected?.label || "");
                    onFooterAction();
                  }}
                  className="block w-full border-t border-slate-700 px-2 py-1 text-left text-[13px] font-semibold leading-5 text-amber-300 hover:bg-amber-400/10 hover:text-amber-200"
                >
                  {footerActionLabel}
                </button>
              )}
            </>
          ) : (
            <div className="px-3 py-2 text-[13px] text-slate-400">{inferredNoMatch}</div>
          )}
        </div>
      )}
    </div>
  );
}
