"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import type { UiValues } from "@/lib/i18n/ui";
import {
  AskCmpriFolderSaveError,
  canUseAskCmpriFolder,
  downloadAskCmpriFile,
  forgetAskCmpriFolder,
  loadAskCmpriFolder,
  pickAskCmpriFolder,
  rememberAskCmpriFolder,
  saveAskCmpriFolderFile,
  setActiveAskCmpriFolder,
  supportsAskCmpriFolder,
  type AskCmpriFolderHandle,
} from "./local-file-storage";
import styles from "./AskCmpriFiles.module.css";

export { downloadAskCmpriFile };

export type AskCmpriLocalFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  text: string;
};

export type AskCmpriFilesStatus = { pending: number; error: string | null };
export const ASK_MAX_FILES = 8;
export const ASK_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const ticketAttachmentTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", heic: "image/heic", heif: "image/heif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

export function isAskCmpriTicketMedia(file: Pick<File, "name" | "type">) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const contentType = ticketAttachmentTypes[extension];
  const declared = file.type.toLowerCase();
  return Object.hasOwn(ticketAttachmentTypes, extension) && (!declared || declared === "application/octet-stream" || contentType === declared);
}

type Props = {
  open: boolean;
  active: boolean;
  scopeKey: string;
  scopeError?: string;
  focusFileId?: string;
  focusExcerpt?: AskCmpriLocalFile;
  selectionReset?: number;
  onOpenFiles: () => void;
  onFilesChange: (files: AskCmpriLocalFile[], status: AskCmpriFilesStatus) => void;
};

type Entry = {
  id: string;
  identity: string;
  file: File;
  inFolder: boolean;
  status: "available" | "reading" | "selected" | "unreadable";
  text: string;
};

const consentKey = "cmpri:ask-files-consent:v1";
const contextLimit = 3_800;
const noExcerpts: AskCmpriLocalFile[] = [];
let consentInMemory = false;

