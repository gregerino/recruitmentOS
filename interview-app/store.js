// ══════════════════════════════════════════════════════════════
//  Store — localStorage-backed session persistence
//
//  A "session" is one candidate interview: the job description,
//  the competency selection, scores, notes, transcript and
//  attached evidence. Because Analyzer.analyze() is deterministic,
//  we only persist the *inputs* (jdText, selection) plus the
//  human-entered data — the full analysis is rebuilt on restore.
// ══════════════════════════════════════════════════════════════
const Store = (() => {
  const KEY = 'ros.sessions.v1';
  const CUR = 'ros.current.v1';
  const MAX_SESSIONS = 25;
  const MAX_UTTERANCES = 1500;
  const MAX_NOTES = 200000;

  let cache = null;
  let saveTimer = null;

  function available() {
    try {
      const k = '__ros_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  const ENABLED = available();

  function read() {
    if (cache) return cache;
    if (!ENABLED) return (cache = []);
    try {
      const raw = localStorage.getItem(KEY);
      cache = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(cache)) cache = [];
    } catch (e) {
      console.warn('Store: could not parse saved sessions, starting fresh', e);
      cache = [];
    }
    return cache;
  }

  // Persist, shedding data if we hit the storage quota.
  function write() {
    if (!ENABLED) return;
    const list = read();
    const curId = currentId();

    const attempts = [
      () => list,
      // 1st fallback: drop transcripts from every session but the current one
      () => list.map(s => s.id === curId ? s : { ...s, utterances: [], notes: '' }),
      // 2nd fallback: keep only the 5 most recent sessions
      () => sortByUpdated(list).slice(0, 5),
      // Last resort: keep only the current session
      () => list.filter(s => s.id === curId),
    ];

    for (const build of attempts) {
      try {
        const payload = build();
        localStorage.setItem(KEY, JSON.stringify(payload));
        cache = payload;
        return;
      } catch (e) {
        if (e && (e.name === 'QuotaExceededError' || e.code === 22)) continue;
        console.warn('Store: save failed', e);
        return;
      }
    }
    console.warn('Store: storage full, session could not be saved');
  }

  function scheduleWrite() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(write, 400);
  }

  function flush() {
    clearTimeout(saveTimer);
    write();
  }

  function sortByUpdated(list) {
    return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function currentId() {
    if (!ENABLED) return null;
    try { return localStorage.getItem(CUR); } catch (e) { return null; }
  }

  function setCurrent(id) {
    if (!ENABLED) return;
    try {
      if (id) localStorage.setItem(CUR, id);
      else localStorage.removeItem(CUR);
    } catch (e) { /* ignore */ }
  }

  function blank() {
    return {
      id: 'ses_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      candidate: '',
      role: '',
      lang: 'en',
      jdText: '',
      preSelectedB5: [],
      selectedCompIds: null,   // null = analyzer defaults
      scorecard: [],           // [{ id, name, category, weight }] snapshot for comparison
      scores: {},              // { compId: 1..5 }
      notes: '',
      template: {},            // { sectionIndex: text }
      utterances: [],          // [{ speaker, text }]
      candidateSpeaker: null,
      evidence: {},            // { compId: [{ text, speaker, pinnedAt }] }
      recommendation: null,    // { level, levelKey, avg, scored, total }
    };
  }

  function create(fields) {
    const session = Object.assign(blank(), fields || {});
    const list = read();
    list.push(session);
    // Trim history, but never the session we just made
    if (list.length > MAX_SESSIONS) {
      const keep = sortByUpdated(list).slice(0, MAX_SESSIONS);
      if (!keep.some(s => s.id === session.id)) keep.push(session);
      cache = keep;
    }
    setCurrent(session.id);
    write();
    return session;
  }

  function get(id) {
    return read().find(s => s.id === id) || null;
  }

  function current() {
    const id = currentId();
    return id ? get(id) : null;
  }

  function trim(fields) {
    const out = { ...fields };
    if (Array.isArray(out.utterances) && out.utterances.length > MAX_UTTERANCES) {
      out.utterances = out.utterances.slice(-MAX_UTTERANCES);
    }
    if (typeof out.notes === 'string' && out.notes.length > MAX_NOTES) {
      out.notes = out.notes.slice(0, MAX_NOTES);
    }
    return out;
  }

  // Merge fields into the current session and schedule a write.
  function patch(fields) {
    const session = current();
    if (!session) return null;
    Object.assign(session, trim(fields), { updatedAt: Date.now() });
    scheduleWrite();
    return session;
  }

  function remove(id) {
    cache = read().filter(s => s.id !== id);
    if (currentId() === id) setCurrent(null);
    write();
  }

  function clearAll() {
    cache = [];
    setCurrent(null);
    write();
  }

  // Sessions that carry enough data to be worth showing, newest first.
  function list() {
    return sortByUpdated(read()).filter(s => s.jdText);
  }

  // A session is worth offering to restore only if the user put work into it.
  function isResumable(s) {
    if (!s || !s.jdText) return false;
    return Object.keys(s.scores || {}).length > 0
      || (s.notes || '').trim().length > 0
      || (s.utterances || []).length > 0
      || Object.values(s.template || {}).some(v => (v || '').trim())
      || !!(s.candidate || '').trim();
  }

  // Write pending changes before the tab goes away.
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  return {
    enabled: ENABLED,
    create, get, current, patch, remove, list, clearAll,
    setCurrent, currentId, isResumable, flush,
  };
})();
