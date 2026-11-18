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
const UNIT_STATS = {builder:{hp:90,damage:0,range:0,speed:3.1},
  soldier:{hp:100,damage:12,range:2.1,speed:3.3}, menatarms:{hp:155,damage:19,range:2.2,speed:2.8},
  archer:{hp:65,damage:9,range:8,speed:3.0}, crossbow:{hp:85,damage:16,range:8.5,speed:2.5},
  knight:{hp:180,damage:22,range:2.5,speed:4.6}, lightcavalry:{hp:115,damage:15,range:2.2,speed:5.4},
  pikeman:{hp:125,damage:17,range:2.3,speed:3.0},
  siege:{hp:220,damage:38,range:10,speed:1.5}, engineer:{hp:90,damage:7,range:1.8,speed:2.7}, ship:{hp:260,damage:25,range:9,speed:2.4}
};
const BUILDING_STATS = {castle:{hp:2400},house:{hp:260},farm:{hp:180},lumberyard:{hp:220},quarry:{hp:260},market:{hp:300},barracks:{hp:500},archery:{hp:420},stable:{hp:480},siegeworkshop:{hp:520},tower:{hp:420,damage:18,range:11},wall:{hp:650},dock:{hp:450}};
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
function structureDamage(unit,target){let m=1;if(target.category!=="building")return m;if(unit.kind==="siege")m=3.2;else if(unit.kind==="engineer")m=1.8;else if(unit.kind==="knight"||unit.kind==="menatarms")m=1.15;else if(unit.kind==="archer"||unit.kind==="crossbow"||unit.kind==="ship")m=.45;else m=.7;if(target.kind==="tower"&&unit.kind!=="siege"&&unit.kind!=="engineer")m*=.8;return m;}
function terrainSpeed(unit){const t=terrainAt(unit.x,unit.z);return t==="road"?1.22:t==="river"?(unit.kind==="knight"?.62:.82):t==="marsh"?(unit.kind==="knight"?.58:.78):t==="forest"?.88:t==="mountain"?.68:t==="hill"?.86:1;}
function terrainCover(target){const t=terrainAt(target.x,target.z);return t==="forest"?.68:t==="mountain"?.72:t==="hill"?.84:t==="marsh"?.92:1;}
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
   const spawnX=(room.players.size-3.5)*360;
   room.players.set(playerId,{ws,name,color});
   const castle={id:"i"+nextId++,kind:"castle",x:spawnX,z:0,owner:playerId,...BUILDING_STATS.castle};
   const builder={id:"i"+nextId++,kind:"builder",x:spawnX+9,z:8,owner:playerId,...UNIT_STATS.builder,maxHp:UNIT_STATS.builder.hp,tx:spawnX+9,tz:8};
   room.state.players[playerId]={id:playerId,name,color,gold:300,wood:260,food:220,stone:140,score:0,buildings:[castle],units:[builder],x:spawnX,defeated:false};
   ws.roomCode=code;ws.playerId=playerId;
   send(ws,{type:"welcome",id:playerId,room:code,color});
   broadcast(room,snapshot(room));broadcast(room,{type:"notice",text:name+" joined the realm."});return;
  }
  if(!room||!playerId)return;
  const me=room.state.players[playerId];if(!me)return;
  if(me.defeated){notice(ws,"Your castle has fallen. You have been defeated.");return;}
  if(msg.type==="action"){
   const kind=String(msg.kind||""),cost=COSTS[kind];if(!cost)return;
   const supply=8+me.buildings.filter(b=>b.kind==="house").length*4;
   const queuedUnits=me.buildings.reduce((n,b)=>n+(b.productionQueue?.length||0),0);
   if(UNITS.has(kind)&&kind!=="builder"&&me.units.filter(u=>u.kind!=="builder").length+queuedUnits>=supply){notice(ws,"Army supply is full. Build houses to support more units.");return;}
   if(UNITS.has(kind)){const facility=me.buildings.find(b=>b.id===String(msg.buildingId));const required=kind==="ship"?"dock":(kind==="archer"||kind==="crossbow")?"archery":(kind==="knight"||kind==="lightcavalry")?"stable":(kind==="siege"||kind==="engineer")?"siegeworkshop":"barracks";if(!facility||facility.kind!==required){const labels={dock:"Harbor",archery:"Archery Range",stable:"Stable",siegeworkshop:"Siege Workshop",barracks:"Barracks"};notice(ws,"Select your "+labels[required]+" to recruit this unit.");return;}}
   if(Object.entries(cost).some(([k,v])=>me[k]<v)){notice(ws,"Not enough resources.");return;}
   const isBuilding=BUILDINGS.has(kind);
   const px=Number(msg.x),pz=Number(msg.z);
   const item={id:"i"+nextId++,kind,x:isBuilding?clamp(Number.isFinite(px)?px:me.x,-2370,2370):clamp(me.x+clamp(Number.isFinite(px)?px:0,-5,5),-2370,2370),z:isBuilding?clamp(Number.isFinite(pz)?pz:0,-1770,1770):clamp(Number.isFinite(pz)?pz:0,-5,5),owner:playerId};
   if(isBuilding){
    if(kind==="dock"&&(terrainAt(item.x,item.z)==="sea"||terrainAt(item.x,item.z)==="river"||!findNearbySea(item.x,item.z,300))){notice(ws,"Place the harbor on land close to the island shoreline so ships can launch.");return;}
    const nearEnemyCastle=allItems(room).some(other=>other.kind==="castle"&&other.owner!==playerId&&distance(item,other)<175);
    if(nearEnemyCastle){notice(ws,"That blueprint is too close to an enemy castle. Choose a safer location.");return;}
    if(kind==="wall"){
     const x2=Number(msg.x2),z2=Number(msg.z2);
     if(!Number.isFinite(x2)||!Number.isFinite(z2)){notice(ws,"Choose both ends of the wall.");return;}
     item.x2=clamp(x2,-2370,2370);item.z2=clamp(z2,-1770,1770);
     const length=distance(item,{x:item.x2,z:item.z2});
     if(length<3||length>32){notice(ws,"Wall length must be between 3 and 32 metres.");return;}
     const midpoint={x:(item.x+item.x2)/2,z:(item.z+item.z2)/2};
     const nearCastle=allItems(room).some(other=>other.kind==="castle"&&other.owner!==playerId&&distance(midpoint,other)<175);
     if(nearCastle){notice(ws,"That wall is too close to an enemy castle.");return;}
     const crowded=allItems(room).some(other=>distance(midpoint,other)<length*.22+2.5);
     if(crowded){notice(ws,"That wall overlaps a nearby structure. Choose another line.");return;}
    }else{
     const radius=kind==="barracks"||kind==="dock"?4.2:3.2;
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
   const mode=msg.mode==="attack"?"attack":"move",formation=["line","column","wedge","box"].includes(msg.formation)?msg.formation:"box",spacing=6.4;
   selected.forEach((unit,i)=>{let ox=0,oz=0;if(formation==="line"){ox=(i-(selected.length-1)/2)*spacing;}else if(formation==="column"){oz=(i-(selected.length-1)/2)*spacing;}else if(formation==="wedge"){const row=Math.floor((Math.sqrt(8*i+1)-1)/2),col=i-row*(row+1)/2;ox=(col-row/2)*spacing;oz=row*spacing*.78;}else{const cols=Math.max(1,Math.ceil(Math.sqrt(selected.length))),rows=Math.ceil(selected.length/cols);ox=(i%cols-(cols-1)/2)*spacing;oz=(Math.floor(i/cols)-(rows-1)/2)*spacing;}
    const tx=clamp(msg.x+ox,-2390,2390),tz=clamp(msg.z+oz,-1790,1790);
    if(unit.kind==="ship"){const route=findWaterRoute(unit, {x:tx,z:tz});if(!route){notice(ws,"No clear water route to that destination. Choose a closer point at sea.");return;}unit.path=route;}else delete unit.path;
    unit.tx=tx;unit.tz=tz;unit.orderMode=mode;});
   broadcast(room,snapshot(room));return;
  }
  if(msg.type==="command"){
   if(!Array.isArray(msg.ids))return;const stance=["guard","hold","aggressive"].includes(msg.stance)?msg.stance:null;if(!stance)return;
   const ids=[...new Set(msg.ids.map(String))].slice(0,80);for(const id of ids){const unit=me.units.find(u=>u.id===id);if(unit){unit.stance=stance;if(stance==="hold"){unit.tx=unit.x;unit.tz=unit.z;unit.orderMode="move";}}}
   broadcast(room,snapshot(room));return;
  }
  if(msg.type==="move"){
   const unit=me.units.find(u=>u.id===msg.id);
   if(unit&&Number.isFinite(msg.x)&&Number.isFinite(msg.z)){if(unit.kind==="ship"){if(terrainAt(msg.x,msg.z)!=="sea"){notice(ws,"Ships can only sail in open water.");return;}const route=findWaterRoute(unit,{x:msg.x,z:msg.z});if(!route){notice(ws,"No clear water route to that destination.");return;}unit.path=route;}unit.tx=clamp(msg.x,-2390,2390);unit.tz=clamp(msg.z,-1790,1790);unit.orderMode="move";return;}
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
   if(p.defeated)continue;
   const farms=p.buildings.filter(b=>b.kind==="farm").length;
   const lumberyards=p.buildings.filter(b=>b.kind==="lumberyard").length;
   const quarries=p.buildings.filter(b=>b.kind==="quarry").length;
   const markets=p.buildings.filter(b=>b.kind==="market").length;
   // No free passive income: production comes from the matching economy buildings.
   p.food+=farms*.55;p.wood+=lumberyards*.45;p.stone+=quarries*.3;p.gold+=markets*.3;
   if(p.units.length)p.food=Math.max(0,p.food-p.units.length*.018);
  }
  for(const p of players)if(!p.defeated){for(const blueprint of p.buildings.filter(b=>b.underConstruction)){let worker=p.units.find(u=>u.kind==="builder"&&u.id===blueprint.builderId);if(!worker){worker=p.units.find(u=>u.kind==="builder"&&!u.assignedBuildingId);if(!worker){const castle=p.buildings.find(b=>b.kind==="castle");if(castle){worker={id:"i"+nextId++,kind:"builder",x:castle.x+9,z:castle.z+8,owner:p.id,...UNIT_STATS.builder,maxHp:UNIT_STATS.builder.hp,tx:castle.x+9,tz:castle.z+8};p.units.push(worker);}}if(worker){worker.assignedBuildingId=blueprint.id;blueprint.builderId=worker.id;worker.tx=blueprint.x;worker.tz=blueprint.z;}}}}
  const items=allItems(room);
  for(const p of players)if(!p.defeated)for(const u of p.units){
   let target=null,best=Infinity;
   for(const enemy of items){if(enemy.owner===p.id||enemy.hp<=0||u.kind==="builder")continue;const dist=distance(u,enemy);if(dist<=u.range&&dist<best){best=dist;target=enemy;}}
   const moveTarget=u.kind==="ship"&&u.path?.length?u.path[0]:{x:u.tx,z:u.tz},dx=moveTarget.x-u.x,dz=moveTarget.z-u.z,d=Math.hypot(dx,dz);
   const stance=u.stance||"guard";if(stance!=="hold"&&d>.15&&!(target&&u.orderMode==="attack")){const step=Math.min(d,u.speed*terrainSpeed(u)*dt);if(u.kind==="ship"&&d<=step+.01){u.x=moveTarget.x;u.z=moveTarget.z;if(u.path?.length)u.path.shift();}else{const nx=u.x+dx/d*step,nz=u.z+dz/d*step;if(u.kind!=="ship"||terrainAt(nx,nz)==="sea"){u.x=nx;u.z=nz;}}}
   if(u.kind==="builder"&&u.assignedBuildingId&&d<5){const blueprint=p.buildings.find(b=>b.id===u.assignedBuildingId);if(blueprint&&blueprint.underConstruction){blueprint.progress=Math.min(1,(blueprint.progress||0)+dt/10);blueprint.hp=blueprint.maxHp*(.12+.88*blueprint.progress);if(blueprint.progress>=1){blueprint.underConstruction=false;delete blueprint.builderId;delete u.assignedBuildingId;u.tx=u.x;u.tz=u.z;u.orderMode="move";}}}
   if(target&&u.kind!=="builder"&&u.damage>0){const owner=room.state.players[target.owner],list=target.category==="unit"?owner.units:owner.buildings,actual=list.find(x=>x.id===target.id);if(actual)actual.hp-=u.damage*terrainAttack(u,actual)*structureDamage(u,target)*terrainCover(actual)*dt;}
  }
  for(const p of players)if(!p.defeated)for(const facility of p.buildings){if(!facility.productionQueue?.length)continue;const job=facility.productionQueue[0];job.remaining-=dt;if(job.remaining<=0){const kind=job.kind,stats=UNIT_STATS[kind];if(stats){let sx=facility.x+7,sz=facility.z+5;if(kind==="ship"){const water=findNearbySea(facility.x,facility.z,300);if(!water){facility.productionQueue.shift();notice(room.players.get(p.id)?.ws,"This harbor has no nearby water. Build it closer to the coast.");continue;}sx=water.x;sz=water.z;}const unit={id:"i"+nextId++,kind,x:sx,z:sz,owner:p.id,...stats,maxHp:stats.hp,tx:sx,tz:sz};p.units.push(unit);}facility.productionQueue.shift();}}
  for(const p of players)if(!p.defeated)for(const tower of p.buildings.filter(b=>b.kind==="tower")){
   let target=null,best=Infinity;for(const enemy of items){if(enemy.owner===p.id||enemy.category!=="unit"||enemy.hp<=0)continue;const d=distance(tower,enemy);if(d<=tower.range&&d<best){best=d;target=enemy;}}
   if(target){const owner=room.state.players[target.owner];const unit=owner?.units.find(u=>u.id===target.id);if(unit)unit.hp-=tower.damage*dt*(terrainAt(unit.x,unit.z)==="forest"?.82:1);}
  }
  const objectives=[{x:-1050,z:0},{x:0,z:-1050},{x:1050,z:0}];
  for(const o of objectives){
   const presence=players.map(p=>({p,n:p.units.filter(u=>distance(u,o)<7).length})).filter(v=>v.n>0).sort((a,b)=>b.n-a.n);
   if(presence.length&&(!presence[1]||presence[0].n>presence[1].n)){presence[0].p.score=(presence[0].p.score||0)+dt*presence[0].n*.35;presence[0].p.gold+=dt*.35;}
  }
  for(const p of players){p.units=p.units.filter(u=>u.hp>0);p.buildings=p.buildings.filter(b=>b.hp>0);const castle=p.buildings.find(b=>b.kind==="castle");if(!castle&&!p.defeated){p.defeated=true;p.units=[];p.buildings=[];broadcast(room,{type:"notice",text:p.name+" has been defeated — their castle has fallen."});}}
  broadcast(room,snapshot(room));
 }
},250);
const port=process.env.PORT||3000;
server.listen(port,"0.0.0.0",()=>console.log("Red Feather RTS listening on "+port));
