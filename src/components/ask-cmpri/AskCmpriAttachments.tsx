"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
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
}

export function AskCmpriAttachments({ onSelect, disabled = false, locale, className }: AttachmentPickerProps) {
  const text = labels(locale);
  const menuId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const takePicture = useRef<HTMLButtonElement>(null);
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
    setMenuOpen(false);
    trigger.current?.focus({ preventScroll: true });
    input.value = "";
    input.click();
  }

  function receive(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length && !disabled) onSelect(files);
  }

  return (
    <span
      ref={root}
      className={styles.picker}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !expanded) return;
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        trigger.current?.focus({ preventScroll: true });
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
        onClick={() => {
          if (window.matchMedia("(max-width: 700px), (pointer: coarse)").matches) setMenuOpen(!menuOpen);
          else pick(filesInput.current);
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
        <button type="button" onClick={() => pick(filesInput.current)}>{text.file}</button>
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
              neighbour?.querySelector("button")?.focus({ preventScroll: true });
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

function DownloadableFile({ file }: { file: File }) {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const anchor = link.current;
    if (!anchor) return;
    const url = URL.createObjectURL(file);
    anchor.href = url;
    return () => {
      anchor.removeAttribute("href");
      URL.revokeObjectURL(url);
    };
  }, [file]);
  return (
    <a ref={link} className={styles.download} download={file.name}>
      <FileThumbnail file={file} />
      <span>{file.name}</span>
    </a>
  );
}

export function AskCmpriFileList({ files, outgoing = false, locale }: {
  files: readonly File[];
  outgoing?: boolean;
  locale?: string;
}) {
  if (!files.length) return null;
  const text = labels(locale);
  return (
    <ul className={styles.files} data-outgoing={outgoing} aria-label={outgoing ? text.sent : text.received}>
      {files.map((file, index) => (
        <li key={`${file.name}-${file.lastModified}-${index}`}><DownloadableFile file={file} /></li>
      ))}
    </ul>
  );
}
