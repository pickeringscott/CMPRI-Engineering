"use client";

import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { loadCmpriSession } from "@/lib/auth/client-session";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { roleKey } from "@/lib/server/roles";

type RoomRankerRow = {
  rowNumber: number;
  room: string;
  inspectedBy: string;
  check1: string;
  check2: string;
  check3: string;
  rank: string;
  notes: string;
};

type EditableField = Exclude<keyof RoomRankerRow, "rowNumber" | "room">;
type SyncState = "loading" | "saved" | "saving" | "error";
type SheetColumn = { key: "room" | EditableField; label: string; width: string };

const columns: SheetColumn[] = [
  { key: "room", label: "Room", width: "w-28" },
  { key: "inspectedBy", label: "Room Inspected by", width: "w-64" },
  { key: "check1", label: "Specific Room Check 1", width: "w-72" },
  { key: "check2", label: "Specific Room Check 2", width: "w-72" },
  { key: "check3", label: "Specific Room Check 3", width: "w-72" },
  { key: "rank", label: "Room Rank", width: "w-36" },
  { key: "notes", label: "Notes / Actions Needed", width: "w-80" },
];

function cellKey(rowNumber: number, field: EditableField) {
  return `${rowNumber}:${field}`;
}

function rankCellClass(rank: string) {
  if (rank === "A") return "bg-green-300 text-green-950";
  if (rank === "B") return "bg-yellow-200 text-yellow-950";
  if (rank === "C") return "bg-[#ff907f] text-red-950";
  return "bg-white text-slate-700";
}

