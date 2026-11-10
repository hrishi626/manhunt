#!/usr/bin/env node
/**
 * MANHUNT — THE VEGAS INCIDENT
 * Single-file Node.js application. Node 22+; no npm dependencies.
 * Run: node server.js
 * Render: set Start Command to `node server.js`; attach a persistent disk at /var/data.
 */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {URL}=require('node:url');
const PORT=Number(process.env.PORT||3000),HOST='0.0.0.0';
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data'),DB=path.join(DATA_DIR,'manhunt.json');
fs.mkdirSync(DATA_DIR,{recursive:true});
let db={users:{},games:{},sessions:{}};
try{if(fs.existsSync(DB))db=JSON.parse(fs.readFileSync(DB,'utf8'));}catch(e){console.error('Could not read data file:',e.message);}
const save=()=>{const tmp=DB+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db,null,2));fs.renameSync(tmp,DB);};
const hash=(s,salt)=>crypto.scryptSync(s,salt,64).toString('hex');
const token=()=>crypto.randomBytes(32).toString('hex');
const code=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'same-origin'});res.end(JSON.stringify(obj));};
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1e6)reject(Error('Request too large'));});req.on('end',()=>{try{resolve(s?JSON.parse(s):{});}catch{reject(Error('Invalid JSON'));}});});}
function userFor(req){const t=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mh='))?.slice(3);return t?db.sessions[t]||null:null;}
function current(req){const id=userFor(req);return id?db.users[id]||null:null;}
function gameOf(user){return user?.gameId?db.games[user.gameId]||null:null;}
function player(game,id){return game?.players?.[id]||null;}
function publicGame(g,uid){
 if(!g)return null;
 const me=player(g,uid),isHunter=me?.role==='HUNTER';
 return {id:g.id,code:g.code,name:g.name,status:g.status,hostId:g.hostId,createdAt:g.createdAt,roundEndsAt:g.roundEndsAt,roundStartedAt:g.roundStartedAt,zone:g.zone,shrinkAt:g.shrinkAt,players:Object.values(g.players).map(p=>({id:p.id,name:p.name,role:(p.id===uid||isHunter)?p.role:'HIDER',status:p.status,lastPing:p.lastPing,location:(p.id===uid||isHunter)?p.location:null,outsideSince:(p.id===uid||isHunter)?p.outsideSince:null})),me:me?{id:me.id,name:me.name,role:me.role,status:me.status,targetId:me.targetId}:null,incidents:g.incidents.slice(-30)};
}
const streams=new Map();
function broadcast(g){const msg='data: '+JSON.stringify({game:publicGame(g,'')})+'\n\n';for(const [uid,set] of streams){const u=db.users[uid];if(u?.gameId===g.id){const payload='data: '+JSON.stringify({game:publicGame(g,uid)})+'\n\n';for(const r of set)r.write(payload);}}}
function incident(g,type,message,by){g.incidents.push({id:token().slice(0,8),type,message,by,at:Date.now()});g.incidents=g.incidents.slice(-100);}
function shrink(g){
 if(!g.zone||g.status!=='LIVE')return;
 const elapsed=Date.now()-g.roundStartedAt,step=Math.floor(elapsed/180000);
 const radius=Math.max(g.zone.minRadius,g.zone.startRadius*Math.pow(.8,step));
 g.zone.radius=Math.round(radius);g.shrinkAt=g.roundStartedAt+(step+1)*180000;
}
function tick(){
 const now=Date.now();
 for(const g of Object.values(db.games)){
  if(g.status!=='LIVE')continue;
  shrink(g);
  if(now>=g.roundEndsAt){g.status='FINISHED';incident(g,'ROUND END','18-minute round ended.', 'SYSTEM');for(const p of Object.values(g.players))p.status=p.status==='ACTIVE'?'SAFE':'ELIMINATED';broadcast(g);save();continue;}
  for(const p of Object.values(g.players)){
   if(p.status!=='ACTIVE'||!p.location)continue;
   if(p.role==='HIDER'){
    const outside=distance(p.location,g.zone.center)>g.zone.radius;
    if(outside&&!p.outsideSince){p.outsideSince=now;incident(g,'ZONE WARNING',p.name+' left the shrinking zone. Return within 3 minutes.', 'SYSTEM');}
    if(!outside&&p.outsideSince){p.outsideSince=null;incident(g,'ZONE RETURN',p.name+' returned inside the zone.', 'SYSTEM');}
    if(p.outsideSince&&now-p.outsideSince>=180000){p.status='ELIMINATED';p.outsideSince=null;incident(g,'ZONE ELIMINATION',p.name+' was eliminated for remaining outside the zone.', 'SYSTEM');}
   }
  }
  if(now%5000<1100)broadcast(g);
 }
}
function distance(a,b){const R=6371000,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x));}
setInterval(tick,1000).unref();
async function api(req,res,url){
 const u=current(req),id=userFor(req),method=req.method;
 if(method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'same-origin','access-control-allow-methods':'GET,POST','access-control-allow-headers':'content-type'});return res.end();}
 if(url.pathname==='/api/register'&&method==='POST'){
  const b=await body(req),name=String(b.name||'').trim().slice(0,24),email=String(b.email||'').trim().toLowerCase(),pass=String(b.password||'');
  if(!name||!email||pass.length<8)return json(res,400,{error:'Name, email and password (8+ characters) required.'});
  if(Object.values(db.users).some(x=>x.email===email))return json(res,409,{error:'Email already registered.'});
  const uid=token(),salt=token();db.users[uid]={id:uid,name,email,salt,password:hash(pass,salt),gameId:null};const t=token();db.sessions[t]=uid;save();res.setHeader('set-cookie',`mh=${t}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);return json(res,200,{user:{id:uid,name}});
 }
 if(url.pathname==='/api/login'&&method==='POST'){
  const b=await body(req),email=String(b.email||'').toLowerCase(),pass=String(b.password||''),entry=Object.values(db.users).find(x=>x.email===email);
  if(!entry||hash(pass,entry.salt)!==entry.password)return json(res,401,{error:'Incorrect email or password.'});
  const t=token();db.sessions[t]=entry.id;save();res.setHeader('set-cookie',`mh=${t}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);return json(res,200,{user:{id:entry.id,name:entry.name}});
 }
 if(url.pathname==='/api/logout'&&method==='POST'){if(id)delete db.sessions[(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mh='))?.slice(3)];res.setHeader('set-cookie','mh=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
 if(url.pathname.startsWith('/api/')&&!u)return json(res,401,{error:'Sign in first.'});
 if(url.pathname==='/api/me'&&method==='GET')return json(res,200,{user:{id:u.id,name:u.name},game:publicGame(gameOf(u),u.id)});
 if(url.pathname==='/api/host'&&method==='POST'){
  if(u.gameId)return json(res,400,{error:'Leave your current game first.'});
  const b=await body(req),name=String(b.name||'Vegas Incident').trim().slice(0,50),lat=Number(b.lat),lng=Number(b.lng),radius=Math.max(500,Math.min(5000,Number(b.radius)||1500));
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return json(res,400,{error:'Set the game centre using your location or map coordinates.'});
  const gid=token(),g={id:gid,code:code(),name,hostId:u.id,status:'LOBBY',createdAt:Date.now(),roundStartedAt:null,roundEndsAt:null,zone:{center:{lat,lng},startRadius:radius,minRadius:150,radius},shrinkAt:null,players:{},incidents:[]};
  g.players[u.id]={id:u.id,name:u.name,role:'HUNTER',status:'ACTIVE',targetId:null,location:null,lastPing:null,outsideSince:null};db.games[gid]=g;u.gameId=gid;incident(g,'GAME CREATED',u.name+' opened the lobby.','SYSTEM');save();return json(res,200,{game:publicGame(g,u.id)});
 }
 if(url.pathname==='/api/join'&&method==='POST'){
  const b=await body(req),g=Object.values(db.games).find(x=>x.code===String(b.code||'').toUpperCase()&&x.status==='LOBBY'),name=String(b.callsign||u.name).trim().slice(0,24);
  if(!g)return json(res,404,{error:'No open lobby found for that code.'});if(u.gameId)return json(res,400,{error:'Leave your current game first.'});
  g.players[u.id]={id:u.id,name,role:'HIDER',status:'ACTIVE',targetId:null,location:null,lastPing:null,outsideSince:null};u.gameId=g.id;incident(g,'PLAYER JOINED',name+' joined the hunt.','SYSTEM');save();broadcast(g);return json(res,200,{game:publicGame(g,u.id)});
 }
 if(url.pathname==='/api/start'&&method==='POST'){
  const g=gameOf(u);if(!g||g.hostId!==u.id)return json(res,403,{error:'Host only.'});if(g.status!=='LOBBY')return json(res,400,{error:'Game already started.'});
  const ps=Object.values(g.players);if(ps.length<2)return json(res,400,{error:'At least two players are required.'});
  const hunterCount=Math.max(1,Math.floor(ps.length/4));const shuffled=[...ps].sort(()=>Math.random()-.5);const hunters=new Set(shuffled.slice(0,hunterCount).map(p=>p.id));for(const p of ps){p.role=hunters.has(p.id)?'HUNTER':'HIDER';p.status='ACTIVE';p.targetId=null;}
  g.status='LIVE';g.roundStartedAt=Date.now();g.roundEndsAt=g.roundStartedAt+18*60000;g.shrinkAt=g.roundStartedAt+180000;const hunterNames=ps.filter(p=>hunters.has(p.id)).map(p=>p.name).join(', ');incident(g,'ROUND START',hunterNames+' assigned as hunter(s). The round is live.','SYSTEM');save();broadcast(g);return json(res,200,{game:publicGame(g,u.id)});
 }
 if(url.pathname==='/api/location'&&method==='POST'){
  const g=gameOf(u),p=player(g,u.id),b=await body(req);if(!g||g.status!=='LIVE'||!p||p.status!=='ACTIVE')return json(res,400,{error:'No active round.'});
  const lat=Number(b.lat),lng=Number(b.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return json(res,400,{error:'Invalid coordinates.'});
  const now=Date.now();if(p.role==='HIDER'&&p.lastPing&&now-p.lastPing<175000)return json(res,429,{error:'Hiders can ping once every 3 minutes.'});
  p.location={lat,lng,at:now};p.lastPing=now;save();broadcast(g);return json(res,200,{ok:true});
 }
 if(url.pathname==='/api/report'&&method==='POST'){
  const g=gameOf(u),b=await body(req);if(!g)return json(res,400,{error:'Join a game first.'});incident(g,String(b.type||'REPORT').slice(0,20),String(b.message||'').slice(0,250),u.name);save();broadcast(g);return json(res,200,{ok:true});
 }
 if(url.pathname==='/api/tag'&&method==='POST'){
  const g=gameOf(u),b=await body(req);if(!g||g.status!=='LIVE'||player(g,u.id)?.role!=='HUNTER')return json(res,403,{error:'Only the hunter can submit a tag.'});
  const target=player(g,String(b.targetId||''));if(!target||target.role!=='HIDER'||target.status!=='ACTIVE')return json(res,400,{error:'Invalid target.'});
  target.status='ELIMINATED';incident(g,'TAG CONFIRMED',target.name+' tagged out by hunter.',u.name);save();broadcast(g);return json(res,200,{ok:true});
 }
 if(url.pathname==='/api/leave'&&method==='POST'){
  const g=gameOf(u);if(g){if(g.status==='LOBBY')delete g.players[u.id];else{const p=player(g,u.id);if(p)p.status='LEFT';}u.gameId=null;save();broadcast(g);}return json(res,200,{ok:true});
 }
 if(url.pathname==='/api/state'&&method==='GET'){const g=gameOf(u);return json(res,200,{game:publicGame(g,u.id)});}
 if(url.pathname==='/api/events'&&method==='GET'){
  const g=gameOf(u);if(!g)return json(res,400,{error:'Join a game first.'});
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});res.write('data: '+JSON.stringify({game:publicGame(g,u.id)})+'\n\n');
  if(!streams.has(u.id))streams.set(u.id,new Set());streams.get(u.id).add(res);req.on('close',()=>streams.get(u.id)?.delete(res));return;
 }
 return json(res,404,{error:'Not found.'});
}
const PAGE=String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MANHUNT — The Vegas Incident</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><style>
:root{--bg:#09090b;--panel:#141419;--line:#303039;--red:#e43d42;--gold:#d6ad65;--muted:#9999a3;--white:#f3f0e9}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 80% -10%,#42191d,transparent 35%),var(--bg);color:var(--white);font:14px/1.5 system-ui,Arial}button,input{font:inherit}button{cursor:pointer;background:#202027;color:white;border:1px solid var(--line);border-radius:8px;padding:11px 14px;font-weight:750}button.primary{background:var(--red);border-color:var(--red)}input{width:100%;background:#09090c;color:white;border:1px solid var(--line);border-radius:8px;padding:12px;margin:5px 0 10px}.top{padding:16px 4vw;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#09090bee;z-index:9}.brand{font-size:20px;font-weight:1000;letter-spacing:.16em}.brand span,h1 em{color:var(--red)}.edition,.eyebrow,small{color:var(--gold);letter-spacing:.18em;font-size:10px}main{max-width:1400px;margin:auto;padding:28px 4vw}.hero{display:flex;justify-content:space-between;gap:15px;align-items:end}.hero h1{font-size:clamp(36px,6vw,64px);line-height:.95;margin:10px 0}.sub{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:20px 0}.stat,.panel{background:linear-gradient(145deg,#19191f,#111115);border:1px solid var(--line);border-radius:12px;padding:15px}.stat label{font-size:10px;color:var(--muted);letter-spacing:.13em}.stat b{display:block;font-size:24px}.layout{display:grid;grid-template-columns:1fr 310px;gap:14px}#map{height:520px;border-radius:0 0 12px 12px}.panelhead{display:flex;justify-content:space-between;padding:2px 0 12px}.side{display:flex;flex-direction:column;gap:12px}.side h3{font-size:11px;letter-spacing:.15em;margin:0 0 12px}.muted{color:var(--muted);font-size:12px}.row{display:flex;gap:8px}.row>*{flex:1}.wide{width:100%;margin-top:7px}.player,.feed{padding:9px 0;border-top:1px solid var(--line);font-size:12px}.pill{color:var(--gold);font-size:10px}.hidden{display:none!important}.auth{max-width:440px;margin:35px auto}.auth h2{margin-bottom:4px}.actions{display:flex;gap:8px;flex-wrap:wrap}.warn{color:#ffbd72}.good{color:#83dfa0}footer{color:#777;font-size:10px;margin-top:18px}@media(max-width:850px){.layout{grid-template-columns:1fr}.side{display:grid;grid-template-columns:1fr 1fr}#map{height:420px}}@media(max-width:560px){.stats{grid-template-columns:1fr 1fr}.hero{display:block}.side{display:flex}.top{padding:12px 4vw}#map{height:380px}}
</style></head><body><header class="top"><div><div class="brand">MAN<span>HUNT</span></div><div class="edition">THE VEGAS INCIDENT · FIELD OPERATIONS</div></div><div class="actions"><button id="logout" class="hidden" onclick="act('/api/logout',{})">LOG OUT</button></div></header><main>
<section id="auth" class="panel auth"><div class="eyebrow">FIELD OPERATIONS</div><h2>ENTER THE HUNT</h2><p class="muted">Create an account or sign in. Location is never shared until you enable it.</p><div id="authFields"><input id="name" placeholder="Callsign / name"><input id="email" type="email" placeholder="Email"><input id="password" type="password" placeholder="Password (8+ characters)"></div><div class="row"><button class="primary" onclick="auth('register')">CREATE ACCOUNT</button><button onclick="auth('login')">SIGN IN</button></div><p id="authMsg" class="muted"></p></section>
<section id="app" class="hidden"><div class="hero"><div><div class="eyebrow">FIELD OPERATIONS · AFTER DARK</div><h1>ONE CITY.<br><em>NO ALIBIS.</em></h1><div class="sub" id="gameName">Create a lobby or join with a code.</div></div><div><b id="timer" style="font-size:28px">18:00</b><br><small>ROUND TIME REMAINING</small></div></div>
<div class="stats"><div class="stat"><label>ACTIVE PLAYERS</label><b id="active">—</b></div><div class="stat"><label>HIDERS AT LARGE</label><b id="hiders">—</b></div><div class="stat"><label>ELIMINATIONS</label><b id="out">—</b></div><div class="stat"><label>YOUR ROLE</label><b id="role">—</b></div></div>
<div class="layout"><div class="panel" style="padding:12px"><div class="panelhead"><b>OPERATIONS MAP</b><span id="mapMode" class="muted">LOBBY</span></div><div id="map"></div><p class="muted">Hiders ping every 3 minutes. Hunter location updates every 5 seconds. GPS sharing is opt-in.</p></div><aside class="side">
<div class="panel"><h3>GAME CONTROL</h3><div id="lobbyControls"><input id="gameTitle" placeholder="Game name"><input id="radius" type="number" min="500" max="5000" value="1500" placeholder="Starting zone radius (m)"><button class="primary wide" onclick="hostGame()">CREATE GAME</button><div class="muted" style="margin:10px 0">OR JOIN A GAME</div><input id="joinCode" placeholder="6-character game code"><input id="callsign" placeholder="Your callsign"><button class="wide" onclick="joinGame()">JOIN GAME</button></div><div id="hostControls" class="hidden"><p>Lobby code: <b id="code" class="good"></b></p><button class="primary wide" onclick="startGame()">START 18-MIN ROUND</button></div><div id="liveControls" class="hidden"><div class="muted" id="mission">Your assignment appears here.</div><button class="primary wide" id="gps" onclick="toggleGPS()">ENABLE LOCATION SHARING</button><button class="wide" onclick="report()">REPORT SIGHTING</button><button class="wide" onclick="leave()">LEAVE GAME</button></div></div>
<div class="panel"><h3>FIELD ROSTER</h3><div id="roster" class="muted">No players yet.</div></div><div class="panel"><h3>INCIDENT FEED</h3><div id="feed" class="muted">No incidents yet.</div></div></aside></div></section><footer>MANHUNT · SINGLE-FILE SERVER BUILD · HTTPS REQUIRED FOR GPS · LOCATION SHARING IS OPT-IN</footer></main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
let me=null,G=null,map=null,markers={},circle=null,watch=null,lastHiderPing=0,events=null;
const $=x=>document.getElementById(x);
async function req(url,data){let r=await fetch(url,{method:data?'POST':'GET',headers:data?{'content-type':'application/json'}:{},body:data?JSON.stringify(data):undefined});let j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j}
async function auth(kind){try{let j=await req('/api/'+kind,{name:$('name').value,email:$('email').value,password:$('password').value});me=j.user;showApp();}catch(e){$('authMsg').textContent=e.message}}
async function boot(){try{let j=await req('/api/me');me=j.user;G=j.game;showApp();if(G)render(G);else showLobby();}catch{}}
function showApp(){$('auth').classList.add('hidden');$('app').classList.remove('hidden');$('logout').classList.remove('hidden');if(!map){map=L.map('map').setView([20,0],2);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',maxZoom:19}).addTo(map)}}
function showLobby(){$('lobbyControls').classList.remove('hidden');$('hostControls').classList.add('hidden');$('liveControls').classList.add('hidden')}
async function hostGame(){try{let pos=await gpsOnce();let j=await req('/api/host',{name:$('gameTitle').value||'Vegas Incident',lat:pos.coords.latitude,lng:pos.coords.longitude,radius:Number($('radius').value)||1500});G=j.game;render(G);connectEvents()}catch(e){alert(e.message)}}
async function joinGame(){try{let j=await req('/api/join',{code:$('joinCode').value,callsign:$('callsign').value});G=j.game;render(G);connectEvents()}catch(e){alert(e.message)}}
function gpsOnce(){return new Promise((resolve,reject)=>{if(!navigator.geolocation)return reject(Error('GPS unavailable'));navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:15000})})}
async function startGame(){try{let j=await req('/api/start',{});render(j.game)}catch(e){alert(e.message)}}
async function toggleGPS(){if(watch!==null){navigator.geolocation.clearWatch(watch);watch=null;$('gps').textContent='ENABLE LOCATION SHARING';return}if(!G||G.status!=='LIVE')return alert('GPS can only be shared during a live round.');if(!navigator.geolocation)return alert('GPS unavailable.');$('gps').textContent='REQUESTING GPS…';watch=navigator.geolocation.watchPosition(async p=>{const interval=G.me.role==='HUNTER'?5000:180000;if(Date.now()-lastHiderPing<(G.me.role==='HUNTER'?4500:175000))return;try{await req('/api/location',{lat:p.coords.latitude,lng:p.coords.longitude});lastHiderPing=Date.now();$('gps').textContent='STOP LOCATION SHARING'}catch(e){$('gps').textContent=e.message}},e=>{alert(e.message);watch=null;$('gps').textContent='ENABLE LOCATION SHARING'},{enableHighAccuracy:true,maximumAge:1000,timeout:15000});}
async function report(){let s=prompt('Sighting details (do not approach or follow anyone):');if(s)try{await req('/api/report',{type:'SIGHTING',message:s})}catch(e){alert(e.message)}}
async function leave(){if(watch!==null)navigator.geolocation.clearWatch(watch);watch=null;await req('/api/leave',{});G=null;if(events)events.close();showLobby();render(null)}
function connectEvents(){if(events)events.close();events=new EventSource('/api/events');events.onmessage=e=>{let j=JSON.parse(e.data);if(j.game){G=j.game;render(G)}}}
function render(g){if(!g){$('gameName').textContent='Create a lobby or join with a code.';return}G=g;$('gameName').textContent=g.name+' · CODE '+g.code;$('code').textContent=g.code;$('mapMode').textContent=g.status;$('role').textContent=g.me?.role||'—';$('active').textContent=g.players.filter(p=>p.status==='ACTIVE').length;$('hiders').textContent=g.players.filter(p=>p.role==='HIDER'&&p.status==='ACTIVE').length;$('out').textContent=g.players.filter(p=>p.status!=='ACTIVE').length;
$('lobbyControls').classList.toggle('hidden',g.status!=='LOBBY');$('hostControls').classList.toggle('hidden',!(g.status==='LOBBY'&&g.hostId===me.id));$('liveControls').classList.toggle('hidden',g.status!=='LIVE');$('mission').textContent=g.me?.role==='HUNTER'?'You are the hunter. Hunter GPS broadcasts every 5 seconds.':g.me?.role==='HIDER'?'Stay inside the shrinking zone. Ping every 3 minutes. Outside the zone gives you 3 minutes to return.':'Waiting for the host to start.';
$('roster').innerHTML=g.players.map(p=>'<div class="player"><b>'+esc(p.name)+'</b> <span class="pill">'+esc(p.role)+' · '+esc(p.status)+'</span></div>').join('')||'No players yet';$('feed').innerHTML=g.incidents.slice(-8).reverse().map(x=>'<div class="feed">'+esc(x.message)+'<br><small>'+new Date(x.at).toLocaleTimeString()+'</small></div>').join('')||'No incidents yet';
if(g.zone){const c=[g.zone.center.lat,g.zone.center.lng];if(!circle){circle=L.circle(c,{radius:g.zone.radius,color:'#e43d42',fillOpacity:.08}).addTo(map);map.setView(c,15)}else{circle.setLatLng(c);circle.setRadius(g.zone.radius)}}
for(const p of g.players){if(p.location){let pos=[p.location.lat,p.location.lng];if(!markers[p.id])markers[p.id]=L.circleMarker(pos,{radius:7,color:p.role==='HUNTER'?'#e43d42':'#d6ad65'}).addTo(map).bindPopup(esc(p.name));else markers[p.id].setLatLng(pos)}}
if(g.roundEndsAt){let sec=Math.max(0,Math.ceil((g.roundEndsAt-Date.now())/1000));$('timer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0')}else $('timer').textContent='18:00';
}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function act(url,data){try{await req(url,data);location.reload()}catch(e){alert(e.message)}}
boot();
</script></body></html>`;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/health'){res.writeHead(200,{'content-type':'text/plain'});return res.end('ok');}
 if(url.pathname.startsWith('/api/')){try{return await api(req,res,url)}catch(e){console.error(e);return json(res,500,{error:'Server error.'});}}
 if(req.method!=='GET'){res.writeHead(405);return res.end('Method not allowed');}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' https: data: blob:; connect-src 'self' https:;"});res.end(PAGE);
});
server.listen(PORT,HOST,()=>console.log(`MANHUNT running on http://${HOST}:${PORT}`));
