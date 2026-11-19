'use strict';

/* Veil — private peer-to-peer messenger with multiple simultaneous permanent links. */

const $ = (id) => document.getElementById(id);
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DB_NAME = 'veil-p2p';
const DB_VERSION = 2;
const DEFAULT_NAME = 'New connection';
const CALL_TIMEOUT = 45000;

let db;
let settings = { signalUrl: '', soundEnabled: true, notificationsEnabled: true };
let localProfile;
let customEmojis = [];
let emojiByName = new Map();
let activeSessionId = null;
let lobbyOpen = false;
let callSession = null;
let toastTimer;
let audioContext = null;

/** room -> session */
const sessions = new Map();
const objectUrlCache = new WeakMap();

// ---------------------------------------------------------------------------
// IndexedDB (messages only)
// ---------------------------------------------------------------------------
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('profiles')) database.createObjectStore('profiles', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('messages')) {
        const store = database.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('sessionId', 'sessionId');
      } else {
        const store = request.transaction.objectStore('messages');
        if (!store.indexNames.contains('sessionId')) store.createIndex('sessionId', 'sessionId');
      }
      if (!database.objectStoreNames.contains('emojis')) database.createObjectStore('emojis', { keyPath: 'name' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let request;
    try { request = operation(store); }
    catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || request?.error);
    tx.onabort = () => reject(tx.error || new Error('Local operation aborted.'));
  });
}

async function packRecord(value) {
  if (!value || typeof value !== 'object') return value;
  const out = { ...value };
  for (const [key, item] of Object.entries(out)) {
    if (item instanceof Blob) out[key] = { __blob: true, type: item.type || '', data: await item.arrayBuffer() };
  }
  return out;
}
function unpackRecord(value) {
  if (!value || typeof value !== 'object') return value;
  const out = { ...value };
  for (const [key, item] of Object.entries(out)) {
    if (item && typeof item === 'object' && item.__blob && item.data) out[key] = new Blob([item.data], { type: item.type || '' });
  }
  return out;
}

const getRecord = async (store, key) => unpackRecord(await storeRequest(store, 'readonly', (s) => s.get(key)));
const putRecord = async (store, value) => {
  const packed = await packRecord(value);
  return storeRequest(store, 'readwrite', (s) => s.put(packed));
};
const removeRecord = (store, key) => storeRequest(store, 'readwrite', (s) => s.delete(key));
const getAllRecords = async (store) => (await storeRequest(store, 'readonly', (s) => s.getAll())).map(unpackRecord);

// ---------------------------------------------------------------------------
// Account files (profile + emojis live on disk, not in the browser store)
// ---------------------------------------------------------------------------
let accountQueue = Promise.resolve();
function accountSerial(task) {
  const run = accountQueue.then(task);
  accountQueue = run.catch(() => {});
  return run;
}
const imageExtension = (blob) => (blob?.type === 'image/png' ? 'png' : 'jpg');
const imageMime = (extension) => (extension === 'png' ? 'image/png' : 'image/jpeg');

