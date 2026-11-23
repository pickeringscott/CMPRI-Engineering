"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { AskResponse } from "@/lib/ask-cmpri/types";
import { AskCmpriFolderSaveError, downloadAskCmpriFile } from "./local-file-storage";
import styles from "./AskCmpriAttachments.module.css";

const COPY = {
  en: {
    attach: "Attach files",
    source: "Attachment source",
    picture: "Take a Picture",
    file: "Attach File",
    drafts: "Files ready to send",
    remove: (name: string) => `Remove ${name}`,
    drop: "Drop files into this conversation",
    sent: "Sent attachments",
    received: "Received attachments",
    save: (name: string) => `Download ${name}`,
    saved: "Saved to the selected folder.",
    downloaded: "Check your browser’s downloads.",
    uncertain: (name: string) => `Check the selected folder for ${name} before downloading again.`,
    unavailable: "This file could not be downloaded.",
  },
  es: {
    attach: "Adjuntar archivos",
    source: "Origen del archivo adjunto",
    picture: "Tomar una foto",
    file: "Adjuntar archivo",
    drafts: "Archivos listos para enviar",
    remove: (name: string) => `Quitar ${name}`,
    drop: "Suelta los archivos en esta conversación",
    sent: "Archivos adjuntos enviados",
    received: "Archivos adjuntos recibidos",
    save: (name: string) => `Descargar ${name}`,
    saved: "Guardado en la carpeta seleccionada.",
    downloaded: "Revisa las descargas del navegador.",
    uncertain: (name: string) => `Busca ${name} en la carpeta seleccionada antes de volver a descargarlo.`,
    unavailable: "No se pudo descargar este archivo.",
  },
};

function labels(locale?: string) {
  return COPY[/^es(?:-|$)/i.test(locale ?? "") ? "es" : "en"];
}

interface AttachmentPickerProps {
  onSelect: (files: File[]) => void;
  disabled?: boolean;
  locale?: string;
  className?: string;
  onInteraction?: () => void;
}

