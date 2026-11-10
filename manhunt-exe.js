#!/usr/bin/env node
/**
 * MANHUNT — THE VEGAS INCIDENT
 * Single-file Node.js application. Node 22+; no npm dependencies.
 * Run: node server.js
 * Render: set Start Command to `node manhunt-exe.js`. For account/game data to survive restarts, configure a persistent disk or external database.
 */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {URL}=require('node:url');
const PORT=Number(process.env.PORT||3000),HOST='0.0.0.0';
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data'),DB=path.join(DATA_DIR,'manhunt.json');
fs.mkdirSync(DATA_DIR,{recursive:true});
let db={users:{},games:{},sessions:{}};
try{if(fs.existsSync(DB))db=JSON.parse(fs.readFileSync(DB,'utf8'));}catch(e){console.error('Could not read data file:',e.message);}
const save=()=>{const tmp=DB+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db,null,2));fs.renameSync(tmp,DB);};
// One-time database reset for Render's free plan (trigger with RESET_ACCOUNTS=true).
// The marker prevents repeated wipes while the environment variable is being removed.
const RESET_MARKER=path.join(DATA_DIR,'.manhunt-reset-complete');
if(process.env.RESET_ACCOUNTS==='true'&&!fs.existsSync(RESET_MARKER)){
 db={users:{},games:{},sessions:{}};
 save();
 fs.writeFileSync(RESET_MARKER,new Date().toISOString(),'utf8');
 console.log('MANHUNT RESET COMPLETE: all accounts, sessions and games cleared.');
}
const hash=(s,salt)=>crypto.scryptSync(s,salt,64).toString('hex');
const token=()=>crypto.randomBytes(32).toString('hex');
const code=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'same-origin'});res.end(JSON.stringify(obj));};
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1e6)reject(Error('Request too large'));});req.on('end',()=>{try{resolve(s?JSON.parse(s):{});}catch{reject(Error('Invalid JSON'));}});});}
function sessionSig(uid,user){return crypto.createHmac('sha256',user.password).update('manhunt-session:'+uid).digest('hex');}
function setLoginCookie(res,uid,user){const value=uid+'.'+sessionSig(uid,user);res.setHeader('set-cookie',`mh=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);}
function userFor(req){const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mh='))?.slice(3);if(!raw)return null;const dot=raw.lastIndexOf('.');if(dot<1)return null;const uid=raw.slice(0,dot),sig=raw.slice(dot+1),user=db.users[uid];if(!user)return null;const expected=sessionSig(uid,user);return sig.length===expected.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))?uid:null;}
function current(req){const id=userFor(req);return id?db.users[id]||null:null;}
function gameOf(user){return user?.gameId?db.games[user.gameId]||null:null;}
function player(game,id){return game?.players?.[id]||null;}
function publicGame(g,uid){
 if(!g)return null;
 const me=player(g,uid),isHunter=me?.role==='HUNTER',isHider=me?.role==='HIDER';
 return {id:g.id,code:g.code,name:g.name,status:g.status,hostId:g.hostId,createdAt:g.createdAt,roundEndsAt:g.roundEndsAt,roundStartedAt:g.roundStartedAt,pausedAt:g.pausedAt||null,endedAt:g.endedAt||null,zone:g.zone,shrinkAt:g.shrinkAt,players:Object.values(g.players).map(p=>{const visible=isHunter||(isHider&&(p.role==='HIDER'||p.role==='HUNTER'))||p.id===uid;return {id:p.id,name:p.name,role:visible?p.role:'HIDER',status:p.status,lastPing:p.lastPing,location:visible?p.location:null,outsideSince:p.id===uid||isHunter?p.outsideSince:null};}),me:me?{id:me.id,name:me.name,role:me.role,status:me.status,targetId:me.targetId,catchCode:me.role==='HIDER'?me.catchCode:null,outsideSince:me.outsideSince||null}:null,incidents:g.incidents.slice(-30)};
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
  if(now>=g.roundEndsAt){g.status='FINISHED';g.endedAt=now;incident(g,'ROUND END','18-minute round ended.', 'SYSTEM');for(const p of Object.values(g.players))p.status=p.status==='ACTIVE'?'SAFE':'ELIMINATED';broadcast(g);save();continue;}
  let zoneChanged=false;
  for(const p of Object.values(g.players)){
   if(p.status!=='ACTIVE'||!p.location)continue;
   if(p.role==='HIDER'){
    const outside=distance(p.location,g.zone.center)>g.zone.radius;
    if(outside&&!p.outsideSince){p.outsideSince=now;zoneChanged=true;incident(g,'ZONE WARNING',p.name+' left the shrinking zone. Return within 3 minutes.', 'SYSTEM');}
    if(!outside&&p.outsideSince){p.outsideSince=null;zoneChanged=true;incident(g,'ZONE RETURN',p.name+' returned inside the zone.', 'SYSTEM');}
    if(p.outsideSince&&now-p.outsideSince>=180000){p.status='ELIMINATED';p.outsideSince=null;zoneChanged=true;incident(g,'ZONE ELIMINATION',p.name+' was eliminated for remaining outside the zone.', 'SYSTEM');}
   }
  }
  if(zoneChanged){save();broadcast(g);}
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
  const uid=token(),salt=token();db.users[uid]={id:uid,name,email,salt,password:hash(pass,salt),gameId:null};save();setLoginCookie(res,uid,db.users[uid]);return json(res,200,{user:{id:uid,name}});
 }
 if(url.pathname==='/api/login'&&method==='POST'){
  const b=await body(req),email=String(b.email||'').toLowerCase(),pass=String(b.password||''),entry=Object.values(db.users).find(x=>x.email===email);
  if(!entry||hash(pass,entry.salt)!==entry.password)return json(res,401,{error:'Incorrect email or password.'});
  setLoginCookie(res,entry.id,entry);return json(res,200,{user:{id:entry.id,name:entry.name}});
 }
 if(url.pathname==='/api/logout'&&method==='POST'){res.setHeader('set-cookie','mh=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
 if(url.pathname.startsWith('/api/')&&!u)return json(res,401,{error:'Sign in first.'});
 if(url.pathname==='/api/me'&&method==='GET')return json(res,200,{user:{id:u.id,name:u.name},game:publicGame(gameOf(u),u.id)});
 if(url.pathname==='/api/host'&&method==='POST'){
  if(u.gameId)return json(res,400,{error:'Leave your current game first.'});
  const b=await body(req),name=String(b.name||'Vegas Incident').trim().slice(0,50),lat=Number(b.lat),lng=Number(b.lng),radius=Math.max(250,Math.min(1000,Number(b.radius)||1000));
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
  const hunterCount=Math.max(1,Math.floor(ps.length/4));const shuffled=[...ps].sort(()=>Math.random()-.5);const hunters=new Set(shuffled.slice(0,hunterCount).map(p=>p.id));for(const p of ps){p.role=hunters.has(p.id)?'HUNTER':'HIDER';p.status='ACTIVE';p.targetId=null;p.catchCode=p.role==='HIDER'?String(crypto.randomInt(100000,1000000)):null;}
  g.status='LIVE';g.roundStartedAt=Date.now();g.roundEndsAt=g.roundStartedAt+18*60000;g.shrinkAt=g.roundStartedAt+180000;const hunterNames=ps.filter(p=>hunters.has(p.id)).map(p=>p.name).join(', ');incident(g,'ROUND START',hunterNames+' assigned as hunter(s). The round is live.','SYSTEM');save();broadcast(g);return json(res,200,{game:publicGame(g,u.id)});
 }
 if(url.pathname==='/api/control'&&method==='POST'){
  const g=gameOf(u),b=await body(req);
  if(!g||g.hostId!==u.id)return json(res,403,{error:'Only the game host can control the round.'});
  if(b.action==='pause'&&g.status==='LIVE'){g.status='PAUSED';g.pausedAt=Date.now();incident(g,'GAME PAUSED','The host paused the game.',u.name);save();broadcast(g);return json(res,200,{ok:true,game:publicGame(g,u.id)});}
  if(b.action==='resume'&&g.status==='PAUSED'){const d=Date.now()-(g.pausedAt||Date.now());g.roundStartedAt+=d;g.roundEndsAt+=d;g.shrinkAt+=d;g.status='LIVE';g.pausedAt=null;incident(g,'GAME RESUMED','The host resumed the game.',u.name);save();broadcast(g);return json(res,200,{ok:true,game:publicGame(g,u.id)});}
  if(b.action==='end'&&(g.status==='LIVE'||g.status==='PAUSED')){g.status='FINISHED';g.endedAt=Date.now();g.pausedAt=null;for(const p of Object.values(g.players))if(p.status==='ACTIVE')p.status='SAFE';incident(g,'GAME ENDED','The host ended the game.',u.name);save();broadcast(g);return json(res,200,{ok:true,game:publicGame(g,u.id)});}
  return json(res,400,{error:'That control is not available right now.'});
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
  const submitted=String(b.code||'').trim();
  if(!target.catchCode||submitted!==target.catchCode)return json(res,403,{error:'Incorrect catch code. Ask the hider for the code they see on their screen.'});
  target.status='ELIMINATED';incident(g,'TAG CONFIRMED',target.name+' confirmed caught by hunter.',u.name);save();broadcast(g);return json(res,200,{ok:true});
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
:root{--bg:#09090b;--panel:#141419;--line:#303039;--red:#e43d42;--gold:#d6ad65;--muted:#9999a3;--white:#f3f0e9}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 80% -10%,#42191d,transparent 35%),var(--bg);color:var(--white);font:14px/1.5 system-ui,Arial}button,input{font:inherit}button{cursor:pointer;background:#202027;color:white;border:1px solid var(--line);border-radius:8px;padding:11px 14px;font-weight:750}button.primary{background:var(--red);border-color:var(--red)}input{width:100%;background:#09090c;color:white;border:1px solid var(--line);border-radius:8px;padding:12px;margin:5px 0 10px}.top{padding:16px 4vw;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#09090bee;z-index:9}.brand{font-size:20px;font-weight:1000;letter-spacing:.16em}.brand span,h1 em{color:var(--red)}.edition,.eyebrow,small{color:var(--gold);letter-spacing:.18em;font-size:10px}main{max-width:1400px;margin:auto;padding:28px 4vw}.hero{display:flex;justify-content:space-between;gap:15px;align-items:end}.hero h1{font-size:clamp(36px,6vw,64px);line-height:.95;margin:10px 0}.sub{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:20px 0}.stat,.panel{background:linear-gradient(145deg,#19191f,#111115);border:1px solid var(--line);border-radius:12px;padding:15px}.stat label{font-size:10px;color:var(--muted);letter-spacing:.13em}.stat b{display:block;font-size:24px}.layout{display:grid;grid-template-columns:1fr 310px;gap:14px}#map{height:520px;border-radius:0 0 12px 12px}.panelhead{display:flex;justify-content:space-between;padding:2px 0 12px}.side{display:flex;flex-direction:column;gap:12px}.side h3{font-size:11px;letter-spacing:.15em;margin:0 0 12px}.muted{color:var(--muted);font-size:12px}.row{display:flex;gap:8px}.row>*{flex:1}.wide{width:100%;margin-top:7px}.player,.feed{padding:9px 0;border-top:1px solid var(--line);font-size:12px}.pill{color:var(--gold);font-size:10px}.hidden{display:none!important}.auth{max-width:440px;margin:35px auto}.auth h2{margin-bottom:4px}.actions{display:flex;gap:8px;flex-wrap:wrap}.warn{color:#ffbd72}.good{color:#83dfa0}.zone-alert{display:none;margin:12px 0;padding:14px 16px;border:2px solid #ff343b;border-radius:10px;background:#4a1015;color:#fff;font-weight:900;font-size:16px;letter-spacing:.04em}.zone-alert.on{display:block;animation:zonePulse 1s infinite alternate}@keyframes zonePulse{from{box-shadow:0 0 4px #e43d42}to{box-shadow:0 0 22px #e43d42}}.you-marker{width:26px;height:26px;border-radius:50%;background:#ed252d;border:4px solid white;box-shadow:0 0 0 7px #ed252d66,0 0 20px #ed252d;position:relative}.you-marker:after{content:'YOU ARE HERE';position:absolute;left:30px;top:0;white-space:nowrap;background:#ed252d;color:white;padding:3px 7px;border-radius:4px;font:bold 10px Arial}.hunter-marker{width:25px;height:25px;border-radius:50%;background:#ed252d;border:4px solid white;box-shadow:0 0 0 7px #ed252d66,0 0 18px #ed252d}.hider-marker{width:15px;height:15px;border-radius:50%;background:#e3b65f;border:3px solid white;box-shadow:0 0 0 4px #e3b65f55}footer{color:#777;font-size:10px;margin-top:18px}@media(max-width:850px){.layout{grid-template-columns:1fr}.side{display:grid;grid-template-columns:1fr 1fr}#map{height:420px}}@media(max-width:560px){.stats{grid-template-columns:1fr 1fr}.hero{display:block}.side{display:flex}.top{padding:12px 4vw}#map{height:380px}}
</style></head><body><header class="top"><div><div class="brand">MAN<span>HUNT</span></div><div class="edition">THE VEGAS INCIDENT · FIELD OPERATIONS</div></div><div class="actions"><button id="logout" class="hidden" onclick="act('/api/logout',{})">LOG OUT</button></div></header><main>
<section id="auth" class="panel auth"><div class="eyebrow">FIELD OPERATIONS</div><h2>ENTER THE HUNT</h2><p class="muted">Create an account or sign in. Location is never shared until you enable it.</p><div id="authFields"><input id="name" placeholder="Callsign / name"><input id="email" type="email" placeholder="Email"><input id="password" type="password" placeholder="Password (8+ characters)"></div><div class="row"><button class="primary" onclick="auth('register')">CREATE ACCOUNT</button><button onclick="auth('login')">SIGN IN</button></div><p id="authMsg" class="muted"></p></section>
<section id="app" class="hidden"><div class="hero"><div><div class="eyebrow">FIELD OPERATIONS · AFTER DARK</div><h1>ONE CITY.<br><em>NO ALIBIS.</em></h1><div class="sub" id="gameName">Create a lobby or join with a code.</div></div><div id="roundClock" class="hidden"><b id="timer" style="font-size:28px">18:00</b><br><small>ROUND TIME REMAINING</small></div></div>
<div id="zoneAlert" class="zone-alert" role="alert"></div><div id="statsBar" class="stats hidden"><div class="stat"><label>ACTIVE PLAYERS</label><b id="active">—</b></div><div class="stat"><label>HIDERS AT LARGE</label><b id="hiders">—</b></div><div class="stat"><label>ELIMINATIONS</label><b id="out">—</b></div><div class="stat"><label>YOUR ROLE</label><b id="role">—</b></div></div>
<div class="layout"><div class="panel" style="padding:12px"><div class="panelhead"><b>OPERATIONS MAP</b><span id="mapMode" class="muted">LOBBY</span></div><div id="map"></div><p class="muted">Hiders ping every 3 minutes. Hunter location updates every 5 seconds. GPS sharing is opt-in.</p></div><aside class="side">
<div class="panel"><h3>GAME CONTROL</h3><div id="lobbyControls"><input id="gameTitle" placeholder="Game name"><input id="radius" type="number" min="250" max="1000" value="1000" placeholder="Starting zone radius (m) · max 1,000 m"><button class="primary wide" onclick="hostGame()">CREATE GAME</button><div class="muted" style="margin:10px 0">OR JOIN A GAME</div><input id="joinCode" placeholder="6-character game code"><input id="callsign" placeholder="Your callsign"><button class="wide" onclick="joinGame()">JOIN GAME</button></div><div id="hostControls" class="hidden"><p>Lobby code: <b id="code" class="good"></b></p><button class="primary wide" onclick="startGame()">START 18-MIN ROUND</button></div><div id="liveControls" class="hidden"><div id="hunterPanel" class="hidden"><h3>HUNTER CONTROL</h3><p class="muted">You are the IMPOSTER. Track the hiders. When you physically catch one, ask for their six-digit code and confirm it in the roster.</p></div><div id="hiderPanel" class="hidden"><h3>HIDER BRIEFING</h3><p class="muted">You are a CREWMATE. Evade the hunter and stay inside the shrinking zone.</p><p>Your one-time catch code:</p><div id="catchCode" style="font-size:28px;font-weight:900;letter-spacing:.2em;color:var(--gold)">------</div><p class="muted">Only tell the hunter this code when they have physically caught you.</p></div><button class="primary wide" id="gps" onclick="toggleGPS()">ENABLE LOCATION SHARING</button><button class="wide" onclick="report()">REPORT SIGHTING</button><div id="hostRoundControls" class="hidden"><button class="wide" id="pauseBtn" onclick="controlRound()">PAUSE GAME</button><button class="wide" onclick="controlRound('end')">END GAME</button></div></div><div id="leaveControls" class="hidden"><button class="wide" onclick="leave()">LEAVE GAME</button></div></div>
<div class="panel"><h3>FIELD ROSTER</h3><div id="roster" class="muted">No players yet.</div></div><div class="panel"><h3>INCIDENT FEED</h3><div id="feed" class="muted">No incidents yet.</div></div></aside></div></section><footer>MANHUNT · SINGLE-FILE SERVER BUILD · HTTPS REQUIRED FOR GPS · LOCATION SHARING IS OPT-IN</footer></main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
let me=null,G=null,map=null,markers={},circle=null,watch=null,gpsTimer=null,latestPosition=null,lastHiderPing=0,events=null,zoneAlertTimer=null;
const $=x=>document.getElementById(x);
async function req(url,data){let r=await fetch(url,{method:data?'POST':'GET',headers:data?{'content-type':'application/json'}:{},body:data?JSON.stringify(data):undefined});let j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j}
async function auth(kind){try{let j=await req('/api/'+kind,{name:$('name').value,email:$('email').value,password:$('password').value});me=j.user;showApp();}catch(e){$('authMsg').textContent=e.message}}
async function boot(){try{let j=await req('/api/me');me=j.user;G=j.game;showApp();if(G)render(G);else showLobby();}catch{}}
function showApp(){$('auth').classList.add('hidden');$('app').classList.remove('hidden');$('logout').classList.remove('hidden');if(!map){map=L.map('map').setView([20,0],2);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',maxZoom:19}).addTo(map)}}
function showLobby(){$('lobbyControls').classList.remove('hidden');$('hostControls').classList.add('hidden');$('liveControls').classList.add('hidden');$('leaveControls').classList.add('hidden')}
async function hostGame(){try{let pos=await gpsOnce();let j=await req('/api/host',{name:$('gameTitle').value||'Vegas Incident',lat:pos.coords.latitude,lng:pos.coords.longitude,radius:Number($('radius').value)||1500});G=j.game;render(G);connectEvents()}catch(e){alert(e.message)}}
async function joinGame(){try{let j=await req('/api/join',{code:$('joinCode').value,callsign:$('callsign').value});G=j.game;render(G);connectEvents()}catch(e){alert(e.message)}}
function gpsOnce(){return new Promise((resolve,reject)=>{if(!navigator.geolocation)return reject(Error('GPS unavailable'));navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:15000})})}
async function startGame(){try{let j=await req('/api/start',{});render(j.game)}catch(e){alert(e.message)}}
function distanceMeters(a,b){const r=x=>x*Math.PI/180,R=6371000,d1=r(b.lat-a.lat),d2=r(b.lng-a.lng),q=Math.sin(d1/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(d2/2)**2;return 2*R*Math.asin(Math.sqrt(q));}
function stopGPS(){if(watch!==null)navigator.geolocation.clearWatch(watch);if(gpsTimer!==null)clearInterval(gpsTimer);watch=null;gpsTimer=null;latestPosition=null;}
async function toggleGPS(){
 if(watch!==null){stopGPS();$('gps').textContent='ENABLE LOCATION SHARING';return;}
 if(!G||G.status!=='LIVE')return alert('GPS can only be shared during a live round.');
 if(!navigator.geolocation)return alert('GPS unavailable.');
 $('gps').textContent='REQUESTING GPS…';
 watch=navigator.geolocation.watchPosition(p=>{latestPosition={lat:p.coords.latitude,lng:p.coords.longitude,at:Date.now()};$('gps').textContent='STOP LOCATION SHARING';if(map&&me){const here=[latestPosition.lat,latestPosition.lng],youIcon=L.divIcon({className:'',html:'<div class="you-marker"></div>',iconSize:[160,30],iconAnchor:[13,13]});if(!markers[me.id])markers[me.id]=L.marker(here,{icon:youIcon,zIndexOffset:1000}).addTo(map).bindPopup('YOU ARE HERE');else markers[me.id].setLatLng(here);if(G?.me?.role==='HIDER'&&G.zone){const d=distanceMeters(latestPosition,G.zone.center);if(d>G.zone.radius&&!G.me.outsideSince){const a=$('zoneAlert');a.classList.add('on');a.textContent='⚠ YOU ARE OUTSIDE THE SAFE ZONE · RETURN NOW · YOUR POSITION IS SYNCING';}else if(d<=G.zone.radius&&!G.me.outsideSince){$('zoneAlert').classList.remove('on');$('zoneAlert').textContent='';}}}},e=>{alert('GPS error: '+e.message);stopGPS();$('gps').textContent='ENABLE LOCATION SHARING';},{enableHighAccuracy:true,maximumAge:0,timeout:20000});
 const isHunter=G.me.role==='HUNTER';
 const send=async()=>{if(!latestPosition||!G||G.status!=='LIVE'||Date.now()-latestPosition.at>20000)return;if(!isHunter&&Date.now()-lastHiderPing<175000)return;try{await req('/api/location',{lat:latestPosition.lat,lng:latestPosition.lng});lastHiderPing=Date.now();}catch(e){if(!String(e.message).includes('once every 3 minutes'))$('gps').textContent=e.message;}};
 send();gpsTimer=setInterval(send,5000);
}
async function controlRound(action){action=action|| (G.status==='PAUSED'?'resume':'pause');if(action==='end'&&!confirm('End this game for everyone?'))return;try{let j=await req('/api/control',{action});render(j.game)}catch(e){alert(e.message)}}
async function tagPlayer(targetId){const code=prompt('Ask the caught hider for the six-digit code shown on their screen:');if(!code)return;try{await req('/api/tag',{targetId,code});alert('Catch verified. Hider eliminated.')}catch(e){alert(e.message)}}
async function report(){let s=prompt('Sighting details (do not approach or follow anyone):');if(s)try{await req('/api/report',{type:'SIGHTING',message:s})}catch(e){alert(e.message)}}
async function leave(){if(!confirm('Leave this game?'))return;stopGPS();try{await req('/api/leave',{});if(events){events.close();events=null;}G=null;markers&&Object.values(markers).forEach(m=>{try{map.removeLayer(m)}catch{}});markers={};if(circle){try{map.removeLayer(circle)}catch{}circle=null;}$('gameName').textContent='Create a lobby or join with a code.';$('timer').textContent='18:00';$('active').textContent='—';$('hiders').textContent='—';$('out').textContent='—';$('role').textContent='—';$('mapMode').textContent='LOBBY';$('roster').textContent='No players yet.';$('feed').textContent='No incidents yet.';$('zoneAlert').classList.remove('on');$('zoneAlert').textContent='';showLobby();render(null);window.location.reload();}catch(e){alert('Could not leave game: '+e.message)}}
function connectEvents(){if(events)events.close();events=new EventSource('/api/events');events.onmessage=e=>{let j=JSON.parse(e.data);if(j.game){G=j.game;render(G)}}}
function render(g){if(!g){$('roundClock').classList.add('hidden');$('statsBar').classList.add('hidden');G=null;$('zoneAlert').classList.remove('on');$('zoneAlert').textContent='';$('gameName').textContent='Create a lobby or join with a code.';$('timer').textContent='18:00';$('active').textContent='—';$('hiders').textContent='—';$('out').textContent='—';$('role').textContent='—';$('mapMode').textContent='LOBBY';$('roster').textContent='No players yet.';$('feed').textContent='No incidents yet.';$('lobbyControls').classList.remove('hidden');$('hostControls').classList.add('hidden');$('liveControls').classList.add('hidden');$('leaveControls').classList.add('hidden');$('hostRoundControls').classList.add('hidden');$('hunterPanel').classList.add('hidden');$('hiderPanel').classList.add('hidden');for(const m of Object.values(markers)){if(map)map.removeLayer(m)}markers={};if(circle){if(map)map.removeLayer(circle);circle=null;}if(map)map.setView([20,0],2);return}$('statsBar').classList.remove('hidden');G=g;$('gameName').textContent=g.name+' · CODE '+g.code;$('code').textContent=g.code;$('mapMode').textContent=g.status;$('role').textContent=g.me?.role==='HUNTER'?'IMPOSTER':g.me?.role==='HIDER'?'CREWMATE':'—';$('active').textContent=g.players.filter(p=>p.status==='ACTIVE').length;$('hiders').textContent=g.players.filter(p=>p.role==='HIDER'&&p.status==='ACTIVE').length;$('out').textContent=g.players.filter(p=>p.status!=='ACTIVE').length;
const alertBox=$('zoneAlert');if(g.me?.role==='HIDER'&&g.me.outsideSince&&g.status==='LIVE'){const remaining=Math.max(0,180-Math.floor((Date.now()-g.me.outsideSince)/1000));alertBox.classList.add('on');alertBox.textContent='⚠ YOU ARE OUTSIDE THE SAFE ZONE · RETURN NOW · ELIMINATION IN '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0');}else{alertBox.classList.remove('on');alertBox.textContent='';}
$('lobbyControls').classList.toggle('hidden',g.status!=='LOBBY');$('hostControls').classList.toggle('hidden',!(g.status==='LOBBY'&&g.hostId===me.id));$('liveControls').classList.toggle('hidden',!['LIVE','PAUSED'].includes(g.status));$('leaveControls').classList.remove('hidden');$('hunterPanel').classList.toggle('hidden',g.me?.role!=='HUNTER');$('hiderPanel').classList.toggle('hidden',g.me?.role!=='HIDER');$('catchCode').textContent=g.me?.catchCode||'------';$('hostRoundControls').classList.toggle('hidden',g.hostId!==me.id||!['LIVE','PAUSED'].includes(g.status));$('pauseBtn').textContent=g.status==='PAUSED'?'RESUME GAME':'PAUSE GAME';$('pauseBtn').disabled=g.status==='FINISHED';
$('roster').innerHTML=g.players.map(p=>'<div class="player"><b>'+esc(p.name)+'</b> <span class="pill">'+(p.role==='HUNTER'?'IMPOSTER':p.role==='HIDER'?'CREWMATE':esc(p.role))+' · '+esc(p.status)+'</span>'+(g.status==='LIVE'&&g.me?.role==='HUNTER'&&p.role==='HIDER'&&p.status==='ACTIVE'?' <button onclick="tagPlayer(\''+esc(p.id)+'\')">CONFIRM CAUGHT</button>':'')+'</div>').join('')||'No players yet';$('feed').innerHTML=g.incidents.slice(-8).reverse().map(x=>'<div class="feed">'+esc(x.message)+'<br><small>'+new Date(x.at).toLocaleTimeString()+'</small></div>').join('')||'No incidents yet';
if(g.zone){const c=[g.zone.center.lat,g.zone.center.lng];if(!circle){circle=L.circle(c,{radius:g.zone.radius,color:'#e43d42',fillOpacity:.08}).addTo(map);map.setView(c,15)}else{circle.setLatLng(c);circle.setRadius(g.zone.radius)}}
const seenMarkers=new Set();for(const p of g.players){if(!p.location||p.status!=='ACTIVE')continue;seenMarkers.add(p.id);let pos=[p.location.lat,p.location.lng],iconHtml=p.id===me.id?'<div class="you-marker"></div>':p.role==='HUNTER'?'<div class="hunter-marker"></div>':'<div class="hider-marker"></div>';if(!markers[p.id])markers[p.id]=L.marker(pos,{icon:L.divIcon({className:'',html:iconHtml,iconSize:p.id===me.id?[160,30]:[28,28],iconAnchor:p.id===me.id?[13,13]:[14,14]})}).addTo(map).bindPopup(esc(p.id===me.id?'YOU ARE HERE':p.role==='HUNTER'?'HUNTER · '+p.name:'HIDER · '+p.name));else{markers[p.id].setLatLng(pos);markers[p.id].setIcon(L.divIcon({className:'',html:iconHtml,iconSize:p.id===me.id?[160,30]:[28,28],iconAnchor:p.id===me.id?[13,13]:[14,14]}));}}for(const id of Object.keys(markers)){if(!seenMarkers.has(id)){map.removeLayer(markers[id]);delete markers[id];}}
const roundStarted=!!g.roundStartedAt;
$('roundClock').classList.toggle('hidden',!roundStarted);
$('statsBar').classList.toggle('hidden',!roundStarted);
if(roundStarted&&g.roundEndsAt){const clockNow=g.pausedAt||g.endedAt||Date.now();const sec=Math.max(0,Math.ceil((g.roundEndsAt-clockNow)/1000));$('timer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0')}else $('timer').textContent='18:00';
}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function act(url,data){try{await req(url,data);location.reload()}catch(e){alert(e.message)}}
setInterval(()=>{if(G&&G.roundStartedAt&&G.roundEndsAt){const clockNow=G.pausedAt||Date.now();const sec=Math.max(0,Math.ceil((G.roundEndsAt-clockNow)/1000));$('timer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');}if(G&&G.me?.role==='HIDER'&&G.me.outsideSince&&G.status==='LIVE'){const left=Math.max(0,180-Math.floor((Date.now()-G.me.outsideSince)/1000));$('zoneAlert').classList.add('on');$('zoneAlert').textContent='⚠ YOU ARE OUTSIDE THE SAFE ZONE · RETURN NOW · ELIMINATION IN '+Math.floor(left/60)+':'+String(left%60).padStart(2,'0');}},1000);
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