const filesSpanish: Record<string, string> = {
  "Checking your CMPRI access…": "Comprobando tu acceso a CMPRI…",
  "An excluded file has no readable text. Check the Files tab.": "Un archivo excluido no tiene texto legible. Revisa la pestaña Archivos.",
  "Folder access was declined. You can pick another folder or choose files individually.": "Se rechazó el acceso a la carpeta. Puedes elegir otra carpeta o seleccionar los archivos uno por uno.",
  "Selected folder connected.": "La carpeta seleccionada está conectada.",
  "Folder connected for this session. Browser storage could not remember it.": "Carpeta conectada durante esta sesión. El navegador no pudo recordar la conexión.",
  "Folder selection ended. The current folder is still connected.": "Terminó la selección. La carpeta actual sigue conectada.",
  "Folder selection ended. You can choose files individually.": "Terminó la selección de carpeta. Puedes seleccionar archivos uno por uno.",
  "In the folder picker, open Documents and select CMPRI-Engineering itself. You can also choose files individually.": "En el selector, abre Documentos y selecciona la carpeta CMPRI-Engineering. También puedes seleccionar archivos uno por uno.",
  "Folder disconnected. Its files stay on this device.": "Carpeta desconectada. Sus archivos siguen en este dispositivo.",
  "Folder disconnected for this session. Browser storage could not clear the remembered folder.": "Carpeta desconectada durante esta sesión. El navegador no pudo borrar la conexión guardada.",
  "Check the selected folder. Ask CMPRI could not verify every saved copy. The original files are available this session.": "Revisa la carpeta seleccionada. Ask CMPRI no pudo verificar todas las copias. Los archivos originales están disponibles durante esta sesión.",
  "Files are ready to select and saved in the connected folder.": "Los archivos están listos para seleccionar y se guardaron en la carpeta conectada.",
  "Some files could not be saved in the connected folder. Those files are available this session.": "Algunos archivos no se pudieron guardar en la carpeta conectada. Están disponibles durante esta sesión.",
  "Files are ready to select for Ask CMPRI.": "Los archivos están listos para seleccionar en Ask CMPRI.",
  "Wait for the current folder operation, then add your files.": "Espera a que termine la operación de la carpeta antes de añadir archivos.",
  "The folder save could not finish. Check your browser’s downloads.": "No se pudo completar el guardado en la carpeta. Revisa las descargas del navegador.",
  "Download sent to your browser.": "Se envió la descarga al navegador.",
  "Saved a copy in the selected folder.": "Se guardó una copia en la carpeta seleccionada.",
  "Ask CMPRI could not verify the copy. Check the selected folder for {file} before downloading again.": "Ask CMPRI no pudo verificar la copia. Busca {file} en la carpeta seleccionada antes de volver a descargarlo.",
  "Check the selected folder or your browser’s downloads to verify the copy.": "Revisa la carpeta seleccionada o las descargas del navegador para verificar la copia.",
  "Select up to eight files. Clear one before adding another to Ask CMPRI.": "Selecciona hasta ocho archivos. Desmarca uno antes de añadir otro a Ask CMPRI.",
  "Choose a file of 100 MB or less for Ask CMPRI.": "Elige un archivo de hasta 100 MB para Ask CMPRI.",
  "Set Up Local Files": "Configurar archivos locales",
  "Close folder setup": "Cerrar configuración de carpeta",
  "Use Documents / CMPRI-Engineering on this device for files you download or add through Ask CMPRI?": "¿Usar Documentos / CMPRI-Engineering en este dispositivo para archivos que descargues o añadas en Ask CMPRI?",
  "In the browser picker, open Documents and select the CMPRI-Engineering folder itself. Create it there if needed.": "En el selector del navegador, abre Documentos y selecciona la carpeta CMPRI-Engineering. Créala allí si es necesario.",
  "Choose files on this device and use browser downloads.": "Elige archivos en este dispositivo y usa las descargas del navegador.",
  "Not now": "Ahora no",
  "Choose Folder": "Elegir carpeta",
  "Open Files": "Abrir archivos",
  "Connected to the folder you selected on this device. Added files and downloads go there.": "Carpeta conectada en este dispositivo. Allí se guardan los archivos que añadas o descargues.",
  "Grant access again to use the saved CMPRI folder.": "Vuelve a conceder acceso para usar la carpeta de CMPRI guardada.",
  "Choose or create CMPRI-Engineering inside Documents, then select that folder.": "Busca o crea CMPRI-Engineering en Documentos y selecciona esa carpeta.",
  "File selection and browser downloads are available on this device.": "Puedes seleccionar archivos y usar las descargas del navegador en este dispositivo.",
  "Refresh folder": "Actualizar carpeta",
  "Reconnect folder": "Reconectar carpeta",
  "Connect folder": "Conectar carpeta",
  "Choose another folder": "Elegir otra carpeta",
  "Disconnect folder": "Desconectar carpeta",
  "Drop files here or choose files on this device.": "Suelta archivos aquí o selecciónalos en este dispositivo.",
  "Choose files": "Elegir archivos",
  "Choose the original file on this device to open it from Files.": "Selecciona el archivo original en este dispositivo para abrirlo desde Archivos.",
  "Available files": "Archivos disponibles",
  "Selected": "Seleccionados",
  "Reading": "Leyendo",
  "Choose or drop a file to make it available in Ask CMPRI.": "Elige o suelta un archivo para usarlo en Ask CMPRI.",
  "Local files": "Archivos locales",
  "CMPRI folder": "Carpeta de CMPRI",
  "This session": "Esta sesión",
  "Use {file} in Ask CMPRI": "Usar {file} en Ask CMPRI",
  "Use in Ask CMPRI": "Usar en Ask CMPRI",
  "Download a copy of {file}": "Descargar una copia de {file}",
  "Download copy": "Descargar copia",
  "Reading text on this device…": "Leyendo texto en este dispositivo…",
  "No readable text was found. Try a text file, PDF, PNG, JPEG, or WebP copy.": "No se encontró texto legible. Prueba con un archivo de texto, PDF, PNG, JPEG o WebP.",
  "Review text for Ask CMPRI": "Revisar texto para Ask CMPRI",
  "Ask CMPRI uses selected text excerpts. It reads the beginning of text files and up to 10 pages of PDFs.": "Ask CMPRI usa los fragmentos de texto seleccionados. Lee el comienzo de los archivos de texto y hasta diez páginas de los PDF.",
};

