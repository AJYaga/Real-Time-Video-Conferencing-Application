import { useEffect, useState, useRef } from "react";
import {
  Video,
  Mic,
  MicOff,
  VideoOff,
  PhoneOff,
  Send,
  Users,
  VolumeX,
  Volume2,
} from "lucide-react";
import { socket } from "./lib/socket";

export default function App() {
  const [page, setPage] = useState("join"); // "join" | "call"
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState("");

  const [isPrivate, setIsPrivate] = useState(false);
  const [inviteToken, setInviteToken] = useState("");

  const [status, setStatus] = useState("Not connected");

  const [isJoining, setIsJoining] = useState(false);

  const [participants, setParticipants] = useState([]); // {socketId, name}
  const participantsRef = useRef([]);
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Privacy default OFF, but we will still create tracks (disabled)
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);

  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState([
    { from: "System", text: "Chat will become real after join." },
  ]);

  const [localStream, setLocalStream] = useState(null);
  const localStreamRef = useRef(null);
  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const [remoteStreams, setRemoteStreams] = useState({}); // { socketId: MediaStream }

  const [remoteMuted, setRemoteMuted] = useState(true);
  const [toast, setToast] = useState("");

  // { socketId: { micOn: boolean, camOn: boolean } }
  const [mediaState, setMediaState] = useState({});

  const [pinnedId, setPinnedId] = useState(null);

  // --------------------------
  // Perfect Negotiation refs
  // --------------------------
  const pcsRef = useRef({}); // {socketId: RTCPeerConnection}
  const makingOfferRef = useRef({}); // {socketId: boolean}
  const ignoreOfferRef = useRef({}); // {socketId: boolean}

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  }

  function uniqueParticipants(list) {
    const map = new Map();
    list.forEach((p) => map.set(p.socketId, p));
    return Array.from(map.values());
  }

  // Deterministic role: "polite" peer is the one with larger socket.id
  function isPolite(remoteId) {
    if (!socket.id) return true;
    return socket.id > remoteId;
  }

  // --------------------------
  // Local media: get once on call page, but disable tracks (privacy)
  // --------------------------
  async function startLocalMediaOnce() {
    if (localStreamRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      // privacy default OFF
      stream.getAudioTracks().forEach((t) => (t.enabled = false));
      stream.getVideoTracks().forEach((t) => (t.enabled = false));

      setMicOn(false);
      setCamOn(false);

      setLocalStream(stream);
      localStreamRef.current = stream;
    } catch (err) {
      console.error(err);
      alert("Camera/Mic permission denied or not available.");
    }
  }

  function attachLocalTracksToPC(pc) {
    const stream = localStreamRef.current;
    if (!stream) return;

    const senders = pc.getSenders();
    stream.getTracks().forEach((track) => {
      const exists = senders.some((s) => s.track && s.track.kind === track.kind);
      if (!exists) pc.addTrack(track, stream);
    });
  }

  function attachLocalTracksToAllPeers() {
    Object.values(pcsRef.current).forEach((pc) => attachLocalTracksToPC(pc));
  }

  // --------------------------
  // Create/get PeerConnection for a remote
  // --------------------------
  function ensurePeer(remoteId) {
    if (pcsRef.current[remoteId]) return pcsRef.current[remoteId];

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    // add local tracks if already available
    attachLocalTracksToPC(pc);

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        try { pc.restartIce(); } catch {}
      }
    };

    pc.ontrack = (event) => {
      setRemoteStreams((prev) => {
        const existing = prev[remoteId] || new MediaStream();
        existing.addTrack(event.track);
        return { ...prev, [remoteId]: existing };
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("signal", {
          to: remoteId,
          data: { type: "candidate", candidate: event.candidate },
        });
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current[remoteId] = true;
        await pc.setLocalDescription();
        socket.emit("signal", {
          to: remoteId,
          data: { type: "description", description: pc.localDescription },
        });
      } catch (e) {
        // ignore
      } finally {
        makingOfferRef.current[remoteId] = false;
      }
    };

    pcsRef.current[remoteId] = pc;
    return pc;
  }

  function closePeer(remoteId) {
    const pc = pcsRef.current[remoteId];
    if (pc) {
      try {
        pc.close();
      } catch {}
    }
    delete pcsRef.current[remoteId];
    delete makingOfferRef.current[remoteId];
    delete ignoreOfferRef.current[remoteId];

    setRemoteStreams((prev) => {
      const c = { ...prev };
      delete c[remoteId];
      return c;
    });

    setMediaState((prev) => {
      const c = { ...prev };
      delete c[remoteId];
      return c;
    });
  }

  // --------------------------
  // Media-state broadcast (for badges + avatar logic)
  // --------------------------
  function broadcastMediaState(nextMic, nextCam) {
    // store mine too
    if (socket.id) {
      setMediaState((prev) => ({
        ...prev,
        [socket.id]: { micOn: nextMic, camOn: nextCam },
      }));
    }

    const others = participantsRef.current.filter((p) => p.socketId !== socket.id);
    others.forEach((p) => {
      socket.emit("signal", {
        to: p.socketId,
        data: { type: "media-state", micOn: nextMic, camOn: nextCam },
      });
    });
  }

  // --------------------------
  // Socket lifecycle
  // --------------------------
  useEffect(() => {
    function onConnect() {
      setStatus("Connected to server ✅");
    }

    function onDisconnect() {
      setStatus("Disconnected ❌");
      setIsJoining(false);

      // cleanup all peers
      Object.keys(pcsRef.current).forEach((id) => closePeer(id));
      pcsRef.current = {};
      makingOfferRef.current = {};
      ignoreOfferRef.current = {};
      setRemoteStreams({});
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    socket.on("join-denied", ({ message }) => {
      alert(message || "Join denied");
      setPage("join");
    });

    socket.on("room-users", ({ others, roomInfo }) => {
      const me = socket.id ? [{ socketId: socket.id, name: "You" }] : [];
      setParticipants(uniqueParticipants([...me, ...others]));
      setIsJoining(false);

      // if this is a private room, store token (creator needs it for invite link)
      if (roomInfo?.isPrivate && roomInfo?.token) {
        setInviteToken(roomInfo.token);
      }

      // privacy default for unknown remote states
      setMediaState((prev) => {
        const copy = { ...prev };
        others.forEach((u) => {
          if (!copy[u.socketId]) copy[u.socketId] = { micOn: false, camOn: false };
        });
        if (socket.id) copy[socket.id] = { micOn, camOn };
        return copy;
      });

      // create PCs for all existing users
      others.forEach((u) => ensurePeer(u.socketId));

      setMessages((prev) => [...prev, { from: "System", text: "Joined room ✅" }]);

      // send my state to everyone
      broadcastMediaState(micOn, camOn);

      // also ask for their state
      others.forEach((u) => {
        socket.emit("signal", { to: u.socketId, data: { type: "media-state-request" } });
      });
    });

    socket.on("user-joined", ({ socketId, name }) => {
      setParticipants((prev) => uniqueParticipants([...prev, { socketId, name }]));

      setMediaState((prev) => ({
        ...prev,
        [socketId]: prev[socketId] || { micOn: false, camOn: false },
        ...(socket.id ? { [socket.id]: { micOn, camOn } } : {}),
      }));

      ensurePeer(socketId);

      setMessages((prev) => [...prev, { from: "System", text: `${name} joined.` }]);

      // handshake
      socket.emit("signal", { to: socketId, data: { type: "media-state", micOn, camOn } });
      socket.emit("signal", { to: socketId, data: { type: "media-state-request" } });
    });

    socket.on("user-left", ({ socketId, name: leftNameFromServer }) => {
      const leftName =
        leftNameFromServer ||
        participantsRef.current.find((p) => p.socketId === socketId)?.name ||
        "A user";

      setParticipants((prev) => prev.filter((p) => p.socketId !== socketId));
      setMessages((prev) => [...prev, { from: "System", text: `${leftName} left.` }]);

      closePeer(socketId);
    });

    socket.on("signal", async ({ from, data }) => {
      if (!data?.type) return;

      // chat
      if (data.type === "chat") {
        setMessages((prev) => [...prev, { from: data.name || from, text: data.text }]);
        return;
      }

      // state request
      if (data.type === "media-state-request") {
        socket.emit("signal", {
          to: from,
          data: { type: "media-state", micOn, camOn },
        });
        return;
      }

      // state update
      if (data.type === "media-state") {
        setMediaState((prev) => ({
          ...prev,
          [from]: { micOn: !!data.micOn, camOn: !!data.camOn },
        }));
        return;
      }

      // WebRTC Perfect Negotiation
      const pc = ensurePeer(from);

      // WebRTC Perfect Negotiation (SAFE)
      if (data.type === "description") {
        const description = data.description;
        const polite = isPolite(from);

        const offerCollision =
          description.type === "offer" &&
          (makingOfferRef.current[from] || pc.signalingState !== "stable");

        const ignoreThisOffer = !polite && offerCollision;
        if (ignoreThisOffer) {
          // IMPORTANT: ignore only this offer, do not permanently ignore future candidates
          return;
        }

        await pc.setRemoteDescription(description);

        if (description.type === "offer") {
          // make sure we have tracks if available
          attachLocalTracksToPC(pc);

          await pc.setLocalDescription();
          socket.emit("signal", {
            to: from,
            data: { type: "description", description: pc.localDescription },
          });
        }
        return;
      }

      if (data.type === "candidate") {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          // If we ignored an offer, candidate may fail — safe to ignore
        }
        return;
      }
    });

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room-users");
      socket.off("user-joined");
      socket.off("user-left");
      socket.off("signal");
      socket.off("join-denied");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOn, camOn]);

  // Invite link room fill
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get("room");
    const t = params.get("token");
    if (r) setRoomId(r);
    if (t) setInviteToken(t);
  }, []);

  // Start local media automatically when entering call page (tracks OFF)
  useEffect(() => {
    if (page === "call") {
      startLocalMediaOnce().then(() => {
        // after stream exists, attach tracks to already-created PCs
        attachLocalTracksToAllPeers();
      });
    }
    if (page === "join" && localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // --------------------------
  // Actions
  // --------------------------
  async function handleJoin(e) {
    e.preventDefault();
    if (!name.trim()) return alert("Enter your name");
    if (!roomId.trim()) return alert("Enter a room ID");
    if (!socket.connected) socket.connect();

    setMessages([{ from: "System", text: "Joining room..." }]);
    setRemoteStreams({});
    setMediaState({});
    setPinnedId(null);
    setIsJoining(true);

    // ✅ KEY FIX: start local media BEFORE joining
    await startLocalMediaOnce(); // tracks will be created but disabled by default

    setPage("call");
    window.history.replaceState({}, "", window.location.pathname);

    socket.emit("join-room", {
      roomId,
      name,
      isPrivate,
      token: inviteToken || undefined,
    });

    // broadcast my state (default off)
    broadcastMediaState(false, false);
  }

  function handleLeave() {
    // server notify + disconnect
    socket.emit("leave-room", { roomId, name });
    socket.disconnect();

    // cleanup peers
    Object.keys(pcsRef.current).forEach((id) => closePeer(id));
    pcsRef.current = {};
    makingOfferRef.current = {};
    ignoreOfferRef.current = {};
    setRemoteStreams({});

    // stop local media
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);

    setIsJoining(false);
    setPage("join");
    setRoomId("");
    setParticipants([]);
    setMediaState({});
    setMessages([{ from: "System", text: "Left room." }]);
  }

  function sendMessage(e) {
    e.preventDefault();
    const txt = chatInput.trim();
    if (!txt) return;

    setMessages((prev) => [...prev, { from: "You", text: txt }]);
    setChatInput("");

    const others = participantsRef.current.filter((p) => p.socketId !== socket.id);
    others.forEach((p) => {
      socket.emit("signal", {
        to: p.socketId,
        data: { type: "chat", text: txt, name },
      });
    });
  }

  function toggleMic() {
    const next = !micOn;
    setMicOn(next);

    const a = localStreamRef.current?.getAudioTracks?.()[0];
    if (a) a.enabled = next;

    broadcastMediaState(next, camOn);
  }

  function toggleCam() {
    const next = !camOn;
    setCamOn(next);

    const v = localStreamRef.current?.getVideoTracks?.()[0];
    if (v) v.enabled = next;

    broadcastMediaState(micOn, next);
  }

  return (
    <>
      {page === "join" ? (
        <JoinScreen
          name={name}
          setName={setName}
          roomId={roomId}
          setRoomId={setRoomId}
          onJoin={handleJoin}
          status={status}
          isJoining={isJoining}
          isPrivate={isPrivate}
          setIsPrivate={setIsPrivate}
        />
      ) : (
        <CallScreen
          roomId={roomId}
          status={status}
          participants={participants}
          micOn={micOn}
          camOn={camOn}
          onToggleMic={toggleMic}
          onToggleCam={toggleCam}
          onLeave={handleLeave}
          messages={messages}
          chatInput={chatInput}
          setChatInput={setChatInput}
          onSend={sendMessage}
          localStream={localStream}
          remoteStreams={remoteStreams}
          remoteMuted={remoteMuted}
          onToggleRemoteMute={() => setRemoteMuted((v) => !v)}
          mediaState={mediaState}
          showToast={showToast}
          pinnedId={pinnedId}
          setPinnedId={setPinnedId}
          inviteToken={inviteToken} 
        />
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-2xl border border-slate-800 bg-slate-950/90 px-4 py-3 text-sm text-slate-100 shadow-xl">
          {toast}
        </div>
      )}
    </>
  );
}

function JoinScreen({ name, setName, roomId, setRoomId, onJoin, status, isJoining, isPrivate, setIsPrivate }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 grid place-items-center">
              <Video className="h-5 w-5 text-indigo-300" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">VIBE</h1>
              <p className="text-sm text-slate-400">Modern room-based video call + chat</p>
            </div>
          </div>
          <div className="text-xs text-slate-400">{status}</div>
        </div>

        <div className="mt-10 flex justify-center">
          <div className="w-full max-w-xl rounded-3xl border border-slate-800 bg-slate-900/30 p-6 shadow-xl">
            <h2 className="text-lg font-semibold">Join a room</h2>

            <form onSubmit={onJoin} className="mt-6 space-y-4">
              <div>
                <label className="text-sm text-slate-300">Your name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-2 w-full rounded-2xl bg-slate-950/40 border border-slate-800 px-4 py-3 outline-none focus:border-indigo-500/60"
                  placeholder="Eg: Alex"
                />
              </div>

              <div>
                <label className="text-sm text-slate-300">Room ID</label>
                <input
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  className="mt-2 w-full rounded-2xl bg-slate-950/40 border border-slate-800 px-4 py-3 outline-none focus:border-indigo-500/60"
                  placeholder="Eg: 123"
                />
                <label className="flex items-center gap-3 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => setIsPrivate(e.target.checked)}
                  />
                  Private room (invite link required)
                </label>
              </div>

              <button
                type="submit"
                disabled={isJoining}
                className={`w-full rounded-2xl py-3 font-semibold transition ${
                  isJoining
                    ? "bg-indigo-600/50 cursor-not-allowed"
                    : "bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99]"
                }`}
              >
                {isJoining ? "Joining..." : "Join"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

function CallScreen({
  roomId,
  status,
  participants,
  micOn,
  camOn,
  onToggleMic,
  onToggleCam,
  onLeave,
  messages,
  chatInput,
  setChatInput,
  onSend,
  localStream,
  remoteStreams,
  remoteMuted,
  onToggleRemoteMute,
  mediaState,
  showToast,
  pinnedId,
  setPinnedId,
  inviteToken,
}) {
  function copyRoomId() {
    navigator.clipboard.writeText(roomId);
    showToast("Room ID copied ✅");
  }

  function copyInviteLink() {
    const base = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
    const link = inviteToken ? `${base}&token=${encodeURIComponent(inviteToken)}` : base;
    navigator.clipboard.writeText(link);
    showToast("Invite link copied ✅");
  }

  function MediaBadges({ isLocal, socketId }) {
    const m = isLocal ? { micOn, camOn } : (mediaState?.[socketId] || {});
    const mic = m.micOn ?? false;
    const cam = m.camOn ?? false;

    return (
      <div className="absolute top-3 left-3 flex gap-2 z-10">
        <span
          title={mic ? "Mic On" : "Mic Off"}
          className="h-9 w-9 grid place-items-center rounded-xl border border-slate-800 bg-slate-950/70"
        >
          {mic ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4 text-red-300" />}
        </span>

        <span
          title={cam ? "Camera On" : "Camera Off"}
          className="h-9 w-9 grid place-items-center rounded-xl border border-slate-800 bg-slate-950/70"
        >
          {cam ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4 text-red-300" />}
        </span>
      </div>
    );
  }

  function getInitials(fullName) {
    const n = (fullName || "").trim();
    if (!n) return "?";
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function AvatarTile({ name }) {
    const initials = getInitials(name);
    return (
      <div className="w-full h-full grid place-items-center bg-slate-950/60">
        <div className="h-24 w-24 rounded-3xl border border-slate-800 bg-slate-900/40 grid place-items-center">
          <span className="text-4xl font-semibold text-slate-100">{initials}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 bg-slate-950/60 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 grid place-items-center">
              <Video className="h-5 w-5 text-indigo-300" />
            </div>
            <div>
              <div className="text-sm text-slate-400">Room</div>
              <div className="font-semibold">{roomId}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copyRoomId}
              className="text-xs px-3 py-2 rounded-xl border border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 transition"
            >
              Copy Room ID
            </button>
            <button
              onClick={copyInviteLink}
              className="text-xs px-3 py-2 rounded-xl border border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 transition"
            >
              Copy Invite Link
            </button>
            <div className="text-xs text-slate-400">{status}</div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="rounded-3xl border border-slate-800 bg-slate-900/20 p-4">
          <div className="flex items-center justify-between px-2 pb-3">
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <Users className="h-4 w-4" />
              Participants: {participants.length}
            </div>
            <div className="text-xs text-slate-500">(WebRTC video + chat)</div>
          </div>

          {/* ====== Big + Small layout ====== */}
          {(() => {
            const pinnedParticipant = pinnedId
              ? participants.find((p) => p.socketId === pinnedId)
              : null;

            const bigIsLocal = !pinnedParticipant;
            const bigTitle = bigIsLocal ? "You" : pinnedParticipant.name;

            const bigStream = bigIsLocal
              ? localStream
              : remoteStreams?.[pinnedParticipant.socketId];

            const smallList = participants.filter((p) => {
              if (bigIsLocal) return p.name !== "You";
              return p.socketId !== pinnedId;
            });

            return (
              <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
                {/* Big tile */}
                <div className="relative w-full aspect-video rounded-3xl bg-slate-950/50 border border-slate-800 overflow-hidden">
                  <MediaBadges
                    isLocal={bigIsLocal}
                    socketId={pinnedParticipant?.socketId}
                  />

                  {bigIsLocal ? (
                    camOn ? (
                      <VideoPlayer stream={bigStream} muted />
                    ) : (
                      <div className="w-full h-full grid place-items-center text-slate-500 text-sm">
                        Camera Off
                      </div>
                    )
                  ) : (() => {
                      const remoteId = pinnedParticipant?.socketId;
                      const remoteName = pinnedParticipant?.name || "User";
                      const remoteCamOn = mediaState?.[remoteId]?.camOn;

                      if (remoteCamOn !== true) return <AvatarTile name={remoteName} />;
                      if (bigStream) return <VideoPlayer stream={bigStream} muted={remoteMuted} />;

                      return (
                        <div className="w-full h-full grid place-items-center text-slate-500 text-sm">
                          Connecting...
                        </div>
                      );
                    })()}

                  <div className="absolute bottom-3 left-3 rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-1 text-xs">
                    {bigTitle} {bigIsLocal ? "(Local)" : "(Remote)"}
                  </div>

                  {!bigIsLocal && (
                    <button
                      onClick={() => setPinnedId(null)}
                      className="absolute top-3 right-3 text-xs px-3 py-2 rounded-xl border border-slate-800 bg-slate-950/70 hover:bg-slate-900/70 transition"
                    >
                      Back to Local
                    </button>
                  )}
                </div>

                {/* Small tiles */}
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                  {smallList.map((p) => {
                    const isLocal = p.name === "You";
                    const stream = isLocal ? localStream : remoteStreams?.[p.socketId];

                    return (
                      <button
                        key={p.socketId}
                        onClick={() => {
                          if (isLocal) setPinnedId(null);
                          else setPinnedId(p.socketId);
                        }}
                        className="text-left relative w-full aspect-video rounded-2xl bg-slate-950/50 border border-slate-800 overflow-hidden hover:border-indigo-500/50 transition"
                        type="button"
                      >
                        <MediaBadges isLocal={isLocal} socketId={p.socketId} />

                        {isLocal ? (
                          camOn ? (
                            <VideoPlayer stream={stream} muted />
                          ) : (
                            <div className="w-full h-full grid place-items-center text-slate-500 text-sm">
                              Camera Off
                            </div>
                          )
                        ) : (() => {
                            const remoteCamOn = mediaState?.[p.socketId]?.camOn;
                            if (remoteCamOn !== true) return <AvatarTile name={p.name} />;
                            if (stream) return <VideoPlayer stream={stream} muted={remoteMuted} />;

                            return (
                              <div className="w-full h-full grid place-items-center text-slate-500 text-sm">
                                Connecting...
                              </div>
                            );
                          })()}

                        <div className="absolute bottom-2 left-2 rounded-lg bg-slate-950/70 border border-slate-800 px-2 py-1 text-[11px]">
                          {p.name}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={onToggleMic}
              className="px-4 py-2 rounded-2xl border border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 transition flex items-center gap-2"
            >
              {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
              <span className="text-sm">{micOn ? "Mute" : "Unmute"}</span>
            </button>

            <button
              onClick={onToggleRemoteMute}
              className="px-4 py-2 rounded-2xl border border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 transition flex items-center gap-2"
            >
              {remoteMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              <span className="text-sm">{remoteMuted ? "Unmute Remote" : "Mute Remote"}</span>
            </button>

            <button
              onClick={onToggleCam}
              className="px-4 py-2 rounded-2xl border border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 transition flex items-center gap-2"
            >
              {camOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
              <span className="text-sm">{camOn ? "Camera Off" : "Camera On"}</span>
            </button>

            <button
              onClick={onLeave}
              className="px-4 py-2 rounded-2xl bg-red-600 hover:bg-red-500 transition flex items-center gap-2"
            >
              <PhoneOff className="h-4 w-4" />
              <span className="text-sm font-semibold">Leave</span>
            </button>
          </div>
        </div>

        {/* Chat */}
        <div className="rounded-3xl border border-slate-800 bg-slate-900/20 p-4 flex flex-col">
          <div className="px-2 pb-3 flex items-center justify-between">
            <div className="font-semibold">Chat</div>
            <div className="text-xs text-slate-500">Live messages</div>
          </div>

          <div className="flex-1 overflow-auto rounded-2xl border border-slate-800 bg-slate-950/40 p-3 space-y-3">
            {messages.map((m, idx) => (
              <div key={idx} className="text-sm">
                <span className="text-slate-400">{m.from}: </span>
                <span className="text-slate-100">{m.text}</span>
              </div>
            ))}
          </div>

          <form onSubmit={onSend} className="mt-3 flex gap-2">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              className="flex-1 rounded-2xl bg-slate-950/40 border border-slate-800 px-4 py-3 outline-none focus:border-indigo-500/60"
              placeholder="Type a message…"
            />
            <button
              type="submit"
              className="rounded-2xl bg-indigo-600 px-4 py-3 hover:bg-indigo-500 transition flex items-center gap-2"
            >
              <Send className="h-4 w-4" />
              <span className="text-sm font-semibold">Send</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function VideoPlayer({ stream, muted }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !stream) return;

    ref.current.srcObject = stream;
    const p = ref.current.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className="w-full h-full object-cover"
    />
  );
}