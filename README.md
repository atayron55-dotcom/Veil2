# Veil Desktop — private P2P messenger (version 3.0.0)

**Veil** is a private peer-to-peer desktop messenger for Windows, Linux and macOS. Each build is a self-contained Electron application: it embeds its own rendering engine and runtime, so the computers that use it do not need Python, Node.js or a browser installed.

All three systems speak the same WebRTC protocol and can talk to each other: Windows ↔ Linux, Windows ↔ macOS, Linux ↔ macOS, or two machines running the same system.

## What is new in version 3

- **Multiple simultaneous links.** You can keep several conversations open at once. Each link has its own signaling socket, WebRTC connection, encryption key, unread counter and history. The sidebar lists every link and lets you switch between them instantly.
- **Permanent links.** A link you create no longer expires after 24 hours. It stays valid as long as you keep it, and the app reconnects automatically — forever, with exponential backoff capped at 30 seconds — whenever the network drops.
- **New name and identity: Veil.**
- **Neon-blue cyberpunk theme.** Deep black background, cyan and electric-blue accents, grid overlay and glow effects replace the old romantic theme.
- **Audio and video calls.** Call any connected peer from the chat header. Calls reuse the existing encrypted peer connection, with mute, camera on/off, accept, decline and hang-up controls.
- **Everything in English.** Menus, buttons, status messages, errors, notifications and documentation.
- **Sound feedback.** A short synthesized tone plays when a message arrives, when a peer connects, when a call ends, plus a ringtone for incoming calls and a ringback tone for outgoing calls. Sounds can be disabled in Settings.

## How Veil works

There is no chat server, no central database and no central message storage. Messages, images, avatars and emojis travel directly between the two applications through a WebRTC DataChannel.

A **tiny rendezvous service** is still required for the invite code. It acts like a game lobby: it introduces the two devices and relays only the technical information needed to open WebRTC (SDP descriptions and ICE candidates). It never receives message text or photos, and keeps no history.

> A direct Internet connection between two networks cannot be triggered by a code alone without a prior exchange of network information. That is why a minimal rendezvous service is needed for the invite. Chat traffic itself remains peer-to-peer.

## Features

- Create any number of links, each with its own invite code to copy and share.
- Several conversations running at the same time, all listed in the sidebar.
- Permanent links with automatic, unlimited reconnection.
- Direct P2P connection over WebRTC DataChannels.
- WebRTC DTLS encryption plus application-level AES-256-GCM encryption. The key is derived from the random secret contained in the invite code; the secret is never sent to the rendezvous service.
- Network path discovery with STUN (Google and Cloudflare configured by default).
- Optional TURN settings for networks that block direct P2P. Even through TURN, the DataChannel content stays encrypted.
- Local history stored in IndexedDB on each computer. Missing messages are synchronized on the next connection, up to the last 400 synchronized items per exchange.
- Image messages (up to 5 MB before compression).
- Personal avatar and custom emojis imported from PNG, JPEG or WebP.
- Audio and video calls over the existing encrypted connection.
- Desktop notifications, unread badges and window attention requests.
- Synthesized message, connection and call sounds (no external audio files).
- Works across Windows, Linux and macOS regardless of the other person's system.

## Starting a conversation

1. The first person opens Veil and chooses **Create a link**.
2. The app generates a random code. Use **Copy** to send it to the other person.
3. The second person opens Veil, pastes the code and chooses **Join**.
4. Both apps negotiate the connection. Once the secret is verified, the chat opens.
5. Messages and files are transferred between the computers, never through the rendezvous service.

The person who creates the link makes the first WebRTC offer, but does not become a central message server: once connected, the channel is bidirectional. If either side closes the app or loses its connection, the link stays saved and Veil reconnects automatically when both sides are online again. History is synchronized after reconnection.

To start another conversation, click **New connection** in the sidebar. You can keep as many links as you like and talk to several people at the same time.

## Calls

When a peer is connected, the microphone and camera buttons in the chat header become available.

- **Audio call** requests only the microphone.
- **Video call** requests the microphone and camera.
- The callee sees an incoming-call overlay, hears a ringtone and can accept or decline.
- During a call you can mute the microphone, turn the camera off or hang up.
- If the peer is already on another call, Veil answers "busy" and plays a short tone.
- Calls use the same encrypted peer connection as the chat, so no second server is involved.

The operating system may ask for microphone and camera permission the first time. Veil only allows media, notification and clipboard permissions; everything else is denied.

## Sounds and notifications

Veil synthesizes its sounds with the Web Audio API:

- a soft two-note chime for incoming messages;
- a rising tone when a peer connects;
- a falling tone when a call ends;
- a repeating ringtone for incoming calls;
- a ringback tone while an outgoing call is ringing.

Both **Sounds** and **Desktop notifications** can be turned off in Settings. A **Test sound** button lets you check the volume.

## 1. Deploy the minimal rendezvous service

This service must be reachable from the Internet. It can run on a small Linux VPS. It hosts no conversation and needs no database.

### Requirements

- A domain or subdomain, for example `signal.example.com`.
- A small Linux server with Docker and Docker Compose.
- The subdomain's DNS pointing to the server's public IP address.
- TCP ports 80 and 443 open on the firewall.

### Installation

From the root of this project, on the server:

```bash
cp .env.example .env
```

Replace `SIGNAL_DOMAIN` in `.env` with your real domain. Then run:

