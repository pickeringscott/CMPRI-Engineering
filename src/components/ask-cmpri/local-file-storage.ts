/** Browser-owned folder permissions. File contents are never stored in IndexedDB. */
const databaseName = "cmpri-ask-local-files";
const folderStore = "folders";
const folderName = "CMPRI-Engineering";
const pickerId = "cmpri-engineering-documents";
const permissionOptions = { mode: "readwrite" } as const;

export type AskCmpriFolderHandle = FileSystemDirectoryHandle & {
  queryPermission(options: typeof permissionOptions): Promise<PermissionState>;
  requestPermission(options: typeof permissionOptions): Promise<PermissionState>;
  values(): AsyncIterable<FileSystemHandle>;
};

type DirectoryPicker = (options: {
  id: string;
  mode: "readwrite";
  startIn: "documents";
}) => Promise<AskCmpriFolderHandle>;

function getPicker() {
  if (typeof window === "undefined" || !window.isSecureContext) return undefined;
  return (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
}

export function supportsAskCmpriFolder() {
  return typeof getPicker() === "function";
}

export async function pickAskCmpriFolder() {
  const picker = getPicker();
  if (!picker) throw new Error("Folder selection is unavailable in this browser.");
  const chosen = await picker.call(window, { id: pickerId, startIn: "documents", ...permissionOptions });
  const name = chosen.name.normalize().toLowerCase();
  if (name === folderName.toLowerCase()) return chosen;
  if (name === "documents") {
    return await chosen.getDirectoryHandle(folderName, { create: true }) as AskCmpriFolderHandle;
  }
  throw new DOMException("Choose CMPRI-Engineering inside Documents.", "NotFoundError");
}

function openFolderStore() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(folderStore);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadAskCmpriFolder(scopeKey: string) {
  const database = await openFolderStore();
  try {
    return await new Promise<AskCmpriFolderHandle | null>((resolve, reject) => {
      const request = database.transaction(folderStore, "readonly").objectStore(folderStore).get(scopeKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export async function rememberAskCmpriFolder(scopeKey: string, folder: AskCmpriFolderHandle) {
  const database = await openFolderStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(folderStore, "readwrite");
      transaction.objectStore(folderStore).put(folder, scopeKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function canUseAskCmpriFolder(folder: AskCmpriFolderHandle, request = false) {
  const permission = request
    ? await folder.requestPermission(permissionOptions)
    : await folder.queryPermission(permissionOptions);
  return permission === "granted";
}

const activeFolders = new Map<string, AskCmpriFolderHandle>();
let pendingWrite: Promise<unknown> = Promise.resolve();

export function setActiveAskCmpriFolder(scopeKey: string, folder: AskCmpriFolderHandle | null) {
  if (folder) activeFolders.set(scopeKey, folder);
  else activeFolders.delete(scopeKey);
}

function safeFileName(name: string) {
  const sanitized = name
    .split(/[\\/]/)
    .pop()
    ?.replace(/[<>:"|?*]/g, "_")
    .trim();
  const bounded = Array.from(sanitized ?? "", (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "_" : character;
  }).join("");
  return bounded && !/^\.+$/.test(bounded) ? bounded : "CMPRI document";
}

async function unusedFileName(folder: AskCmpriFolderHandle, name: string) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let copy = 2; ; copy++) {
    try {
      await folder.getFileHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return candidate;
      if (!(error instanceof DOMException) || error.name !== "TypeMismatchError") throw error;
    }
    candidate = base + " (" + copy + ")" + extension;
  }
}

export async function saveAskCmpriFolderFile(folder: AskCmpriFolderHandle, name: string, blob: Blob) {
  const write = async () => {
    const target = await folder.getFileHandle(await unusedFileName(folder, safeFileName(name)), { create: true });
    const stream = await target.createWritable();
    try {
      await stream.write(blob);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
    return target.getFile();
  };
  const result = pendingWrite.then(async () => navigator.locks
    ? await navigator.locks.request("cmpri-engineering-file-write", write)
    : await write());
  pendingWrite = result.catch(() => {});
  return result;
}

export async function downloadAskCmpriFile(scopeKey: string, name: string, blob: Blob) {
  const folder = activeFolders.get(scopeKey);
  if (folder) {
    try {
      await saveAskCmpriFolderFile(folder, name, blob);
      return "folder" as const;
    } catch {
      /* The browser download remains available after a folder permission changes. */
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFileName(name);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "browser" as const;
}