function useFilesLanguage() {
  const { t, locale } = useUiLanguage();
  return { t: (text: string, values?: UiValues) => t(text, filesSpanish[text] ?? text, values), locale };
}

function consentRecorded() {
  try {
    return consentInMemory || localStorage.getItem(consentKey) === "1";
  } catch {
    return consentInMemory;
  }
}

function recordConsent() {
  consentInMemory = true;
  try {
    localStorage.setItem(consentKey, "1");
  } catch {
    /* Retain the choice for this session if the browser blocks local storage. */
  }
}

function entryFor(file: File, inFolder: boolean): Entry {
  const identity = JSON.stringify([inFolder, file.name, file.size, file.lastModified]);
  return { id: crypto.randomUUID(), identity, file, inFolder, status: "available", text: "" };
}

function fileSize(bytes: number, locale: string) {
  const mb = bytes >= 1024 * 1024;
  const kb = bytes >= 1024;
  const number = mb ? bytes / (1024 * 1024) : kb ? bytes / 1024 : bytes;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: mb ? "megabyte" : kb ? "kilobyte" : "byte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(number);
}

export async function readAskCmpriFileExcerpt(file: File, signal: AbortSignal) {
  signal.throwIfAborted();
  let text: string;
  if (file.type.startsWith("text/") || /^(application\/(json|xml))$/i.test(file.type) || /\.(txt|md|csv|tsv|json|xml|ya?ml|log)$/i.test(file.name)) {
    text = await file.slice(0, contextLimit * 4).text();
  } else {
    const { recognizeLocalDocument } = await import("@/lib/ocr/local-ocr");
    const result = await recognizeLocalDocument(file, { signal, readAllPages: true, maxPages: 10 });
    text = result.pages.map((page) => page.text).filter(Boolean).join("\n\n");
  }
  signal.throwIfAborted();
  return text.replaceAll("\u0000", "").trim().slice(0, contextLimit);
}

function replaceFolderEntries(previous: Entry[], folderEntries: Entry[]) {
  const priorEntries = new Map(previous.map((entry) => [entry.identity, entry]));
  return [
    ...folderEntries.map((entry) => priorEntries.get(entry.identity) ?? entry),
    ...previous.filter((entry) => !entry.inFolder),
  ];
}

async function listFolder(folder: AskCmpriFolderHandle) {
  const entries: Entry[] = [];
  for await (const handle of folder.values()) {
    if (handle.kind !== "file") continue;
    try {
      entries.push(entryFor(await (handle as FileSystemFileHandle).getFile(), true));
    } catch {
      /* Some files can be unavailable even when their directory is readable. */
    }
  }
  return entries;
}

export function AskCmpriFiles(props: Props) {
  const { t } = useFilesLanguage();
  if (props.scopeKey) return <AccountLocalFiles key={props.scopeKey} {...props} />;
  return <section id="ask-cmpri-files-view" className={styles.panel} role="tabpanel" aria-labelledby="ask-cmpri-files-tab"
    tabIndex={0} hidden={!props.open || !props.active}>
    <p className={styles.content} role={props.scopeError ? "alert" : "status"}>
      {props.scopeError || t("Checking your CMPRI access…")}
    </p>
  </section>;
}

