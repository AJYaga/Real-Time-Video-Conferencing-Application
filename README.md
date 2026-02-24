# VIBE — Real-Time Video Conferencing (WebRTC + Socket.IO)

VIBE is a room-based real-time video conferencing web app built with **WebRTC** (peer-to-peer media) and **Socket.IO** (signaling + chat).  
It supports **multi-user rooms**, **open/private rooms**, **chat**, and **mic/camera privacy controls**.

---

## Live Demo (Deployed)
- Render URL: https://vibe-webrtc.onrender.com

> Note: Render free tier may “sleep” when inactive. First load may take some time to wake up.

---

## Features
- Join rooms using **Room ID**
- **Open rooms**: anyone with the Room ID can join
- **Private rooms**: only users with the **invite link (token)** can join
- **Multi-user video call (mesh)**
- Privacy default: **Mic OFF + Camera OFF**
- Toggle **Mic ON/OFF** and **Camera ON/OFF**
- **Remote audio mute/unmute** (local speaker control)
- Room chat (Socket.IO relay)
- Copy **Room ID** and **Invite Link**
- Leave/rejoin cleanup (no duplicate tiles, no frozen streams)
- Modern UI (React + Tailwind)

---

## Tech Stack
### Frontend
- React (Vite)
- TailwindCSS
- socket.io-client
- WebRTC APIs (`RTCPeerConnection`, ICE candidates)

### Backend
- Node.js
- Express
- Socket.IO (WebSockets)
- Private room token generation using `crypto`

---

## Project Structure
Project/
├─ webrtc-meet/ # Frontend (Vite React)
│ ├─ src/
│ ├─ index.html
│ └─ package.json
│
└─ webrtc-signal-server/ # Backend (Express + Socket.IO)
├─ index.js
└─ package.json


---

## How It Works (High Level)
1. User joins a room with a **name** + **Room ID**.
2. **Socket.IO** is used for:
   - signaling (exchange WebRTC descriptions + ICE candidates)
   - chat relay
   - room membership events (join/left)
3. **WebRTC** creates peer-to-peer media connections between browsers.
4. For private rooms, the server generates an **invite token**, and only users with the correct token can join.

---

## Open Room vs Private Room
### Open Room
- Anyone can join by entering the same Room ID.

### Private Room
- First user creates the room and selects **Private Room**.
- Server generates a secret token.
- The invite link includes:
  - `?room=<ROOM_ID>&token=<TOKEN>`
- Only users joining via that invite link are accepted.
- Manual joining without token is denied.

---

## Local Setup & Run

### 1) Run Backend (Signaling + Hosting Frontend Build)
Open terminal in `webrtc-signal-server/`:

```bash
npm install
node index.js
```

## Backend default:
http://localhost:5000

API check:
http://localhost:5000/api

### 2) Run Frontend (Dev Mode)
Open another terminal in `webrtc-meet/`:

```bash
npm install
npm run dev
```

Frontend dev URL:
http://localhost:5173

If your socket.js uses VITE_SOCKET_URL, set it to backend:
VITE_SOCKET_URL=http://localhost:5000

### 3) Production-style Local Test (Recommended)
Build frontend:

```bash
cd webrtc-meet
npm run build
```
Then run backend (it serves webrtc-meet/dist):

```bash
cd ../webrtc-signal-server
node index.js
```

Open:
http://localhost:5000

Testing Checklist
- Open room: 2–4 tabs join same Room ID
- Turn camera on in any order
- Private room:
  - creator joins with Private ON
  - copy invite link and join from another tab
  - manual join without token is denied
- Late joiner: open a new tab after 1 minute and join
- Leave + rejoin: no duplicate tiles, correct “left” message

Deployment (Render)
We deployed using Render Web Service (supports WebSockets).

Build Command:
```
cd webrtc-signal-server && npm install && cd ../webrtc-meet && npm install && npm run build
```
Start Command:
```
cd webrtc-signal-server && node index.js
```

Limitations
- Uses STUN only (no TURN). In strict NAT/firewall networks, some peers may fail to connect.
- Mesh calls increase CPU/bandwidth as users increase.

Group Members
Kishothana P. — Frontend / UI
Shapthana J.  — WebRTC logic & Testing
Ajanthan T.   — Backend + private rooms
