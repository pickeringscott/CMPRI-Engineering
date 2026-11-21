"use client";

import { useUiLanguage } from "@/components/UiLanguageProvider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SearchableSelect, { type SearchableSelectOption } from "@/components/SearchableSelect";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { authorizationHeaders, loadCmpriSession } from "@/lib/auth/client-session";
import { canOpenEnseo } from "@/lib/dashboard/menu-access";
import { enseoSaveSuccessMessage, resolveEnseoPageResponse } from "@/lib/enseo-page-state";

type Asset = { id: string; name: string; asset_type?: string | null; asset_tag?: string | null; location_id?: string | null; manufacturer?: string | null; model_number?: string | null; serial_number?: string | null };
type Location = { id: string; name: string; room_number?: string | null; location_type?: string | null; area?: string | null };
type Assignment = { id: string; asset_id: string; device_type: "TV" | "STB"; location_id: string; room_number?: string | null; sub_location: string; endpoint_code?: string | null; paired_asset_id?: string | null; revision: number; updated_at?: string | null };
type History = { id: string; batch_id: string; asset_id: string; reason?: string | null; from_room_number?: string | null; from_sub_location?: string | null; from_endpoint_code?: string | null; to_room_number?: string | null; to_sub_location: string; to_endpoint_code?: string | null; moved_at: string };
type Payload = { configured: boolean; can_manage?: boolean; assignments: Assignment[]; assets: Asset[]; locations: Location[]; history: History[]; error?: string };
type MoveDraft = { key: string; asset_id: string; device_type: "TV" | "STB"; location_id: string; room_number: string; sub_location: string; endpoint_code: string; paired_asset_id: string };

function newMove(): MoveDraft {
  return { key: crypto.randomUUID(), asset_id: "", device_type: "TV", location_id: "", room_number: "", sub_location: "", endpoint_code: "", paired_asset_id: "" };
}