```bash
docker compose -f docker-compose.rendezvous.yml up -d --build
```

Caddy automatically requests and renews a TLS certificate. The WebSocket service is available at:

```text
wss://signal.example.com/signal
```

Check the service:

```bash
curl https://signal.example.com/health
```

The response should say that the Veil rendezvous is running, that links are permanent and that no message is stored.

### Data seen by the service

The service receives:

- the temporary room identifier (10 characters), needed to find the invite;
- an HMAC verifier derived from the secret, used to reject anyone without the right code;
- SDP descriptions and ICE candidates needed for WebRTC negotiation;
- the participants' network connections (source IP address visible to the host).

The encryption secret (24 random characters) is never sent. An HMAC verifier derived from the secret validates the invite without transmitting the secret in clear text. No message content, avatar, emoji or file passes through this service. Rooms are kept in memory only and are removed when the host socket closes; **they are never deleted because of age**, so links are permanent.

The service applies basic per-IP attempt limiting and does not log SDP or exchanged data. This does not make the IP address invisible to the host: it is required to establish an Internet connection.

## 2. Configure the applications

On each computer:

1. Launch Veil.
2. Open **Settings** (gear icon).
3. In **Rendezvous service**, enter the same address: `wss://signal.example.com/signal`.
4. Click **Save settings**.
5. Create or join a link.

### Direct connection and optional relay

The app tries a direct connection with STUN. On most home networks this is enough. Some corporate networks, mobile networks or strict NATs can prevent direct P2P.

In that case you need a TURN server and must fill in Settings:

- URL, for example `turns:turn.example.com:5349`;
- TURN username;
- TURN password.

TURN relays encrypted WebRTC packets; it never receives plaintext messages. No TURN server is provided or hosted by default in this project. If neither a direct path nor a TURN relay is available, the link cannot connect.

## 3. Build standalone applications

Users' computers do not need Node.js. Node.js and npm are only used to build the packages.

On the build machine, at the root of the project:

```bash
npm install
```

Then run the command matching the build system:

| Build system | Command | Standalone result |
|---|---|---|
| Windows x64 | `npm run dist:win` | `.exe` installer and portable `.exe` |
| Linux x64 | `npm run dist:linux` | Portable `.AppImage` and `.deb` package |
| macOS | `npm run dist:mac` | `.dmg` and `.zip` containing the universal Intel + Apple Silicon app |

Files are written to `release/`.

- **Windows portable**: run `Veil-3.0.0-win-portable.exe` directly. No installer is needed; the `VeilData` folder created next to the file keeps the profile and history.
- **Linux AppImage**: make the file executable (`chmod +x Veil-*.AppImage`) and double-click it. Some distributions require the FUSE library for AppImages; when the AppImage folder is writable, `VeilData` keeps the profile and history there.
- **macOS ZIP/DMG**: the ZIP contains the `.app`, and the DMG lets you drag it into Applications. Data is kept in the standard macOS user folder.

macOS builds must be produced on macOS. Cross-compilation is not guaranteed for every Apple SDK version.

## 4. Build all three families automatically with GitHub Actions

The workflow `.github/workflows/build-desktop.yml` builds each family on its own system: Windows, Ubuntu and macOS.

1. Create a private GitHub repository and push the contents of this folder.
2. In the repository, open the **Actions** tab.
3. Select **Build Veil desktop apps** and click **Run workflow**.
4. When it finishes, download the Windows, Linux and macOS artifacts.

Artifacts are kept for 14 days by GitHub Actions. They are unsigned portable builds/installers.

### Signature warning

Files generated without developer certificates may trigger Microsoft SmartScreen on Windows or Gatekeeper on macOS. This is not a virus warning; it only means the app is not signed/notarized by an identified publisher. For distribution without these warnings, configure Windows code signing and Apple signing/notarization.

## 5. Important limitations

- Both people must be online at the same time to talk live. Messages are synchronized on the next connection; there is no instant delivery while the other app is closed.
- The first user who creates the link initiates the negotiation, but chat traffic is bidirectional and direct.
- STUN does not relay messages. With strict NAT or a firewall, a TURN server may be required.
- The rendezvous service can see public IP addresses and network metadata of the negotiation, but not the invite secret or encrypted content.
- History is local to each device. There is no automatic cloud backup; backing up the app's data folder also backs up that history. Encryption protects network exchanges, but the local IndexedDB database is not separately encrypted at rest: protect the Windows/macOS/Linux account that holds this data.
- Custom emojis are sent to the other device while a link is connected or on the next connection. Deleting an emoji locally does not yet delete it on the peer.
- The encryption has not undergone an independent audit.

## Project layout

```text
veil-p2p/
├── desktop/
│   ├── main.cjs                 # Electron window, permissions and local preferences
│   ├── preload.cjs              # restricted IPC bridge
│   ├── index.html               # desktop interface
│   ├── style.css                # neon-blue cyberpunk theme
│   ├── app.js                   # WebRTC, encryption, calls, messages and local storage
│   └── assets/                  # Windows, Linux and macOS icons
├── rendezvous/
│   ├── server.js                # minimal signaling server, no storage
│   ├── package.json
│   └── Dockerfile
├── worker/                      # optional Cloudflare Workers signaling service
├── docker-compose.rendezvous.yml
├── Caddyfile
├── .env.example
├── package.json
└── .github/workflows/build-desktop.yml
```
