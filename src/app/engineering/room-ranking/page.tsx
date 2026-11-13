"use client";

import { subscribeResources } from "@/lib/events/browser";
import { useEffect, useRef, useState } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import { isTicketAutomaticallyEscalated, readRankingFloorState, roomRankCounts, type RankedRoom, type RoomRank } from "@/lib/ticket-room-ranking";
import TicketEscalationIndicator from "@/components/TicketEscalationIndicator";
import RoomRankerKey from "@/components/RoomRankerKey";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";
import styles from "./room-ranking.module.css";

const FLOOR_KEY = "cmpri:ticket-room-ranker:floors:v1";
const REQUEST_TIMEOUT_MS = 15_000;

export default function TicketRoomRankerPage() {
  const embedded = useEmbeddedModal();
  const [rooms, setRooms] = useState<RankedRoom[]>([]);
  const [filter, setFilter] = useState<RoomRank | "All">("All");
  const [floorsOpen, setFloorsOpen] = useState<Record<string, boolean>>(() => {
    try { return typeof window === "undefined" ? {} : readRankingFloorState(localStorage.getItem(FLOOR_KEY)); } catch { return {}; }
  });
  const [additionalRoom, setAdditionalRoom] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    let controller: AbortController | undefined;
    async function refresh() {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/ticket-room-ranker", { headers: await authorizationHeaders(), cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) {
          if (!stopped && (response.status === 401 || response.status === 403)) setRooms([]);
          throw new Error(result.error || "Room ranking could not be refreshed.");
        }
        if (!stopped) { setRooms(result.rooms); setLoaded(true); setError(""); }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : "Room ranking could not be refreshed.");
      } finally { clearTimeout(timeout); busy = false; }
    }
    const stop = subscribeResources(["orders", "rooms"], async () => {
      if (!(await enforceSessionPreference())) { if (!stopped) window.location.replace("/"); return; }
      if (!stopped) await refresh();
    });
    return () => { stopped = true; controller?.abort(); stop(); };
  }, []);

  const counts = roomRankCounts(rooms);
  const shown = rooms.filter((room) => filter === "All" || room.rank === filter);
  const floors = [...new Set(rooms.map((room) => room.floor))].sort();
  const selected = rooms.find((room) => room.id === additionalRoom);
  const extras = selected?.issues.slice(1) || [];

  function toggleFloor(floor: string) {
    const next = { ...floorsOpen, [floor]: !floorsOpen[floor] };
    setFloorsOpen(next);
    try { localStorage.setItem(FLOOR_KEY, JSON.stringify(next)); } catch {}
  }

  function showAdditional(room: RankedRoom) {
    setAdditionalRoom(room.id);
    dialog.current?.showModal();
  }

  return <main className={styles.page}>
    <div className={styles.heading}>
      <div className={styles.counts} role="group" aria-label="Filter rooms by rank">
        <button type="button" aria-pressed={filter === "All"} onClick={() => setFilter("All")}><b>{rooms.length}</b> rooms</button>
        {(["A", "B", "C"] as const).map((rank) => <button type="button" key={rank} aria-label={`Show ${counts[rank]} rank ${rank} rooms`} aria-pressed={filter === rank} onClick={() => setFilter(rank)}><b className={`${styles.badge} ${styles[rank]}`}>{rank}</b><span>{counts[rank]}</span></button>)}
      </div>
      {embedded && <ModalDashboardLink className={styles.dashboard}>Dashboard</ModalDashboardLink>}
      <span className={styles.source}>CMPRI tickets · Active priorities and counts</span>
      {!embedded && <RoomRankerKey />}
    </div>
    {error && <p role="alert" className={styles.error}>{error}{loaded && " Displaying the last successful refresh."}</p>}
    {!loaded && !error && <p role="status" className={styles.message}>Loading rooms and active tickets…</p>}
    <div className={styles.visibleCount} aria-live="polite">{shown.length} / {rooms.length} rooms · Read down each floor</div>
    <div className={styles.floors}>
      {floors.map((floor) => {
        const list = shown.filter((room) => room.floor === floor);
        const open = floorsOpen[floor] === true;
        return <section key={floor} className={styles.floor} aria-label={`${({"1":"1st", "2":"2nd", "3":"3rd", "4":"4th"} as Record<string,string>)[floor] || floor} Floor`}>
          <button type="button" className={styles.floorHeader} aria-expanded={open} aria-controls={`floor-${floor}`} onClick={() => toggleFloor(floor)}><span>{open ? "▾" : "▸"} {({"1":"1st", "2":"2nd", "3":"3rd", "4":"4th"} as Record<string,string>)[floor] || floor} Floor</span><span>{list.length} rooms</span></button>
          <div id={`floor-${floor}`} hidden={!open}>
            <div className={styles.columns}><span>Room</span><span>Rank</span><span /><span>Issue</span><span /></div>
            {list.map((room) => <div key={room.id} className={styles.row} data-room={room.number} data-rank={room.rank}>
              <span className={`${styles.room} ${styles[`text${room.rank}`]}`}>{room.number}</span><span className={`${styles.badge} ${styles[room.rank]}`}>{room.rank}</span>
              {room.issues.some(isTicketAutomaticallyEscalated) ? <TicketEscalationIndicator /> : <span />}
              {room.issues[0] ? <a className={styles.issue} href={`/work-orders/${encodeURIComponent(room.issues[0].id)}`} title={room.issues[0].issue}>{room.issues[0].issue}</a> : <span className={styles.muted}>No active tickets</span>}
              {room.issues.length > 1 ? <button type="button" className={styles.more} aria-label={`Show ${room.issues.length - 1} additional issues for room ${room.number}`} title={room.issues.slice(1).map((issue) => issue.issue).join("\n")} onClick={() => showAdditional(room)}>+{room.issues.length - 1} more</button> : <span />}
            </div>)}
            {!list.length && <p className={styles.message}>No matching rooms</p>}
          </div>
        </section>;
      })}
    </div>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="additional-issues-title" onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
    }}>
      <button type="button" className={styles.close} onClick={() => dialog.current?.close()}>Close</button>
      <h2 id="additional-issues-title" className={styles.detailTitle}>Room {selected?.number}<span>{extras.length} additional issue{extras.length === 1 ? "" : "s"}</span></h2>
      <div className={styles.detailColumns}><span>Priority</span><span>Issue</span></div>
      {extras.map((issue) => <div key={issue.id} className={styles.detailRow}><strong>{issue.priority}</strong><a href={`/work-orders/${encodeURIComponent(issue.id)}`}>{issue.issue}</a></div>)}
      {!extras.length && <p className={styles.message}>No additional active issues.</p>}
    </dialog>
  </main>;
}
