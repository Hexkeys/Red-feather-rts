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
  house:{wood:90}, farm:{wood:65}, lumberyard:{wood:80}, quarry:{wood:80,stone:25}, market:{wood:100,stone:40}, barracks:{wood:120,stone:35}, archery:{wood:100,stone:25}, stable:{wood:150,stone:60}, siegeworkshop:{wood:180,stone:100}, tower:{wood:55,stone:70}, wall:{wood:45,stone:25}, dock:{wood:150,stone:40},
  soldier:{gold:45,food:35}, menatarms:{gold:85,food:45}, archer:{gold:55,wood:15,food:30}, crossbow:{gold:75,wood:25,food:35}, knight:{gold:110,food:55}, lightcavalry:{gold:85,food:50},
  pikeman:{gold:65,wood:10,food:40}, siege:{gold:160,wood:90}, engineer:{gold:95,wood:35,food:30}, ship:{gold:130,wood:120,food:25}
};
const UNIT_STATS = {
  soldier:{hp:100,damage:12,range:2.1,speed:3.3}, menatarms:{hp:155,damage:19,range:2.2,speed:2.8},
  archer:{hp:65,damage:9,range:8,speed:3.0}, crossbow:{hp:85,damage:16,range:8.5,speed:2.5},
  knight:{hp:180,damage:22,range:2.5,speed:4.6}, lightcavalry:{hp:115,damage:15,range:2.2,speed:5.4},
  pikeman:{hp:125,damage:17,range:2.3,speed:3.0},
  siege:{hp:220,damage:38,range:10,speed:1.5}, engineer:{hp:90,damage:7,range:1.8,speed:2.7}, ship:{hp:260,damage:25,range:9,speed:2.4}
};
const BUILDING_STATS = {house:{hp:260},farm:{hp:180},lumberyard:{hp:220},quarry:{hp:260},market:{hp:300},barracks:{hp:500},archery:{hp:420},stable:{hp:480},siegeworkshop:{hp:520},tower:{hp:420,damage:18,range:11},wall:{hp:650},dock:{hp:450}};
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
 if(unit.kind==="pikeman"&&(target.kind==="knight"||target.kind==="lightcavalry"))m*=1.65;
 if(unit.kind==="archer"&&target.kind==="siege")m*=1.25;
 if(unit.kind==="knight"&&target.kind==="archer")m*=1.25;
 return m;
}
function structureDamage(unit,target){let m=1;if(target.category!=="building")return m;if(unit.kind==="siege")m=3.2;else if(unit.kind==="engineer")m=1.8;else if(unit.kind==="knight"||unit.kind==="menatarms")m=1.15;else if(unit.kind==="archer"||unit.kind==="crossbow"||unit.kind==="ship")m=.45;else m=.7;if(target.kind==="tower"&&unit.kind!=="siege"&&unit.kind!=="engineer")m*=.8;return m;}
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
   const spawnX=(room.players.size-3.5)*95;
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
   if(UNITS.has(kind)){const facility=me.buildings.find(b=>b.id===String(msg.buildingId));const required=kind==="ship"?"dock":(kind==="archer"||kind==="crossbow")?"archery":(kind==="knight"||kind==="lightcavalry")?"stable":(kind==="siege"||kind==="engineer")?"siegeworkshop":"barracks";if(!facility||facility.kind!==required){const labels={dock:"Harbor",archery:"Archery Range",stable:"Stable",siegeworkshop:"Siege Workshop",barracks:"Barracks"};notice(ws,"Select your "+labels[required]+" to recruit this unit.");return;}}
   if(Object.entries(cost).some(([k,v])=>me[k]<v)){notice(ws,"Not enough resources.");return;}
   const isBuilding=BUILDINGS.has(kind);
   const px=Number(msg.x),pz=Number(msg.z);
   const item={id:"i"+nextId++,kind,x:isBuilding?clamp(Number.isFinite(px)?px:me.x,-585,585):clamp(me.x+clamp(Number.isFinite(px)?px:0,-5,5),-585,585),z:isBuilding?clamp(Number.isFinite(pz)?pz:0,-435,435):clamp(Number.isFinite(pz)?pz:0,-5,5),owner:playerId};
   if(isBuilding){
    if(kind==="wall"){
     const x2=Number(msg.x2),z2=Number(msg.z2);
     if(!Number.isFinite(x2)||!Number.isFinite(z2)){notice(ws,"Choose both ends of the wall.");return;}
     item.x2=clamp(x2,-585,585);item.z2=clamp(z2,-435,435);
     const length=distance(item,{x:item.x2,z:item.z2});
     if(length<3||length>32){notice(ws,"Wall length must be between 3 and 32 metres.");return;}
     const midpoint={x:(item.x+item.x2)/2,z:(item.z+item.z2)/2};
     const crowded=allItems(room).some(other=>distance(midpoint,other)<length*.22+2.5);
     if(crowded){notice(ws,"That wall overlaps a nearby structure. Choose another line.");return;}
    }else{
     const radius=kind==="barracks"||kind==="dock"?4.2:3.2;
     const crowded=allItems(room).some(other=>distance(item,other)<radius+(other.category==="building"?3:1.2));
     if(crowded){notice(ws,"That spot is occupied. Choose another location.");return;}
    }
    for(const[k,v]of Object.entries(cost))me[k]-=v;
    Object.assign(item,BUILDING_STATS[kind]);me.buildings.push(item);
   }else{for(const[k,v]of Object.entries(cost))me[k]-=v;Object.assign(item,UNIT_STATS[kind],{maxHp:UNIT_STATS[kind].hp,tx:item.x,tz:item.z});me.units.push(item);}
   broadcast(room,snapshot(room));broadcast(room,{type:"notice",text:me.name+(isBuilding?" built ":" recruited ")+kind+"."});return;
  }
  if(msg.type==="chat"){
   const text=String(msg.text||"").replace(/[<>]/g,"").trim().slice(0,120);
   if(text){room.state.chat.push({name:me.name,text});broadcast(room,snapshot(room));}return;
  }
  if(msg.type==="move"){
   const unit=me.units.find(u=>u.id===msg.id);
   if(unit&&Number.isFinite(msg.x)&&Number.isFinite(msg.z)){unit.tx=clamp(msg.x,-595,595);unit.tz=clamp(msg.z,-445,445);return;}
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
   const lumberyards=p.buildings.filter(b=>b.kind==="lumberyard").length;
   const quarries=p.buildings.filter(b=>b.kind==="quarry").length;
   const markets=p.buildings.filter(b=>b.kind==="market").length;
   // No free passive income: production comes from the matching economy buildings.
   p.food+=farms*.55;p.wood+=lumberyards*.45;p.stone+=quarries*.3;p.gold+=markets*.3;
   if(p.units.length)p.food=Math.max(0,p.food-p.units.length*.018);
  }
  const items=allItems(room);
  for(const p of players)for(const u of p.units){
   const dx=u.tx-u.x,dz=u.tz-u.z,d=Math.hypot(dx,dz);
   if(d>.15){const step=Math.min(d,u.speed*terrainSpeed(u)*dt);u.x+=dx/d*step;u.z+=dz/d*step;}
   let target=null,best=Infinity;
   for(const enemy of items){if(enemy.owner===p.id||enemy.hp<=0)continue;
    const dist=distance(u,enemy);if(dist<=u.range&&dist<best){best=dist;target=enemy;}}
   if(target){const owner=room.state.players[target.owner];const list=target.category==="unit"?owner.units:owner.buildings;const actual=list.find(x=>x.id===target.id);if(actual)actual.hp-=u.damage*terrainAttack(u,actual)*structureDamage(u,target)*dt;}
  }
  for(const p of players)for(const tower of p.buildings.filter(b=>b.kind==="tower")){
   let target=null,best=Infinity;for(const enemy of items){if(enemy.owner===p.id||enemy.category!=="unit"||enemy.hp<=0)continue;const d=distance(tower,enemy);if(d<=tower.range&&d<best){best=d;target=enemy;}}
   if(target){const owner=room.state.players[target.owner];const unit=owner?.units.find(u=>u.id===target.id);if(unit)unit.hp-=tower.damage*dt*(terrainAt(unit.x,unit.z)==="forest"?.82:1);}
  }
  const objectives=[{x:-260,z:0},{x:0,z:-250},{x:260,z:0}];
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