export function AskCmpriAttachments({ onSelect, disabled = false, locale, className, onInteraction }: AttachmentPickerProps) {
  const text = labels(locale);
  const menuId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const takePicture = useRef<HTMLButtonElement>(null);
  const chooseFiles = useRef<HTMLButtonElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const expanded = menuOpen && !disabled;

  useEffect(() => {
    if (!expanded) return;
    takePicture.current?.focus({ preventScroll: true });
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setMenuOpen(false);
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [expanded]);

  function pick(input: HTMLInputElement | null) {
    if (!input || disabled) return;
    onInteraction?.();
    setMenuOpen(false);
    trigger.current?.focus({ preventScroll: true });
    input.value = "";
    input.click();
  }

  function receive(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) onSelect(files);
  }

  return (
    <span
      ref={root}
      className={styles.picker}
      onBlur={(event) => {
        if (expanded && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          setMenuOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (!expanded) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(false);
          trigger.current?.focus({ preventScroll: true });
        } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          (event.key === "Home" || (event.key !== "End" && event.target === chooseFiles.current)
            ? takePicture.current : chooseFiles.current)?.focus({ preventScroll: true });
        }
      }}
    >
      <button
        type="button"
        className={[styles.clipButton, className].filter(Boolean).join(" ")}
        ref={trigger}
        aria-label={text.attach}
        aria-expanded={expanded}
        aria-controls={menuId}
        disabled={disabled}
        data-ask-attach-trigger
        onClick={() => {
          if (window.matchMedia("(max-width: 700px), (pointer: coarse)").matches) {
            onInteraction?.();
            setMenuOpen(!menuOpen);
          } else pick(filesInput.current);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="m8.2 13.8 6.5-6.5a2 2 0 0 1 2.9 2.8l-7.8 7.8a3.5 3.5 0 0 1-5-5l8.3-8.3a5 5 0 0 1 7 7l-8.2 8.3" />
        </svg>
      </button>
      <input ref={filesInput} type="file" multiple hidden onChange={receive} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={receive} />
      <span id={menuId} className={styles.choices} role="group" aria-label={text.source} hidden={!expanded}>
        <button ref={takePicture} type="button" onClick={() => pick(cameraInput.current)}>{text.picture}</button>
        <button ref={chooseFiles} type="button" onClick={() => pick(filesInput.current)}>{text.file}</button>
      </span>
    </span>
  );
}

interface AttachmentDraftsProps {
  files: readonly File[];
  onRemove: (index: number) => void;
  disabled?: boolean;
  locale?: string;
}

const PREVIEWABLE_IMAGE = /^image\/(?:avif|bmp|gif|heic|heif|jpeg|png|tiff|webp|x-icon)$/i;
const PHOTO_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

function FileThumbnail({ file }: { file: File }) {
  const preview = useRef<HTMLSpanElement>(null);
  const image = PREVIEWABLE_IMAGE.test(file.type) || (!file.type && PHOTO_EXTENSION.test(file.name));
  useEffect(() => {
    const element = preview.current;
    if (!image || !element) return;
    const url = URL.createObjectURL(file);
    element.style.backgroundImage = `url("${url}")`;
    return () => {
      element.style.removeProperty("background-image");
      URL.revokeObjectURL(url);
    };
  }, [file, image]);
  return <span aria-hidden="true" ref={preview} className={image ? styles.thumbnail : styles.document} />;
}

export function AskCmpriAttachmentDrafts({ files, onRemove, disabled = false, locale }: AttachmentDraftsProps) {
  const text = labels(locale);
  if (!files.length) return null;
  return (
    <div className={styles.drafts} role="group" aria-label={text.drafts}>
      {files.map((file, index) => (
        <div className={styles.chip} key={`${file.name}-${file.lastModified}-${index}`}>
          <FileThumbnail file={file} />
          <span className={styles.name} title={file.name}>{file.name}</span>
          <button
            type="button"
            aria-label={text.remove(file.name)}
            disabled={disabled}
            onClick={(event) => {
              const chip = event.currentTarget.parentElement;
              const neighbour = chip?.nextElementSibling ?? chip?.previousElementSibling;
              const next = neighbour?.querySelector<HTMLButtonElement>("button")
                ?? chip?.closest("dialog")?.querySelector<HTMLButtonElement>("[data-ask-attach-trigger]");
              next?.focus({ preventScroll: true });
              onRemove(index);
            }}
          >×</button>
        </div>
      ))}
    </div>
  );
}

function isFileDrag(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files") || event.dataTransfer.files.length > 0;
}

export function useAskCmpriAttachmentDrop({ onSelect, enabled = true }: Pick<AttachmentPickerProps, "onSelect"> & { enabled?: boolean }) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  return {
    dragging: enabled && dragging,
    dropProps: {
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        if (!enabled) return;
        depth.current += 1;
        setDragging(true);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!isFileDrag(event) && !depth.current) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (enabled && event.dataTransfer.files.length) onSelect(Array.from(event.dataTransfer.files));
      },
    },
  };
}

export function AskCmpriAttachmentDropIndicator({ locale }: { locale?: string }) {
  return <div className={styles.dropIndicator} aria-hidden="true">{labels(locale).drop}</div>;
}

function DownloadableFile({ name, openBlob, file, scopeKey = "", locale }: {
  name: string;
  openBlob: (signal: AbortSignal) => Blob | Promise<Blob>;
  file?: File;
  scopeKey?: string;
  locale?: string;
}) {
  const text = labels(locale);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);
  async function download() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const current = () => request.current === controller && !controller.signal.aborted;
    setBusy(true);
    setStatus("");
    try {
      const blob = await openBlob(controller.signal);
      if (!current()) return;
      const destination = await downloadAskCmpriFile(scopeKey, name, blob, controller.signal);
      if (current()) setStatus(destination === "folder" ? text.saved : text.downloaded);
    } catch (error) {
      if (current()) setStatus(error instanceof AskCmpriFolderSaveError ? text.uncertain(error.fileName) : text.unavailable);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return <>
    <button type="button" className={styles.download} aria-label={text.save(name)} aria-disabled={busy}
      onClick={() => void download()}>
      {file ? <FileThumbnail file={file} /> : <span className={styles.document} aria-hidden="true" />}
      <span>{name}</span>
    </button>
    <p role="status" className={styles.downloadStatus}>{status}</p>
  </>;
}

