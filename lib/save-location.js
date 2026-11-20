// Where finished videos are saved (Settings → Save to):
//  - 'downloads': Chrome's download folder (chrome.downloads)
//  - 'ask':       Chrome asks every time (Save As window)
//  - 'folder':    a folder the user picked. Chrome only hands extensions a
//                 handle to it (never its full path), kept in IndexedDB.

export const SAVE_TO = ['downloads', 'folder', 'ask'];
export const DEFAULT_SAVE_TO = 'downloads';
export const saveToSetting = (value) => (SAVE_TO.includes(value) ? value : DEFAULT_SAVE_TO);

const DB_NAME = 'save-location';
const STORE = 'handles';
const KEY = 'folder';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The chosen folder's handle, or null. */
export async function savedFolder() {
  try {
    return (await withStore('readonly', (s) => s.get(KEY))) || null;
  } catch {
    return null;
  }
}

export const rememberFolder = (handle) => withStore('readwrite', (s) => s.put(handle, KEY));

/** Opens Chrome's folder picker (needs a click) and remembers the folder. */
export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'save-videos', mode: 'readwrite', startIn: 'videos' });
  await rememberFolder(handle);
  return handle;
}

export async function hasAccess(handle) {
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Asks Chrome for write access; must run right after a click. */
export async function askAccess(handle) {
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return false;
    if (e.name === 'TypeMismatchError') return true; // a folder with that name
    throw e;
  }
}

// "Name.mp4", then "Name (1).mp4", "Name (2).mp4", … like Chrome's downloads.
async function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 0; ; i++) {
    const candidate = i ? `${stem} (${i})${ext}` : name;
    if (!(await exists(dir, candidate))) return candidate;
  }
}

/** Writes `blob` into the folder without replacing a file; returns the name used. */
export async function writeToFolder(dir, name, blob) {
  const fileName = await freeName(dir, name);
  const file = await dir.getFileHandle(fileName, { create: true });
  try {
    await blob.stream().pipeTo(await file.createWritable()); // closes (commits) on success
  } catch (e) {
    await dir.removeEntry(fileName).catch(() => {});
    throw e;
  }
  return fileName;
}

/** Plain-language message for a failed write. */
export function folderError(e, folderName) {
  if (e?.name === 'NotFoundError') return `The folder “${folderName}” doesn't exist any more. Choose another one in Settings.`;
  if (e?.name === 'NotAllowedError') return `Chrome didn't allow saving to “${folderName}”.`;
  if (e?.name === 'QuotaExceededError') return `There isn't enough free space to save to “${folderName}”.`;
  return `Couldn't save to “${folderName}”: ${e?.message || e}`;
}
