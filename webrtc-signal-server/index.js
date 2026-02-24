const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const rooms = new Map();
// rooms.set(roomId, { isPrivate: true/false, token: "..." })

const app = express();
app.use(cors());

app.get("/api", (req, res) => {
  res.json({ ok: true, message: "Signaling server running" });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // later we will lock this to frontend URL
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("✅ connected:", socket.id);

  socket.on("join-room", ({ roomId, name, isPrivate, token }) => {
    let isCreator = false;

    if (!rooms.has(roomId)) {
      // first person creates the room
      const privateFlag = !!isPrivate;
      const roomToken = privateFlag ? crypto.randomBytes(16).toString("hex") : null;
      rooms.set(roomId, { isPrivate: privateFlag, token: roomToken });
      isCreator = true;
    }

    const roomInfo = rooms.get(roomId);

    // If private => must provide correct token (EXCEPT the creator)
    if (roomInfo.isPrivate && !isCreator) {
      if (!token || token !== roomInfo.token) {
        socket.emit("join-denied", {
          message: "Private room: invalid invite link/token.",
        });
        return;
      }
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    // Tell others in the room that a new user joined
    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      name,
    });

    // Send back to the new user: who is already inside the room
    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    const others = clients
      .filter((id) => id !== socket.id)
      .map((id) => {
        const s = io.sockets.sockets.get(id);
        return { socketId: id, name: s?.data?.name || "User" };
      });

    // Send room users + room privacy info to the new user
    socket.emit("room-users", { others, roomInfo });
  });

  // relay messages (we will use these later for WebRTC offer/answer/ice)
  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("leave-room", ({ roomId, name }) => {
    const finalName = name || socket.data.name || "User";

    socket.to(roomId).emit("user-left", { socketId: socket.id, name: finalName });

    socket.leave(roomId);
    socket.data.roomId = null;

    // Cleanup room settings if empty
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room || room.size === 0) {
      rooms.delete(roomId);
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const name = socket.data.name || "User";

    if (roomId) {
      socket.to(roomId).emit("user-left", { socketId: socket.id, name });

      // Cleanup room settings if room becomes empty
      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room || room.size === 0) {
        rooms.delete(roomId);
      }
    }

    console.log("❌ disconnected:", socket.id);
  });
});

// Serve React build (after you build client)
const clientBuildPath = path.join(__dirname, "../webrtc-meet/dist");
app.use(express.static(clientBuildPath));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(clientBuildPath, "index.html"));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Signaling server on http://localhost:${PORT}`));