async function readAccountJson(name) {
  const text = await window.veilDesktop.accountReadJson(name);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
async function writeAccountJson(name, data) {
  await window.veilDesktop.accountWriteJson(name, JSON.stringify(data));
}
async function readAccountBlob(relative, extension) {
  const data = await window.veilDesktop.accountReadFile(relative);
  return data ? new Blob([data], { type: imageMime(extension) }) : null;
}

async function accountGetProfile(key) {
  const table = (await readAccountJson('profiles')) || {};
  const meta = table[key];
  if (!meta) return undefined;
  const { avatarExt, ...rest } = meta;
  return { ...rest, id: key, avatar: avatarExt ? await readAccountBlob(`avatars/${key}.${avatarExt}`, avatarExt) : null };
}
async function accountPutProfile(value) {
  const table = (await readAccountJson('profiles')) || {};
  const key = value.id;
  const { avatar, ...rest } = value;
  const previous = table[key]?.avatarExt;
  let avatarExt = null;
  if (avatar instanceof Blob) {
    avatarExt = imageExtension(avatar);
    await window.veilDesktop.accountWriteFile(`avatars/${key}.${avatarExt}`, await avatar.arrayBuffer());
  }
  if (previous && previous !== avatarExt) await window.veilDesktop.accountDeleteFile(`avatars/${key}.${previous}`);
  table[key] = { ...rest, avatarExt };
  await writeAccountJson('profiles', table);
}
async function accountGetEmoji(name) {
  const table = (await readAccountJson('emojis')) || {};
  const meta = table[name];
  if (!meta) return undefined;
  return { name, createdAt: meta.createdAt, owner: meta.owner, blob: await readAccountBlob(`emojis/${name}.${meta.ext}`, meta.ext) };
}
async function accountPutEmoji(value) {
  const table = (await readAccountJson('emojis')) || {};
  const ext = imageExtension(value.blob);
  await window.veilDesktop.accountWriteFile(`emojis/${value.name}.${ext}`, await value.blob.arrayBuffer());
  const previous = table[value.name]?.ext;
  if (previous && previous !== ext) await window.veilDesktop.accountDeleteFile(`emojis/${value.name}.${previous}`);
  table[value.name] = { ext, createdAt: value.createdAt || Date.now(), owner: value.owner || 'local' };
  await writeAccountJson('emojis', table);
}
async function accountRemoveEmoji(name) {
  const table = (await readAccountJson('emojis')) || {};
  const meta = table[name];
  if (!meta) return;
  await window.veilDesktop.accountDeleteFile(`emojis/${name}.${meta.ext}`);
  delete table[name];
  await writeAccountJson('emojis', table);
}
async function accountAllEmojis() {
  const table = (await readAccountJson('emojis')) || {};
  const records = await Promise.all(Object.keys(table).map((name) => accountGetEmoji(name)));
  return records.filter(Boolean);
}

const getProfile = (key) => accountSerial(() => accountGetProfile(key));
const putProfile = (value) => accountSerial(() => accountPutProfile(value));
const getEmoji = (name) => accountSerial(() => accountGetEmoji(name));
const putEmoji = (value) => accountSerial(() => accountPutEmoji(value));
const removeEmoji = (name) => accountSerial(() => accountRemoveEmoji(name));
const getAllEmojis = () => accountSerial(() => accountAllEmojis());

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${randomChars(12)}`;
}
function randomChars(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
function formatInvite(room, secret) {
  return `${room}${secret}`.match(/.{1,4}/g).join('-');
}
function parseInvite(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 34 || [...raw].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return { room: raw.slice(0, 10), secret: raw.slice(10) };
}
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
function blobUrl(blob) {
  if (!blob) return '';
  const cached = objectUrlCache.get(blob);
  if (cached) return cached;
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(blob, url);
  return url;
}
function setAvatar(element, blob, fallback = 'V') {
  if (!element) return;
  element.replaceChildren();
  if (blob instanceof Blob) {
    const image = document.createElement('img');
    image.src = blobUrl(blob);
    image.alt = '';
    element.append(image);
  } else {
    element.textContent = fallback;
  }
}
function initialOf(name) {
  const clean = String(name || '').trim();
  return clean ? clean[0].toUpperCase() : 'V';
}
const profileKeyForRoom = (room) => `remote-${String(room).toLowerCase()}`;

// ---------------------------------------------------------------------------
// Sounds (synthesized, no external assets)
// ---------------------------------------------------------------------------
function audio() {
  if (!audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioContext = new Ctor();
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}
function tone(freq, startOffset, duration, type = 'sine', volume = 0.07) {
  const ctx = audio();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = freq;
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  const start = ctx.currentTime + startOffset;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}
function playMessageSound() {
  if (!settings.soundEnabled) return;
  tone(880, 0, 0.09, 'sine', 0.075);
  tone(1320, 0.1, 0.14, 'sine', 0.06);
}
function playConnectSound() {
  if (!settings.soundEnabled) return;
  tone(660, 0, 0.1, 'triangle', 0.06);
  tone(990, 0.12, 0.18, 'triangle', 0.05);
}
function playEndSound() {
  if (!settings.soundEnabled) return;
  tone(520, 0, 0.12, 'sine', 0.05);
  tone(360, 0.13, 0.18, 'sine', 0.05);
}
function startRingtone() {
  if (!settings.soundEnabled) return;
  stopRingtone();
  const ring = () => {
    tone(700, 0, 0.32, 'triangle', 0.09);
    tone(920, 0.36, 0.32, 'triangle', 0.09);
  };
  ring();
  callSession.call.ringTimer = setInterval(ring, 1900);
}
function stopRingtone() {
  if (callSession?.call?.ringTimer) {
    clearInterval(callSession.call.ringTimer);
    callSession.call.ringTimer = null;
  }
}
function startRingback() {
  if (!settings.soundEnabled) return;
  stopRingback();
  const ring = () => tone(440, 0, 0.5, 'sine', 0.04);
  ring();
  callSession.call.ringbackTimer = setInterval(ring, 3000);
}
function stopRingback() {
  if (callSession?.call?.ringbackTimer) {
    clearInterval(callSession.call.ringbackTimer);
    callSession.call.ringbackTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------
function freshCall() {
  return {
    state: 'idle',
    video: false,
    startedAt: 0,
    localStream: null,
    remoteStream: null,
    muted: false,
    cameraOff: false,
    timer: null,
    ringTimer: null,
    ringbackTimer: null,
    timeout: null
  };
}

function createSessionState(pairing) {
  return {
    id: pairing.room,
    room: pairing.room,
    secret: pairing.secret,
    name: pairing.name || DEFAULT_NAME,
    createdAt: pairing.createdAt || Date.now(),
    rtc: null,
    dataChannel: null,
    signalSocket: null,
    role: null,
    encryptionKey: null,
    proof: null,
    meetingEnabled: true,
    connected: false,
    verified: false,
    reconnectTimer: null,
    reconnectDelay: 2000,
    failedAttempts: 0,
    disconnectTimer: null,
    pendingCandidates: [],
    incomingFiles: new Map(),
    pendingImage: null,
    remoteProfile: { id: profileKeyForRoom(pairing.room), name: pairing.name || 'Peer', avatar: null },
    messages: [],
    unread: 0,
    lastMessageAt: pairing.createdAt || Date.now(),
    makingOffer: false,
    ignoreOffer: false,
    call: freshCall()
  };
}

function sessionLabel(session) {
  const name = session.name && session.name !== DEFAULT_NAME ? session.name : session.remoteProfile?.name;
  return name && name !== 'Peer' ? name : DEFAULT_NAME;
}

async function loadSessionProfile(session) {
  const saved = await getProfile(profileKeyForRoom(session.room));
  if (saved) {
    session.remoteProfile = { ...session.remoteProfile, ...saved, id: profileKeyForRoom(session.room) };
    if ((!session.name || session.name === DEFAULT_NAME) && saved.name) session.name = saved.name;
  }
}

async function loadSessionMessages(session) {
  const all = await getAllRecords('messages');
  session.messages = all.filter((m) => m.sessionId === session.room).sort((a, b) => a.createdAt - b.createdAt);
  const last = session.messages[session.messages.length - 1];
  if (last) session.lastMessageAt = Math.max(session.lastMessageAt, last.createdAt);
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------
async function deriveSessionKey(secret, room) {
  if (!crypto.subtle) throw new Error('The built-in browser encryption is unavailable. Please update the app.');
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(`Veil:${room}:v2`), iterations: 180000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function deriveInviteProof(secret, room) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`Veil:${room}:join:v1`)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function encryptPacket(session, packet) {
  if (!session.encryptionKey) throw new Error('Session key unavailable.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new TextEncoder().encode(JSON.stringify(packet));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.encryptionKey, clear));
  const result = new Uint8Array(iv.length + encrypted.length);
  result.set(iv, 0);
  result.set(encrypted, iv.length);
  return result.buffer;
}
async function decryptPacket(session, buffer) {
  if (!session.encryptionKey) return null;
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 29) return null;
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, session.encryptionKey, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(clear));
}
async function preparePairing(session) {
  session.encryptionKey = await deriveSessionKey(session.secret, session.room);
  session.proof = await deriveInviteProof(session.secret, session.room);
}

async function sendPacket(session, packet) {
  const channel = session.dataChannel;
  if (!channel || channel.readyState !== 'open') throw new Error('The connection with your peer is interrupted.');
  while (channel.bufferedAmount > 512 * 1024 && channel.readyState === 'open') {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (channel.readyState !== 'open') throw new Error('The connection was interrupted.');
  channel.send(await encryptPacket(session, packet));
}

// ---------------------------------------------------------------------------
// Signaling
// ---------------------------------------------------------------------------
function sendSignal(session, data) {
  if (session.signalSocket?.readyState === WebSocket.OPEN) {
    session.signalSocket.send(JSON.stringify({ type: 'signal', data }));
  }
}

function closeSignalSocket(session) {
  if (session.signalSocket) {
    const old = session.signalSocket;
    session.signalSocket = null;
    try { old.close(); } catch { /* ignore */ }
  }
}

function connectSignal(session) {
  return new Promise((resolve, reject) => {
    if (!settings.signalUrl) {
      const error = new Error('No rendezvous service configured. Open Settings (⚙) to add one.');
      error.fatal = true;
      reject(error);
      return;
    }
    let url;
    try { url = new URL(settings.signalUrl); }
    catch { const error = new Error('Invalid rendezvous service address.'); error.fatal = true; reject(error); return; }
    if (!['wss:', 'ws:'].includes(url.protocol)) {
      const error = new Error('Invalid address: use wss://.'); error.fatal = true; reject(error);
      return;
    }
    let settled = false;
    let keepAlive = null;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        closeSignalSocket(session);
        reject(new Error('The rendezvous service is not responding.'));
      }
    }, 12000);

    url.searchParams.set('room', session.room);
    const socket = new WebSocket(url.toString());
    session.signalSocket = socket;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'meet', room: session.room, proof: session.proof, device: localProfile.id }));
      keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
      }, 25000);
    });
    socket.addEventListener('message', async (event) => {
      if (socket !== session.signalSocket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ready') {
        session.role = message.role === 'host' ? 'host' : 'guest';
        if (!settled) { settled = true; clearTimeout(timeout); resolve(true); }
        return;
      }
      if (message.type === 'peer-joined') {
        // Both sides reset and rebuild their peer connection for this link.
        resetPeerConnection(session);
        setWaitingStatus(session, 'Peer is here — opening the direct tunnel…');
        renderSessionList();
        await startPeerConnection(session, session.role === 'host');
        return;
      }
      if (message.type === 'signal') {
        await handleSignaling(session, message.data);
        return;
      }
      if (message.type === 'peer-left') {
        handlePeerLeft(session);
        return;
      }
      if (message.type === 'error') {
        const error = new Error(message.message || 'The service refused the connection.');
        error.fatal = /incorrect|invalid|expired|already|too many/i.test(error.message);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        } else {
          toast(error.message);
          handlePeerLeft(session);
        }
      }
    });
    socket.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Cannot reach the service. Check its address and your connection.'));
      }
    });
    socket.addEventListener('close', () => {
      clearInterval(keepAlive);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('The service closed the connection.'));
        return;
      }
      if (socket === session.signalSocket) {
        session.signalSocket = null;
        if (session.meetingEnabled) {
          setConnectionState(session, false, 'Reconnecting…');
          scheduleReconnect(session);
        }
      }
    });
  });
}

async function startMeeting(session) {
  if (!session.meetingEnabled || session.signalSocket) return;
  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
  try {
    if (!session.encryptionKey) await preparePairing(session);
    await connectSignal(session);
    session.reconnectDelay = 2000;
    session.failedAttempts = 0;
    setConnectionState(session, false, session.role === 'host' ? 'Waiting for peer' : 'Connecting…');
    setWaitingStatus(session, session.role === 'host'
      ? 'Waiting for the other side… They will join as soon as they open Veil.'
      : 'Peer is already online — connecting…');
    renderActiveView();
  } catch (error) {
    closeSignalSocket(session);
    setConnectionState(session, false, 'Offline');
    if (error.fatal) {
      setWaitingStatus(session, error.message);
      showWaitingHint(session, 'If the code is wrong, manage this link in Settings and create a new one.');
      return;
    }
    setWaitingStatus(session, `${error.message} Retrying…`);
    scheduleReconnect(session);
  }
}

function scheduleReconnect(session) {
  if (!session.meetingEnabled || session.reconnectTimer) return;
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    startMeeting(session);
  }, session.reconnectDelay);
  session.reconnectDelay = Math.min(Math.round(session.reconnectDelay * 1.6), 30000);
}

function handlePeerLeft(session) {
  const wasConnected = session.connected;
  session.connected = false;
  session.verified = false;
  resetPeerConnection(session);
  if (session.call.state !== 'idle') cleanupCall(session, false);
  setConnectionState(session, false, 'Waiting for peer');
  if (wasConnected) {
    session.failedAttempts = 0;
    session.reconnectDelay = 2000;
    setWaitingStatus(session, 'Your peer disconnected. The link stays open and reconnects automatically when they return.');
  } else {
    session.failedAttempts += 1;
    setWaitingStatus(session, 'The direct connection did not complete. Retrying…');
    if (session.failedAttempts >= 3) {
      showWaitingHint(session, 'Several failures: one of your networks may block direct connections. A TURN relay can help (Settings → Network).');
    }
  }
  renderSessionList();
  renderActiveView();
  if (!session.signalSocket) scheduleReconnect(session);
}

// ---------------------------------------------------------------------------
// WebRTC (perfect negotiation, shared by chat + calls)
// ---------------------------------------------------------------------------
function iceServers() {
  const servers = [...STUN_SERVERS];
  if (settings.turnUrl) {
    servers.push({ urls: settings.turnUrl, username: settings.turnUsername || '', credential: settings.turnCredential || '' });
  }
  return servers;
}

async function startPeerConnection(session, isHost) {
  if (session.rtc) return session.rtc;
  try {
    const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
    session.rtc = pc;
    session.pendingCandidates = [];

    pc.onicecandidate = (event) => {
      if (pc === session.rtc && event.candidate) sendSignal(session, { kind: 'ice', candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc !== session.rtc) return;
      clearTimeout(session.disconnectTimer);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        handlePeerLeft(session);
      } else if (pc.connectionState === 'disconnected') {
        session.disconnectTimer = setTimeout(() => {
          if (pc === session.rtc && pc.connectionState !== 'connected') handlePeerLeft(session);
        }, 8000);
      }
    };
    pc.onnegotiationneeded = async () => {
      if (pc !== session.rtc) return;
      try {
        session.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(session, { kind: 'description', description: pc.localDescription });
      } catch (error) {
        console.warn('Negotiation failed:', error.message);
      } finally {
        session.makingOffer = false;
      }
    };
    pc.ontrack = (event) => {
      if (pc !== session.rtc) return;
      session.call.remoteStream = event.streams[0] || new MediaStream([event.track]);
      attachRemoteMedia(session);
    };

    if (isHost) {
      const channel = pc.createDataChannel('veil', { ordered: true });
      session.dataChannel = channel;
      attachDataChannel(session, channel);
    } else {
      pc.ondatachannel = (event) => {
        session.dataChannel = event.channel;
        attachDataChannel(session, event.channel);
      };
    }
    return pc;
  } catch (error) {
    toast(`Connection failed: ${error.message}`);
    handlePeerLeft(session);
    return null;
  }
}

async function handleSignaling(session, data) {
  if (!data || !data.kind) return;
  if (!session.rtc) await startPeerConnection(session, session.role === 'host');
  const pc = session.rtc;
  if (!pc) return;
  try {
    if (data.kind === 'description' && data.description) {
      const description = data.description;
      const offerCollision = description.type === 'offer' && (session.makingOffer || pc.signalingState !== 'stable');
      // Perfect negotiation: the impolite peer (host) ignores a colliding offer, while the
      // polite peer (guest) rolls its own offer back and accepts the incoming one.
      session.ignoreOffer = session.role !== 'guest' && offerCollision;
      if (session.ignoreOffer) return;
      if (offerCollision && session.role === 'guest') {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch { /* already stable */ }
      }
      await pc.setRemoteDescription(description);
      for (const candidate of session.pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(candidate); } catch { /* stale ICE */ }
      }
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal(session, { kind: 'description', description: pc.localDescription });
      }
    } else if (data.kind === 'ice' && data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else session.pendingCandidates.push(data.candidate);
    }
  } catch (error) {
    console.warn('WebRTC signal ignored:', error.message);
  }
}

function resetPeerConnection(session) {
  clearTimeout(session.disconnectTimer);
  session.connected = false;
  session.verified = false;
  const old = session.rtc;
  session.rtc = null;
  session.dataChannel = null;
  session.pendingCandidates = [];
  session.incomingFiles.clear();
  session.makingOffer = false;
  session.ignoreOffer = false;
  try { old?.close(); } catch { /* ignore */ }
}

function attachDataChannel(session, channel) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 128 * 1024;
  channel.onopen = async () => {
    if (channel !== session.dataChannel) return;
    setConnectionState(session, false, 'Verifying link…');
    setWaitingStatus(session, 'Encrypted link verification…');
    try {
      // The invitation secret never reaches the rendezvous service.
      await sendPacket(session, { type: 'hello', profile: { id: localProfile.id, name: localProfile.name } });
    } catch (error) { toast(error.message); }
    setTimeout(() => {
      if (!session.connected && channel === session.dataChannel && channel.readyState === 'open') {
        toast('The other device uses a different link code. Make sure both sides have the same code.');
        handlePeerLeft(session);
      }
    }, 15000);
  };
  channel.onmessage = async (event) => {
    try {
      const packet = await decryptPacket(session, event.data);
      if (packet) await handlePacket(session, packet);
    } catch {
      // Packets without this link's key are ignored.
    }
  };
  channel.onclose = () => { if (channel === session.dataChannel) handlePeerLeft(session); };
  channel.onerror = () => toast('An error occurred on the direct connection.');
}

// ---------------------------------------------------------------------------
// Packets
// ---------------------------------------------------------------------------
async function handlePacket(session, packet) {
  switch (packet.type) {
    case 'hello': {
      const firstVerifiedPacket = !session.connected;
      session.remoteProfile.name = String(packet.profile?.name || 'Peer').slice(0, 32);
      session.remoteProfile.id = profileKeyForRoom(session.room);
      await putProfile({ id: profileKeyForRoom(session.room), name: session.remoteProfile.name, avatar: session.remoteProfile.avatar || null });
      if (!session.name || session.name === DEFAULT_NAME || session.name === 'Connection') {
        session.name = session.remoteProfile.name;
        window.veilDesktop.renamePairing(session.room, session.name).catch(() => {});
      }
      if (firstVerifiedPacket) {
        session.connected = true;
        session.verified = true;
        session.failedAttempts = 0;
        session.reconnectDelay = 2000;
        showWaitingHint(session, '');
        setConnectionState(session, true, 'Connected');
        setWaitingStatus(session, 'Connection established.');
        if (localProfile.avatar) await sendFile(session, localProfile.avatar, 'avatar', 'remote-profile', 'avatar.png');
        await syncEmojis(session);
        await syncHistoryList(session);
        renderSessionList();
        renderActiveView();
        renderMessages();
      }
      break;
    }
    case 'message':
    case 'sync-message': {
      const existing = await getRecord('messages', packet.message.id);
      const merged = existing ? { ...packet.message, image: existing.image || null } : packet.message;
      merged.sessionId = session.room;
      await putRecord('messages', merged);
      await loadSessionMessages(session);
      if (packet.type === 'message') {
        if (activeSessionId !== session.room || !document.hasFocus()) {
          session.unread += 1;
          updateBadge();
        }
        playMessageSound();
        notifyIncoming(session, sessionLabel(session), merged.text ? merged.text.slice(0, 160) : 'Sent an image');
      }
      renderSessionList();
      if (activeSessionId === session.room) renderMessages();
      break;
    }
    case 'sync-list': {
      const localMap = new Map(session.messages.map((m) => [m.id, m]));
      const missing = [];
      for (const item of (packet.items || []).slice(-400)) {
        const ours = localMap.get(item.id);
        if (!ours || (item.hasImage && !ours.image)) missing.push(item.id);
      }
      if (missing.length) await sendPacket(session, { type: 'sync-need', ids: missing });
      break;
    }
    case 'sync-need': {
      for (const id of (packet.ids || []).slice(0, 400)) {
        const message = await getRecord('messages', id);
        if (!message) continue;
        const { image, ...metadata } = message;
        metadata.hasImage = !!image || !!message.hasImage;
        await sendPacket(session, { type: 'sync-message', message: metadata });
        if (image) await sendFile(session, image, 'message-image', id, 'image');
      }
      break;
    }
    case 'file-start':
      if (typeof packet.id !== 'string' || !Number.isInteger(packet.totalChunks) || packet.totalChunks < 1 || packet.totalChunks > 300 || !Number.isInteger(packet.size) || packet.size < 1 || packet.size > 5 * 1024 * 1024) break;
      session.incomingFiles.set(packet.id, { ...packet, chunks: new Array(packet.totalChunks), received: 0 });
      break;
    case 'file-chunk': {
      const transfer = session.incomingFiles.get(packet.id);
      if (!transfer || packet.index < 0 || packet.index >= transfer.totalChunks) break;
      transfer.chunks[packet.index] = base64ToBytes(packet.data);
      transfer.received += 1;
      break;
    }
    case 'file-end':
      await finishIncomingFile(session, packet.id);
      break;
    case 'emoji-removed':
      await removeEmoji(packet.name);
      await loadEmojis();
      break;
    case 'call-offer':
      await receiveCallOffer(session, packet);
      break;
    case 'call-accept':
      await acceptCallRemote(session);
      break;
    case 'call-decline':
      if (callSession === session) {
        toast('Call declined.');
        playEndSound();
        cleanupCall(session, false);
      }
      break;
    case 'call-busy':
      if (callSession === session) {
        toast('Your peer is already on a call.');
        playEndSound();
        cleanupCall(session, false);
      }
      break;
    case 'call-end':
      if (callSession === session) {
        toast('Call ended.');
        playEndSound();
        cleanupCall(session, false);
      }
      break;
    case 'typing':
      break;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sendFile(session, blob, purpose, referenceId, filename, extra = {}) {
  if (!(blob instanceof Blob)) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 18 * 1024;
  const totalChunks = Math.ceil(bytes.length / chunkSize);
  const transferId = uid();
  await sendPacket(session, { type: 'file-start', id: transferId, purpose, referenceId, filename, mime: blob.type || 'application/octet-stream', totalChunks, size: bytes.length, extra });
  for (let index = 0; index < totalChunks; index++) {
    const chunk = bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize));
    await sendPacket(session, { type: 'file-chunk', id: transferId, index, data: bytesToBase64(chunk) });
  }
  await sendPacket(session, { type: 'file-end', id: transferId });
}

async function finishIncomingFile(session, transferId) {
  const transfer = session.incomingFiles.get(transferId);
  if (!transfer) return;
  session.incomingFiles.delete(transferId);
  if (transfer.received !== transfer.totalChunks || transfer.chunks.some((chunk) => !chunk)) {
    toast('A received file is incomplete.');
    return;
  }
  const blob = new Blob(transfer.chunks, { type: transfer.mime });
  if (transfer.size !== blob.size) return;
  if (['avatar', 'emoji'].includes(transfer.purpose) && !['image/png', 'image/jpeg'].includes(blob.type)) return;
  if (transfer.purpose === 'message-image') {
    const message = await getRecord('messages', transfer.referenceId);
    if (message) {
      message.image = blob;
      await putRecord('messages', message);
      await loadSessionMessages(session);
      if (activeSessionId === session.room) renderMessages();
    }
  } else if (transfer.purpose === 'avatar') {
    session.remoteProfile.avatar = blob;
    await putProfile({ id: profileKeyForRoom(session.room), name: session.remoteProfile.name, avatar: blob });
    updateProfileUI();
    renderSessionList();
  } else if (transfer.purpose === 'emoji') {
    const name = String(transfer.extra?.emojiName || transfer.referenceId).toLowerCase();
    if (/^[a-z0-9_-]{1,24}$/.test(name)) {
      await putEmoji({ name, blob, createdAt: Date.now(), owner: 'peer' });
      await loadEmojis();
    }
  }
}

async function syncEmojis(session) {
  const emojis = await getAllEmojis();
  for (const emoji of emojis) {
    await sendFile(session, emoji.blob, 'emoji', emoji.name, `${emoji.name}.png`, { emojiName: emoji.name });
  }
}
async function syncHistoryList(session) {
  const messages = session.messages.slice(-400);
  await sendPacket(session, {
    type: 'sync-list',
    items: messages.map((m) => ({ id: m.id, hasImage: !!m.image || !!m.hasImage }))
  });
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------
function attachRemoteMedia(session) {
  const stream = session.call.remoteStream;
  if (!stream) return;
  const remoteAudio = $('remoteAudio');
  if (remoteAudio.srcObject !== stream) remoteAudio.srcObject = stream;
  if (session.call.video) {
    const remoteVideo = $('remoteVideo');
    remoteVideo.srcObject = stream;
    remoteVideo.muted = true;
    remoteVideo.play().catch(() => {});
  }
}

async function beginMedia(session) {
  if (!session.rtc) return false;
  try {
    const constraints = { audio: true, video: session.call.video ? { width: 1280, height: 720 } : false };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    session.call.localStream = stream;
    for (const track of stream.getTracks()) session.rtc.addTrack(track, stream);
    if (session.call.video) {
      const localVideo = $('localVideo');
      localVideo.srcObject = stream;
      localVideo.play().catch(() => {});
    }
    return true;
  } catch (error) {
    toast(`Cannot access microphone/camera: ${error.message}`);
    return false;
  }
}

async function startCall(session, video) {
  if (!session.connected) { toast('Connect this conversation before calling.'); return; }
  if (callSession) { toast('A call is already in progress.'); return; }
  callSession = session;
  session.call = freshCall();
  session.call.state = 'outgoing';
  session.call.video = !!video;
  session.call.startedAt = Date.now();
  renderCallUI();
  startRingback();
  try {
    await sendPacket(session, { type: 'call-offer', video: !!video });
  } catch (error) {
    toast(error.message);
    cleanupCall(session, false);
    return;
  }
  session.call.timeout = setTimeout(() => {
    if (session.call.state === 'outgoing') {
      toast('No answer.');
      playEndSound();
      cleanupCall(session, true);
    }
  }, CALL_TIMEOUT);
}

async function receiveCallOffer(session, packet) {
  if (callSession) {
    try { await sendPacket(session, { type: 'call-busy' }); } catch { /* ignore */ }
    return;
  }
  callSession = session;
  session.call = freshCall();
  session.call.state = 'incoming';
  session.call.video = !!packet.video;
  session.call.startedAt = Date.now();
  renderCallUI();
  startRingtone();
  playMessageSound();
  notifyIncoming(session, sessionLabel(session), session.call.video ? 'Incoming video call' : 'Incoming audio call');
  session.call.timeout = setTimeout(() => {
    if (session.call.state === 'incoming') {
      try { sendPacket(session, { type: 'call-decline' }); } catch { /* ignore */ }
      cleanupCall(session, false);
    }
  }, CALL_TIMEOUT);
}

async function acceptCall(session) {
  if (!session || session.call.state !== 'incoming') return;
  stopRingtone();
  clearTimeout(session.call.timeout);
  session.call.state = 'active';
  session.call.startedAt = Date.now();
  try { await sendPacket(session, { type: 'call-accept' }); } catch { /* ignore */ }
  const ok = await beginMedia(session);
  if (!ok) { cleanupCall(session, true); return; }
  playConnectSound();
  startCallTimer(session);
  renderCallUI();
}

async function acceptCallRemote(session) {
  if (callSession !== session || session.call.state !== 'outgoing') return;
  stopRingback();
  clearTimeout(session.call.timeout);
  session.call.state = 'active';
  session.call.startedAt = Date.now();
  const ok = await beginMedia(session);
  if (!ok) { cleanupCall(session, true); return; }
  playConnectSound();
  startCallTimer(session);
  renderCallUI();
}

function startCallTimer(session) {
  clearInterval(session.call.timer);
  session.call.timer = setInterval(() => {
    if (session.call.state !== 'active') return;
    const seconds = Math.floor((Date.now() - session.call.startedAt) / 1000);
    $('callTimer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }, 500);
}

function cleanupCall(session, notifyPeer) {
  if (notifyPeer && session.connected) {
    sendPacket(session, { type: 'call-end' }).catch(() => {});
  }
  stopRingtone();
  stopRingback();
  clearTimeout(session.call.timeout);
  clearInterval(session.call.timer);
  if (session.call.localStream) {
    for (const track of session.call.localStream.getTracks()) track.stop();
  }
  if (session.rtc) {
    for (const sender of session.rtc.getSenders()) {
      if (sender.track) { try { session.rtc.removeTrack(sender); } catch { /* ignore */ } }
    }
  }
  session.call = freshCall();
  $('remoteAudio').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('localVideo').srcObject = null;
  $('callOverlay').hidden = true;
  $('callOverlay').querySelector('.call-card').classList.remove('video-mode');
  callSession = null;
  renderSessionList();
}

function toggleMute() {
  if (!callSession?.call.localStream) return;
  callSession.call.muted = !callSession.call.muted;
  for (const track of callSession.call.localStream.getAudioTracks()) track.enabled = !callSession.call.muted;
  renderCallUI();
}
function toggleCamera() {
  if (!callSession?.call.localStream) return;
  callSession.call.cameraOff = !callSession.call.cameraOff;
  for (const track of callSession.call.localStream.getVideoTracks()) track.enabled = !callSession.call.cameraOff;
  renderCallUI();
}

function renderCallUI() {
  const overlay = $('callOverlay');
  if (!callSession || callSession.call.state === 'idle') { overlay.hidden = true; return; }
  overlay.hidden = false;
  const call = callSession.call;
  const card = overlay.querySelector('.call-card');
  const isVideoActive = call.video && call.state === 'active';
  card.classList.toggle('video-mode', isVideoActive);

  $('callTitle').textContent = call.video ? 'Video call' : 'Audio call';
  $('callSubtitle').textContent = call.state === 'incoming'
    ? (call.video ? 'Incoming video call…' : 'Incoming audio call…')
    : call.state === 'outgoing' ? 'Calling…' : 'Connected';
  if (call.state === 'active') {
    const seconds = Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000));
    $('callTimer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  } else {
    $('callTimer').textContent = '';
  }
  setAvatar($('callAvatar'), callSession.remoteProfile.avatar, initialOf(sessionLabel(callSession)));

  $('callAccept').hidden = call.state !== 'incoming';
  $('callDecline').hidden = call.state !== 'incoming';
  $('callHangup').hidden = call.state === 'incoming';
  $('callMute').hidden = call.state !== 'active';
  $('callCamera').hidden = call.state !== 'active' || !call.video;
  $('callMute').classList.toggle('active-state', call.muted);
  $('callCamera').classList.toggle('active-state', call.cameraOff);
  $('callMute').querySelector('span').textContent = call.muted ? 'Unmute' : 'Mute';
  $('callCamera').querySelector('span').textContent = call.cameraOff ? 'Camera off' : 'Camera';

  $('remoteVideo').hidden = !isVideoActive;
  $('localVideo').hidden = !(isVideoActive && call.localStream);
  if (call.state === 'active') attachRemoteMedia(callSession);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function notifyIncoming(session, title, body) {
  if (!settings.notificationsEnabled) return;
  window.veilDesktop.notify({ title, body, sessionId: session.room }).catch(() => {});
  window.veilDesktop.attention().catch(() => {});
}
function updateBadge() {
  let total = 0;
  for (const session of sessions.values()) total += session.unread;
  window.veilDesktop.setBadge(total).catch(() => {});
}

// ---------------------------------------------------------------------------
// UI: session list, views, profile
// ---------------------------------------------------------------------------
function setConnectionState(session, connected, label) {
  session.connected = Boolean(connected);
  if (session.room === activeSessionId) {
    $('connectionDot').parentElement.classList.toggle('connected', connected);
    $('connectionLabel').textContent = label;
    $('topStatus').textContent = connected ? 'P2P · AES-256' : 'Waiting';
  }
  $('audioCallButton').disabled = !(activeSession()?.connected);
  $('videoCallButton').disabled = !(activeSession()?.connected);
}

function setWaitingStatus(session, message) {
  if (session.room === activeSessionId) $('waitingStatus').textContent = message;
}
function showWaitingHint(session, message) {
  if (session.room !== activeSessionId) return;
  $('waitingHint').textContent = message || '';
  $('waitingHint').hidden = !message;
}

function activeSession() {
  return activeSessionId ? sessions.get(activeSessionId) : null;
}

function renderSessionList() {
  const list = $('sessionList');
  list.replaceChildren();
  const ordered = [...sessions.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  for (const session of ordered) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `session-item${session.room === activeSessionId ? ' active' : ''}`;
    button.addEventListener('click', () => selectSession(session.room));

    const avatar = document.createElement('div');
    avatar.className = 'session-avatar';
    setAvatar(avatar, session.remoteProfile.avatar, initialOf(sessionLabel(session)));

    const copy = document.createElement('div');
    copy.className = 'session-copy';
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = sessionLabel(session);
    const sub = document.createElement('span');
    sub.className = `session-sub${session.connected ? ' online' : ''}`;
    sub.textContent = session.connected ? 'Online · encrypted' : 'Waiting for peer';
    copy.append(name, sub);

    button.append(avatar, copy);
    if (session.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'session-badge';
      badge.textContent = session.unread > 99 ? '99+' : String(session.unread);
      button.append(badge);
    } else {
      const dot = document.createElement('span');
      dot.className = `session-dot${session.connected ? ' online' : ''}`;
      button.append(dot);
    }
    list.append(button);
  }
}

function selectSession(room) {
  if (!sessions.has(room)) return;
  lobbyOpen = false;
  activeSessionId = room;
  const session = sessions.get(room);
  session.unread = 0;
  updateBadge();
  renderSessionList();
  renderActiveView();
  renderMessages();
}

function renderActiveView() {
  const session = activeSession();
  const hasSessions = sessions.size > 0;
  const showLobby = lobbyOpen || !hasSessions;
  $('lobbyView').hidden = !showLobby;
  $('waitingView').hidden = showLobby || !session || session.connected;
  $('chatView').hidden = showLobby || !session || !session.connected;

  if (showLobby) {
    $('topEyebrow').textContent = hasSessions ? 'NEW LINK' : 'SECURE CHANNEL';
    $('topTitle').textContent = hasSessions ? 'New connection' : 'Veil';
    $('topStatus').textContent = hasSessions ? 'Ready' : 'P2P · AES-256';
    $('connectionDot').parentElement.classList.remove('connected');
    $('connectionLabel').textContent = hasSessions ? 'Choose a conversation' : 'No connections';
    $('audioCallButton').disabled = true;
    $('videoCallButton').disabled = true;
    return;
  }

  if (!session) {
    const first = [...sessions.values()][0];
    if (first) { selectSession(first.room); return; }
    return;
  }

  $('topEyebrow').textContent = session.connected ? 'ENCRYPTED TUNNEL' : 'PERMANENT LINK';
  $('topTitle').textContent = sessionLabel(session);
  $('topStatus').textContent = session.connected ? 'P2P · AES-256' : 'Waiting';
  $('connectionDot').parentElement.classList.toggle('connected', session.connected);
  $('connectionLabel').textContent = session.connected ? 'Connected' : 'Waiting for peer';
  $('audioCallButton').disabled = !session.connected;
  $('videoCallButton').disabled = !session.connected;

  $('inviteCodeDisplay').textContent = formatInvite(session.room, session.secret);
  setAvatar($('waitingAvatar'), session.remoteProfile.avatar, initialOf(sessionLabel(session)));
  $('waitingTitle').textContent = session.connected ? 'Connected' : `Waiting for ${sessionLabel(session)}…`;
  $('waitingSubtitle').textContent = session.connected
    ? 'Your encrypted tunnel is open.'
    : 'This link is permanent. Share it once through a private channel, then leave Veil running. It reconnects on its own, forever.';

  setAvatar($('chatPartnerAvatar'), session.remoteProfile.avatar, initialOf(sessionLabel(session)));
  $('chatPartnerName').textContent = sessionLabel(session);
  $('chatPartnerStatus').textContent = session.connected ? 'Connected directly' : 'Waiting';

  // Composer attachment state follows the active conversation.
  $('attachmentPreview').hidden = !session.pendingImage;
}

function updateProfileUI() {
  $('localName').textContent = localProfile.name || 'You';
  $('displayName').value = localProfile.name || '';
  setAvatar($('localAvatar'), localProfile.avatar, initialOf(localProfile.name));
  setAvatar($('settingsAvatar'), localProfile.avatar, initialOf(localProfile.name));
  renderSessionList();
  if (activeSession()) renderActiveView();
}

function renderMessages() {
  const session = activeSession();
  if (!session) return;
  const container = $('messages');
  container.replaceChildren();
  if (!session.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-chat';
    const glyph = document.createElement('div');
    glyph.textContent = '◇';
    const heading = document.createElement('h3');
    heading.textContent = 'The channel is open.';
    const note = document.createElement('p');
    note.textContent = 'Your conversation starts here.';
    empty.append(glyph, heading, note);
    container.append(empty);
    return;
  }
  for (const message of session.messages.slice(-1000)) {
    const mine = message.senderId === localProfile.id;
    const row = document.createElement('div');
    row.className = `message-row${mine ? ' mine' : ''}`;
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    const avatarBlob = mine ? localProfile.avatar : session.remoteProfile.avatar;
    setAvatar(avatar, avatarBlob, initialOf(mine ? localProfile.name : sessionLabel(session)));
    const wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = `${mine ? 'You' : (message.senderName || sessionLabel(session))} · ${new Date(message.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    appendEmojiText(bubble, message.text || '');
    if (message.image instanceof Blob) {
      const img = document.createElement('img');
      img.className = 'attached-image';
      img.src = blobUrl(message.image);
      img.alt = 'Shared image';
      img.addEventListener('click', () => openImagePreview(img.src));
      bubble.append(img);
    }
    wrap.append(meta, bubble);
    row.append(avatar, wrap);
    container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}

function appendEmojiText(container, value) {
  const regex = /:([a-z0-9_-]{1,24}):/gi;
  let last = 0;
  let match;
  while ((match = regex.exec(value)) !== null) {
    if (match.index > last) appendTextWithBreaks(container, value.slice(last, match.index));
    const emoji = emojiByName.get(match[1].toLowerCase());
    if (emoji) {
      const img = document.createElement('img');
      img.className = 'inline-emoji';
      img.src = blobUrl(emoji.blob);
      img.alt = `:${emoji.name}:`;
      img.title = `:${emoji.name}:`;
      container.append(img);
    } else appendTextWithBreaks(container, match[0]);
    last = regex.lastIndex;
  }
  if (last < value.length) appendTextWithBreaks(container, value.slice(last));
}
function appendTextWithBreaks(container, text) {
  text.split('\n').forEach((line, index) => {
    if (index) container.append(document.createElement('br'));
    container.append(document.createTextNode(line));
  });
}
function openImagePreview(src) {
  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  const img = document.createElement('img');
  img.src = src;
  img.alt = 'Image preview';
  overlay.append(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.append(overlay);
}

// ---------------------------------------------------------------------------
// Pairings
// ---------------------------------------------------------------------------
async function createLink() {
  try {
    $('createLink').disabled = true;
    const pairing = { room: randomChars(10), secret: randomChars(24), name: DEFAULT_NAME, createdAt: Date.now() };
    await window.veilDesktop.addPairing(pairing);
    const session = createSessionState(pairing);
    sessions.set(session.room, session);
    selectSession(session.room);
    startMeeting(session);
  } catch (error) {
    $('lobbyStatus').textContent = error.message;
    $('lobbyStatus').classList.add('error');
  } finally {
    $('createLink').disabled = false;
  }
}

async function joinLink() {
  const code = parseInvite($('inviteCode').value);
  if (!code) {
    $('lobbyStatus').textContent = 'This code is invalid. It must contain 34 characters (without dashes).';
    $('lobbyStatus').classList.add('error');
    return;
  }
  try {
    $('joinLink').disabled = true;
    const pairing = { room: code.room, secret: code.secret, name: DEFAULT_NAME, createdAt: Date.now() };
    await window.veilDesktop.addPairing(pairing);
    $('inviteCode').value = '';
    let session = sessions.get(code.room);
    if (!session) {
      session = createSessionState(pairing);
      sessions.set(session.room, session);
      await loadSessionProfile(session);
    }
    selectSession(session.room);
    startMeeting(session);
  } catch (error) {
    $('lobbyStatus').textContent = error.message;
    $('lobbyStatus').classList.add('error');
  } finally {
    $('joinLink').disabled = false;
  }
}

async function removeSession(room) {
  const session = sessions.get(room);
  if (!session) return;
  if (!window.confirm(`Delete “${sessionLabel(session)}”?\n\nThe permanent link and this conversation's local history will be removed from this computer.`)) return;
  session.meetingEnabled = false;
  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
  if (callSession === session) cleanupCall(session, true);
  resetPeerConnection(session);
  closeSignalSocket(session);
  try { await window.veilDesktop.removePairing(room); } catch { /* ignore */ }
  const messages = await getAllRecords('messages');
  for (const message of messages) if (message.sessionId === room) await removeRecord('messages', message.id);
  sessions.delete(room);
  if (activeSessionId === room) {
    activeSessionId = null;
    const first = [...sessions.values()][0];
    if (first) selectSession(first.room);
    else renderActiveView();
  }
  renderSessionList();
  renderConnectionsSettings();
  updateBadge();
}

async function renameSession(room) {
  const session = sessions.get(room);
  if (!session) return;
  const value = window.prompt('Name this connection:', sessionLabel(session));
  if (value === null) return;
  const name = value.trim().slice(0, 40) || DEFAULT_NAME;
  session.name = name;
  try { await window.veilDesktop.renamePairing(room, name); } catch { /* ignore */ }
  renderSessionList();
  renderActiveView();
  renderConnectionsSettings();
}

async function copyCode(room) {
  const session = sessions.get(room);
  if (!session) return;
  const text = formatInvite(session.room, session.secret);
  try {
    await navigator.clipboard.writeText(text);
    toast('Link code copied.');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    document.body.append(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
    toast('Link code copied.');
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
async function sendTextMessage() {
  const session = activeSession();
  if (!session) return;
  const text = $('messageInput').value.trim();
  if (!text && !session.pendingImage) return;
  if (!session.connected) { toast('Connect this conversation before sending a message.'); return; }
  const message = {
    id: uid(),
    sessionId: session.room,
    senderId: localProfile.id,
    senderName: localProfile.name,
    text,
    createdAt: Date.now(),
    image: session.pendingImage || null
  };
  await putRecord('messages', message);
  session.messages.push(message);
  session.lastMessageAt = message.createdAt;
  $('messageInput').value = '';
  $('messageInput').style.height = 'auto';
  const imageToSend = session.pendingImage;
  session.pendingImage = null;
  $('attachmentPreview').hidden = true;
  renderMessages();
  renderSessionList();
  try {
    const { image, ...metadata } = message;
    await sendPacket(session, { type: 'message', message: { ...metadata, hasImage: !!image } });
    if (imageToSend) await sendFile(session, imageToSend, 'message-image', message.id, 'image');
  } catch (error) {
    toast(error.message);
  }
}

async function compressImage(file, maxEdge = 1600, maxBytes = 5 * 1024 * 1024) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > maxBytes) throw new Error('This image exceeds the 5 MB limit.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
  if (!blob) throw new Error('Cannot prepare this image.');
  return blob;
}

// ---------------------------------------------------------------------------
// Emojis
// ---------------------------------------------------------------------------
async function loadEmojis() {
  customEmojis = await getAllEmojis();
  emojiByName = new Map(customEmojis.map((item) => [item.name, item]));
  renderEmojiPicker();
  renderCustomEmojiSettings();
}
function renderEmojiPicker() {
  const grid = $('emojiGrid');
  grid.replaceChildren();
  const defaults = ['😀', '😂', '😊', '😎', '🤝', '👋', '👍', '🔥', '⚡', '✨', '💠', '🛰️', '🌐', '🔒', '🌙', '⭐', '💬', '📡'];
  for (const symbol of defaults) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = symbol;
    button.addEventListener('click', () => insertText(symbol));
    grid.append(button);
  }
  for (const emoji of customEmojis) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = `:${emoji.name}:`;
    const img = document.createElement('img');
    img.src = blobUrl(emoji.blob);
    img.alt = emoji.name;
    button.append(img);
    button.addEventListener('click', () => insertText(`:${emoji.name}:`));
    grid.append(button);
  }
}
function renderCustomEmojiSettings() {
  const list = $('customEmojiList');
  list.replaceChildren();
  for (const emoji of customEmojis) {
    const item = document.createElement('div');
    item.className = 'custom-emoji-item';
    const img = document.createElement('img');
    img.src = blobUrl(emoji.blob);
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = `:${emoji.name}:`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Delete this emoji';
    remove.addEventListener('click', async () => {
      await removeEmoji(emoji.name);
      await loadEmojis();
      for (const session of sessions.values()) {
        if (session.connected) sendPacket(session, { type: 'emoji-removed', name: emoji.name }).catch(() => {});
      }
    });
    item.append(img, name, remove);
    list.append(item);
  }
}
function insertText(value) {
  const input = $('messageInput');
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.setRangeText(value, start, end, 'end');
  input.focus();
  $('emojiPicker').hidden = true;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function showSettings() {
  $('signalUrl').value = settings.signalUrl || '';
  $('turnUrl').value = settings.turnUrl || '';
  $('turnUsername').value = settings.turnUsername || '';
  $('turnCredential').value = settings.turnCredential || '';
  $('soundEnabled').checked = settings.soundEnabled !== false;
  $('notificationsEnabled').checked = settings.notificationsEnabled !== false;
  renderConnectionsSettings();
  $('settingsModal').hidden = false;
}
function closeSettings() { $('settingsModal').hidden = true; }

function renderConnectionsSettings() {
  const list = $('connectionsList');
  list.replaceChildren();
  if (!sessions.size) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No permanent links yet. Create one from the home screen.';
    list.append(empty);
    return;
  }
  for (const session of sessions.values()) {
    const row = document.createElement('div');
    row.className = 'connection-row';
    const copy = document.createElement('div');
    copy.className = 'conn-copy';
    const name = document.createElement('strong');
    name.textContent = sessionLabel(session);
    const code = document.createElement('code');
    code.textContent = formatInvite(session.room, session.secret);
    copy.append(name, code);

    const copyButton = document.createElement('button');
    copyButton.className = 'secondary-btn';
    copyButton.textContent = 'Copy';
    copyButton.addEventListener('click', () => copyCode(session.room));

    const renameButton = document.createElement('button');
    renameButton.className = 'secondary-btn';
    renameButton.textContent = 'Rename';
    renameButton.addEventListener('click', () => renameSession(session.room));

    const deleteButton = document.createElement('button');
    deleteButton.className = 'secondary-btn danger';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => removeSession(session.room));

    row.append(copy, copyButton, renameButton, deleteButton);
    list.append(row);
  }
}

async function saveSignalSettings() {
  try {
    settings = await window.veilDesktop.saveSettings({
      signalUrl: $('signalUrl').value.trim(),
      turnUrl: $('turnUrl').value.trim(),
      turnUsername: $('turnUsername').value.trim(),
      turnCredential: $('turnCredential').value,
      soundEnabled: $('soundEnabled').checked,
      notificationsEnabled: $('notificationsEnabled').checked
    });
    $('signalFeedback').textContent = 'Settings saved.';
    $('signalFeedback').classList.remove('error');
    $('signalFeedback').classList.add('good');
    for (const session of sessions.values()) {
      if (!session.signalSocket && !session.connected) { session.reconnectDelay = 2000; startMeeting(session); }
    }
  } catch (error) {
    $('signalFeedback').textContent = error.message;
    $('signalFeedback').classList.remove('good');
    $('signalFeedback').classList.add('error');
  }
}

async function savePreferences() {
  try {
    settings = await window.veilDesktop.saveSettings({
      signalUrl: settings.signalUrl || $('signalUrl').value.trim(),
      turnUrl: $('turnUrl').value.trim(),
      turnUsername: $('turnUsername').value.trim(),
      turnCredential: $('turnCredential').value,
      soundEnabled: $('soundEnabled').checked,
      notificationsEnabled: $('notificationsEnabled').checked
    });
  } catch (error) {
    toast(error.message);
  }
}

async function saveLocalProfile() {
  localProfile.name = $('displayName').value.trim().slice(0, 32) || 'You';
  try {
    await putProfile(localProfile);
  } catch (error) {
    $('profileFeedback').textContent = `Cannot save the profile: ${error.message || error}`;
    return;
  }
  updateProfileUI();
  $('profileFeedback').textContent = 'Profile saved on this computer.';
  for (const session of sessions.values()) {
    if (!session.connected) continue;
    try {
      await sendPacket(session, { type: 'hello', profile: { id: localProfile.id, name: localProfile.name } });
      if (localProfile.avatar) await sendFile(session, localProfile.avatar, 'avatar', 'remote-profile', 'avatar.png');
    } catch { /* ignore */ }
  }
}

async function saveAvatar(file) {
  try {
    const previousAvatar = localProfile.avatar;
    localProfile.avatar = await compressImage(file, 512, 5 * 1024 * 1024);
    try { await putProfile(localProfile); }
    catch (error) { localProfile.avatar = previousAvatar; throw error; }
    updateProfileUI();
    $('profileFeedback').textContent = 'Picture saved.';
    for (const session of sessions.values()) {
      if (session.connected) sendFile(session, localProfile.avatar, 'avatar', 'remote-profile', 'avatar.png').catch(() => {});
    }
  } catch (error) { $('profileFeedback').textContent = error.message; }
}

async function addCustomEmoji() {
  const name = $('emojiName').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 24);
  const file = $('emojiInput').files?.[0];
  if (!/^[a-z0-9_-]{1,24}$/.test(name)) { $('emojiFeedback').textContent = 'Choose a name made of letters, digits or dashes.'; return; }
  if (!file) { $('emojiFeedback').textContent = 'Choose an image first.'; return; }
  try {
    const blob = await compressImage(file, 160, 2 * 1024 * 1024);
    await putEmoji({ name, blob, createdAt: Date.now(), owner: 'local' });
    await loadEmojis();
    $('emojiName').value = '';
    $('emojiInput').value = '';
    $('emojiFeedback').textContent = 'Emoji added.';
    for (const session of sessions.values()) {
      if (session.connected) sendFile(session, blob, 'emoji', name, `${name}.png`, { emojiName: name }).catch(() => {});
    }
  } catch (error) { $('emojiFeedback').textContent = error.message; }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function bindEvents() {
  $('settingsButton').addEventListener('click', showSettings);
  $('topSettings').addEventListener('click', showSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (event) => { if (event.target === $('settingsModal')) closeSettings(); });

  $('addConnection').addEventListener('click', () => {
    lobbyOpen = true;
    activeSessionId = null;
    renderSessionList();
    renderActiveView();
  });
  $('createLink').addEventListener('click', createLink);
  $('joinLink').addEventListener('click', joinLink);
  $('inviteCode').addEventListener('keydown', (event) => { if (event.key === 'Enter') joinLink(); });
  $('copyInvite').addEventListener('click', () => { if (activeSession()) copyCode(activeSession().room); });
  $('cancelWaiting').addEventListener('click', showSettings);

  $('audioCallButton').addEventListener('click', () => { if (activeSession()) startCall(activeSession(), false); });
  $('videoCallButton').addEventListener('click', () => { if (activeSession()) startCall(activeSession(), true); });
  $('callAccept').addEventListener('click', () => { if (callSession) acceptCall(callSession); });
  $('callDecline').addEventListener('click', () => {
    if (!callSession) return;
    if (callSession.call.state === 'incoming') {
      sendPacket(callSession, { type: 'call-decline' }).catch(() => {});
      cleanupCall(callSession, false);
    } else {
      cleanupCall(callSession, true);
    }
  });
  $('callHangup').addEventListener('click', () => { if (callSession) cleanupCall(callSession, true); });
  $('callMute').addEventListener('click', toggleMute);
  $('callCamera').addEventListener('click', toggleCamera);

  $('saveSignal').addEventListener('click', saveSignalSettings);
  $('soundEnabled').addEventListener('change', savePreferences);
  $('notificationsEnabled').addEventListener('change', savePreferences);
  $('testSound').addEventListener('click', () => { playMessageSound(); setTimeout(playConnectSound, 400); });
  $('saveProfile').addEventListener('click', saveLocalProfile);
  $('avatarInput').addEventListener('change', (event) => { if (event.target.files?.[0]) saveAvatar(event.target.files[0]); });
  $('addEmoji').addEventListener('click', addCustomEmoji);

  $('attachButton').addEventListener('click', () => $('imageInput').click());
  $('imageInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const session = activeSession();
    if (!session) return;
    try {
      session.pendingImage = await compressImage(file, 1600, 5 * 1024 * 1024);
      $('attachmentName').textContent = file.name;
      $('attachmentPreview').hidden = false;
    } catch (error) { toast(error.message); }
    event.target.value = '';
  });
  $('removeAttachment').addEventListener('click', () => {
    const session = activeSession();
    if (session) session.pendingImage = null;
    $('attachmentPreview').hidden = true;
  });
  $('sendButton').addEventListener('click', sendTextMessage);
  $('messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendTextMessage(); }
  });
  $('messageInput').addEventListener('input', () => {
    const input = $('messageInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  });
  $('emojiButton').addEventListener('click', () => { $('emojiPicker').hidden = !$('emojiPicker').hidden; });
  $('closeEmoji').addEventListener('click', () => { $('emojiPicker').hidden = true; });
  $('addEmojiFromPicker').addEventListener('click', () => { $('emojiPicker').hidden = true; showSettings(); });
  $('openAccountFolder').addEventListener('click', () => window.veilDesktop.accountOpenFolder().catch((error) => toast(error.message)));
  window.veilDesktop.accountFolder().then((folder) => { $('accountFolderPath').textContent = folder; }).catch(() => {});
  window.veilDesktop.onOpenSettings(showSettings);
  window.veilDesktop.onOpenSession((room) => { if (sessions.has(room)) selectSession(room); });

  // Resume the audio context on the first interaction (Electron autoplay policy).
  document.addEventListener('click', () => audio(), { once: true });
  window.addEventListener('beforeunload', () => {
    for (const session of sessions.values()) {
      try { session.rtc?.close(); session.signalSocket?.close(); } catch { /* ignore */ }
    }
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function migrateLegacyMessages(pairings) {
  if (!pairings.length) return;
  const firstRoom = pairings[0].room;
  const all = await getAllRecords('messages');
  for (const message of all) {
    if (!message.sessionId) {
      message.sessionId = firstRoom;
      await putRecord('messages', message);
    }
  }
}

async function initialise() {
  try { await navigator.storage?.persist?.(); } catch { /* optional */ }
  db = await openDatabase();
  settings = await window.veilDesktop.getSettings();
  localProfile = await getProfile('local');
  if (!localProfile) {
    localProfile = { id: 'local', name: 'You', avatar: null, createdAt: Date.now() };
    await putProfile(localProfile);
  }

  const pairings = await window.veilDesktop.listPairings();
  await migrateLegacyMessages(pairings);
  for (const pairing of pairings) {
    const session = createSessionState(pairing);
    await loadSessionProfile(session);
    await loadSessionMessages(session);
    sessions.set(session.room, session);
  }

  await loadEmojis();
  updateProfileUI();
  bindEvents();

  if (sessions.size) {
    const first = [...sessions.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
    selectSession(first.room);
    for (const session of sessions.values()) startMeeting(session);
  } else {
    renderActiveView();
    $('lobbyStatus').textContent = settings.signalUrl
      ? 'Ready. Create a permanent link, or enter one you received.'
      : 'Welcome. Open Settings to configure the rendezvous service.';
  }
}

initialise().catch((error) => {
  console.error(error);
  const main = document.createElement('main');
  main.className = 'startup-error';
  const title = document.createElement('h1');
  title.textContent = 'Veil could not start';
  const detail = document.createElement('p');
  detail.textContent = String(error.message || error);
  const advice = document.createElement('p');
  advice.textContent = 'Restart the application. If the problem persists, contact the person who provided the program.';
  main.append(title, detail, advice);
  document.body.replaceChildren(main);
});
