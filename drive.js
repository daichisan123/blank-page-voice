// Saves phone notes straight into the "Blank Page" folder in Google Drive,
// which Drive for desktop syncs to the laptop, where the desktop app picks
// them up. Sign-in is Google's own (Identity Services): a token lasts an
// hour, and getting a new one needs a tap, so syncing waits for one.
//
// A file changed on the laptop is never overwritten. If only its header
// changed (the desktop app added labels), the phone keeps that header and
// writes its text under it; if the text changed there, the phone's version
// goes into a new note instead.

const Drive = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  const read = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  const clientId = () => localStorage.getItem('driveClientId') || '';
  const folder = () => read('driveFolder'); // { id, name, count }
  let token = read('driveToken');           // { value, expires }
  const signedIn = () => Boolean(token && token.expires > Date.now() + 60000);

  class NeedsTap extends Error {}

  // Google's sign-in script, loaded ahead of time: a popup only opens
  // straight from a tap, with nothing loading in between.
  let gis = null;
  function loadGoogle() {
    if (!gis) {
      gis = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = resolve;
        s.onerror = () => { gis = null; reject(new Error('Could not load Google sign-in (no signal?).')); };
        document.head.append(s);
      });
    }
    return gis;
  }

  function signIn() {
    if (!window.google?.accounts?.oauth2) {
      loadGoogle();
      return Promise.reject(new Error('Google sign-in is still loading. Tap again in a moment.'));
    }
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: SCOPE,
        prompt: '',
        callback: (r) => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          token = { value: r.access_token, expires: Date.now() + Number(r.expires_in || 3600) * 1000 };
          write('driveToken', token);
          resolve();
        },
        error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Sign-in was closed.' : (e.message || e.type)))
      });
      client.requestAccessToken();
    });
  }

  async function api(url, options = {}) {
    if (!signedIn()) throw new NeedsTap();
    const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token.value}`, ...(options.headers || {}) } });
    if (res.status === 401) { token = null; write('driveToken', null); throw new NeedsTap(); }
    return res;
  }
  async function json(url, options) {
    const res = await api(url, options);
    if (!res.ok) throw new Error(`Drive returned ${res.status}. ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return res.json();
  }

  // The folder named "Blank Page" that already holds the most notes is the
  // one Drive for desktop syncs; any other is a stray.
  async function findFolder() {
    const q = encodeURIComponent("name = 'Blank Page' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
    const { files } = await json(`${API}/files?q=${q}&fields=files(id,name)&pageSize=20&includeItemsFromAllDrives=true&supportsAllDrives=true`);
    if (!files.length) throw new Error('No folder called "Blank Page" in your Drive. Is Drive for desktop syncing it?');
    let best = null;
    for (const f of files) {
      const inside = encodeURIComponent(`'${f.id}' in parents and name contains '.md' and trashed = false`);
      const { files: notes } = await json(`${API}/files?q=${inside}&fields=files(id)&pageSize=1000`);
      if (!best || notes.length > best.count) best = { id: f.id, name: f.name, count: notes.length };
    }
    write('driveFolder', best);
    return best;
  }

  // --- the file format (the desktop app's storage.js) ---

  const HEADER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  function parse(raw) {
    const match = HEADER.exec(raw);
    if (!match) return { meta: {}, body: raw };
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      let value = kv[2].trim();
      if (value.startsWith('"') || value.startsWith('[')) {
        try { value = JSON.parse(value); } catch { value = value.replace(/^"|"$/g, ''); }
      }
      meta[kv[1]] = value;
    }
    return { meta, body: raw.slice(match[0].length) };
  }
  const stringify = (meta, body) => {
    const lines = Object.entries(meta)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${JSON.stringify(Array.isArray(v) ? v : String(v))}`);
    return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
  };
  const same = (a, b) => String(a || '').replace(/\r\n/g, '\n').trim() === String(b || '').replace(/\r\n/g, '\n').trim();

  // Title is the first line, the body the rest, as the desktop app stores them.
  function split(text) {
    const lines = text.trim().split('\n');
    return { title: lines[0].trim().slice(0, 120), body: lines.slice(1).join('\n').trim() };
  }
  const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';

  async function create(note, meta, body) {
    const boundary = `bp${Date.now()}`;
    const metadata = { name: `${slug(meta.title)}-${meta.id}.md`, parents: [folder().id], mimeType: 'text/markdown' };
    const payload = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${stringify(meta, body)}\r\n--${boundary}--`;
    return json(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: payload
    });
  }
  const update = (id, text) => json(`${UPLOAD}/files/${id}?uploadType=media&fields=id,modifiedTime`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/markdown; charset=UTF-8' },
    body: text
  });

  async function syncNote(note) {
    const { title: first, body } = split(note.text);
    const title = note.driveNoteId ? `${first} (from phone)` : first;
    const meta = { id: note.driveNoteId || note.id, title, created: note.created, updated: note.updated };
    let saved;
    let remote = null;
    if (note.driveId) {
      const res = await api(`${API}/files/${note.driveId}?fields=modifiedTime,trashed`);
      remote = res.ok ? await res.json() : null;
      if (remote?.trashed) remote = null;
    }
    if (!remote) {
      saved = await create(note, meta, body);
    } else if (remote.modifiedTime === note.driveModified) {
      saved = await update(note.driveId, stringify(meta, body));
    } else {
      // Changed on the laptop since the phone last wrote it.
      const raw = await (await api(`${API}/files/${note.driveId}?alt=media`)).text();
      const there = parse(raw);
      if (same(there.body, note.syncedBody)) {
        saved = await update(note.driveId, stringify({ ...there.meta, title, updated: note.updated }, body));
      } else {
        note.driveNoteId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        saved = await create(note, { ...meta, id: note.driveNoteId, title: `${first} (from phone)` }, body);
      }
    }
    note.driveId = saved.id;
    note.driveModified = saved.modifiedTime;
    note.syncedBody = body;
    note.syncedAt = note.updated;
  }

  const waiting = (notes) => notes.filter((n) => n.text.trim() && (!n.syncedAt || n.syncedAt < n.updated));

  // Returns what the sync line should say: off, done, waiting (needs a tap),
  // offline, or an error message.
  async function sync(notes, save) {
    if (!clientId() || !folder()) return { state: 'off' };
    const todo = waiting(notes);
    if (!todo.length) return { state: 'done' };
    if (!navigator.onLine) return { state: 'offline', count: todo.length };
    if (!signedIn()) return { state: 'waiting', count: todo.length };
    try {
      for (const note of todo) { await syncNote(note); save(); }
      return { state: 'done' };
    } catch (error) {
      if (error instanceof NeedsTap) return { state: 'waiting', count: waiting(notes).length };
      return { state: 'error', count: waiting(notes).length, message: error.message };
    }
  }

  return { clientId, folder, signedIn, loadGoogle, signIn, findFolder, sync, waiting };
})();
