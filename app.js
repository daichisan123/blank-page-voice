// Blank Page on the phone: voice notes only. Notes live on the phone
// (localStorage); recordings wait in IndexedDB until they are transcribed, so
// one made without signal is never lost. "Send to Drive" shares a note as a
// .md file the desktop app reads like any other.

const $ = (id) => document.getElementById(id);
const GROQ = 'https://api.groq.com/openai/v1';
const MODEL = 'whisper-large-v3-turbo';

// --- notes -------------------------------------------------------------------

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function loadNotes() {
  try { return JSON.parse(localStorage.getItem('notes') || '[]'); } catch { return []; }
}
function saveNotes() {
  localStorage.setItem('notes', JSON.stringify(notes));
}
let notes = loadNotes();
let current = null; // the open note

const firstLine = (text) => (text.trim().split('\n')[0] || '').trim();
const titleOf = (note) => firstLine(note.text).slice(0, 120) || 'Untitled';

function touch(note) {
  note.updated = new Date().toISOString();
  if (!notes.includes(note)) notes.push(note);
  saveNotes();
}

// --- key ---------------------------------------------------------------------

const getKey = () => localStorage.getItem('groqKey') || '';

// --- recordings waiting to be transcribed -------------------------------------

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('blank-page', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function store(mode, run) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('pending', mode);
    const req = run(tx.objectStore('pending'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const putPending = (item) => store('readwrite', (s) => s.put(item));
const dropPending = (id) => store('readwrite', (s) => s.delete(id));
const allPending = () => store('readonly', (s) => s.getAll());

async function transcribe(blob, type) {
  const key = getKey();
  if (!key) throw new Error('No Groq key yet. Add it in Settings.');
  const form = new FormData();
  form.append('file', blob, `voice.${type.includes('mp4') ? 'm4a' : 'webm'}`);
  form.append('model', MODEL);
  form.append('response_format', 'json');
  const res = await fetch(`${GROQ}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(res.status === 401 ? 'Groq refused the key. Check it in Settings.' : `Groq returned ${res.status}. ${detail.slice(0, 120)}`);
  }
  return String((await res.json()).text || '').trim();
}

// --- views -------------------------------------------------------------------

function show(view) {
  for (const id of ['list-view', 'note-view', 'settings-view']) $(id).hidden = id !== view;
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function renderList() {
  const list = $('notes');
  list.textContent = '';
  const sorted = notes.filter((n) => n.text.trim()).sort((a, b) => (a.updated < b.updated ? 1 : -1));
  $('empty').hidden = sorted.length > 0;
  for (const note of sorted) {
    const li = document.createElement('li');
    const title = document.createElement('div');
    title.className = 'n-title';
    title.textContent = titleOf(note);
    const meta = document.createElement('div');
    meta.className = 'n-meta';
    const unsent = !note.sentAt || note.sentAt < note.updated;
    meta.textContent = when(note.updated);
    if (unsent) {
      const flag = document.createElement('span');
      flag.className = 'n-flag';
      flag.textContent = ' · not sent yet';
      meta.append(flag);
    }
    li.append(title, meta);
    li.addEventListener('click', () => openNote(note));
    list.append(li);
  }
}

function openNote(note) {
  current = note;
  $('body').value = note.text;
  $('draft').value = '';
  sizeDraft();
  setStatus('');
  show('note-view');
  history.pushState({ note: note.id }, ''); // so the phone's back gesture closes the note
  renderPending();
  requestAnimationFrame(() => { $('body').scrollTop = $('body').scrollHeight; });
}

function closeNote() {
  if (recorder) stopRecording();
  // A note never written in leaves nothing behind.
  if (current && !current.text.trim()) notes = notes.filter((n) => n !== current);
  saveNotes();
  current = null;
  renderList();
  show('list-view');
}

$('new-note').addEventListener('click', () => {
  const now = new Date().toISOString();
  openNote({ id: newId(), text: '', created: now, updated: now, sentAt: '' });
});
$('back').addEventListener('click', () => history.back());
window.addEventListener('popstate', () => { if (!$('note-view').hidden) closeNote(); });

let bodyTimer = 0;
$('body').addEventListener('input', () => {
  clearTimeout(bodyTimer);
  bodyTimer = setTimeout(() => { current.text = $('body').value; touch(current); }, 400);
});

$('delete').addEventListener('click', () => {
  if (!current || !confirm('Delete this note from the phone?')) return;
  notes = notes.filter((n) => n !== current);
  current.text = '';
  history.back();
});

// --- the draft box and Enter ---------------------------------------------------

function sizeDraft() {
  const d = $('draft');
  d.style.height = 'auto';
  d.style.height = `${d.scrollHeight + 2}px`;
  $('enter').disabled = !d.value.trim();
}
$('draft').addEventListener('input', sizeDraft);
$('draft').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
});
$('enter').addEventListener('click', commit);

// Enter puts the draft into the note, on a line of its own.
function commit() {
  const text = $('draft').value.trim();
  if (!text || !current) return;
  clearTimeout(bodyTimer);
  const before = $('body').value.replace(/\s+$/, '');
  current.text = before ? `${before}\n${text}` : text;
  $('body').value = current.text;
  touch(current);
  $('draft').value = '';
  sizeDraft();
  $('body').scrollTop = $('body').scrollHeight;
}

function addToDraft(text) {
  if (!text) return;
  const d = $('draft');
  d.value = d.value.trim() ? `${d.value.trimEnd()} ${text}` : text;
  sizeDraft();
}

function setStatus(text, error = false) {
  $('status').hidden = !text;
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

// --- recording -------------------------------------------------------------------

let recorder = null;
let wakeLock = null;
let tick = 0;

const TYPE = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

$('mic').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));

async function startRecording() {
  if (!getKey()) { openSettings(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus('The microphone is blocked. Allow it for this site in Chrome.', true);
    return;
  }
  const chunks = [];
  const noteId = current.id; // the note may be closed before the recording ends
  // 32 kbit/s keeps an hour of talking well under Groq's 25 MB limit.
  recorder = new MediaRecorder(stream, { ...(TYPE ? { mimeType: TYPE } : {}), audioBitsPerSecond: 32000 });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || TYPE || 'audio/webm';
    recorder = null;
    handleRecording(new Blob(chunks, { type }), type, noteId);
  };
  recorder.start(1000);
  $('mic').classList.add('recording');
  $('mic').setAttribute('aria-label', 'Stop recording');
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* the screen may sleep */ }
  const started = Date.now();
  const update = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    setStatus(`Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · tap ■ to stop`);
  };
  update();
  tick = setInterval(update, 1000);
}

function stopRecording() {
  clearInterval(tick);
  $('mic').classList.remove('recording');
  $('mic').setAttribute('aria-label', 'Record');
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

// Kept first, transcribed second: a failed or offline transcription leaves
// the recording waiting under the note.
async function handleRecording(blob, type, noteId) {
  if (!blob.size) { setStatus(''); return; }
  const item = { id: newId(), noteId, blob, type, at: new Date().toISOString() };
  try { await putPending(item); } catch { /* still try to transcribe */ }
  await run(item);
}

let running = false;
async function run(item) {
  running = true;
  $('mic').classList.add('busy');
  setStatus('Turning speech into text…');
  try {
    const text = await transcribe(item.blob, item.type);
    if (current && current.id === item.noteId) addToDraft(text);
    else if (text) appendToNote(item.noteId, text);
    await dropPending(item.id).catch(() => {});
    setStatus(text ? '' : 'Nothing was heard in that recording.');
  } catch (error) {
    setStatus(navigator.onLine ? error.message : 'No signal. The recording is kept and will be turned into text when you are back online.', true);
  } finally {
    running = false;
    $('mic').classList.remove('busy');
    renderPending();
  }
}

// A recording finished after its note was closed goes straight into that note.
function appendToNote(noteId, text) {
  const note = notes.find((n) => n.id === noteId);
  if (!note) return;
  note.text = note.text.trim() ? `${note.text.replace(/\s+$/, '')}\n${text}` : text;
  touch(note);
  renderList();
}

async function renderPending() {
  const box = $('pending');
  let waiting = [];
  try { waiting = (await allPending()).filter((p) => current && p.noteId === current.id); } catch { /* no storage */ }
  box.hidden = !waiting.length || running;
  if (box.hidden) return;
  box.textContent = `${waiting.length} recording${waiting.length > 1 ? 's' : ''} not turned into text yet`;
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.addEventListener('click', retryAll);
  box.append(retry);
}

async function retryAll() {
  let waiting = [];
  try { waiting = await allPending(); } catch { return; }
  for (const item of waiting.sort((a, b) => (a.at < b.at ? -1 : 1))) {
    if (running) return;
    await run(item);
  }
}
window.addEventListener('online', retryAll);

// --- sending to the desktop app ---------------------------------------------------

const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';

// The same header and file name the desktop app writes, so it reads the note
// as its own and labels it on the next start.
function asMarkdown(note) {
  const lines = note.text.trim().split('\n');
  const title = lines[0].trim().slice(0, 120);
  const body = lines.slice(1).join('\n').trim();
  const meta = { id: note.id, title, created: note.created, updated: note.updated };
  const header = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`).join('\n');
  return { name: `${slug(title)}-${note.id}.md`, text: `---\n${header}\n---\n\n${body}\n` };
}

$('share').addEventListener('click', async () => {
  if (!current || !current.text.trim()) return;
  clearTimeout(bodyTimer);
  current.text = $('body').value;
  touch(current);
  const { name, text } = asMarkdown(current);
  const files = [new File([text], name, { type: 'text/markdown' }), new File([text], name, { type: 'text/plain' })];
  const file = files.find((f) => navigator.canShare && navigator.canShare({ files: [f] }));
  try {
    if (file) {
      await navigator.share({ files: [file], title: titleOf(current) });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    current.sentAt = new Date().toISOString();
    saveNotes();
    setStatus('Sent. Save it in Drive → Blank Page.');
  } catch (error) {
    if (error.name !== 'AbortError') setStatus(`Could not share: ${error.message}`, true);
  }
});

// --- settings ------------------------------------------------------------------------

let settingsFrom = 'list-view';
function openSettings() {
  settingsFrom = current ? 'note-view' : 'list-view';
  $('key').value = getKey();
  $('key-status').textContent = getKey() ? 'A key is saved.' : 'Get a free key at console.groq.com → API Keys.';
  show('settings-view');
}
$('open-settings').addEventListener('click', openSettings);
$('settings-back').addEventListener('click', () => show(settingsFrom));

$('save-key').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) return;
  $('key-status').textContent = 'Checking…';
  try {
    const res = await fetch(`${GROQ}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 401) { $('key-status').textContent = 'Groq refused that key.'; return; }
    localStorage.setItem('groqKey', key);
    $('key-status').textContent = res.ok ? 'Saved. The key works.' : `Saved, but Groq answered ${res.status}.`;
  } catch {
    localStorage.setItem('groqKey', key);
    $('key-status').textContent = 'Saved. It could not be checked without signal.';
  }
});

// --- start -----------------------------------------------------------------------------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
renderList();
show('list-view');
if (navigator.onLine) retryAll();