export function AskCmpriFileList({ files, outgoing = false, locale, scopeKey }: {
  files: readonly File[];
  outgoing?: boolean;
  locale?: string;
  scopeKey?: string;
}) {
  if (!files.length) return null;
  const text = labels(locale);
  return (
    <ul className={styles.files} data-outgoing={outgoing} aria-label={outgoing ? text.sent : text.received}>
      {files.map((file, index) => (
        <li key={`${scopeKey}:${file.name}-${file.lastModified}-${index}`}><DownloadableFile name={file.name} file={file}
          openBlob={() => file} locale={locale} scopeKey={scopeKey} /></li>
      ))}
    </ul>
  );
}

type ReplyDownload = NonNullable<AskResponse["downloads"]>[number];
type AuthorizeDownload = (signal?: AbortSignal, expected?: string) => Promise<{ scope: string; headers: Record<string, string> }>;
const MAX_NATIVE_DOWNLOAD_BYTES = 100 * 1024 * 1024;

async function responseDownload(download: ReplyDownload, scopeKey: string, authorize: AuthorizeDownload, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if ("downloadToken" in download) {
    const auth = await authorize(signal, scopeKey);
    signal.throwIfAborted();
    if (!scopeKey || auth.scope !== scopeKey) throw new Error("The download account changed.");
    const response = await fetch("/api/ask-cmpri/document-download", {
      method: "POST", headers: { ...auth.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ token: download.downloadToken }), cache: "no-store", signal,
    });
    const metadata = await response.json().catch(() => null) as Record<string, unknown> | null;
    signal.throwIfAborted();
    if (!response.ok || !metadata || typeof metadata.url !== "string" || metadata.name !== download.name
      || metadata.mimeType !== "application/pdf" || metadata.mimeType !== download.mimeType
      || typeof metadata.size !== "number" || !Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > MAX_NATIVE_DOWNLOAD_BYTES
      || typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(metadata.sha256)) {
      throw new Error("The PDF download could not be verified.");
    }
    const url = new URL(metadata.url);
    if (url.protocol !== "https:" || url.username || url.password
      || !url.pathname.startsWith("/storage/v1/object/sign/") || !url.searchParams.get("token")) {
      throw new Error("The PDF download address is invalid.");
    }
    const file = await fetch(url.href, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal });
    if (!file.ok || !file.body) throw new Error("The PDF could not be retrieved.");
    const reader = file.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > metadata.size) throw new Error("The PDF size changed.");
        chunks.push(new Uint8Array(chunk.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (size !== metadata.size) throw new Error("The PDF size changed.");
    const blob = new Blob(chunks, { type: metadata.mimeType });
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== metadata.sha256.toLowerCase()) throw new Error("The PDF content changed.");
    const finalAuth = await authorize(signal, scopeKey);
    signal.throwIfAborted();
    if (finalAuth.scope !== scopeKey) throw new Error("The download account changed.");
    return blob;
  }
  if (download.encoding === "utf8") return new Blob([download.content], { type: download.mimeType });
  const decoded = atob(download.content);
  return new Blob([Uint8Array.from(decoded, (value) => value.charCodeAt(0))], { type: download.mimeType });
}

export function AskCmpriDownloadList({ downloads, scopeKey, locale, authorize }: {
  downloads?: readonly ReplyDownload[];
  scopeKey: string;
  locale?: string;
  authorize: AuthorizeDownload;
}) {
  if (!downloads?.length) return null;
  return <ul className={styles.files} aria-label={labels(locale).received}>
    {downloads.map((item) => <li key={`${scopeKey}:${item.id}`}>
      <DownloadableFile name={item.name} openBlob={signal => responseDownload(item, scopeKey, authorize, signal)} locale={locale} scopeKey={scopeKey} />
    </li>)}
  </ul>;
}