export default function EnseoAssignmentsPage() {
  const { t } = useUiLanguage();
  const embedded = useEmbeddedModal();
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageAllowed, setPageAllowed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [moves, setMoves] = useState<MoveDraft[]>([newMove()]);

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const session = await loadCmpriSession();
      if (!canOpenEnseo(session.user)) {
        router.replace(session.landing);
        return false;
      }
      setPageAllowed(true);
      const response = await fetch("/api/enseo/assignments", { headers: await authorizationHeaders(), cache: "no-store" });
      const result = resolveEnseoPageResponse<Payload>(response.ok, await response.json());
      setData(result.data);
      setMessage(result.message || "");
      return response.ok && result.data !== null && !result.message;
    } catch (error) {
      setData(null);
      setMessage(error instanceof Error ? error.message : "Enseo assignments could not be loaded.");
      return false;
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void Promise.resolve().then(load).catch(() => router.replace("/")); }, [load, router]);

  const assetById = useMemo(() => new Map((data?.assets || []).map((asset) => [asset.id, asset])), [data?.assets]);
  const locationById = useMemo(() => new Map((data?.locations || []).map((location) => [location.id, location])), [data?.locations]);
  const assignmentByAsset = useMemo(() => new Map((data?.assignments || []).map((assignment) => [assignment.asset_id, assignment])), [data?.assignments]);

  const assetOptions = useMemo<SearchableSelectOption[]>(() => (data?.assets || []).map((asset) => {
    const text = `${asset.name || ""} ${asset.asset_type || ""}`.toLowerCase();
    const group = /stb|set.?top|enseo/.test(text) ? "Enseo / STB" : /tv|television|display/.test(text) ? "Televisions" : "Other CMPRI equipment";
    return { value: asset.id, label: asset.name || asset.asset_type || asset.id, group: t(group), keywords: [asset.asset_type || "", asset.asset_tag || "", asset.manufacturer || "", asset.model_number || "", asset.serial_number || ""] };
  }), [data?.assets, t]);

  const locationOptions = useMemo<SearchableSelectOption[]>(() => (data?.locations || []).map((location) => ({
    value: location.id,
    label: location.room_number ? t("Room {number}", { number: location.room_number }) : location.name,
    group: location.area || location.location_type || t("Locations"),
    keywords: [location.name, location.room_number || "", location.location_type || "", location.area || ""],
  })), [data?.locations, t]);

  function updateMove(key: string, patch: Partial<MoveDraft>) {
    setMoves((current) => current.map((move) => move.key === key ? { ...move, ...patch } : move));
  }

  function chooseAsset(key: string, assetId: string) {
    const existing = assignmentByAsset.get(assetId);
    const location = existing ? locationById.get(existing.location_id) : null;
    updateMove(key, {
      asset_id: assetId,
      device_type: existing?.device_type || (/stb|set.?top|enseo/i.test(`${assetById.get(assetId)?.name || ""} ${assetById.get(assetId)?.asset_type || ""}`) ? "STB" : "TV"),
      location_id: existing?.location_id || "",
      room_number: existing?.room_number || location?.room_number || "",
      sub_location: existing?.sub_location || "",
      endpoint_code: existing?.endpoint_code || "",
      paired_asset_id: existing?.paired_asset_id || "",
    });
  }

  function chooseLocation(key: string, locationId: string) {
    const location = locationById.get(locationId);
    updateMove(key, { location_id: locationId, room_number: location?.room_number || "" });
  }

  async function saveMoves() {
    if (!data?.can_manage || saving) return;
    const invalid = moves.find((move) => !move.asset_id || !move.location_id || !move.sub_location.trim());
    if (invalid) { setMessage("Every move needs a device, destination, and room sub-location."); return; }
    if (new Set(moves.map((move) => move.asset_id)).size !== moves.length) { setMessage("The same device cannot appear twice in one move batch."); return; }
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/enseo/assignments", {
        method: "PATCH",
        headers: { ...(await authorizationHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reason.trim() || null,
          moves: moves.map(({ key: _key, ...move }) => ({ ...move, endpoint_code: move.device_type === "STB" ? move.endpoint_code.trim() || null : null, paired_asset_id: move.paired_asset_id || null })), // eslint-disable-line @typescript-eslint/no-unused-vars
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Enseo assignments could not be saved.");
      setReason(""); setMoves([newMove()]);
      if (await load()) setMessage(enseoSaveSuccessMessage(moves.length));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enseo assignments could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!pageAllowed) return null;
  if (loading) return <main className="min-h-screen bg-slate-950 p-6 text-slate-100">{embedded && <ModalDashboardLink className="mb-4 inline-block rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">{t("← Dashboard")}</ModalDashboardLink>}<p>{t("Loading Enseo assignments…")}</p></main>;
  if (!data) return <main className="min-h-screen bg-slate-950 p-4 text-slate-100 sm:p-6">{!embedded && <header className="flex justify-end"><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">{t("← Dashboard")}</ModalDashboardLink></header>}{embedded && <div className="mb-4"><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">{t("← Dashboard")}</ModalDashboardLink></div>}<p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-950/30 px-4 py-3 text-sm text-red-100">{message ? t(message) : t("Enseo assignments could not be loaded.")}</p></main>;

  return (
    <main className="min-h-screen bg-slate-950 p-4 text-slate-100 sm:p-6">
      <div className="mx-auto w-full">
        {!embedded && <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-xs font-bold uppercase tracking-[.22em] text-sky-400">{t("CMPRI v1.0")}</p><p className="mt-2 max-w-3xl text-sm text-slate-400">{t("Track each physical television and set-top box by exact room sub-location. Put every device involved in a swap or move in the same batch; the database commits the whole batch together or none of it.")}</p></div>
          <ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">{t("← Dashboard")}</ModalDashboardLink>
        </header>}
        {embedded && <div className="mb-4"><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">{t("← Dashboard")}</ModalDashboardLink></div>}

        {message && <p className="mt-4 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200">{t(message)}</p>}
        {data?.configured === false && <p className="mt-4 rounded-xl border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">{t("The Enseo assignment migration has not been applied yet. No live assignment changes are possible until the database schema is prepared.")}</p>}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs text-slate-400">{data?.assignments.length || 0}{" "}{t("tracked devices")}</p></div></div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="pb-2">{t("Device")}</th><th className="pb-2">{t("Type")}</th><th className="pb-2">{t("Room")}</th><th className="pb-2">{t("Sub-location")}</th><th className="pb-2">{t("Endpoint")}</th><th className="pb-2">{t("Paired device")}</th></tr></thead><tbody className="divide-y divide-slate-800">
              {(data?.assignments || []).map((assignment) => <tr key={assignment.id}><td className="py-2 pr-3 font-semibold">{assetById.get(assignment.asset_id)?.name || assignment.asset_id}</td><td className="py-2 pr-3">{assignment.device_type}</td><td className="py-2 pr-3">{assignment.room_number ? t("Room {value0}", { value0: assignment.room_number }) : locationById.get(assignment.location_id)?.name || "—"}</td><td className="py-2 pr-3">{assignment.sub_location}</td><td className="py-2 pr-3">{assignment.endpoint_code || "—"}</td><td className="py-2">{assignment.paired_asset_id ? assetById.get(assignment.paired_asset_id)?.name || assignment.paired_asset_id : "—"}</td></tr>)}
              {!data?.assignments.length && <tr><td colSpan={6} className="py-5 text-slate-500">{t("No Enseo physical-device assignments have been recorded yet.")}</td></tr>}
            </tbody></table>
          </div>
        </section>

        {data?.can_manage && data.configured !== false && <section className="mt-6 rounded-2xl border border-sky-500/30 bg-slate-900 p-4">
          <div><p className="mt-1 text-sm text-slate-400">{t("For a physical swap, add every TV and STB that changes location before saving. This prevents one half of a paired move from being recorded without the other.")}</p></div>
          <div className="mt-4 space-y-4">{moves.map((move, index) => {
            const pairedOptions: SearchableSelectOption[] = [{ value: "", label: "No paired device", group: "Pairing" }, ...assetOptions.filter((option) => option.value !== move.asset_id)];
            return <div key={move.key} className="rounded-xl border border-slate-700 bg-slate-950/50 p-3">
              <div className="mb-3 flex items-center justify-between"><p className="text-sm font-bold">{t("Device")}{" "}{index + 1}</p>{moves.length > 1 && <button type="button" onClick={() => setMoves((current) => current.filter((item) => item.key !== move.key))} className="text-xs font-semibold text-red-300">{t("Remove")}</button>}</div>
              <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
                <label className="grid gap-1 text-xs text-slate-400">{t("Physical device")}<SearchableSelect value={move.asset_id} options={assetOptions} onChange={(value) => chooseAsset(move.key, value)} placeholder={t("TV / STB asset")} expandOnOpen /></label>
                <label className="grid gap-1 text-xs text-slate-400">{t("Device type")}<SearchableSelect value={move.device_type} options={[{ value: "TV", label: "TV" }, { value: "STB", label: "STB / Enseo box" }]} onChange={(value) => updateMove(move.key, { device_type: value as "TV" | "STB", endpoint_code: value === "TV" ? "" : move.endpoint_code })} placeholder={t("Device type")} /></label>
                <label className="grid gap-1 text-xs text-slate-400">{t("Destination room / location")}<SearchableSelect value={move.location_id} options={locationOptions} onChange={(value) => chooseLocation(move.key, value)} placeholder={t("Room / Location")} /></label>
                <label className="grid gap-1 text-xs text-slate-400">{t("Sub-location")}<input value={move.sub_location} onChange={(event) => updateMove(move.key, { sub_location: event.target.value })} placeholder={t("Bedroom / Living Room / Office")} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" /></label>
                <label className="grid gap-1 text-xs text-slate-400">{t("Enseo endpoint")}{" "}{move.device_type === "TV" ? t("(STB only)") : ""}<input value={move.endpoint_code} disabled={move.device_type === "TV"} onChange={(event) => updateMove(move.key, { endpoint_code: event.target.value.toUpperCase() })} placeholder={t("134A / 134B")} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm disabled:opacity-50" /></label>
                <label className="grid gap-1 text-xs text-slate-400">{t("Paired TV / STB")}<SearchableSelect value={move.paired_asset_id} options={pairedOptions} onChange={(value) => updateMove(move.key, { paired_asset_id: value })} placeholder={t("Paired device")} expandOnOpen /></label>
              </div>
            </div>;
          })}</div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><label className="grid flex-1 gap-1 text-xs text-slate-400">{t("Reason / move note")}<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Example: Bedroom TV failed; move known-good living-room TV and matching STB")} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" /></label><div className="flex gap-2"><button type="button" onClick={() => setMoves((current) => [...current, newMove()])} disabled={moves.length >= 20 || saving} className="rounded-lg border border-sky-600 px-4 py-2 text-sm font-semibold text-sky-200 disabled:opacity-50">{t("Add Device")}</button><button type="button" onClick={() => void saveMoves()} disabled={saving} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-60">{saving ? t("Saving…") : t("Save {value0} Device{value1}", { value0: moves.length, value1: moves.length === 1 ? "" : "s" })}</button></div></div>
        </section>}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-4"><div className="mt-3 space-y-2">{(data?.history || []).slice(0, 30).map((item) => <div key={item.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-sm"><p className="font-semibold">{assetById.get(item.asset_id)?.name || item.asset_id}</p><p className="mt-1 text-slate-400">{item.from_room_number || item.from_sub_location ? t("{value0}{value1} → ", { value0: item.from_room_number ? `Room ${item.from_room_number}` : "Previous location", value1: item.from_sub_location ? ` · ${item.from_sub_location}` : "" }) : t("Assigned → ")}{item.to_room_number ? t("Room {value0}", { value0: item.to_room_number }) : t("Destination")} · {item.to_sub_location}{item.to_endpoint_code ? t(" · {value0}", { value0: item.to_endpoint_code }) : ""}</p>{item.reason && <p className="mt-1 text-xs text-slate-500">{item.reason}</p>}</div>)}{!data?.history.length && <p className="text-sm text-slate-500">{t("No assignment moves recorded yet.")}</p>}</div></section>
      </div>
    </main>
  );
}
