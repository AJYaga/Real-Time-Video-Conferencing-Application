import { io } from "socket.io-client";

const URL = import.meta.env.VITE_SOCKET_URL || window.location.origin;
export const socket = io(URL, { transports: ["websocket"] });