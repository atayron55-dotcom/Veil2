// Veil: WebRTC rendezvous (signaling) service for Cloudflare Workers.
// Version 3.0: permanent links. A pairing code stays valid for as long as you keep using it;
// nothing is deleted because of age or inactivity. One Durable Object ("Room") per code.
// No conversation messages pass through here: only SDP descriptions and ICE candidates.
// The service stores nothing but the HMAC fingerprint of the secret.

const ROOM_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
const PROOF_PATTERN = /^[a-f0-9]{64}$/;
const DEVICE_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const BASE_ORIGINS = ['file://', 'null']; // the desktop app loads its page from file://
const FAIL_WINDOW_MS = 60 * 60 * 1000;
const MAX_FAILS_PER_WINDOW = 15;
const MAX_SOCKETS = 6;
const UNAUTH_TIMEOUT_MS = 30 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('Veil rendezvous is running. Links are permanent. No messages are stored here.\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (url.pathname !== '/signal') return new Response('Not found\n', { status: 404 });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('WebSocket required\n', { status: 426 });
    }

    const allowed = new Set([...BASE_ORIGINS, ...String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
    const origin = request.headers.get('Origin');
    if (origin && !allowed.has(origin)) return new Response('Forbidden\n', { status: 403 });

    const room = url.searchParams.get('room') || '';
    if (!ROOM_PATTERN.test(room)) return new Response('Invalid session code\n', { status: 400 });

    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(request);
  }
};

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Client keepalive: answered without waking the object (so it costs nothing).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomName = url.searchParams.get('room') || '';
    const now = Date.now();

    for (const s of this.ctx.getWebSockets()) {
      const att = s.deserializeAttachment() || {};
      if (!att.role && now - (att.connectedAt || 0) > UNAUTH_TIMEOUT_MS) {
        try { s.close(1008, 'Timeout'); } catch { /* ignore */ }
      }
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response('Session busy\n', { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null, room: roomName, connectedAt: now });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(socket, message) {
    try { if (socket && socket.readyState === 1) socket.send(JSON.stringify(message)); } catch { /* ignore */ }
  }

  fail(socket, message) {
    this.send(socket, { type: 'error', message });
    try { socket.close(1008, 'Request refused'); } catch { /* ignore */ }
  }

  find(role, except) {
    return this.ctx.getWebSockets().find((s) => s !== except && s.readyState === 1 && (s.deserializeAttachment() || {}).role === role) || null;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 40 * 1024) return this.fail(ws, 'Invalid signaling message.');
    let message;
    try { message = JSON.parse(raw); } catch { return this.fail(ws, 'Invalid message format.'); }

    const att = ws.deserializeAttachment() || {};
    if (!att.role) return this.handshake(ws, att, message);
    if (message && message.type === 'signal') this.relay(ws, att.role, message.data);
  }

  async handshake(ws, att, message) {
    if (!message || message.type !== 'meet' ||
        typeof message.room !== 'string' || message.room !== att.room || !ROOM_PATTERN.test(message.room) ||
        typeof message.proof !== 'string' || !PROOF_PATTERN.test(message.proof) ||
        typeof message.device !== 'string' || !DEVICE_PATTERN.test(message.device)) {
      return this.fail(ws, 'Invalid session code.');
    }
    const storage = this.ctx.storage;
    const now = Date.now();

    let stored = await storage.get('proof');
    let fails = ((await storage.get('fails')) || []).filter((t) => now - t < FAIL_WINDOW_MS);

    if (stored) {
      if (fails.length >= MAX_FAILS_PER_WINDOW) return this.fail(ws, 'Too many attempts. Try again in an hour.');
      if (!safeEqualHex(message.proof, stored)) {
        fails.push(now);
        await storage.put('fails', fails);
        return this.fail(ws, 'Incorrect secret code. Check the link code.');
      }
    } else {
      // First arrival: records the fingerprint of the code. Only the matching secret can join afterwards.
      await storage.put({ proof: message.proof, createdAt: now });
      stored = message.proof;
    }
    // Links are permanent: no inactivity alarm is scheduled and the stored fingerprint is never purged.

    // Same device reconnecting (previous connection dead): replace the old one.
    for (const s of this.ctx.getWebSockets()) {
      if (s === ws) continue;
      const other = s.deserializeAttachment() || {};
      if (other.role && other.device === message.device) {
        s.serializeAttachment({ ...other, role: 'replaced' });
        try { s.close(1000, 'Replaced'); } catch { /* ignore */ }
      }
    }

    const host = this.find('host', ws);
    const guest = this.find('guest', ws);
    if (!host) {
      ws.serializeAttachment({ ...att, role: 'host', device: message.device });
      this.send(ws, { type: 'ready', role: 'host' });
      // If a guest was waiting without a host, they are told when the host invites them to negotiate.
      if (guest) this.send(ws, { type: 'peer-joined' });
      return;
    }
    if (!guest) {
      ws.serializeAttachment({ ...att, role: 'guest', device: message.device });
      this.send(ws, { type: 'ready', role: 'guest' });
      this.send(host, { type: 'peer-joined' });
      return;
    }
    this.fail(ws, 'This link is already in use on two computers.');
  }

  relay(ws, role, data) {
    const other = this.find(role === 'host' ? 'guest' : 'host', ws);
    if (!other || !data || typeof data !== 'object') return;
    if (data.kind === 'description') {
      const d = data.description;
      if (!d || !['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string' || d.sdp.length > 30000) return;
    } else if (data.kind === 'ice') {
      const c = data.candidate;
      if (!c || typeof c.candidate !== 'string' || c.candidate.length > 3000) return;
    } else {
      return;
    }
    this.send(other, { type: 'signal', data });
  }

  leave(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'host') {
      this.send(this.find('guest', ws), { type: 'peer-left' });
    } else if (att.role === 'guest') {
      this.send(this.find('host', ws), { type: 'peer-left' });
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* ignore */ }
    this.leave(ws);
  }

  async webSocketError(ws) {
    try { ws.close(); } catch { /* ignore */ }
    this.leave(ws);
  }
}
