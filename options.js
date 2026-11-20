import { SPEEDS, DEFAULT_SPEED, BUFFER_AHEAD, MAX_REQUESTS_PER_SECOND, speedSetting } from './lib/download.js';
import { saveToSetting, savedFolder, chooseFolder } from './lib/save-location.js';
import { icon } from './lib/icons.js';

const speedForm = document.getElementById('speeds');
const saveToForm = document.getElementById('save-to');
const folderError = document.getElementById('folder-error');
const saved = document.getElementById('saved');
document.getElementById('max-rate').textContent = MAX_REQUESTS_PER_SECOND;
document.getElementById('logo').append(icon('settings', 17));
document.getElementById('about').prepend(icon('lock', 15));
document.getElementById('version').textContent = `Version ${chrome.runtime.getManifest().version}.`;

const ICONS = { normal: 'gauge', fast: 'bolt', max: 'rocket', downloads: 'download', folder: 'folder', ask: 'dialog' };
const NOTES = {
  max: 'The easiest for a site to notice.',
};

async function readSettings() {
  try {
    return (await chrome.storage.local.get('settings')).settings || {};
  } catch {
    return {};
  }
}

// Read fresh each time: the download page also saves the speed.
async function saveSetting(patch) {
  await chrome.storage.local.set({ settings: { ...(await readSettings()), ...patch } });
  saved.hidden = false;
  clearTimeout(saveSetting.timer);
  saveSetting.timer = setTimeout(() => (saved.hidden = true), 1500);
}

// Rough time for a 10-minute video at each speed.
function tenMinutesAt(speed) {
  const minutes = Math.round(((600 - BUFFER_AHEAD) / speed / 60) * 2) / 2;
  if (minutes < 1) return 'under a minute';
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function option({ name, key, label, detail, checked, recommended = false }) {
  const input = Object.assign(document.createElement('input'), { type: 'radio', name, value: key, checked });
  const iconBox = document.createElement('span');
  iconBox.className = 'option-icon';
  iconBox.append(icon(ICONS[key] || 'gauge', 19));
  const title = document.createElement('span');
  title.className = 'option-title';
  title.textContent = label;
  if (recommended) {
    const badge = document.createElement('span');
    badge.className = 'chip accent';
    badge.textContent = 'Recommended';
    title.append(badge);
  }
  const detailBox = document.createElement('span');
  detailBox.className = 'option-detail';
  detailBox.append(...[detail].flat());
  const text = document.createElement('span');
  text.className = 'option-text';
  text.append(title, detailBox);
  const check = document.createElement('span');
  check.className = 'check';
  check.append(icon('check', 13));
  const box = document.createElement('label');
  box.className = 'option';
  box.dataset.key = key;
  box.append(input, iconBox, text, check);
  return box;
}

function speedOption(key, s, checked) {
  const connections = s.connections === 1 ? 'one connection' : `${s.connections} connections`;
  const pace = Number.isFinite(s.speed)
    ? `Up to ${s.speed}× playback speed, ${connections}. A 10-minute video takes ${tenMinutesAt(s.speed)}.`
    : `As fast as your connection allows, up to ${s.connections} requests at a time.`;
  return option({ name: 'speed', key, label: s.label, detail: `${pace}${NOTES[key] ? ` ${NOTES[key]}` : ''}`, checked, recommended: key === DEFAULT_SPEED });
}

// ------------------------------------------------------------ save to

let folder = null; // handle of the chosen folder
let saveTo = 'downloads';

function folderDetail() {
  if (!folder) return 'Pick any folder on your computer.';
  const name = Object.assign(document.createElement('b'), { textContent: folder.name });
  const change = Object.assign(document.createElement('button'), { type: 'button', className: 'btn ghost', id: 'change-folder' });
  change.append(icon('folder', 14), 'Change folder…');
  change.addEventListener('click', (e) => {
    e.preventDefault(); // the button sits inside the option's label
    pickFolder();
  });
  return ['Saves to ', name, '. Chrome asks you to allow it once in a while.', document.createElement('br'), change];
}

function renderSaveTo() {
  saveToForm.replaceChildren(
    option({ name: 'save-to', key: 'downloads', label: 'Downloads folder', detail: 'Where Chrome saves your other downloads.', checked: saveTo === 'downloads' }),
    option({ name: 'save-to', key: 'folder', label: 'A folder you choose', detail: folderDetail(), checked: saveTo === 'folder' }),
    option({ name: 'save-to', key: 'ask', label: 'Ask every time', detail: 'Chrome asks where to save each video.', checked: saveTo === 'ask' })
  );
}

async function pickFolder() {
  folderError.hidden = true;
  try {
    folder = await chooseFolder();
  } catch (e) {
    if (e.name !== 'AbortError') {
      folderError.textContent = `Couldn't use that folder: ${e.message}`;
      folderError.hidden = false;
    }
    renderSaveTo(); // back to the previous choice
    return;
  }
  saveTo = 'folder';
  renderSaveTo();
  await saveSetting({ saveTo });
}

saveToForm.addEventListener('change', async (e) => {
  const value = e.target.value;
  if (value === 'folder' && !folder) return pickFolder(); // the click lets Chrome show the picker
  saveTo = value;
  folderError.hidden = true;
  await saveSetting({ saveTo });
});

async function load() {
  const settings = await readSettings();
  const current = speedSetting(settings.speed);
  for (const [key, s] of Object.entries(SPEEDS)) speedForm.append(speedOption(key, s, key === current));
  speedForm.addEventListener('change', (e) => saveSetting({ speed: e.target.value }));

  folder = await savedFolder();
  saveTo = saveToSetting(settings.saveTo);
  if (saveTo === 'folder' && !folder) saveTo = 'downloads';
  renderSaveTo();
}

load();
