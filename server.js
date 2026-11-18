const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, game: "Red Feather RTS" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map();
let nextId = 1;

const COSTS = {
  house:{wood:90}, farm:{wood:65}, barracks:{wood:120,stone:35}, tower:{wood:55,stone:70}, dock:{wood:150,stone:40},
  soldier:{gold:45,food:35}, archer:{gold:55,wood:15,food:30}, knight:{gold:110,food:55},
  pikeman:{gold:65,wood:10,food:40}, siege:{gold:160,wood:90}, ship:{gold:130,wood:120,food:25}
};
const UNIT_STATS = {
  soldier:{hp:100,damage:12,range:2.1,speed:3.3},
  archer:{hp:65,damage:9,range:8,speed:3.0},
  knight:{hp:180,damage:22,range:2.5,speed:4.6},
  pikeman:{hp:125,damage:17,range:2.3,speed:3.0},
  siege:{hp:220,damage:38,range:10,speed:1.5},
  ship:{hp:260,damage:25,range:9,speed:2.4}
};
const BUILDING_STATS = {house:{hp:260},farm:{hp:180},barracks:{hp:500},tower:{hp:420,damage:18,range:11},dock:{hp:450}};
const BUILDINGS = new Set(Object.keys(BUILDING_STATS));
const UNITS = new Set(Object.keys(UNIT_STATS));

function roomFor(code) {
  if (!rooms.has(code)) rooms.set(code,{players:new Map(),state:{players:{},chat:[]}});
  return rooms.get(code);
}
function send(ws,data){if(ws.readyState===1)ws.send(JSON.stringify(data));}
function broadcast(room,data){for(const p of room.players.values())send(p.ws,data);}
function snapshot(room){return{type:"state",players:room.state.players,chat:room.state.chat.slice(-30)};}
function notice(ws,text){send(ws,{type:"notice",text});}
function distance(a,b){return Math.hypot(a.x-b.x,a.z-b.z);}
function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
// Deterministic tactical terrain shared by all players.
function terrainAt(x,z){
 if(Math.abs(z)<2.2||Math.abs(x)<1.8)return "road";
 const a=Math.sin((x+18)*.19)*Math.cos((z-7)*.17),b=Math.cos((x-9)*.13+z*.11);
 if(a>.56)return "forest";if(b>.72)return "hill";if(a<-.58&&Math.sin(z*.22)>.1)return "marsh";return "plains";
}
function terrainAttack(unit,target){
 const t=terrainAt(target.x,target.z);let m=1;
 if(t==="forest"){if(unit.kind==="archer")m*=1.22;if(unit.kind==="knight")m*=.88;}
 if(t==="hill"&&(unit.kind==="archer"||unit.kind==="siege"))m*=1.2;
 if(t==="marsh"&&unit.kind==="knight")m*=.78;
 if(unit.kind==="pikeman"&&target.kind==="knight")m*=1.65;
 if(unit.kind==="archer"&&target.kind==="siege")m*=1.25;
 if(unit.kind==="knight"&&target.kind==="archer")m*=1.25;
 return m;
}
function terrainSpeed(unit){const t=terrainAt(unit.x,unit.z);return t==="road"?1.22:t==="marsh"?(unit.kind==="knight"?.58:.78):t==="forest"?.88:1;}
function allItems(room){const out=[];for(const p of Object.values(room.state.players)){for(const b of p.buildings)out.push({...b,owner:p.id,category:"building"});for(const u of p.units)out.push({...u,owner:p.id,category:"unit"});}return out;}

