"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import {
  canUseAskCmpriFolder,
  downloadAskCmpriFile,
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

type Props = {
  open: boolean;
  active: boolean;
  scopeKey: string;
  onOpenFiles: () => void;
  onFilesChange: (files: AskCmpriLocalFile[]) => void;
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
let consentInMemory = false;

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

async function extractText(file: File, signal: AbortSignal) {
  let text: string;
  if (file.type.startsWith("text/") || /\.(txt|md|csv|tsv|json|ya?ml|log)$/i.test(file.name)) {
    text = await file.slice(0, contextLimit * 4).text();
  } else {
    const { recognizeLocalDocument } = await import("@/lib/ocr/local-ocr");
    const result = await recognizeLocalDocument(file, { signal, readAllPages: true, maxPages: 10 });
    text = result.pages.map((page) => page.text).filter(Boolean).join("\n\n");
  }
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
  return props.scopeKey ? <AccountLocalFiles key={props.scopeKey} {...props} /> : null;
}

function AccountLocalFiles({ open, active, scopeKey, onOpenFiles, onFilesChange }: Props) {
  const { t, locale } = useUiLanguage();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [setupDismissed, setSetupDismissed] = useState<boolean>();
  const [folderSupported, setFolderSupported] = useState(false);
  const [folderConnected, setFolderConnected] = useState(false);
  const [folderRemembered, setFolderRemembered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState("");
  const overlay = useRef<HTMLDivElement>(null);
  const decline = useRef<HTMLButtonElement>(null);
  const focusFilesTab = useRef(false);
  const folder = useRef<AskCmpriFolderHandle | null>(null);
  const rememberedFolder = useRef<AskCmpriFolderHandle | null>(null);
  const permissionBusy = useRef(false);
  const restored = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const reading = useRef(new Map<string, AbortController>());
  const showSetup = open && setupDismissed === false;

  useEffect(() => {
    const session = new AbortController();
    lifetime.current = session;
    const currentReads = reading.current;
    return () => {
      session.abort();
      if (lifetime.current === session) lifetime.current = null;
      for (const read of currentReads.values()) read.abort();
      currentReads.clear();
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

  useEffect(() => { onFilesChange(selected); }, [onFilesChange, selected]);

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
    try {
      let nextFolder = folder.current;
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
      setEntries((previous) => replaceFolderEntries(previous, currentEntries));
      setFeedback(t("CMPRI-Engineering is connected."));
      void rememberAskCmpriFolder(scopeKey, nextFolder).catch(() => {});
    } catch {
      if (!alive()) return;
      folder.current = null;
      setActiveAskCmpriFolder(scopeKey, null);
      setFolderConnected(false);
      setEntries((previous) => previous.filter((entry) => !entry.inFolder));
      setFeedback(t("In the folder picker, open Documents and select CMPRI-Engineering itself. You can also choose files individually."));
    } finally {
      permissionBusy.current = false;
      if (alive()) setBusy(false);
    }
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const session = lifetime.current;
    if (!session) return;
    const target = folder.current;
    const added: Entry[] = [];
    let connected = 0;
    for (const file of files) {
      if (session.signal.aborted) return;
      if (target) {
        try {
          added.push(entryFor(await saveAskCmpriFolderFile(target, file.name, file), true));
          connected++;
          continue;
        } catch {
          /* Keep access to the user-selected original for this session. */
        }
      }
      added.push(entryFor(file, false));
    }
    if (session.signal.aborted) return;
    setEntries((previous) => {
      const combined = new Map(previous.map((entry) => [entry.identity, entry]));
      for (const entry of added) {
        if (!combined.has(entry.identity)) combined.set(entry.identity, entry);
      }
      return [...combined.values()];
    });
    setFeedback(connected === added.length
      ? t("Files are ready to select and saved in CMPRI-Engineering.")
      : t("Files are ready to select for Ask CMPRI."));
  }

  async function downloadCopy(entry: Entry) {
    const session = lifetime.current;
    if (!session) return;
    const destination = await downloadAskCmpriFile(scopeKey, entry.file.name, entry.file);
    if (session.signal.aborted) return;
    if (destination === "browser") {
      setFeedback(t("Download sent to your browser."));
      return;
    }
    setFeedback(t("Saved a copy in CMPRI-Engineering."));
    const target = folder.current;
    if (!target) return;
    try {
      const updated = await listFolder(target);
      if (!session.signal.aborted && folder.current === target) {
        setEntries((previous) => replaceFolderEntries(previous, updated));
      }
    } catch {
      /* The saved file appears the next time the folder refreshes. */
    }
  }

  function changeFile(id: string, status: Entry["status"], text = "") {
    setEntries((previous) => previous.map((entry) => entry.id === id ? { ...entry, status, text } : entry));
  }

  async function changeSelection(entry: Entry, useFile: boolean) {
    reading.current.get(entry.id)?.abort();
    reading.current.delete(entry.id);
    if (!useFile) {
      changeFile(entry.id, "available");
      return;
    }
    const reader = new AbortController();
    reading.current.set(entry.id, reader);
    changeFile(entry.id, "reading");
    try {
      const text = await extractText(entry.file, reader.signal);
      if (!reader.signal.aborted) changeFile(entry.id, text ? "selected" : "unreadable", text);
    } catch {
      if (!reader.signal.aborted) changeFile(entry.id, "unreadable");
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
    <section id="ask-cmpri-files-view" className={styles.panel} role="tabpanel" aria-labelledby="ask-cmpri-files-tab"
      tabIndex={0} hidden={!open || !active}>
      <div className={styles.content}>
        <div className={styles.location}>
          <div>
            <strong>Documents / CMPRI-Engineering</strong>
            <p className={styles.muted}>{t(folderSupported
              ? folderConnected
                ? "Folder connected. Added files and downloads are saved here."
                : folderRemembered
                  ? "Grant access again to use the saved CMPRI folder."
                  : "Choose or create CMPRI-Engineering inside Documents, then select that folder."
              : "File selection and browser downloads are available on this device.")}</p>
          </div>
          {folderSupported && <div className={styles.folderActions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => void connectFolder()}>
              {t(folderConnected ? "Refresh folder" : folderRemembered ? "Reconnect folder" : "Connect folder")}
            </button>
            {folderRemembered && !folderConnected && <button type="button" className={styles.link} disabled={busy}
              onClick={() => void connectFolder(true)}>{t("Choose another folder")}</button>}
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
            <input type="file" multiple className={styles.visuallyHidden} onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void addFiles(files);
            }} />
            <span className={styles.secondary}>{t("Choose files")}</span>
          </label>
        </div>
        <p className={styles.muted} role="status">{feedback}</p>
        <div className={styles.heading}>
          <h3>{t("Available files")}</h3>
          {selected.length > 0 && <span className={styles.muted}>{t("Selected")} · {selected.length}</span>}
        </div>
        {entries.length === 0 ? <p className={styles.muted}>{t("Choose or drop a file to make it available in Ask CMPRI.")}</p>
          : <ul className={styles.list} aria-label={t("Local files")}>
            {entries.map((entry) => <li className={styles.file} key={entry.id}>
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
                  <button type="button" className={styles.link}
                    aria-label={t("Download a copy of {file}", { file: entry.file.name })}
                    onClick={() => void downloadCopy(entry)}>{t("Download copy")}</button>
                </div>
              </div>
              {entry.status === "reading" && <p className={styles.muted} role="status">{t("Reading text on this device…")}</p>}
              {entry.status === "unreadable" && <p className={styles.muted} role="status">
                {t("No readable text was found. Try a text file, PDF, PNG, JPEG, or WebP copy.")}</p>}
              {entry.status === "selected" && <details className={styles.excerpt}>
                <summary>{t("Review text for Ask CMPRI")}</summary>
                <p>{entry.text}</p>
              </details>}
            </li>)}
          </ul>}
        <p className={styles.muted}>{t("Select files to review a text excerpt. Ask CMPRI uses those excerpts for your CMPRI request.")}</p>
      </div>
    </section>
  </>;
}