function AccountLocalFiles({ open, active, scopeKey, focusFileId, focusExcerpt, selectionReset, onOpenFiles, onFilesChange }: Props) {
  const { t, locale } = useFilesLanguage();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [appliedReset, setAppliedReset] = useState(selectionReset);
  const [setupDismissed, setSetupDismissed] = useState<boolean>();
  const [folderSupported, setFolderSupported] = useState(false);
  const [folderConnected, setFolderConnected] = useState(false);
  const [folderRemembered, setFolderRemembered] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState("");
  const overlay = useRef<HTMLDivElement>(null);
  const decline = useRef<HTMLButtonElement>(null);
  const focusFilesTab = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const folder = useRef<AskCmpriFolderHandle | null>(null);
  const rememberedFolder = useRef<AskCmpriFolderHandle | null>(null);
  const permissionBusy = useRef(false);
  const restored = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const reading = useRef(new Map<string, AbortController>());
  const selectedIds = useRef(new Set<string>());
  const showSetup = open && setupDismissed === false;
  const requestSelectionActive = open && appliedReset === selectionReset;
  const focusedEntry = focusFileId ? entries.find((entry) => entry.id === focusFileId) : undefined;
  const focusedId = focusedEntry?.id;

  useEffect(() => {
    const session = new AbortController();
    lifetime.current = session;
    const currentReads = reading.current;
    const currentSelection = selectedIds.current;
    return () => {
      session.abort();
      if (lifetime.current === session) lifetime.current = null;
      for (const read of currentReads.values()) read.abort();
      currentReads.clear();
      currentSelection.clear();
      setActiveAskCmpriFolder(scopeKey, null);
    };
  }, [scopeKey]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      const supported = supportsAskCmpriFolder();
      setFolderSupported(supported);
      setSetupDismissed(consentRecorded());
      if (!supported || restored.current) return;
      try {
        const remembered = rememberedFolder.current ?? await loadAskCmpriFolder(scopeKey);
        if (cancelled || !remembered) return;
        rememberedFolder.current = remembered;
        setFolderRemembered(true);
        if (!await canUseAskCmpriFolder(remembered) || cancelled || permissionBusy.current || folder.current) return;
        const initialEntries = await listFolder(remembered);
        if (cancelled || permissionBusy.current || folder.current) return;
        folder.current = remembered;
        setActiveAskCmpriFolder(scopeKey, remembered);
        setFolderConnected(true);
        setFolderName(remembered.name);
        setEntries((previous) => replaceFolderEntries(previous, initialEntries));
      } catch {
        /* The file chooser and browser downloads remain available. */
      } finally {
        if (!cancelled) restored.current = true;
      }
    });
    return () => { cancelled = true; };
  }, [open, scopeKey]);

  useEffect(() => {
    if (requestSelectionActive) return;
    for (const read of reading.current.values()) read.abort();
    reading.current.clear();
    selectedIds.current.clear();
    queueMicrotask(() => {
      setEntries((previous) => previous.map((entry) => entry.status === "available" ? entry : { ...entry, status: "available", text: "" }));
      setDragging(false);
      setAppliedReset(selectionReset);
    });
  }, [requestSelectionActive, selectionReset]);

  useEffect(() => {
    for (const id of selectedIds.current) {
      if (entries.some((entry) => entry.id === id)) continue;
      reading.current.get(id)?.abort();
      reading.current.delete(id);
      selectedIds.current.delete(id);
    }
  }, [entries]);

  useEffect(() => {
    if (!showSetup) return;
    const node = overlay.current;
    if (!node?.parentElement) return;
    const priorFocus = document.activeElement;
    const siblings = [...node.parentElement.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== node && !child.inert,
    );
    for (const sibling of siblings) sibling.inert = true;
    decline.current?.focus({ preventScroll: true });
    return () => {
      for (const sibling of siblings) sibling.inert = false;
      const target = focusFilesTab.current ? document.getElementById("ask-cmpri-files-tab") : priorFocus;
      focusFilesTab.current = false;
      if (target instanceof HTMLElement && target.isConnected) {
        target.focus({ preventScroll: true });
      }
    };
  }, [showSetup]);

  const selected = useMemo<AskCmpriLocalFile[]>(() => entries
    .filter((entry) => entry.status === "selected")
    .map(({ id, file, text }) => ({ id, name: file.name.slice(0, 255), type: file.type.slice(0, 120), size: file.size, text })), [entries]);

  const pending = entries.filter((entry) => entry.status === "reading").length;
  const readError = entries.some((entry) => entry.status === "unreadable") ? t("An excluded file has no readable text. Check the Files tab.") : null;
  useEffect(() => {
    onFilesChange(requestSelectionActive ? selected : noExcerpts, { pending: requestSelectionActive ? pending : 0, error: requestSelectionActive ? readError : null });
  }, [onFilesChange, pending, readError, requestSelectionActive, selected]);

  useEffect(() => {
    if (!active || !open || !focusFileId || showSetup) return;
    const frame = requestAnimationFrame(() => {
      const element = focusedId
        ? panel.current?.querySelector<HTMLElement>(`[data-source-file-id="${CSS.escape(focusedId)}"]`)
        : panel.current?.querySelector<HTMLElement>("[data-file-source-fallback]");
      element?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focusFileId, focusedId, open, showSetup]);

  function dismissSetup() {
    recordConsent();
    setSetupDismissed(true);
  }

  function handleSetupKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismissSetup();
    }
    if (event.key !== "Tab") return;
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if ((!event.shiftKey && event.target === last) || (event.shiftKey && event.target === first)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  async function connectFolder(pickAnother = false) {
    if (permissionBusy.current) return;
    permissionBusy.current = true;
    setBusy(true);
    const session = lifetime.current;
    const alive = () => session && !session.signal.aborted;
    const previous = folder.current;
    try {
      let nextFolder = pickAnother ? null : previous;
      const remembered = rememberedFolder.current;
      if (!nextFolder && remembered && !pickAnother) {
        if (!await canUseAskCmpriFolder(remembered, true)) {
          if (alive()) setFeedback(t("Folder access was declined. You can pick another folder or choose files individually."));
          return;
        }
        nextFolder = remembered;
      }
      nextFolder ||= await pickAskCmpriFolder();
      const currentEntries = await listFolder(nextFolder);
      if (!alive()) return;
      folder.current = nextFolder;
      rememberedFolder.current = nextFolder;
      setActiveAskCmpriFolder(scopeKey, nextFolder);
      setFolderConnected(true);
      setFolderRemembered(true);
      setFolderName(nextFolder.name);
      if (pickAnother) {
        abortFolderReads();
        setEntries((old) => replaceFolderEntries(old.filter((entry) => !entry.inFolder), currentEntries));
      } else {
        setEntries((old) => replaceFolderEntries(old, currentEntries));
      }
      setFeedback(t("Selected folder connected."));
      try {
        await rememberAskCmpriFolder(scopeKey, nextFolder);
      } catch {
        if (alive()) setFeedback(t("Folder connected for this session. Browser storage could not remember it."));
      }
    } catch (error) {
      if (!alive()) return;
      if (pickAnother && previous) {
        setFeedback(t("Folder selection ended. The current folder is still connected."));
      } else {
        if (previous) clearFolder();
        setFeedback(error instanceof DOMException && error.name === "AbortError"
          ? t("Folder selection ended. You can choose files individually.")
          : t("In the folder picker, open Documents and select CMPRI-Engineering itself. You can also choose files individually."));
      }
    } finally {
      permissionBusy.current = false;
      if (alive()) setBusy(false);
    }
  }

  function abortFolderReads() {
    for (const { id, inFolder } of entries) {
      if (!inFolder) continue;
      reading.current.get(id)?.abort();
      reading.current.delete(id);
      selectedIds.current.delete(id);
    }
  }

  function clearFolder() {
    abortFolderReads();
    folder.current = null;
    setActiveAskCmpriFolder(scopeKey, null);
    setFolderConnected(false);
    setFolderName("");
    setEntries((previous) => previous.filter((entry) => !entry.inFolder));
  }

  async function disconnectFolder() {
    if (permissionBusy.current) return;
    permissionBusy.current = true;
    setBusy(true);
    const session = lifetime.current;
    clearFolder();
    rememberedFolder.current = null;
    setFolderRemembered(false);
    try {
      await forgetAskCmpriFolder(scopeKey);
      if (!session?.signal.aborted) setFeedback(t("Folder disconnected. Its files stay on this device."));
    } catch {
      if (!session?.signal.aborted) setFeedback(t("Folder disconnected for this session. Browser storage could not clear the remembered folder."));
    } finally {
      permissionBusy.current = false;
      if (!session?.signal.aborted) setBusy(false);
    }
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const session = lifetime.current;
    if (!session) return;
    if (permissionBusy.current) {
      setFeedback(t("Wait for the current folder operation, then add your files."));
      return;
    }
    const target = folder.current;
    const added: Entry[] = [];
    let connected = 0;
    let uncertain = false;
    if (target) {
      permissionBusy.current = true;
      setBusy(true);
    }
    try {
      for (const file of files) {
        if (session.signal.aborted) return;
        if (target) {
          try {
            added.push(entryFor(await saveAskCmpriFolderFile(target, file.name, file), true));
            connected++;
            continue;
          } catch (error) {
            uncertain ||= error instanceof AskCmpriFolderSaveError;
            /* Keep access to the user-selected original for this session. */
          }
        }
        added.push(entryFor(file, false));
      }
    } finally {
      if (target) {
        permissionBusy.current = false;
        if (!session.signal.aborted) setBusy(false);
      }
    }
    if (session.signal.aborted) return;
    setEntries((previous) => {
      const combined = new Map(previous.map((entry) => [entry.identity, entry]));
      for (const entry of added) {
        if (!combined.has(entry.identity)) combined.set(entry.identity, entry);
      }
      return [...combined.values()];
    });
    if (uncertain) setFeedback(t("Check the selected folder. Ask CMPRI could not verify every saved copy. The original files are available this session."));
    else if (connected === added.length) setFeedback(t("Files are ready to select and saved in the connected folder."));
    else if (target) setFeedback(t("Some files could not be saved in the connected folder. Those files are available this session."));
    else setFeedback(t("Files are ready to select for Ask CMPRI."));
  }

  async function downloadCopy(entry: Entry) {
    const session = lifetime.current;
    if (!session || permissionBusy.current) return;
    const target = folder.current;
    permissionBusy.current = true;
    setBusy(true);
    try {
      const destination = await downloadAskCmpriFile(scopeKey, entry.file.name, entry.file);
      if (session.signal.aborted) return;
      if (destination === "browser") {
        setFeedback(target
          ? t("The folder save could not finish. Check your browser’s downloads.")
          : t("Download sent to your browser."));
        return;
      }
      setFeedback(t("Saved a copy in the selected folder."));
      if (!target) return;
      const updated = await listFolder(target);
      if (!session.signal.aborted && folder.current === target) {
        setEntries((previous) => replaceFolderEntries(previous, updated));
      }
    } catch (error) {
      if (session.signal.aborted) return;
      if (error instanceof AskCmpriFolderSaveError) {
        setFeedback(t("Ask CMPRI could not verify the copy. Check the selected folder for {file} before downloading again.", { file: error.fileName }));
      } else {
        setFeedback(t("Check the selected folder or your browser’s downloads to verify the copy."));
      }
    } finally {
      permissionBusy.current = false;
      if (!session.signal.aborted) setBusy(false);
    }
  }

  function changeFile(id: string, status: Entry["status"], text = "") {
    setEntries((previous) => previous.map((entry) => entry.id === id ? { ...entry, status, text } : entry));
  }

  async function changeSelection(entry: Entry, useFile: boolean) {
    if (!useFile) {
      reading.current.get(entry.id)?.abort();
      reading.current.delete(entry.id);
      selectedIds.current.delete(entry.id);
      changeFile(entry.id, "available");
      return;
    }
    if (selectedIds.current.has(entry.id)) return;
    if (selectedIds.current.size >= ASK_MAX_FILES) {
      setFeedback(t("Select up to eight files. Clear one before adding another to Ask CMPRI."));
      return;
    }
    if (entry.file.size > ASK_MAX_ATTACHMENT_BYTES) {
      setFeedback(t("Choose a file of 100 MB or less for Ask CMPRI."));
      return;
    }
    setFeedback("");
    const reader = new AbortController();
    selectedIds.current.add(entry.id);
    reading.current.set(entry.id, reader);
    changeFile(entry.id, "reading");
    try {
      const text = await readAskCmpriFileExcerpt(entry.file, reader.signal);
      if (!reader.signal.aborted) {
        if (!text) selectedIds.current.delete(entry.id);
        changeFile(entry.id, text ? "selected" : "unreadable", text);
      }
    } catch {
      if (!reader.signal.aborted) {
        selectedIds.current.delete(entry.id);
        changeFile(entry.id, "unreadable");
      }
    } finally {
      if (reading.current.get(entry.id) === reader) reading.current.delete(entry.id);
    }
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  }

  function dragFiles(event: DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function selectFolder() {
    focusFilesTab.current = true;
    dismissSetup();
    onOpenFiles();
    if (folderSupported) void connectFolder();
  }

  return <>
    {showSetup && <div ref={overlay} className={styles.overlay} onKeyDown={handleSetupKeys}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="ask-cmpri-files-setup"
        aria-describedby="ask-cmpri-files-setup-help">
        <header className={styles.titlebar}>
          <h2 id="ask-cmpri-files-setup">{t("Set Up Local Files")}</h2>
          <button type="button" className={styles.close} aria-label={t("Close folder setup")} onClick={dismissSetup}>×</button>
        </header>
        <div className={styles.content}>
          <p>{t("Use Documents / CMPRI-Engineering on this device for files you download or add through Ask CMPRI?")}</p>
          <p id="ask-cmpri-files-setup-help" className={styles.muted}>{folderSupported
            ? t("In the browser picker, open Documents and select the CMPRI-Engineering folder itself. Create it there if needed.")
            : t("Choose files on this device and use browser downloads.")}</p>
          <div className={styles.actions}>
            <button ref={decline} type="button" className={styles.secondary} onClick={dismissSetup}>{t("Not now")}</button>
            <button type="button" className={styles.primary} onClick={selectFolder}>
              {t(folderSupported ? "Choose Folder" : "Open Files")}
            </button>
          </div>
        </div>
      </section>
    </div>}
    <section ref={panel} id="ask-cmpri-files-view" className={styles.panel} role="tabpanel" aria-labelledby="ask-cmpri-files-tab"
      tabIndex={0} hidden={!open || !active}>
      <div className={styles.content}>
        <div className={styles.location}>
          <div>
            <strong>{folderConnected ? folderName : "Documents / CMPRI-Engineering"}</strong>
            <p className={styles.muted}>{t(folderSupported
              ? folderConnected
                ? "Connected to the folder you selected on this device. Added files and downloads go there."
                : folderRemembered
                  ? "Grant access again to use the saved CMPRI folder."
                  : "Choose or create CMPRI-Engineering inside Documents, then select that folder."
              : "File selection and browser downloads are available on this device.")}</p>
          </div>
          {folderSupported && <div className={styles.folderActions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => void connectFolder()}>
              {t(folderConnected ? "Refresh folder" : folderRemembered ? "Reconnect folder" : "Connect folder")}
            </button>
            {folderRemembered && <button type="button" className={styles.link} disabled={busy}
              onClick={() => void connectFolder(true)}>{t("Choose another folder")}</button>}
            {folderRemembered && <button type="button" className={styles.link} disabled={busy}
              onClick={() => void disconnectFolder()}>{t("Disconnect folder")}</button>}
          </div>}
        </div>
        <div className={styles.drop} data-active={dragging}
          onDragEnter={dragFiles} onDragOver={dragFiles}
          onDragLeave={(event) => {
            event.stopPropagation();
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
          }}
          onDrop={dropFiles}>
          <p>{t("Drop files here or choose files on this device.")}</p>
          <label className={styles.filePicker}>
            <input type="file" multiple disabled={busy} className={styles.visuallyHidden} onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void addFiles(files);
            }} />
            <span className={styles.secondary}>{t("Choose files")}</span>
          </label>
        </div>
        <p className={`${styles.muted} ${styles.feedback}`} role="status">{feedback}</p>
        {focusFileId && (!focusedEntry || focusedEntry.status !== "selected") && <aside className={styles.sourceExcerpt}
          tabIndex={-1} data-file-source-fallback>
          {focusExcerpt && focusExcerpt.id === focusFileId && <>
            <strong>{focusExcerpt.name}</strong>
            <p>{focusExcerpt.text}</p>
          </>}
          {!focusedEntry && <p className={styles.muted}>{t("Choose the original file on this device to open it from Files.")}</p>}
        </aside>}
        <div className={styles.heading}>
          <h3>{t("Available files")}</h3>
          <span className={styles.muted}>{t("Selected")} · {selected.length} / {ASK_MAX_FILES}
            {pending > 0 && <> · {t("Reading")} {pending}</>}</span>
        </div>
        {entries.length === 0 ? <p className={styles.muted}>{t("Choose or drop a file to make it available in Ask CMPRI.")}</p>
          : <ul className={styles.list} aria-label={t("Local files")}>
            {entries.map((entry) => <li className={styles.file} key={entry.id} data-source-file-id={entry.id}
              tabIndex={entry.id === focusFileId ? -1 : undefined}>
              <div className={styles.fileRow}>
                <span className={styles.fileIdentity}><strong>{entry.file.name}</strong>
                  <span className={styles.muted}> · {fileSize(entry.file.size, locale)} · {t(entry.inFolder ? "CMPRI folder" : "This session")}</span>
                </span>
                <div className={styles.fileActions}>
                  <label className={styles.fileCheck}>
                    <input type="checkbox" checked={entry.status === "reading" || entry.status === "selected"}
                      aria-label={t("Use {file} in Ask CMPRI", { file: entry.file.name })}
                      onChange={(event) => void changeSelection(entry, event.currentTarget.checked)} />
                    {t("Use in Ask CMPRI")}
                  </label>
                  <button type="button" className={styles.link} disabled={busy}
                    aria-label={t("Download a copy of {file}", { file: entry.file.name })}
                    onClick={() => void downloadCopy(entry)}>{t("Download copy")}</button>
                </div>
              </div>
              {entry.status === "reading" && <p className={styles.muted} role="status">{t("Reading text on this device…")}</p>}
              {entry.status === "unreadable" && <p className={styles.muted} role="status">
                {t("No readable text was found. Try a text file, PDF, PNG, JPEG, or WebP copy.")}</p>}
              {entry.status === "selected" && <details className={styles.excerpt} open={entry.id === focusFileId ? true : undefined}>
                <summary>{t("Review text for Ask CMPRI")}</summary>
                <p>{entry.text}</p>
              </details>}
            </li>)}
          </ul>}
        <p className={styles.muted}>{t("Ask CMPRI uses selected text excerpts. It reads the beginning of text files and up to 10 pages of PDFs.")}</p>
      </div>
    </section>
  </>;
}