export default function RoomRankerPage() {
  const embedded = useEmbeddedModal();
  const [rooms, setRooms] = useState<RoomRankerRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [safeMode, setSafeMode] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [syncStatus, setSyncStatus] = useState("Loading source sheet…");
  const [lastRefresh, setLastRefresh] = useState("");

  async function token() {
    const session = await getValidSession();
    return session?.access_token || "";
  }

  async function loadRooms() {
    setLoading(true);
    setSyncState("loading");
    setSyncStatus("Loading source sheet…");
    setCanEdit(false);
    try {
      const session = await loadCmpriSession();
      if (roleKey(session.user.role) !== "system_admin") {
        setRooms([]);
        setSyncState("error");
        setSyncStatus("Room Ranker is available only to System Administrators.");
        return;
      }
      const response = await fetch("/api/room-ranker", {
        headers: { Authorization: `Bearer ${await token()}` },
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to load Room Ranker.");
      setRooms(Array.isArray(result.rooms) ? result.rooms : []);
      setCanEdit(result.can_edit === true);
      setSafeMode(result.safeMode === true);
      setLastRefresh(new Date(result.fetchedAt || Date.now()).toLocaleTimeString());
      setSyncState("saved");
      setSyncStatus(result.safeMode ? "Connected to source sheet · Safe mode" : "Connected to source sheet");
    } catch (cause) {
      setSyncState("error");
      setSyncStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      if (!(await enforceSessionPreference())) {
        window.location.replace("/");
        return;
      }
      await loadRooms();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveCell(row: RoomRankerRow, field: EditableField, value: string) {
    const key = cellKey(row.rowNumber, field);
    if (!canEdit || saving || loading || value === row[field]) {
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }

    setSaving(true);
    setSyncState("saving");
    setSyncStatus(`Saving room ${row.room} to source sheet…`);
    try {
      const response = await fetch("/api/room-ranker", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await token()}`,
        },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          expectedRoom: row.room,
          [field]: value,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save Room Ranker.");

      setRooms((current) => current.map((item) => item.rowNumber === row.rowNumber
        ? { ...item, [field]: value }
        : item));
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (result.safeMode && result.blocked) {
        setSafeMode(true);
        setSyncState("saved");
        setSyncStatus("Safe mode is on — this edit was not sent to the source sheet.");
      } else {
        setSyncState("saved");
        setSyncStatus(`All changes saved to source sheet · ${new Date().toLocaleTimeString()}`);
      }
    } catch (cause) {
      setSyncState("error");
      setSyncStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const statusClass = syncState === "error"
    ? "text-red-700"
    : syncState === "saving" || syncState === "loading"
      ? "text-amber-700"
      : safeMode
        ? "text-amber-700"
        : "text-green-700";

  return (
    <main className="flex min-h-screen flex-col bg-white text-slate-800">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-lg font-medium text-slate-800">Room Ranker</h1>
          {embedded && (
            <ModalDashboardLink className="shrink-0 rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              ← Dashboard
            </ModalDashboardLink>
          )}
        </div>
        <p role="status" aria-live="polite" className={`text-sm ${statusClass}`}>
          {syncState === "saved" && !safeMode && lastRefresh && syncStatus === "Connected to source sheet"
            ? `${syncStatus} · Synced ${lastRefresh}`
            : syncStatus}
        </p>
      </header>

      <section aria-label="Room Ranker spreadsheet" className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-max min-w-full border-collapse text-sm">
            <thead className="sticky top-0 z-20">
              <tr className="h-8 bg-slate-100 text-xs text-slate-600">
                <th aria-label="Row numbers" className="sticky left-0 z-30 w-11 min-w-11 border border-slate-300 bg-slate-100" />
                {columns.map((column, index) => (
                  <th key={column.key} className={`${column.width} min-w-28 border border-slate-300 bg-slate-100 px-2 text-center font-normal`}>
                    {String.fromCharCode(65 + index)}
                  </th>
                ))}
              </tr>
              <tr className="h-11 bg-[#f6b26b] text-left text-slate-900">
                <th className="sticky left-0 z-30 w-11 min-w-11 border border-slate-300 bg-slate-100 text-center text-xs font-normal text-slate-600">1</th>
                {columns.map((column) => (
                  <th key={column.key} className={`${column.width} min-w-28 border border-[#d6a05f] px-3 font-medium`}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={columns.length + 1} className="border border-slate-200 px-4 py-8 text-center text-slate-500">
                    Loading live rooms…
                  </td>
                </tr>
              ) : rooms.map((row) => (
                <tr key={row.rowNumber} className="h-10 odd:bg-white even:bg-slate-50">
                  <th scope="row" className="sticky left-0 z-10 w-11 min-w-11 border border-slate-200 bg-slate-100 px-2 text-center text-xs font-normal text-slate-600">
                    {row.rowNumber}
                  </th>
                  {columns.map((column) => {
                    const field = column.key;
                    const value = String(row[field] ?? "");
                    if (field === "room") {
                      return (
                        <td key={field} className={`border border-slate-200 px-3 text-center ${rankCellClass(row.rank)}`}>
                          {value}
                        </td>
                      );
                    }

                    const editableField = field;
                    const key = cellKey(row.rowNumber, editableField);
                    const displayedValue = drafts[key] ?? value;
                    return (
                      <td key={field} className={`border border-slate-200 p-0 ${field === "rank" ? rankCellClass(displayedValue) : ""}`}>
                        {field === "rank" ? (
                          <select
                            aria-label={`Room ${row.room}, ${column.label}`}
                            disabled={!canEdit || saving || loading}
                            value={displayedValue}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              setDrafts((current) => ({ ...current, [key]: nextValue }));
                              void saveCell(row, editableField, nextValue);
                            }}
                            className={`h-10 w-full cursor-pointer appearance-none border-0 bg-transparent px-3 text-center font-medium outline-none focus:ring-2 focus:ring-inset focus:ring-blue-600 disabled:cursor-not-allowed ${rankCellClass(displayedValue)}`}
                          >
                            <option value="">—</option>
                            <option value="A">A</option>
                            <option value="B">B</option>
                            <option value="C">C</option>
                          </select>
                        ) : (
                          <input
                            aria-label={`Room ${row.room}, ${column.label}`}
                            disabled={!canEdit || saving || loading}
                            value={displayedValue}
                            onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                            onBlur={(event) => void saveCell(row, editableField, event.currentTarget.value)}
                            className="h-10 w-full border-0 bg-transparent px-3 text-slate-800 outline-none focus:ring-2 focus:ring-inset focus:ring-blue-600 disabled:cursor-not-allowed"
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!loading && rooms.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="border border-slate-200 px-4 py-8 text-center text-slate-500">
                    No rooms are available in the source sheet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex h-11 shrink-0 items-center border-t border-slate-200 bg-slate-50 px-4">
          <span className="border-b-2 border-blue-600 bg-white px-4 py-2 text-sm font-medium text-blue-700">🔒 Room Ranker</span>
        </div>
      </section>
    </main>
  );
}