wss.on("connection",ws=>{
 let room,playerId;
 ws.on("message",raw=>{
  let msg;try{msg=JSON.parse(raw.toString())}catch{return}
  if(msg.type==="join"){
   if(room)return;
   const code=String(msg.room||"KINGDOM").toUpperCase().replace(/[^A-Z0-9_-]/g,"").slice(0,12)||"KINGDOM";
   const name=String(msg.name||"Lord").replace(/[^a-z0-9 _-]/gi,"").trim().slice(0,16)||"Lord";
   room=roomFor(code);
   if(room.players.size>=8){notice(ws,"This realm is full (8 players).");ws.close();return;}
   playerId="p"+nextId++;
   const color=["#b84a3a","#4778b8","#6d9b58","#a17ac2","#c08a36","#4b9b9b","#9b5478","#858c4b"][room.players.size];
   const spawnX=(room.players.size-3.5)*12;
   room.players.set(playerId,{ws,name,color});
   room.state.players[playerId]={id:playerId,name,color,gold:300,wood:260,food:220,stone:140,score:0,buildings:[],units:[],x:spawnX};
   ws.roomCode=code;ws.playerId=playerId;
   send(ws,{type:"welcome",id:playerId,room:code,color});
   broadcast(room,snapshot(room));broadcast(room,{type:"notice",text:name+" joined the realm."});return;
  }
  if(!room||!playerId)return;
  const me=room.state.players[playerId];if(!me)return;
  if(msg.type==="action"){
   const kind=String(msg.kind||""),cost=COSTS[kind];if(!cost)return;
   const supply=8+me.buildings.filter(b=>b.kind==="house").length*4;
   if(UNITS.has(kind)&&me.units.length>=supply){notice(ws,"Army supply is full. Build houses to support more units.");return;}
   if(UNITS.has(kind)&&!me.buildings.some(b=>b.kind==="barracks")&&!(kind==="ship"&&me.buildings.some(b=>b.kind==="dock"))){notice(ws,"Build a barracks before recruiting an army.");return;}
   if(kind==="ship"&&!me.buildings.some(b=>b.kind==="dock")){notice(ws,"Build a harbor before commissioning a ship.");return;}
   if(Object.entries(cost).some(([k,v])=>me[k]<v)){notice(ws,"Not enough resources.");return;}
   for(const[k,v]of Object.entries(cost))me[k]-=v;
   const isBuilding=BUILDINGS.has(kind);
   const item={id:"i"+nextId++,kind,x:clamp(me.x+clamp(Number(msg.x)||0,-5,5),-45,45),z:clamp(Number(msg.z)||0,-5,5),owner:playerId};
   if(isBuilding){Object.assign(item,BUILDING_STATS[kind]);me.buildings.push(item);}
   else{Object.assign(item,UNIT_STATS[kind],{maxHp:UNIT_STATS[kind].hp,tx:item.x,tz:item.z});me.units.push(item);}
   broadcast(room,snapshot(room));broadcast(room,{type:"notice",text:me.name+(isBuilding?" built ":" recruited ")+kind+"."});return;
  }
  if(msg.type==="chat"){
   const text=String(msg.text||"").replace(/[<>]/g,"").trim().slice(0,120);
   if(text){room.state.chat.push({name:me.name,text});broadcast(room,snapshot(room));}return;
  }
  if(msg.type==="move"){
   const unit=me.units.find(u=>u.id===msg.id);
   if(unit&&Number.isFinite(msg.x)&&Number.isFinite(msg.z)){unit.tx=clamp(msg.x,-48,48);unit.tz=clamp(msg.z,-48,48);return;}
  }
 });
 ws.on("close",()=>{
  if(room&&playerId){const p=room.players.get(playerId);room.players.delete(playerId);delete room.state.players[playerId];
   if(p){broadcast(room,snapshot(room));broadcast(room,{type:"notice",text:p.name+" left the realm."});}
   if(!room.players.size)rooms.delete(ws.roomCode);
  }
 });
});

let last=Date.now();
setInterval(()=>{
 const now=Date.now(),dt=Math.min(.25,(now-last)/1000);last=now;
 for(const room of rooms.values()){
  const players=Object.values(room.state.players);
  for(const p of players){
   const farms=p.buildings.filter(b=>b.kind==="farm").length;
   const houses=p.buildings.filter(b=>b.kind==="house").length;
   p.gold+=1+Math.floor(houses*.5);p.wood+=.65;p.food+=.8+farms*.7;p.stone+=.45;
   if(p.units.length)p.food=Math.max(0,p.food-p.units.length*.018);
  }
  const items=allItems(room);
  for(const p of players)for(const u of p.units){
   const dx=u.tx-u.x,dz=u.tz-u.z,d=Math.hypot(dx,dz);
   if(d>.15){const step=Math.min(d,u.speed*terrainSpeed(u)*dt);u.x+=dx/d*step;u.z+=dz/d*step;}
   let target=null,best=Infinity;
   for(const enemy of items){if(enemy.owner===p.id||enemy.hp<=0)continue;
    const dist=distance(u,enemy);if(dist<=u.range&&dist<best){best=dist;target=enemy;}}
   if(target){const owner=room.state.players[target.owner];const list=target.category==="unit"?owner.units:owner.buildings;const actual=list.find(x=>x.id===target.id);if(actual)actual.hp-=u.damage*terrainAttack(u,actual)*dt;}
  }
  for(const p of players)for(const tower of p.buildings.filter(b=>b.kind==="tower")){
   let target=null,best=Infinity;for(const enemy of items){if(enemy.owner===p.id||enemy.category!=="unit"||enemy.hp<=0)continue;const d=distance(tower,enemy);if(d<=tower.range&&d<best){best=d;target=enemy;}}
   if(target){const owner=room.state.players[target.owner];const unit=owner?.units.find(u=>u.id===target.id);if(unit)unit.hp-=tower.damage*dt*(terrainAt(unit.x,unit.z)==="forest"?.82:1);}
  }
  const objectives=[{x:-24,z:0},{x:0,z:-24},{x:24,z:0}];
  for(const o of objectives){
   const presence=players.map(p=>({p,n:p.units.filter(u=>distance(u,o)<7).length})).filter(v=>v.n>0).sort((a,b)=>b.n-a.n);
   if(presence.length&&(!presence[1]||presence[0].n>presence[1].n)){presence[0].p.score=(presence[0].p.score||0)+dt*presence[0].n*.35;presence[0].p.gold+=dt*.35;}
  }
  for(const p of players){p.units=p.units.filter(u=>u.hp>0);p.buildings=p.buildings.filter(b=>b.hp>0);}
  broadcast(room,snapshot(room));
 }
},250);
const port=process.env.PORT||3000;
server.listen(port,"0.0.0.0",()=>console.log("Red Feather RTS listening on "+port));
