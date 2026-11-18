const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, game: "Red Feather RTS" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();
const START = { gold: 500, wood: 350, food: 300, stone: 180, buildings: [], units: [] };
let nextId = 1;

function roomFor(code) {
  if (!rooms.has(code)) rooms.set(code, { players: new Map(), state: { players: {}, chat: [] } });
  return rooms.get(code);
}
function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function broadcast(room, data) { for (const p of room.players.values()) send(p.ws, data); }
function snapshot(room) { return { type: "state", players: room.state.players, chat: room.state.chat.slice(-30) }; }

wss.on("connection", (ws) => {
  let room, playerId;
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "join") {
      const code = String(msg.room || "KINGDOM").toUpperCase().slice(0, 12);
      const name = String(msg.name || "Lord").replace(/[^a-z0-9 _-]/gi, "").slice(0, 16) || "Lord";
      room = roomFor(code);
      playerId = "p" + nextId++;
      const color = ["#b84a3a", "#4778b8", "#6d9b58", "#a17ac2"][room.players.size % 4];
      room.players.set(playerId, { ws, name, color });
      room.state.players[playerId] = { id: playerId, name, color, gold: 500, wood: 350, food: 300, stone: 180, buildings: [], units: [], x: (room.players.size - 1) * 12 - 6 };
      ws.roomCode = code; ws.playerId = playerId;
      send(ws, { type: "welcome", id: playerId, room: code, color });
      broadcast(room, snapshot(room));
      broadcast(room, { type: "notice", text: name + " joined the realm." });
      return;
    }
    if (!room || !playerId) return;
    const me = room.state.players[playerId];
    if (!me) return;
    if (msg.type === "action") {
      const costs = {
        house: { wood: 90 }, farm: { wood: 65 }, barracks: { wood: 120, stone: 35 },
        tower: { wood: 55, stone: 70 }, dock: { wood: 150, stone: 40 },
        soldier: { gold: 45, food: 35 }, archer: { gold: 55, wood: 15, food: 30 },
        knight: { gold: 110, food: 55 }, pikeman: { gold: 65, wood: 10, food: 40 },
        siege: { gold: 160, wood: 90 }, ship: { gold: 130, wood: 120, food: 25 }
      };
      const kind = String(msg.kind || "");
      const cost = costs[kind];
      if (!cost) return;
      if (kind === "ship" && !me.buildings.some(b => b.kind === "dock")) {
        send(ws, { type: "notice", text: "Build a dock before commissioning a ship." }); return;
      }
      if (["soldier","archer","knight","pikeman","siege","ship"].includes(kind) &&
          !me.buildings.some(b => b.kind === "barracks" || (kind === "ship" && b.kind === "dock"))) {
        send(ws, { type: "notice", text: "Build a barracks first to recruit an army." }); return;
      }
      if (Object.entries(cost).some(([k,v]) => me[k] < v)) {
        send(ws, { type: "notice", text: "Not enough resources." }); return;
      }
      for (const [k,v] of Object.entries(cost)) me[k] -= v;
      const item = { id: "i" + nextId++, kind, x: Number.isFinite(msg.x) ? Math.max(-40, Math.min(40,msg.x)) : me.x + (Math.random()*8-4), z: Number.isFinite(msg.z) ? Math.max(-40, Math.min(40,msg.z)) : (Math.random()*8-4), owner: playerId };
      if (["house","farm","barracks","tower","dock"].includes(kind)) me.buildings.push(item);
      else me.units.push(item);
      broadcast(room, snapshot(room));
      broadcast(room, { type: "notice", text: me.name + (me.units.includes(item) ? " recruited " : " built ") + kind + "." });
    }
    if (msg.type === "chat") {
      const text = String(msg.text || "").replace(/[<>]/g,"").slice(0,120);
      if (text.trim()) { room.state.chat.push({ name: me.name, text }); broadcast(room, snapshot(room)); }
    }
    if (msg.type === "move") {
      const unit = me.units.find(u => u.id === msg.id);
      if (unit && Number.isFinite(msg.x) && Number.isFinite(msg.z)) {
        unit.x = Math.max(-45, Math.min(45,msg.x)); unit.z = Math.max(-45, Math.min(45,msg.z));
        broadcast(room, snapshot(room));
      }
    }
  });
  ws.on("close", () => {
    if (room && playerId) {
      const p = room.players.get(playerId);
      room.players.delete(playerId); delete room.state.players[playerId];
      if (p) { broadcast(room, snapshot(room)); broadcast(room, { type: "notice", text: p.name + " left the realm." }); }
      if (!room.players.size) rooms.delete(ws.roomCode);
    }
  });
});
setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of Object.values(room.state.players)) {
      const farms = p.buildings.filter(b => b.kind === "farm").length;
      const houses = p.buildings.filter(b => b.kind === "house").length;
      p.gold += 2 + houses; p.wood += 1; p.food += 1 + farms; p.stone += 1;
    }
    broadcast(room, snapshot(room));
  }
}, 10000);
const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => console.log("Red Feather RTS listening on " + port));
