const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const AUTOSAVE_INTERVAL_MS = 20_000;
const { Pool } = require("pg");
const pool = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="disable"?false:{rejectUnauthorized:false},max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:10000}) : null;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (process.env.RENDER && !process.env.DATA_DIR) console.warn("Render detected: set DATA_DIR=/var/data and attach a persistent disk at /var/data to keep saves across restarts.");
const SAVE_FILE = path.join(DATA_DIR, "red-feather-save.json");
let store = { accounts: {}, rooms: {} };
async function loadStore(){
 if(!pool)throw new Error("DATABASE_URL is required. Configure the Render PostgreSQL Internal Database URL.");
 await pool.query("CREATE TABLE IF NOT EXISTS red_feather_game_state(id SMALLINT PRIMARY KEY CHECK(id=1),data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 const r=await pool.query("SELECT data FROM red_feather_game_state WHERE id=1");
 if(r.rows.length&&r.rows[0].data){const v=r.rows[0].data;store={accounts:v.accounts&&typeof v.accounts==="object"?v.accounts:{},rooms:v.rooms&&typeof v.rooms==="object"?v.rooms:{}};}
 else{try{if(fs.existsSync(SAVE_FILE)){const v=JSON.parse(fs.readFileSync(SAVE_FILE,"utf8"));if(v&&typeof v==="object")store={accounts:v.accounts||{},rooms:v.rooms||{}};}}catch(e){console.warn("Old local save import failed:",e.message);}await pool.query("INSERT INTO red_feather_game_state(id,data) VALUES(1,$1::jsonb) ON CONFLICT(id) DO NOTHING",[JSON.stringify(store)]);}
 console.log("Game state loaded from PostgreSQL.");
}
async function saveStore(){try{for(const[code,room]of rooms)store.rooms[code]={state:room.state,playerAccounts:Object.fromEntries(room.playerAccounts),playerSlots:Object.fromEntries(room.playerSlots),parkedPlayers:room.parkedPlayers,nextId};if(!pool)throw new Error("DATABASE_URL is not configured.");await pool.query("INSERT INTO red_feather_game_state(id,data,updated_at) VALUES(1,$1::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()",[JSON.stringify(store)]);return true;}catch(e){console.error("PostgreSQL save failed:",e.message);return false;}}
function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}
function validUsername(value) {
  return /^[a-z0-9_]{3,16}$/.test(value);
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}
async function authenticate(mode, username, password) {
  if (!validUsername(username)) return { ok: false, error: "Username must be 3–16 letters, numbers, or underscores." };
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return { ok: false, error: "Password must be 8–128 characters." };
  }
  const existing = store.accounts[username];
  if (mode === "register") {
    if (existing) return { ok: false, error: "That username is already registered. Log in instead." };
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt).toString("hex");
    store.accounts[username] = { salt, hash };
    if (!(await saveStore())) {
      delete store.accounts[username];
      return { ok: false, error: "The server could not save your new account. Please try again later or contact the game owner." };
    }
    return { ok: true };
  }
  if (mode !== "login" || !existing) return { ok: false, error: "Username or password is incorrect." };
  const actual = hashPassword(password, existing.salt);
  const expected = Buffer.from(existing.hash, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, error: "Username or password is incorrect." };
  }
  return { ok: true };
}
// Load PostgreSQL before opening the server.
// One-time full game reset requested by the owner on 2026-11-19.
// Accounts are global, so this clears every saved account and realm once.
// Write the empty save directly here: the room manager is initialized below,
// so saveStore() must not be called until after that initialization.
const RESET_MARKER = path.join(DATA_DIR, "red-feather-full-reset-2026-11-19.done");
if (!pool && !fs.existsSync(RESET_MARKER)) {
  try {
    store = { accounts: {}, rooms: {} };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const resetTemp = SAVE_FILE + ".reset.tmp";
    fs.writeFileSync(resetTemp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(resetTemp, SAVE_FILE);
    fs.writeFileSync(RESET_MARKER, "Completed full realm reset.\\n", { flag: "wx", mode: 0o600 });
    console.log("Completed one-time full realm reset: all accounts and realm progress cleared.");
  } catch (error) {
    console.error("Full realm reset failed; server startup is being stopped to avoid an incomplete reset:", error.message);
    process.exit(1);
  }
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, game: "Red Feather RTS" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map();
let nextId = 1;
let debugResetInProgress = false;

const COSTS = {
  house:{wood:90}, farm:{wood:65}, lumberyard:{wood:80}, quarry:{wood:80,stone:25}, mine:{wood:110,stone:25}, market:{wood:100,stone:40}, barracks:{wood:120,stone:35}, archery:{wood:100,stone:25}, stable:{wood:150,stone:60}, siegeworkshop:{wood:180,stone:100}, tower:{wood:55,stone:70}, wall:{wood:100,stone:75},
  soldier:{gold:45,food:35}, menatarms:{gold:85,food:45}, archer:{gold:55,wood:15,food:30}, crossbow:{gold:75,wood:25,food:35}, knight:{gold:110,food:55}, lightcavalry:{gold:85,food:50},
  pikeman:{gold:65,wood:10,food:40}, siege:{gold:160,wood:90}, engineer:{gold:95,wood:35,food:30}
};
const UNIT_STATS = {builder:{hp:90,damage:0,range:0,speed:3.1,engageRange:0},
  soldier:{hp:100,damage:12,range:2.1,speed:3.3,engageRange:34,attackRate:1.05}, menatarms:{hp:155,damage:19,range:2.2,speed:2.8,engageRange:34,attackRate:1.15},
  archer:{hp:65,damage:10,range:25,speed:3.0,engageRange:42,attackRate:1.35}, crossbow:{hp:85,damage:17,range:21,speed:2.5,engageRange:40,attackRate:1.75},
  knight:{hp:180,damage:22,range:2.5,speed:4.6,engageRange:38,attackRate:1.05}, lightcavalry:{hp:115,damage:15,range:2.2,speed:5.4,engageRange:38,attackRate:1.0},
  pikeman:{hp:125,damage:17,range:2.3,speed:3.0,engageRange:34,attackRate:1.1},
  siege:{hp:220,damage:38,range:18,speed:1.5,engageRange:48,attackRate:2.5}, engineer:{hp:90,damage:7,range:1.8,speed:2.7,engageRange:28,attackRate:1.2}
};
const BUILDING_STATS = {castle:{hp:2400},house:{hp:260},farm:{hp:180},lumberyard:{hp:220},quarry:{hp:260},mine:{hp:360},market:{hp:300},barracks:{hp:500},archery:{hp:420},stable:{hp:480},siegeworkshop:{hp:520},tower:{hp:420,damage:18,range:11},wall:{hp:1600}};
const BUILDINGS = new Set(Object.keys(BUILDING_STATS));
const UNITS = new Set(Object.keys(UNIT_STATS));

function roomFor(code) {
  if (!rooms.has(code)) {
    const saved = store.rooms[code];
    if (saved && Number.isFinite(saved.nextId)) nextId = Math.max(nextId, saved.nextId);
    const restoredState = saved?.state && typeof saved.state === "object" ? saved.state : { players: {}, chat: [] };
    const parkedPlayers = saved?.parkedPlayers && typeof saved.parkedPlayers === "object" ? saved.parkedPlayers : {};
    // Every player in a disk save is offline after a server restart. Keep their
    // kingdoms in private storage rather than exposing them to the live map.
    for (const [id, player] of Object.entries(restoredState.players || {})) {
      if (player && !parkedPlayers[id]) parkedPlayers[id] = player;
    }
    restoredState.players = {};
    for(const player of Object.values(parkedPlayers)){if(!player)continue;player.buildings=(player.buildings||[]).filter(b=>b.kind!=="dock");player.units=(player.units||[]).filter(u=>u.kind!=="ship");for(const b of player.buildings){if(b.productionQueue)b.productionQueue=b.productionQueue.filter(job=>job.kind!=="ship");if(b.autoProduceKind==="ship")b.autoProduceKind=null;}}
    rooms.set(code, {
      players: new Map(),
      playerAccounts: new Map(Object.entries(saved?.playerAccounts || {})),
      // Spawn slots remain assigned even while a kingdom is parked offline.
      playerSlots: new Map(Object.entries(saved?.playerSlots || {})),
      parkedPlayers,
      state: restoredState
    });
  }
  return rooms.get(code);
}
function send(ws,data){if(ws.readyState===1)ws.send(JSON.stringify(data));}
function broadcast(room,data){
 const payload=JSON.stringify(data);
 for(const p of room.players.values()){
  const ws=p.ws;
  if(ws.readyState!==1)continue;
  if(data?.type==="state"&&ws.bufferedAmount>262144)continue;
  ws.send(payload);
 }
}
function snapshot(room){return{type:"state",players:room.state.players,chat:room.state.chat.slice(-30)};}
function notice(ws,text){send(ws,{type:"notice",text});}
function verifyDebugAdminPassword(candidate){
 const configured=process.env.DEBUG_ADMIN_PASSWORD;
 if(!configured||typeof candidate!=="string")return false;
 const expected=crypto.createHash("sha256").update(configured).digest();
 const actual=crypto.createHash("sha256").update(candidate).digest();
 return crypto.timingSafeEqual(expected,actual);
}
async function resetAllGameProgress(){
 store={accounts:{},rooms:{}};
 rooms.clear();
 nextId=1;
 const temp=SAVE_FILE+".admin-reset.tmp";
 fs.mkdirSync(DATA_DIR,{recursive:true});
 await pool.query("INSERT INTO red_feather_game_state(id,data,updated_at) VALUES(1,$1::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()",[JSON.stringify(store)]);
 for(const client of wss.clients){
  client.skipSaveOnClose=true;
  send(client,{type:"debug-admin",ok:true,resetting:true,message:"All accounts and realm progress have been reset. Reconnect and create a new account."});
  try{client.close(4001,"Game progress reset by DEBUG administrator");}catch{}
 }
 console.log("DEBUG administrator reset all accounts and realm progress.");
}
async function grantResourcesToPlayer(username,realmCode,amounts){
 const code=String(realmCode||"").toUpperCase();
 const liveRoom=rooms.get(code);
 const saved=store.rooms[code];
 if(!liveRoom&&!saved)return {ok:false,message:"That realm was not found."};
 const accountMap=liveRoom?liveRoom.playerAccounts:new Map(Object.entries(saved?.playerAccounts||{}));
 const playerEntry=[...accountMap.entries()].find(([,account])=>String(account).toLowerCase()===username);
 if(!playerEntry)return {ok:false,message:"That username does not have a kingdom in that realm."};
 const playerId=playerEntry[0];
 const player=liveRoom?(liveRoom.state.players?.[playerId]||liveRoom.parkedPlayers?.[playerId]):(saved?.state?.players?.[playerId]||saved?.parkedPlayers?.[playerId]);
 if(!player||typeof player!=="object")return {ok:false,message:"The player's saved kingdom could not be found in that realm."};
 const keys=["gold","wood","food","stone"];
 const before={};
 for(const key of keys){before[key]=Number.isFinite(player[key])?player[key]:0;player[key]=Math.min(Number.MAX_SAFE_INTEGER,before[key]+amounts[key]);}
 if(!(await saveStore())){for(const key of keys)player[key]=before[key];return {ok:false,message:"The server could not save the resource update."};}
 if(liveRoom&&liveRoom.state.players?.[playerId])broadcast(liveRoom,snapshot(liveRoom));
 return {ok:true,realm:code};
}
function distance(a,b){return Math.hypot(a.x-b.x,a.z-b.z);}
function distanceToWall(point,wall){
 const ax=wall.x,az=wall.z,bx=Number.isFinite(wall.x2)?wall.x2:wall.x,bz=Number.isFinite(wall.z2)?wall.z2:wall.z;
 const dx=bx-ax,dz=bz-az,len2=dx*dx+dz*dz;
 const t=len2?Math.max(0,Math.min(1,((point.x-ax)*dx+(point.z-az)*dz)/len2)):0;
 return Math.hypot(point.x-(ax+t*dx),point.z-(az+t*dz));
}
function wallSegmentsIntersect(a,b){
 const orient=(p,q,r)=>(q.x-p.x)*(r.z-p.z)-(q.z-p.z)*(r.x-p.x);
 const onSegment=(p,q,r)=>q.x>=Math.min(p.x,r.x)-1e-8&&q.x<=Math.max(p.x,r.x)+1e-8&&q.z>=Math.min(p.z,r.z)-1e-8&&q.z<=Math.max(p.z,r.z)+1e-8;
 const a1={x:a.x,z:a.z},a2={x:a.x2,z:a.z2},b1={x:b.x,z:b.z},b2={x:b.x2,z:b.z2};
 const o1=orient(a1,a2,b1),o2=orient(a1,a2,b2),o3=orient(b1,b2,a1),o4=orient(b1,b2,a2);
 if(((o1>0&&o2<0)||(o1<0&&o2>0))&&((o3>0&&o4<0)||(o3<0&&o4>0)))return true;
 return (Math.abs(o1)<1e-8&&onSegment(a1,b1,a2))||(Math.abs(o2)<1e-8&&onSegment(a1,b2,a2))||(Math.abs(o3)<1e-8&&onSegment(b1,a1,b2))||(Math.abs(o4)<1e-8&&onSegment(b1,a2,b2));
}
function wallToWallDistance(a,b){
 if(wallSegmentsIntersect(a,b))return 0;
 return Math.min(distanceToWall({x:a.x,z:a.z},b),distanceToWall({x:a.x2,z:a.z2},b),distanceToWall({x:b.x,z:b.z},a),distanceToWall({x:b.x2,z:b.z2},a));
}
function buildingWallClearance(kind){
 if(kind==="castle")return 10;
 if(kind==="tower")return 5;
 if(kind==="barracks"||kind==="siegeworkshop")return 5;
 if(kind==="wall")return 2.6;
 return 4;
}
function blockedByEnemyWall(unit,x,z,items){
 const candidate={x,z};
 return items.some(item=>item.category==="building"&&item.kind==="wall"&&item.owner!==unit.owner&&item.hp>0&&distanceToWall(candidate,item)<1.9);
}
function repositionParkedTroops(player){
 const castle=player.buildings.find(b=>b.kind==="castle");
 if(!castle)return;
 const placed=[];
 for(const unit of player.units){
  // Ships stay at their saved harbor/water positions; land troops regroup around the castle.
  if(unit.kind==="ship")continue;
  let destination=null;
  for(let radius=34;radius<=130&&!destination;radius+=12){
   for(let i=0;i<32;i++){
    const angle=(i/32)*Math.PI*2+(placed.length%2)*.08;
    const candidate={x:clamp(castle.x+Math.cos(angle)*radius,-2370,2370),z:clamp(castle.z+Math.sin(angle)*radius,-1770,1770)};
    if(["sea","river"].includes(terrainAt(candidate.x,candidate.z)))continue;
    if(player.buildings.some(b=>distance(candidate,b)<(b.kind==="castle"?30:b.kind==="wall"?10:14)))continue;
    if(placed.some(p=>distance(candidate,p)<9))continue;
    destination=candidate;break;
   }
  }
  if(!destination)destination={x:castle.x+36+(placed.length%6)*9,z:castle.z+36+Math.floor(placed.length/6)*9};
  unit.x=destination.x;unit.z=destination.z;unit.tx=destination.x;unit.tz=destination.z;
  unit.orderMode="move";delete unit.path;placed.push(destination);
 }
}
function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
// Deterministic terrain aligned with the client-side continental map.
function riverCenter(z){return Math.sin(z*.00105)*368+Math.sin(z*.00275)*96-140+Math.sin(z*.00048)*110;}
function islandCoastRadius(x,z){const a=Math.atan2(z,x);return .865+.035*Math.sin(a*3+.4)+.018*Math.sin(a*7-1.1);}
function terrainHeight(x,z){
 const broad=Math.sin(x*.0015+Math.sin(z*.001)*1.4)*Math.cos(z*.00175)*48;
 const rolling=Math.sin(x*.00475+z*.003)*Math.cos(z*.0045-x*.00225)*19+Math.sin(x*.0085-z*.00675)*8;
 const ridgeA=Math.max(0,1-Math.abs((x-1320)+Math.sin(z*.0015)*260)/740);
 const ridgeB=Math.max(0,1-Math.abs((x+1560)-Math.sin(z*.00125)*220)/620);
 const peaks=Math.pow(ridgeA,1.65)*(150+Math.max(0,Math.sin(z*.0045))*210)+Math.pow(ridgeB,1.7)*(115+Math.max(0,Math.cos(z*.004))*185);
 const foothills=Math.max(0,1-Math.abs(x+320)/1160)*Math.max(0,Math.sin(z*.00225+1))*62;
 const riverDist=Math.abs(x-riverCenter(z));
 const valley=-Math.max(0,1-riverDist/350)*35,bank=-Math.max(0,1-riverDist/155)*14;
 const d=Math.sqrt((x/2350)**2+(z/1720)**2),shore=clamp((islandCoastRadius(x,z)+.055-d)/.28,0,1);
 const landMask=shore*shore*(3-2*shore);
 return -82+145*landMask+(broad+rolling+peaks+foothills+valley+bank)*landMask;
}
function terrainAt(x,z){
 const riverDist=Math.abs(x-riverCenter(z));if(riverDist<68)return "river";
 const h=terrainHeight(x,z);if(h<0)return "sea";
 if(Math.abs(z)<34||Math.abs(x)<24)return "road";
 if(h>145)return "mountain";if(h>48)return "hill";
 if(Math.sin(x*.0035+z*.00225)>.28)return "forest";
 if(h<18)return "beach";return "plains";
}
function findNearbySea(x,z,maxDistance=260){
 for(let r=20;r<=maxDistance;r+=20)for(let i=0;i<32;i++){
  const a=i*Math.PI/16,px=x+Math.cos(a)*r,pz=z+Math.sin(a)*r;
  if(terrainAt(px,pz)==="sea")return{x:px,z:pz};
 }
 return null;
}
function findWaterRoute(start,target){
 const step=100,minX=-2400,minZ=-1800,cols=49,rows=37;
 const toCell=p=>({x:clamp(Math.round((p.x-minX)/step),0,cols-1),z:clamp(Math.round((p.z-minZ)/step),0,rows-1)});
 const point=(x,z)=>({x:minX+x*step,z:minZ+z*step});
 const nearest=(p)=>{const c=toCell(p);let best=null,dist=Infinity;for(let r=0;r<=5&&!best;r++)for(let dz=-r;dz<=r;dz++)for(let dx=-r;dx<=r;dx++){if(Math.max(Math.abs(dx),Math.abs(dz))!==r)continue;const x=c.x+dx,z=c.z+dz;if(x<0||x>=cols||z<0||z>=rows)continue;const q=point(x,z);if(terrainAt(q.x,q.z)!=="sea")continue;const d=(q.x-p.x)**2+(q.z-p.z)**2;if(d<dist){best={x,z};dist=d;}}return best;};
 const a=nearest(start),b=nearest(target);if(!a||!b)return null;
 const key=(x,z)=>x+","+z,open=[{...a,g:0,f:Math.hypot(a.x-b.x,a.z-b.z)}],came=new Map(),scores=new Map([[key(a.x,a.z),0]]),closed=new Set();
 const dirs=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
 let found=false,iterations=0;
 while(open.length&&iterations++<5000){
  let bi=0;for(let i=1;i<open.length;i++)if(open[i].f<open[bi].f)bi=i;
  const cur=open.splice(bi,1)[0],ck=key(cur.x,cur.z);if(closed.has(ck))continue;if(cur.x===b.x&&cur.z===b.z){found=true;break;}closed.add(ck);
  for(const [dx,dz] of dirs){const nx=cur.x+dx,nz=cur.z+dz;if(nx<0||nx>=cols||nz<0||nz>=rows)continue;const nk=key(nx,nz);if(closed.has(nk))continue;const q=point(nx,nz);if(terrainAt(q.x,q.z)!=="sea")continue;if(dx&&dz&&(terrainAt(...Object.values(point(cur.x+dx,cur.z)))!=="sea"||terrainAt(...Object.values(point(cur.x,cur.z+dz)))!=="sea"))continue;
   const ng=cur.g+(dx&&dz?1.4142:1);if(ng>=(scores.get(nk)??Infinity))continue;scores.set(nk,ng);came.set(nk,ck);open.push({x:nx,z:nz,g:ng,f:ng+Math.hypot(nx-b.x,nz-b.z)});
  }
 }
 if(!found)return null;
 const cells=[];let k=key(b.x,b.z);while(k!==key(a.x,a.z)){const [x,z]=k.split(",").map(Number);cells.push(point(x,z));k=came.get(k);if(!k)return null;}cells.reverse();cells.push({x:target.x,z:target.z});return cells;
}
function terrainAttack(unit,target){
 const t=terrainAt(target.x,target.z);let m=1;
 if(t==="forest"){if(unit.kind==="archer")m*=1.22;if(unit.kind==="knight")m*=.88;}
 if((t==="hill"||t==="mountain")&&(unit.kind==="archer"||unit.kind==="siege"))m*=1.2;
 if(t==="marsh"&&unit.kind==="knight")m*=.78;
 if(unit.kind==="pikeman"&&(target.kind==="knight"||target.kind==="lightcavalry"))m*=1.65;
 if(unit.kind==="archer"&&target.kind==="siege")m*=1.25;
 if(unit.kind==="knight"&&target.kind==="archer")m*=1.25;
 return m;
}
function structureDamage(unit,target){let m=1;if(target.category!=="building")return m;if(unit.kind==="siege")m=3.2;else if(unit.kind==="engineer")m=1.8;else if(unit.kind==="knight"||unit.kind==="menatarms")m=1.15;else if(unit.kind==="archer"||unit.kind==="crossbow")m=.45;else m=.7;if(target.kind==="tower"&&unit.kind!=="siege"&&unit.kind!=="engineer")m*=.8;return m;}
function terrainSpeed(unit){const t=terrainAt(unit.x,unit.z);return t==="road"?1.22:t==="river"?(unit.kind==="knight"?.62:.82):t==="marsh"?(unit.kind==="knight"?.58:.78):t==="forest"?.88:t==="mountain"?.68:t==="hill"?.86:1;}
function terrainCover(target){const t=terrainAt(target.x,target.z);return t==="forest"?.68:t==="mountain"?.72:t==="hill"?.84:t==="marsh"?.92:1;}
function allItems(room){const out=[];for(const p of Object.values(room.state.players)){for(const b of p.buildings)out.push({...b,owner:p.id,category:"building"});for(const u of p.units)out.push({...u,owner:p.id,category:"unit"});}return out;}

wss.on("connection",ws=>{
 let room,playerId;
 ws.on("message",async raw=>{
  let msg;try{msg=JSON.parse(raw.toString())}catch{return}
  if (msg.type === "auth") {
   if (room || ws.authUser) return;
   const username = normalizeUsername(msg.username);
   const result = await authenticate(msg.mode, username, msg.password);
   if (!result.ok) { send(ws, { type: "auth", ok: false, error: result.error }); return; }
   ws.authUser = username;
   send(ws, { type: "auth", ok: true, username });
   return;
  }
  if(msg.type==="debug-admin-auth"){
   if(ws.roomCode!=="DEBUG"){send(ws,{type:"debug-admin",ok:false,message:"The admin panel is only available in the DEBUG realm."});return;}
   if(!process.env.DEBUG_ADMIN_PASSWORD){send(ws,{type:"debug-admin",ok:false,message:"DEBUG_ADMIN_PASSWORD is not configured on the server."});return;}
   ws.debugAdminAuthed=verifyDebugAdminPassword(msg.password);
   send(ws,{type:"debug-admin",ok:ws.debugAdminAuthed,message:ws.debugAdminAuthed?"Admin access granted.":"Incorrect admin password."});
   return;
  }
  if(msg.type==="debug-admin-grant-resources"){
   if(ws.roomCode!=="DEBUG"||!ws.debugAdminAuthed){send(ws,{type:"debug-admin-resources",ok:false,message:"Admin authentication required."});return;}
   const username=String(msg.username||"").trim().toLowerCase();
   const realm=String(msg.realm||"").trim().toUpperCase();
   const resources=msg.resources;
   const keys=["gold","wood","food","stone"];
   if(!/^[a-z0-9_]{3,16}$/.test(username)||!/^[A-Z0-9_-]{1,12}$/.test(realm)||!resources||typeof resources!=="object"||Array.isArray(resources)||keys.some(key=>!Number.isSafeInteger(resources[key])||resources[key]<0||resources[key]>1000000000)||!keys.some(key=>resources[key]>0)){
    send(ws,{type:"debug-admin-resources",ok:false,message:"Check the username, realm code, and resource amounts."});return;
   }
   try{
    const result=await grantResourcesToPlayer(username,realm,resources);
    send(ws,{type:"debug-admin-resources",ok:result.ok,message:result.ok?"Resources added to "+username+" in realm "+realm+".":result.message});
   }catch(error){console.error("DEBUG resource grant failed:",error);send(ws,{type:"debug-admin-resources",ok:false,message:"Resource grant failed. Check server logs."});}
   return;
  }
  if(msg.type==="debug-admin-reset"){
   if(ws.roomCode!=="DEBUG"||!ws.debugAdminAuthed){send(ws,{type:"debug-admin",ok:false,message:"Admin authentication required."});return;}
   if(debugResetInProgress)return;
   debugResetInProgress=true;
   try{await resetAllGameProgress();}catch(error){console.error("DEBUG reset failed:",error);send(ws,{type:"debug-admin",ok:false,message:"Reset failed. Check server logs."});}
   finally{debugResetInProgress=false;}
   return;
  }
  if(msg.type==="join"){
   if(room)return;
   if(!ws.authUser){notice(ws,"Create an account or log in before joining.");return;}
   const code=String(msg.room||"KINGDOM").toUpperCase().replace(/[^A-Z0-9_-]/g,"").slice(0,12)||"KINGDOM";
   const name=String(msg.name||"Lord").replace(/[^a-z0-9 _-]/gi,"").trim().slice(0,16)||"Lord";
   room=roomFor(code);
   if(room.players.size>=8){notice(ws,"This realm is full (8 players).");ws.close();return;}
   const savedEntry=[...room.playerAccounts.entries()].find(([,user])=>user===ws.authUser);
   if(savedEntry && room.players.has(savedEntry[0])){notice(ws,"This account is already playing in that realm.");ws.close();return;}
   const spawnPoints=[[-1300,-650],[-650,-900],[650,-900],[1300,-650],[1300,650],[650,900],[-650,900],[-1300,650]];
   const spawnColors=["#b84a3a","#4778b8","#6d9b58","#a17ac2","#c08a36","#4b9b9b","#9b5478","#858c4b"];
   // Migrate older saves by assigning existing accounts their original order-based slots.
   for (const [id] of room.playerAccounts) {
    if (!room.playerSlots.has(id)) {
     const used=new Set([...room.playerSlots.values()].map(Number));
     const legacySlot=[...room.playerAccounts.keys()].indexOf(id);
     if (legacySlot>=0 && legacySlot<spawnPoints.length && !used.has(legacySlot)) room.playerSlots.set(id,String(legacySlot));
    }
   }
   if(savedEntry){
    playerId=savedEntry[0];
   }else{
    const usedSlots=new Set([...room.playerSlots.values()].map(Number));
    const slot=spawnPoints.findIndex((_,index)=>!usedSlots.has(index));
    if(slot<0){notice(ws,"This realm has no unclaimed kingdom spawn positions (8 maximum).");ws.close();return;}
    playerId="p"+nextId++;
    room.playerSlots.set(playerId,String(slot));
    const color=spawnColors[slot];
    const [spawnX,spawnZ]=spawnPoints[slot];
    const castle={id:"i"+nextId++,kind:"castle",x:spawnX,z:spawnZ,owner:playerId,...BUILDING_STATS.castle};
    const builder={id:"i"+nextId++,kind:"builder",x:spawnX+9,z:spawnZ+8,owner:playerId,...UNIT_STATS.builder,maxHp:UNIT_STATS.builder.hp,tx:spawnX+9,tz:spawnZ+8};
    room.state.players[playerId]={id:playerId,name,color,gold:300,wood:260,food:220,stone:140,score:0,buildings:[castle],units:[builder],x:spawnX,z:spawnZ,defeated:false};
    room.playerAccounts.set(playerId,ws.authUser);
   }
   if (!room.playerSlots.has(playerId)) {
    const usedSlots=new Set([...room.playerSlots.values()].map(Number));
    const slot=spawnPoints.findIndex((_,index)=>!usedSlots.has(index));
    if(slot<0){notice(ws,"No free preset kingdom position is available for this account.");ws.close();return;}
    room.playerSlots.set(playerId,String(slot));
   }
   if (!room.state.players[playerId] && room.parkedPlayers[playerId]) {
    room.state.players[playerId] = room.parkedPlayers[playerId];
    delete room.parkedPlayers[playerId];
    repositionParkedTroops(room.state.players[playerId]);
   }
   const savedPlayer=room.state.players[playerId];
   if(!savedPlayer){notice(ws,"Saved kingdom data is missing. Please contact the game owner.");ws.close();return;}
   savedPlayer.name=name || savedPlayer.name;
   room.players.set(playerId,{ws,name:savedPlayer.name,color:savedPlayer.color,username:ws.authUser});
   ws.roomCode=code;ws.playerId=playerId;
   send(ws,{type:"welcome",id:playerId,room:code,color:savedPlayer.color,name:savedPlayer.name});
   await saveStore();
   broadcast(room,snapshot(room));broadcast(room,{type:"notice",text:savedPlayer.name+" joined the realm."});return;
  }
  if(!room||!playerId)return;
  const me=room.state.players[playerId];if(!me)return;
  if(me.defeated){notice(ws,"Your castle has fallen. You have been defeated.");return;}
  if(msg.type==="remove-building"){
   const buildingId=String(msg.buildingId||"");
   const index=me.buildings.findIndex(b=>b.id===buildingId);
   if(index<0){notice(ws,"That building is not in your kingdom.");return;}
   const building=me.buildings[index];
   if(building.kind==="castle"){notice(ws,"Your castle is the heart of your kingdom and cannot be demolished.");return;}
   me.buildings.splice(index,1);
   if(selectedBuilding?.id===buildingId)selectedBuilding=null;
   broadcast(room,snapshot(room));
   notice(ws,building.kind+" demolished. Resources are not refunded.");
   await saveStore();
   return;
  }
  if(msg.type==="production-auto"){
   const buildingId=String(msg.buildingId||""),facility=me.buildings.find(b=>b.id===buildingId);
   if(!facility||!["barracks","archery","stable","siegeworkshop"].includes(facility.kind)){notice(ws,"Select one of your troop-production buildings.");return;}
   const kind=String(msg.kind||"");
   if(!kind){facility.autoProduceKind=null;broadcast(room,snapshot(room));notice(ws,"Automatic production stopped.");return;}
   const required=(kind==="archer"||kind==="crossbow")?"archery":(kind==="knight"||kind==="lightcavalry")?"stable":(kind==="siege"||kind==="engineer")?"siegeworkshop":["soldier","menatarms","pikeman"].includes(kind)?"barracks":"";
   if(!required||facility.kind!==required||!UNIT_STATS[kind]||!COSTS[kind]){notice(ws,"That troop cannot be produced in this building.");return;}
   if(facility.underConstruction){notice(ws,"Finish building this facility before starting automatic production.");return;}
   facility.autoProduceKind=kind;broadcast(room,snapshot(room));notice(ws,"Automatic production enabled for "+kind+".");return;
  }
  if(msg.type==="action"){
   const kind=String(msg.kind||""),cost=COSTS[kind];if(!cost)return;
   const supply=8+me.buildings.filter(b=>b.kind==="house").length*4;
   const queuedUnits=me.buildings.reduce((n,b)=>n+(b.productionQueue?.length||0),0);
   if(UNITS.has(kind)&&kind!=="builder"&&me.units.filter(u=>u.kind!=="builder").length+queuedUnits>=supply){notice(ws,"Army supply is full. Build houses to support more units.");return;}
   if(UNITS.has(kind)){const facility=me.buildings.find(b=>b.id===String(msg.buildingId));const required=(kind==="archer"||kind==="crossbow")?"archery":(kind==="knight"||kind==="lightcavalry")?"stable":(kind==="siege"||kind==="engineer")?"siegeworkshop":"barracks";if(!facility||facility.kind!==required){const labels={archery:"Archery Range",stable:"Stable",siegeworkshop:"Siege Workshop",barracks:"Barracks"};notice(ws,"Select your "+labels[required]+" to recruit this unit.");return;}}
   if(Object.entries(cost).some(([k,v])=>me[k]<v)){notice(ws,"Not enough resources.");return;}
   const isBuilding=BUILDINGS.has(kind);
   const px=Number(msg.x),pz=Number(msg.z);
   const item={id:"i"+nextId++,kind,x:isBuilding?clamp(Number.isFinite(px)?px:me.x,-2370,2370):clamp(me.x+clamp(Number.isFinite(px)?px:0,-5,5),-2370,2370),z:isBuilding?clamp(Number.isFinite(pz)?pz:0,-1770,1770):clamp(Number.isFinite(pz)?pz:0,-5,5),owner:playerId};
   if(isBuilding){
    const nearEnemyCastle=allItems(room).some(other=>other.kind==="castle"&&other.owner!==playerId&&distance(item,other)<175);
    if(nearEnemyCastle){notice(ws,"That blueprint is too close to an enemy castle. Choose a safer location.");return;}
    if(kind==="wall"){
     const x2=Number(msg.x2),z2=Number(msg.z2);
     if(!Number.isFinite(x2)||!Number.isFinite(z2)){notice(ws,"Choose both ends of the wall.");return;}
     item.x2=clamp(x2,-2370,2370);item.z2=clamp(z2,-1770,1770);
     const length=distance(item,{x:item.x2,z:item.z2});
     if(length<6||length>300){notice(ws,"City wall sections must be between 6 and 300 metres.");return;}
     const midpoint={x:(item.x+item.x2)/2,z:(item.z+item.z2)/2};
     const nearCastle=allItems(room).some(other=>other.kind==="castle"&&other.owner!==playerId&&distance(midpoint,other)<175);
     if(nearCastle){notice(ws,"That wall is too close to an enemy castle.");return;}
     // Only actual player buildings obstruct walls. Decorative grass, rocks and trees
     // are client scenery, and troops must never make a wall placement fail.
     const crowded=allItems(room).some(other=>{
      if(other.category!=="building"||other.hp<=0)return false;
      if(other.kind==="wall"){const shared=[[item.x,item.z,other.x,other.z],[item.x,item.z,other.x2,other.z2],[item.x2,item.z2,other.x,other.z],[item.x2,item.z2,other.x2,other.z2]].some(([ax,az,bx,bz])=>Math.hypot(ax-bx,az-bz)<1.5);return !shared&&wallToWallDistance(item,other)<5.2;}
      return distanceToWall(other,item)<buildingWallClearance(other.kind)+2.2;
     });
     if(crowded){notice(ws,"That wall is obstructed by a nearby building or wall. Choose another line.");return;}
    }else{
     const radius=kind==="barracks"?4.2:3.2;
     const crowded=allItems(room).some(other=>distance(item,other)<radius+(other.category==="building"?3:1.2));
     if(crowded){notice(ws,"That spot is occupied. Choose another location.");return;}
    }
    for(const[k,v]of Object.entries(cost))me[k]-=v;
    const builder=me.units.find(u=>u.kind==="builder"&&!u.assignedBuildingId);
    if(!builder){const castle=me.buildings.find(b=>b.kind==="castle");const worker={id:"i"+nextId++,kind:"builder",x:castle?.x||me.x,z:(castle?.z||0)+8,owner:playerId,...UNIT_STATS.builder,maxHp:UNIT_STATS.builder.hp,tx:castle?.x||me.x,tz:(castle?.z||0)+8};me.units.push(worker);}
    const worker=me.units.find(u=>u.kind==="builder"&&!u.assignedBuildingId);
    item.underConstruction=true;item.progress=0;item.maxHp=BUILDING_STATS[kind].hp;item.hp=BUILDING_STATS[kind].hp*.12;item.builderId=worker.id;
    worker.assignedBuildingId=item.id;worker.tx=item.x;worker.tz=item.z;worker.orderMode="build";me.buildings.push(item);
   }else{
    if(kind==="builder"){notice(ws,"Builders are supplied by your castle.");return;}
    if(Object.entries(cost).some(([k,v])=>me[k]<v)){notice(ws,"Not enough resources.");return;}
    const facility=me.buildings.find(b=>b.id===String(msg.buildingId));
    if(!facility||!Array.isArray(facility.productionQueue)){facility.productionQueue=[];}
    for(const[k,v]of Object.entries(cost))me[k]-=v;
    facility.productionQueue.push({kind,remaining:10});
    broadcast(room,snapshot(room));notice(ws,kind+" added to "+facility.kind+" production queue.");return;
   }
   broadcast(room,snapshot(room));broadcast(room,{type:"notice",text:me.name+(isBuilding?" built ":" recruited ")+kind+"."});return;
  }
  if(msg.type==="chat"){
   const text=String(msg.text||"").replace(/[<>]/g,"").trim().slice(0,120);
   if(text){room.state.chat.push({name:me.name,text});broadcast(room,snapshot(room));}return;
  }
  if(msg.type==="order"){
   if(!Array.isArray(msg.ids)||!Number.isFinite(msg.x)||!Number.isFinite(msg.z))return;
   const ids=[...new Set(msg.ids.map(String))].slice(0,80),selected=ids.map(id=>me.units.find(u=>u.id===id)).filter(Boolean);
   if(selected.some(u=>u.kind==="ship")&&terrainAt(msg.x,msg.z)!=="sea"){notice(ws,"Ships can only sail in open water. Choose a blue-water destination.");return;}
   if(selected.some(u=>u.kind!=="ship")&&selected.some(u=>u.kind==="ship")){notice(ws,"Select ships separately from land troops.");return;}
   const mode=msg.mode==="attack"?"attack":msg.mode==="zone"?"zone":"move",formation=["line","column","wedge","box"].includes(msg.formation)?msg.formation:"box",spacing=6.4;
   selected.forEach((unit,i)=>{if(mode==="zone"){unit.attackZone={x:clamp(msg.x,-2390,2390),z:clamp(msg.z,-1790,1790),radius:clamp(Number(msg.radius)||120,30,240)};unit.tx=unit.x;unit.tz=unit.z;unit.orderMode="zone";delete unit.path;return;}delete unit.attackZone;let ox=0,oz=0;if(formation==="line"){ox=(i-(selected.length-1)/2)*spacing;}else if(formation==="column"){oz=(i-(selected.length-1)/2)*spacing;}else if(formation==="wedge"){const row=Math.floor((Math.sqrt(8*i+1)-1)/2),col=i-row*(row+1)/2;ox=(col-row/2)*spacing;oz=row*spacing*.78;}else{const cols=Math.max(1,Math.ceil(Math.sqrt(selected.length))),rows=Math.ceil(selected.length/cols);ox=(i%cols-(cols-1)/2)*spacing;oz=(Math.floor(i/cols)-(rows-1)/2)*spacing;}
    const tx=clamp(msg.x+ox,-2390,2390),tz=clamp(msg.z+oz,-1790,1790);
    if(unit.kind==="ship"){const route=findWaterRoute(unit, {x:tx,z:tz});if(!route){notice(ws,"No clear water route to that destination. Choose a closer point at sea.");return;}unit.path=route;}else delete unit.path;
    unit.tx=tx;unit.tz=tz;unit.orderMode=mode;});
   broadcast(room,snapshot(room));return;
  }
  if(msg.type==="move"){
   const unit=me.units.find(u=>u.id===msg.id);
   if(unit&&Number.isFinite(msg.x)&&Number.isFinite(msg.z)){delete unit.attackZone;unit.orderMode="move";if(unit.kind==="ship"){if(terrainAt(msg.x,msg.z)!=="sea"){notice(ws,"Ships can only sail in open water.");return;}const route=findWaterRoute(unit,{x:msg.x,z:msg.z});if(!route){notice(ws,"No clear water route to that destination.");return;}unit.path=route;}unit.tx=clamp(msg.x,-2390,2390);unit.tz=clamp(msg.z,-1790,1790);unit.orderMode="move";return;}
  }
 });
 ws.on("close",async()=>{
  if(!ws.skipSaveOnClose&&room&&playerId){const p=room.players.get(playerId);room.players.delete(playerId);
   const savedPlayer=room.state.players[playerId];
   if(savedPlayer){
    // Park the complete kingdom off the active map. Its buildings cannot block
    // placements or be attacked while its owner is away.
    room.parkedPlayers[playerId]=savedPlayer;
    delete room.state.players[playerId];
   }
   if(p){broadcast(room,snapshot(room));broadcast(room,{type:"notice",text:p.name+" left the realm. Their kingdom has been safely stored."});}
   await saveStore();
  }
 });
});

let last=Date.now(),lastSnapshotAt=0;
setInterval(()=>{
 const now=Date.now(),dt=Math.min(.25,(now-last)/1000);last=now;
 for(const room of rooms.values()){
  const players=Object.values(room.state.players);
  for(const p of players){
   if(p.defeated)continue;
   let farms=0,lumberyards=0,quarries=0,mines=0,markets=0;
   for(const b of p.buildings){
    if(b.kind==="farm")farms++;
    else if(b.kind==="lumberyard")lumberyards++;
    else if(b.kind==="quarry")quarries++;
    else if(b.kind==="mine")mines++;
    else if(b.kind==="market")markets++;
   }
   // No free passive income: production comes from the matching economy buildings.
   p.food+=farms*.55;p.wood+=lumberyards*.45;p.stone+=quarries*.3+mines*.75;p.gold+=markets*.3;
   if(p.units.length)p.food=Math.max(0,p.food-p.units.length*.018);
  }
  for(const p of players)if(!p.defeated){for(const blueprint of p.buildings.filter(b=>b.underConstruction)){let worker=p.units.find(u=>u.kind==="builder"&&u.id===blueprint.builderId);if(!worker){worker=p.units.find(u=>u.kind==="builder"&&!u.assignedBuildingId);if(!worker){const castle=p.buildings.find(b=>b.kind==="castle");if(castle){worker={id:"i"+nextId++,kind:"builder",x:castle.x+9,z:castle.z+8,owner:p.id,...UNIT_STATS.builder,maxHp:UNIT_STATS.builder.hp,tx:castle.x+9,tz:castle.z+8};p.units.push(worker);}}if(worker){worker.assignedBuildingId=blueprint.id;blueprint.builderId=worker.id;worker.tx=blueprint.x;worker.tz=blueprint.z;}}}}
  const items=allItems(room);
  for(const p of players)if(!p.defeated)for(const u of p.units){
   const targetsInRange=[];
   let target=null,targetDistance=Infinity;
   if(u.orderMode!=="move"&&u.kind!=="builder"&&u.damage>0){
    for(const enemy of items){
     if(enemy.owner===p.id||enemy.hp<=0||(enemy.category!=="unit"&&enemy.category!=="building"))continue;
     if(u.attackZone&&Math.hypot(enemy.x-u.attackZone.x,enemy.z-u.attackZone.z)>u.attackZone.radius)continue;
     const dist=enemy.kind==="wall"?distanceToWall(u,enemy):distance(u,enemy);
     if(dist<=u.range+(enemy.kind==="wall"?1.9:0)){
      targetsInRange.push({item:enemy,dist});
      if(dist<targetDistance){targetDistance=dist;target=enemy;}
     }
    }
   }
   const manualDistance=distance(u,{x:Number.isFinite(u.tx)?u.tx:u.x,z:Number.isFinite(u.tz)?u.tz:u.z});
   const hasManualMove=manualDistance>1.2;
   let moveTarget=u.kind==="ship"&&u.path?.length?u.path[0]:{x:u.tx,z:u.tz};
   if(!hasManualMove&&!targetsInRange.length&&u.attackZone){
    let nearestUnit=null,nearestUnitDistance=Infinity,nearestBuilding=null,nearestBuildingDistance=Infinity;
    for(const enemy of items){
     if(enemy.owner===p.id||enemy.hp<=0||Math.hypot(enemy.x-u.attackZone.x,enemy.z-u.attackZone.z)>u.attackZone.radius)continue;
     const d=distance(u,enemy);
     if(enemy.category==="unit"&&d<nearestUnitDistance){nearestUnit=enemy;nearestUnitDistance=d;}
     else if(enemy.category==="building"&&d<nearestBuildingDistance){nearestBuilding=enemy;nearestBuildingDistance=d;}
    }
    const zoneTarget=nearestUnit||nearestBuilding;
    if(zoneTarget)moveTarget={x:zoneTarget.x,z:zoneTarget.z};else moveTarget={x:u.x,z:u.z};
   }
   const dx=moveTarget.x-u.x,dz=moveTarget.z-u.z,d=Math.hypot(dx,dz);
   const approaching=!hasManualMove&&!targetsInRange.length&&u.attackZone&&Math.hypot(moveTarget.x-u.x,moveTarget.z-u.z)>.15;
   if(d>.15&&(hasManualMove||approaching)){
    const step=Math.min(d,u.speed*terrainSpeed(u)*dt);
    if(u.kind==="ship"&&d<=step+.01){u.x=moveTarget.x;u.z=moveTarget.z;if(u.path?.length)u.path.shift();}
    else{const nx=u.x+dx/d*step,nz=u.z+dz/d*step;if((u.kind!=="ship"||terrainAt(nx,nz)==="sea")&&!blockedByEnemyWall(u,nx,nz,items)){u.x=nx;u.z=nz;}}
   }
   if(u.kind==="builder"&&u.assignedBuildingId&&d<5){const blueprint=p.buildings.find(b=>b.id===u.assignedBuildingId);if(blueprint&&blueprint.underConstruction){blueprint.progress=Math.min(1,(blueprint.progress||0)+dt/10);blueprint.hp=blueprint.maxHp*(.12+.88*blueprint.progress);if(blueprint.progress>=1){blueprint.underConstruction=false;delete blueprint.builderId;delete u.assignedBuildingId;u.tx=u.x;u.tz=u.z;u.orderMode="move";}}}
   if(target&&u.kind!=="builder"&&u.damage>0){
    u.attackCooldown=Math.max(0,(u.attackCooldown||0)-dt);
    if(u.attackCooldown<=0){
     for(const entry of targetsInRange){
      const enemy=entry.item,owner=room.state.players[enemy.owner],list=enemy.category==="unit"?owner?.units:owner?.buildings,actual=list?.find(x=>x.id===enemy.id);
      if(actual)actual.hp-=u.damage*terrainAttack(u,actual)*structureDamage(u,enemy)*terrainCover(actual);
     }
     u.attackCooldown=u.attackRate||1.2;u.attackPulse=(u.attackPulse||0)+1;u.attackTargetId=target.id;
    }
   }else if(!target)u.attackCooldown=Math.max(0,(u.attackCooldown||0)-dt);
  }
  for(const p of players)if(!p.defeated)for(const facility of p.buildings){
   if(!Array.isArray(facility.productionQueue))facility.productionQueue=[];
   if(!facility.productionQueue.length&&facility.autoProduceKind&&!facility.underConstruction){
    const kind=facility.autoProduceKind,cost=COSTS[kind],supply=8+p.buildings.filter(b=>b.kind==="house").length*4,queued=p.buildings.reduce((n,b)=>n+(b.productionQueue?.length||0),0);
    if(!cost||!UNIT_STATS[kind]){facility.autoProduceKind=null;}
    else if(p.units.filter(u=>u.kind!=="builder").length+queued>=supply){facility.autoProduceKind=null;notice(room.players.get(p.id)?.ws,"Auto production stopped: army supply is full. Build more houses.");}
    else if(Object.entries(cost).some(([resource,amount])=>(p[resource]||0)<amount)){facility.autoProduceKind=null;notice(room.players.get(p.id)?.ws,"Auto production stopped: not enough resources.");}
    else{for(const[resource,amount]of Object.entries(cost))p[resource]-=amount;facility.productionQueue.push({kind,remaining:10});}
   }
   if(!facility.productionQueue.length)continue;
   const job=facility.productionQueue[0];job.remaining-=dt;
   if(job.remaining<=0){const kind=job.kind,stats=UNIT_STATS[kind];if(stats){let sx=facility.x+7,sz=facility.z+5;if(kind==="ship"){const water=findNearbySea(facility.x,facility.z,300);if(!water){facility.productionQueue.shift();facility.autoProduceKind=null;notice(room.players.get(p.id)?.ws,"This harbor has no nearby water. Automatic production stopped.");continue;}sx=water.x;sz=water.z;}const unit={id:"i"+nextId++,kind,x:sx,z:sz,owner:p.id,...stats,maxHp:stats.hp,tx:sx,tz:sz,attackCooldown:0,attackPulse:0,};p.units.push(unit);}facility.productionQueue.shift();}
  }
  for(const p of players)if(!p.defeated)for(const tower of p.buildings.filter(b=>b.kind==="tower")){
   let target=null,best=Infinity;for(const enemy of items){if(enemy.owner===p.id||enemy.category!=="unit"||enemy.hp<=0)continue;const d=distance(tower,enemy);if(d<=tower.range&&d<best){best=d;target=enemy;}}
   if(target){const owner=room.state.players[target.owner];const unit=owner?.units.find(u=>u.id===target.id);if(unit)unit.hp-=tower.damage*dt*(terrainAt(unit.x,unit.z)==="forest"?.82:1);}
  }
  const objectives=[{x:-1050,z:0},{x:0,z:-1050},{x:1050,z:0}];
  for(const o of objectives){
   let leader=null,leaderCount=0,runnerUpCount=0;
   for(const p of players){
    let count=0;
    for(const u of p.units)if(distance(u,o)<7)count++;
    if(count>leaderCount){runnerUpCount=leaderCount;leader=p;leaderCount=count;}
    else if(count>runnerUpCount)runnerUpCount=count;
   }
   if(leader&&leaderCount>runnerUpCount){leader.score=(leader.score||0)+dt*leaderCount*.35;leader.gold+=dt*.35;}
  }
  for(const p of players){p.units=p.units.filter(u=>u.hp>0);p.buildings=p.buildings.filter(b=>b.hp>0);const castle=p.buildings.find(b=>b.kind==="castle");if(!castle&&!p.defeated){p.defeated=true;p.units=[];p.buildings=[];broadcast(room,{type:"notice",text:p.name+" has been defeated — their castle has fallen."});}}
  if(now-lastSnapshotAt>=500){broadcast(room,snapshot(room));lastSnapshotAt=now;}
 }
},250);
const saveTimer=setInterval(()=>{saveStore().catch(e=>console.error("Autosave failed:",e.message));},AUTOSAVE_INTERVAL_MS);
const port=process.env.PORT||3000;
async function startServer(){try{await loadStore();server.listen(port,"0.0.0.0",()=>console.log("Red Feather RTS listening on "+port+"; PostgreSQL autosave every 20 seconds."));}catch(e){console.error("PostgreSQL startup failed:",e.message);process.exit(1);}}
startServer();
async function shutdown() {
  clearInterval(saveTimer);
  await saveStore();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
