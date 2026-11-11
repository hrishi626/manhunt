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
 return {id:g.id,code:g.code,name:g.name,status:g.status,hostId:g.hostId,createdAt:g.createdAt,roundEndsAt:g.roundEndsAt,roundStartedAt:g.roundStartedAt,hideStartedAt:g.hideStartedAt||null,hideEndsAt:g.hideEndsAt||null,pausedAt:g.pausedAt||null,endedAt:g.endedAt||null,zone:g.zone,shrinkAt:g.shrinkAt,players:Object.values(g.players).map(p=>{const visible=p.id===uid||(g.status!=='HIDING'&&(isHunter||(isHider&&(p.role==='HIDER'||p.role==='HUNTER'))));return {id:p.id,name:p.name,role:g.status==='LOBBY'?null:p.role,status:p.status,lastPing:p.lastPing,location:visible?p.location:null,outsideSince:p.id===uid||isHunter?p.outsideSince:null};}),me:me?{id:me.id,name:me.name,role:g.status==='LOBBY'?null:me.role,status:me.status,targetId:me.targetId,catchCode:me.role==='HIDER'?me.catchCode:null,outsideSince:me.outsideSince||null}:null,incidents:g.incidents.slice(-30)};
}
const streams=new Map();
function broadcast(g){const msg='data: '+JSON.stringify({game:publicGame(g,'')})+'\n\n';for(const [uid,set] of streams){const u=db.users[uid];if(u?.gameId===g.id){const payload='data: '+JSON.stringify({game:publicGame(g,uid)})+'\n\n';for(const r of set)r.write(payload);}}}
function incident(g,type,message,by){g.incidents.push({id:token().slice(0,8),type,message,by,at:Date.now()});g.incidents=g.incidents.slice(-100);}
function shrink(g){
 if(!g.zone||g.status!=='LIVE'||!g.roundStartedAt)return false;
 const elapsed=Math.max(0,Date.now()-g.roundStartedAt);
 const step=Math.floor(elapsed/180000); // one shrink every 3 minutes
 const minimum=100; // 100 m radius = 200 m diameter
 const nextRadius=Math.max(minimum,Math.round(g.zone.startRadius*Math.pow(0.8,step)));
 const changed=nextRadius!==g.zone.radius;
 g.zone.minRadius=minimum;
 g.zone.radius=nextRadius;
 g.shrinkAt=nextRadius<=minimum?null:g.roundStartedAt+(step+1)*180000;
 return changed;
}
function tick(){
 const now=Date.now();
 for(const g of Object.values(db.games)){
  if(g.status==='HIDING'){
   if(now>=g.hideEndsAt){
    g.status='LIVE';g.roundStartedAt=now;g.roundEndsAt=now+18*60000;g.shrinkAt=now+180000;
    incident(g,'HUNT BEGINS','The 2-minute hiding period is over. The 18-minute round is live.','SYSTEM');
    save();broadcast(g);
   }
   continue;
  }
  if(g.status!=='LIVE')continue;
  const radiusChanged=shrink(g);
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
  if(zoneChanged||radiusChanged){save();broadcast(g);}
  if(now%5000<1100)broadcast(g);
 }
}
function distance(a,b){const R=6371000,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x));}
setInterval(tick,1000).unref();
async function api(req,res,url){
 const u=current(req),id=userFor(req),method=req.method;
 if(method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'same-origin','access-control-allow-methods':'GET,POST','access-control-allow-headers':'content-type'});return res.end();}
 if(url.pathname==='/api/guest'&&method==='POST'){
  const b=await body(req),name=String(b.name||'').trim().slice(0,24)||'PLAYER';
  if(u)return json(res,200,{user:{id:u.id,name:u.name},game:publicGame(gameOf(u),u.id)});
  const uid=token(),secret=token();
  db.users[uid]={id:uid,name,password:secret,gameId:null,guest:true};
  save();setLoginCookie(res,uid,db.users[uid]);
  return json(res,200,{user:{id:uid,name},game:null});
 }
 if(url.pathname.startsWith('/api/')&&!u)return json(res,401,{error:'Session expired. Refresh the page to rejoin.'});
 if(url.pathname==='/api/me'&&method==='GET')return json(res,200,{user:{id:u.id,name:u.name},game:publicGame(gameOf(u),u.id)});
 if(url.pathname==='/api/host'&&method==='POST'){
  if(u.gameId)return json(res,400,{error:'Leave your current game first.'});
  const b=await body(req),name=String(b.name||'Vegas Incident').trim().slice(0,50),lat=Number(b.lat),lng=Number(b.lng),radius=Math.max(100,Math.min(1000,Number(b.radius)||1000));
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return json(res,400,{error:'Set the game centre using your location or map coordinates.'});
  const gid=token(),g={id:gid,code:code(),name,hostId:u.id,status:'LOBBY',createdAt:Date.now(),roundStartedAt:null,roundEndsAt:null,zone:{center:{lat,lng},startRadius:radius,minRadius:100,radius},shrinkAt:null,players:{},incidents:[]};
  g.players[u.id]={id:u.id,name:u.name,role:null,status:'ACTIVE',targetId:null,location:null,lastPing:null,outsideSince:null};db.games[gid]=g;u.gameId=gid;incident(g,'GAME CREATED',u.name+' opened the lobby.','SYSTEM');save();return json(res,200,{game:publicGame(g,u.id)});
 }
 if(url.pathname==='/api/join'&&method==='POST'){
  const b=await body(req),g=Object.values(db.games).find(x=>x.code===String(b.code||'').toUpperCase()&&x.status==='LOBBY'),name=String(b.callsign||u.name).trim().slice(0,24);
  if(!g)return json(res,404,{error:'No open lobby found for that code.'});if(u.gameId)return json(res,400,{error:'Leave your current game first.'});
  g.players[u.id]={id:u.id,name,role:null,status:'ACTIVE',targetId:null,location:null,lastPing:null,outsideSince:null};u.gameId=g.id;incident(g,'PLAYER JOINED',name+' joined the hunt.','SYSTEM');save();broadcast(g);return json(res,200,{game:publicGame(g,u.id)});
 }
 if(url.pathname==='/api/start'&&method==='POST'){
  const g=gameOf(u);if(!g||g.hostId!==u.id)return json(res,403,{error:'Host only.'});if(g.status!=='LOBBY')return json(res,400,{error:'Game already started.'});
  const ps=Object.values(g.players);if(ps.length<2)return json(res,400,{error:'At least two players are required.'});
  const hunterCount=Math.max(1,Math.floor(ps.length/4));const shuffled=[...ps];for(let i=shuffled.length-1;i>0;i--){const j=crypto.randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}const hunters=new Set(shuffled.slice(0,hunterCount).map(p=>p.id));for(const p of ps){p.role=hunters.has(p.id)?'HUNTER':'HIDER';p.status='ACTIVE';p.targetId=null;p.location=null;p.lastPing=null;p.outsideSince=null;p.catchCode=p.role==='HIDER'?String(crypto.randomInt(100000,1000000)):null;}
  g.status='HIDING';g.hideStartedAt=Date.now();g.hideEndsAt=g.hideStartedAt+2*60000;g.roundStartedAt=null;g.roundEndsAt=null;g.shrinkAt=null;const hunterNames=ps.filter(p=>hunters.has(p.id)).map(p=>p.name).join(', ');incident(g,'HIDING PHASE',hunterNames+' assigned as hunter(s). Hiders have 2 minutes to hide.','SYSTEM');save();broadcast(g);return json(res,200,{game:publicGame(g,u.id)});
 }
 if(url.pathname==='/api/control'&&method==='POST'){
  const g=gameOf(u),b=await body(req);
  if(!g||g.hostId!==u.id)return json(res,403,{error:'Only the game host can control the round.'});
  if(b.action==='pause'&&g.status==='LIVE'){g.status='PAUSED';g.pausedAt=Date.now();incident(g,'GAME PAUSED','The host paused the game.',u.name);save();broadcast(g);return json(res,200,{ok:true,game:publicGame(g,u.id)});}
  if(b.action==='resume'&&g.status==='PAUSED'){const d=Date.now()-(g.pausedAt||Date.now());g.roundStartedAt+=d;g.roundEndsAt+=d;g.shrinkAt+=d;g.status='LIVE';g.pausedAt=null;incident(g,'GAME RESUMED','The host resumed the game.',u.name);save();broadcast(g);return json(res,200,{ok:true,game:publicGame(g,u.id)});}
  if(b.action==='end'&&(g.status==='HIDING'||g.status==='LIVE'||g.status==='PAUSED')){g.status='FINISHED';g.endedAt=Date.now();g.pausedAt=null;for(const p of Object.values(g.players))if(p.status==='ACTIVE')p.status='SAFE';incident(g,'GAME ENDED','The host ended the game.',u.name);save();broadcast(g);return json(res,200,{ok:true,game:publicGame(g,u.id)});}
  return json(res,400,{error:'That control is not available right now.'});
 }
 if(url.pathname==='/api/location'&&method==='POST'){
  const g=gameOf(u),p=player(g,u.id),b=await body(req);if(!g||g.status!=='LIVE'||!p||p.status!=='ACTIVE')return json(res,400,{error:'Location sharing is not available in this phase.'});
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
:root{--bg:#08090d;--panel:#13151c;--panel2:#191c25;--line:#292e3a;--red:#ed3d45;--gold:#e8bd72;--muted:#9ba2b2;--white:#f5f3ef;--green:#49d69a}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% -18%,#64252c 0,transparent 42%),linear-gradient(180deg,#0c0d12,#08090d 70%);color:var(--white);font:15px/1.55 Inter,system-ui,Arial;min-height:100vh}
button,input{font:inherit}button{cursor:pointer;background:#202430;color:white;border:1px solid #343b4b;border-radius:12px;padding:13px 18px;font-weight:800;letter-spacing:.04em;transition:.18s}button:hover{transform:translateY(-1px);border-color:#687184}button.primary{background:var(--red);border-color:var(--red);color:#fff}button:disabled{opacity:.45;cursor:not-allowed;transform:none}
input{width:100%;background:#0b0d13;color:white;border:1px solid #343b4b;border-radius:12px;padding:15px;margin:7px 0 14px;outline:none}input:focus{border-color:var(--gold);box-shadow:0 0 0 3px #e8bd7222}
.top{height:82px;padding:14px clamp(18px,5vw,76px);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;border-bottom:1px solid #ffffff12;background:#090a0dcc;backdrop-filter:blur(16px);position:sticky;top:0;z-index:20}
.top-left{justify-self:start}.top-right{justify-self:end}.brand{font-size:22px;font-weight:1000;letter-spacing:.2em;text-align:center}.brand span,h1 em{color:var(--red)}.edition{color:var(--gold);font-size:9px;letter-spacing:.22em;text-align:center}
.navbtn{padding:11px 17px;border-radius:999px;font-size:11px}.navbtn.create{background:var(--red);border-color:var(--red)}
main{max-width:1440px;margin:auto;padding:34px clamp(16px,4vw,64px) 54px}.page{min-height:calc(100vh - 150px)}.hidden{display:none!important}
.landing{display:flex;flex-direction:column;align-items:center;text-align:center;justify-content:center;padding:28px 0 50px}.eyebrow{color:var(--gold);font-size:10px;letter-spacing:.27em;font-weight:900}.landing h1{font-size:clamp(48px,9vw,104px);line-height:.88;letter-spacing:-.065em;margin:22px 0 18px;font-weight:1000}.landing h1 em{font-style:normal}.tagline{font-size:clamp(15px,2vw,19px);color:#c1c5ce;max-width:580px;margin:0 auto 28px}.hero-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.hero-actions button{min-width:170px}
.movie-strip{width:min(860px,100%);height:clamp(190px,33vw,330px);margin:38px auto 0;border:1px solid #ffffff24;border-radius:20px;overflow:hidden;position:relative;box-shadow:0 24px 80px #0009;background:#171a22}
.movie-strip img {   width: 100%;   height: 100%;   object-fit: cover;   object-position: center;   display: block; }{width:100%;height:100%;object-fit:contain;object-position:center;background:#07080b;display:block;filter:saturate(.9) contrast(1.04)}.movie-strip:after{content:"THE WOLFPACK · BANGKOK";position:absolute;left:20px;bottom:17px;font-size:10px;letter-spacing:.22em;font-weight:900;text-shadow:0 2px 10px #000;background:#08090d99;padding:8px 12px;border-radius:7px}
.page-card{max-width:620px;margin:30px auto;background:linear-gradient(145deg,#191c25,#101219);border:1px solid var(--line);border-radius:22px;padding:clamp(22px,4vw,38px);box-shadow:0 24px 80px #0005}
.page-card h2{font-size:clamp(28px,5vw,42px);letter-spacing:-.04em;margin:7px 0}.page-card p{color:var(--muted)}.page-actions{display:flex;gap:10px;margin-top:16px}.page-actions>*{flex:1}
.rules-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:22px 0}.rule{background:#0d1017;border:1px solid var(--line);border-radius:14px;padding:16px}.rule b{display:block;font-size:21px;color:var(--gold)}.rule span{color:var(--muted);font-size:12px}
.hero{display:flex;justify-content:space-between;gap:18px;align-items:end;margin:8px 0 20px}.hero h1{font-size:clamp(34px,5vw,58px);line-height:.94;margin:10px 0}.sub{color:var(--muted)}#roundClock{text-align:right;background:#171a22;border:1px solid var(--line);padding:13px 18px;border-radius:14px;min-width:155px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}.stat,.panel{background:linear-gradient(145deg,#171a22,#101219);border:1px solid var(--line);border-radius:16px;padding:18px}.stat label{font-size:10px;color:var(--muted);letter-spacing:.13em}.stat b{display:block;font-size:27px;margin-top:4px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px}#map{height:560px;border-radius:12px;overflow:hidden}.panelhead{display:flex;justify-content:space-between;padding:0 0 14px;align-items:center}.side{display:flex;flex-direction:column;gap:14px}.side h3{font-size:11px;letter-spacing:.16em;margin:0 0 13px;color:var(--gold)}.muted{color:var(--muted);font-size:12px}.row{display:flex;gap:8px}.row>*{flex:1}.wide{width:100%;margin-top:8px}.player,.feed{padding:11px 0;border-top:1px solid var(--line);font-size:12px}.pill{color:var(--gold);font-size:10px}.actions{display:flex;gap:8px;flex-wrap:wrap}
.zone-alert{display:none;margin:12px 0;padding:14px 16px;border:2px solid #ff343b;border-radius:12px;background:#4a1015;color:#fff;font-weight:900;font-size:15px}.zone-alert.on{display:block;animation:zonePulse 1s infinite alternate}@keyframes zonePulse{from{box-shadow:0 0 4px #e43d42}to{box-shadow:0 0 22px #e43d42}}
.you-marker{width:26px;height:26px;border-radius:50%;background:#16C784;border:4px solid white;box-shadow:0 0 0 7px #16C78466,0 0 20px #16C784;position:relative}.you-marker:after{content:'YOU ARE HERE';position:absolute;left:30px;top:0;white-space:nowrap;background:#16C784;color:#071b12;padding:3px 7px;border-radius:4px;font:bold 10px Arial}.hunter-marker{width:25px;height:25px;border-radius:50%;background:#005BFF;border:4px solid white;box-shadow:0 0 0 7px #005BFF66,0 0 18px #005BFF}.hider-marker{width:15px;height:15px;border-radius:50%;background:#e3b65f;border:3px solid white;box-shadow:0 0 0 4px #e3b65f55}
.good{color:var(--green)}.warn{color:#ffbd72}footer{color:#747b8a;font-size:10px;text-align:center;margin-top:30px;letter-spacing:.12em}
@media(max-width:900px){.layout{grid-template-columns:1fr}.side{display:grid;grid-template-columns:1fr 1fr}#map{height:460px}}
@media(max-width:600px){.top{height:72px;padding:10px 12px;grid-template-columns:1fr auto 1fr}.brand{font-size:17px}.edition{font-size:7px}.navbtn{font-size:9px;padding:10px 11px}.stats{grid-template-columns:1fr 1fr}.hero{display:block}.side{display:flex}.rules-grid{grid-template-columns:1fr}.page-actions{flex-direction:column}#map{height:390px}.landing{padding-top:40px}}

.badge{display:inline-block;font-size:10px;font-weight:900;letter-spacing:.12em;padding:2px 8px;border-radius:999px;color:#fff;vertical-align:middle}.badge.hunter{background:#e0262d;box-shadow:0 0 12px #e0262d88}.badge.hider{background:#12a38f;color:#04201c}.player.is-hunter{background:#e0262d1a;border-left:3px solid #e0262d;padding-left:9px}.player.is-hunter b{color:#ff6a70;font-size:14px}
.rr{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;overflow:hidden;background:radial-gradient(ellipse at 50% 40%,var(--rg) 0,#050507 70%);animation:rrIn .6s ease-out both}
.rr.hunter{--rg:#6a0f16;--c:#d9272f;--cd:#8f141a;--glow:#ff343b}.rr.hider{--rg:#0b5a52;--c:#1fbfa8;--cd:#128273;--glow:#2de0c6}
@keyframes rrIn{from{opacity:0;transform:scale(1.15)}to{opacity:1;transform:scale(1)}}
.rr-lights{position:absolute;inset:-50%;background:conic-gradient(from 0deg,transparent 0 80deg,var(--glow) 90deg,transparent 100deg 260deg,var(--glow) 270deg,transparent 280deg);opacity:.18;animation:rrSpin 6s linear infinite;pointer-events:none}
@keyframes rrSpin{to{transform:rotate(360deg)}}
.rr-card{position:relative;text-align:center;max-width:520px;width:100%;max-height:100%;overflow:auto;animation:rrPop .7s cubic-bezier(.2,1.3,.4,1) .15s both}
@keyframes rrPop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
.rr h2{font-size:clamp(34px,9vw,64px);line-height:.95;letter-spacing:-.04em;margin:18px 0 10px;font-weight:1000;color:var(--white);text-shadow:0 0 28px var(--glow)}
.rr p{font-size:clamp(15px,4vw,19px);color:#d9dde6;margin:0 0 8px}#rrTimer{color:var(--gold);font-weight:900;letter-spacing:.14em;font-size:12px;min-height:18px}
#rrBtn{margin-top:18px;min-width:200px;background:var(--c);border-color:var(--c);color:#fff}.rr.hider #rrBtn{color:#04201c}
.crew-wrap{width:120px;margin:0 auto}.crew{position:relative;width:120px;height:150px;animation:rrFloat 2.4s ease-in-out infinite;filter:drop-shadow(0 0 26px var(--glow))}
@keyframes rrFloat{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-14px) rotate(3deg)}}
.crew .leg{position:absolute;bottom:0;width:34px;height:38px;background:var(--c);border-radius:8px 8px 16px 16px;box-shadow:inset -8px -6px 0 var(--cd)}.crew .leg.l{left:20px}.crew .leg.r{left:66px}
.crew .bp{position:absolute;left:0;top:46px;width:24px;height:62px;background:var(--cd);border-radius:12px 0 0 12px}
.crew .body{position:absolute;left:14px;top:0;width:92px;height:120px;background:var(--c);border-radius:46px 46px 28px 28px;box-shadow:inset -12px -10px 0 var(--cd),inset 6px 6px 0 #ffffff26}
.crew .visor{position:absolute;left:34px;top:24px;width:64px;height:40px;border-radius:22px;background:linear-gradient(145deg,#bfe9ff,#3f8fb8);box-shadow:inset -6px -5px 0 #2b5f7e}.crew .visor:after{content:'';position:absolute;left:10px;top:7px;width:18px;height:8px;border-radius:6px;background:#ffffffaa}
.rr.hunter .crew .visor{background:linear-gradient(145deg,#ffd0d0,#d3363d);box-shadow:inset -6px -5px 0 #8f141a}
.rr-shadow{width:90px;height:14px;margin:10px auto 0;border-radius:50%;background:#0008;filter:blur(4px);animation:rrShadow 2.4s ease-in-out infinite}
@keyframes rrShadow{0%,100%{transform:scale(1);opacity:.8}50%{transform:scale(.7);opacity:.45}}
@media(max-width:600px){.crew-wrap{transform:scale(.8);margin-bottom:-14px}}
</style></head><body><header class="top"><div class="top-left"><button class="navbtn" onclick="navTo('join')">JOIN GAME</button></div><div><div class="brand">MAN<span>HUNT</span></div><div class="edition">THE VEGAS INCIDENT</div></div><div class="top-right"><button class="navbtn create" onclick="navTo('create')">CREATE GAME</button></div></header><main>
<section id="homePage" class="page landing">
 <div class="eyebrow">FIELD OPERATIONS · AFTER DARK</div><h1>ONE CITY.<br><em>NO ALIBIS.</em></h1>
 <p class="tagline">The city is your playing field. Two minutes to disappear. Eighteen minutes to survive.</p>
 <div class="hero-actions"><button onclick="navTo('rules')">HOW TO PLAY · RULES</button><button class="primary" onclick="navTo('join')">ENTER A GAME</button></div>
 <div class="movie-strip"><img src="https://m.media-amazon.com/images/M/MV5BMTU2ODY2OTA0M15BMl5BanBnXkFtZTcwOTkyODU4NA%40%40._V1_.jpg" alt="The Hangover Part II — three men on the Bangkok staircase"><a href="https://wallpapers.com/wallpapers/the-hangover-part-ii-movie-posters-trio-collection-lp9re0kjf84mg9qf.html" target="_blank" rel="noopener noreferrer" style="position:absolute;right:14px;bottom:14px;color:#ddd;background:#08090d99;padding:5px 8px;border-radius:6px;font-size:9px">IMAGE CREDIT · WALLPAPERS.COM</a></div>
</section>
<section id="createPage" class="page hidden"><div class="page-card"><div class="eyebrow">HOST OPERATIONS</div><h2>Create a game.</h2><p>Set the arena and open your lobby. Share the six-character code with everyone joining.</p><label>GAME NAME</label><input id="gameTitle" placeholder="e.g. Vegas Incident"><label>STARTING SAFE-ZONE RADIUS · 100–1,000 METRES</label><input id="radius" type="number" min="100" max="1000" value="1000"><button class="primary wide" onclick="hostGame()">CREATE LOBBY</button><button class="wide" onclick="navTo('home')">BACK</button></div></section>
<section id="joinPage" class="page hidden"><div class="page-card"><div class="eyebrow">PLAYER ACCESS</div><h2>Join the hunt.</h2><p>Enter the game code supplied by the host. Your callsign is saved on this device.</p><label>GAME CODE</label><input id="joinCode" placeholder="6-CHARACTER CODE" maxlength="6" autocapitalize="characters"><label>CALLSIGN</label><input id="callsign" placeholder="Your player name" maxlength="24"><button class="primary wide" onclick="joinGame()">JOIN LOBBY</button><button class="wide" onclick="navTo('home')">BACK</button></div></section>
<section id="rulesPage" class="page hidden"><div class="page-card"><div class="eyebrow">READ BEFORE DEPLOYMENT</div><h2>Rules of the hunt.</h2><p>Everyone gets a head start. Then the clock starts and the zone begins closing in.</p>
 <div class="rules-grid"><div class="rule"><b>02:00</b><span>HIDING PHASE · Hiders get two minutes to get into position. The 18-minute round has not started yet.</span></div><div class="rule"><b>18:00</b><span>ROUND TIME · Once hiding ends, the actual game clock begins.</span></div><div class="rule"><b>03:00</b><span>ZONE SHRINK · The safe zone contracts by 20% every three minutes.</span></div><div class="rule"><b>03:00</b><span>RETURN WINDOW · Hiders outside the zone have three minutes to get back in.</span></div></div>
 <p><b>Hunters:</b> track hiders and confirm a catch using the hider's six-digit code. <b>Hiders:</b> evade capture and remain inside the shrinking zone. Hunter locations update continuously; hider location sharing is limited to one ping every three minutes. Sharing is opt-in.</p>
 <p class="warn">Play safely. No running into roads, restricted areas, private property or unsafe locations. A catch is confirmed verbally and by code; no physical contact is required.</p><button class="primary wide" onclick="navTo('home')">GOT IT · BACK TO HOME</button></div></section>
<section id="gamePage" class="page hidden">
 <div class="hero"><div><div class="eyebrow">FIELD OPERATIONS · AFTER DARK</div><h1>THE HUNT<br><em>IS ON.</em></h1><div class="sub" id="gameName">Waiting for game state…</div></div><div id="roundClock" class="hidden"><b id="timer" style="font-size:30px">18:00</b><br><small id="clockLabel">ROUND TIME REMAINING</small></div></div>
 <div id="zoneAlert" class="zone-alert" role="alert"></div><div id="statsBar" class="stats hidden"><div class="stat"><label>ACTIVE PLAYERS</label><b id="active">—</b></div><div class="stat"><label>HIDERS AT LARGE</label><b id="hiders">—</b></div><div class="stat"><label>ELIMINATIONS</label><b id="out">—</b></div><div class="stat"><label>YOUR ROLE</label><b id="role">—</b></div></div>
 <div id="mapPanel" class="panel hidden"><div class="panelhead"><b>OPERATIONS MAP</b><span id="mapMode" class="muted">LIVE</span></div><div id="map"></div><p class="muted">Zone contracts by 20% every 3 minutes. Hider GPS pings every 3 minutes; hunter updates every 5 seconds.</p></div>
 <div id="hidingNotice" class="panel hidden" style="text-align:center;margin:20px 0"><div class="eyebrow">HIDERS DEPLOY</div><h2 style="font-size:clamp(28px,5vw,46px);margin:8px">Find your hiding spot.</h2><p class="muted">The hunter cannot see hider positions during this phase. The actual 18-minute round starts when this countdown reaches zero.</p><b id="hideTimer" style="font-size:56px;color:var(--gold)">02:00</b></div>
 <div class="layout"><div class="panel"><div class="panelhead"><b>PLAYER STATUS</b><span id="mapMode2" class="muted">LOBBY</span></div><div id="roster" class="muted">No players yet.</div></div><aside class="side">
 <div class="panel"><h3>GAME CONTROL</h3><div id="lobbyControls" class="hidden"><p class="muted">Lobby code: <b id="code" class="good"></b></p><p class="muted">Waiting for players. The host starts the 2-minute hiding phase when everyone is ready.</p></div><div id="hostControls" class="hidden"><button class="primary wide" onclick="startGame()">START · 2-MINUTE HIDING PHASE</button></div>
 <div id="liveControls" class="hidden"><div id="hunterPanel" class="hidden"><h3>HUNTER BRIEFING</h3><p class="muted">You are the HUNTER. Track the hiders. When a player is caught, ask for their six-digit code and confirm it in the roster.</p></div><div id="hiderPanel" class="hidden"><h3>HIDER BRIEFING</h3><p class="muted">You are a HIDER. Evade the hunter and stay inside the shrinking zone.</p><p>Your one-time catch code:</p><div id="catchCode" style="font-size:28px;font-weight:900;letter-spacing:.2em;color:var(--gold)">------</div><p class="muted">Only share this code when you have been caught.</p></div><button class="primary wide" id="gps" onclick="toggleGPS()">ENABLE LOCATION SHARING</button><button class="wide" onclick="report()">REPORT SIGHTING</button><div id="hostRoundControls" class="hidden"><button class="wide" id="pauseBtn" onclick="controlRound()">PAUSE GAME</button><button class="wide" onclick="controlRound('end')">END GAME</button></div><div id="hideHostControls" class="hidden"><button class="wide" onclick="controlRound('end')">CANCEL GAME</button></div></div><div id="leaveControls" class="hidden"><button class="wide" onclick="leave()">LEAVE GAME</button></div></div>
 <div class="panel"><h3>INCIDENT FEED</h3><div id="feed" class="muted">No incidents yet.</div></div></aside></div>
</section><footer></footer></main>
<div id="roleReveal" class="rr hidden" role="dialog" aria-modal="true" aria-labelledby="rrTitle"><div class="rr-lights"></div><div class="rr-card"><div class="crew-wrap"><div class="crew"><div class="leg l"></div><div class="leg r"></div><div class="bp"></div><div class="body"><div class="visor"></div></div></div><div class="rr-shadow"></div></div><h2 id="rrTitle"></h2><p id="rrSub"></p><div id="rrTimer"></div><button id="rrBtn" type="button">LET'S GO</button></div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
let me=null,G=null,map=null,markers={},circle=null,watch=null,gpsTimer=null,latestPosition=null,lastHiderPing=0,events=null,zoneAlertTimer=null;
const $=x=>document.getElementById(x);
async function req(url,data){let r=await fetch(url,{method:data?'POST':'GET',headers:data?{'content-type':'application/json'}:{},body:data?JSON.stringify(data):undefined});let j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j}
async function boot(){
 try{
  let j;
  try{j=await req('/api/me');}
  catch(e){
   if(!navigator.onLine)throw e;
   let callsign=localStorage.getItem('mh_callsign')||'';
   if(!callsign){callsign=prompt('Choose your MANHUNT callsign:')||'PLAYER';callsign=callsign.trim().slice(0,24)||'PLAYER';localStorage.setItem('mh_callsign',callsign);}
   j=await req('/api/guest',{name:callsign});
  }
  me=j.user;G=j.game;if(G){navTo('game');render(G);connectEvents();}else navTo('home');
 }catch(e){alert('Could not enter MANHUNT: '+e.message);}
}
function navTo(page){
 const ids={home:'homePage',create:'createPage',join:'joinPage',rules:'rulesPage',game:'gamePage'};
 Object.values(ids).forEach(id=>$(id).classList.add('hidden'));
 $(ids[page]||ids.home).classList.remove('hidden');
 window.scrollTo({top:0,behavior:'smooth'});
}
function ensureMap(){
 if(!map){map=L.map('map').setView([20,0],2);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',maxZoom:19}).addTo(map);}
 setTimeout(()=>map.invalidateSize(),80);
}
function showLobby(){$('lobbyControls').classList.remove('hidden');$('hostControls').classList.add('hidden');$('liveControls').classList.add('hidden');$('leaveControls').classList.add('hidden')}
async function hostGame(){try{let pos=await gpsOnce();let j=await req('/api/host',{name:$('gameTitle').value||'Vegas Incident',lat:pos.coords.latitude,lng:pos.coords.longitude,radius:Number($('radius').value)||1000});G=j.game;navTo('game');render(G);connectEvents()}catch(e){alert(e.message)}}
async function joinGame(){try{let j=await req('/api/join',{code:$('joinCode').value.trim().toUpperCase(),callsign:$('callsign').value||me.name});G=j.game;navTo('game');render(G);connectEvents()}catch(e){alert(e.message)}}
function gpsOnce(){return new Promise((resolve,reject)=>{if(!navigator.geolocation)return reject(Error('GPS unavailable'));navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:15000})})}
async function startGame(){try{let j=await req('/api/start',{});render(j.game)}catch(e){alert(e.message)}}
function distanceMeters(a,b){const r=x=>x*Math.PI/180,R=6371000,d1=r(b.lat-a.lat),d2=r(b.lng-a.lng),q=Math.sin(d1/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(d2/2)**2;return 2*R*Math.asin(Math.sqrt(q));}
function stopGPS(){if(watch!==null)navigator.geolocation.clearWatch(watch);if(gpsTimer!==null)clearInterval(gpsTimer);watch=null;gpsTimer=null;latestPosition=null;}
async function toggleGPS(){
 if(watch!==null){stopGPS();$('gps').textContent='ENABLE LOCATION SHARING';return;}
 if(!G||G.status!=='LIVE')return alert('GPS is available once the live round begins.');
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
async function leave(){if(!confirm('Leave this game?'))return;stopGPS();try{await req('/api/leave',{});if(events){events.close();events=null;}G=null;markers&&Object.values(markers).forEach(m=>{try{map.removeLayer(m)}catch{}});markers={};if(circle){try{map.removeLayer(circle)}catch{}circle=null;}$('gameName').textContent='Create a lobby or join with a code.';$('timer').textContent='18:00';$('active').textContent='—';$('hiders').textContent='—';$('out').textContent='—';$('role').textContent='—';$('mapMode').textContent='LOBBY';$('roster').textContent='No players yet.';$('feed').textContent='No incidents yet.';$('zoneAlert').classList.remove('on');$('zoneAlert').textContent='';render(null);navTo('home');}catch(e){alert('Could not leave game: '+e.message)}}
function connectEvents(){if(events)events.close();events=new EventSource('/api/events');events.onmessage=e=>{let j=JSON.parse(e.data);if(j.game){G=j.game;render(G)}}}
function render(g){
 if(!g){
  $('roleReveal').classList.add('hidden');$('roundClock').classList.add('hidden');$('statsBar').classList.add('hidden');$('mapPanel').classList.add('hidden');$('hidingNotice').classList.add('hidden');
  G=null;$('zoneAlert').classList.remove('on');$('zoneAlert').textContent='';$('gameName').textContent='Create a lobby or join with a code.';
  $('timer').textContent='18:00';$('active').textContent='—';$('hiders').textContent='—';$('out').textContent='—';$('role').textContent='—';
  $('roster').textContent='No players yet.';$('feed').textContent='No incidents yet.';
  $('lobbyControls').classList.add('hidden');$('hostControls').classList.add('hidden');$('liveControls').classList.add('hidden');$('leaveControls').classList.add('hidden');$('hostRoundControls').classList.add('hidden');$('hideHostControls').classList.add('hidden');$('hunterPanel').classList.add('hidden');$('hiderPanel').classList.add('hidden');
  for(const m of Object.values(markers)){if(map)map.removeLayer(m)}markers={};if(circle&&map){map.removeLayer(circle);circle=null;}
  return;
 }
 G=g;navTo('game');maybeReveal(g);$('gameName').textContent=g.name+' · CODE '+g.code;$('code').textContent=g.code;$('mapMode').textContent=g.status;$('mapMode2').textContent=g.status;
 $('role').textContent=g.me?.role==='HUNTER'?'HUNTER':g.me?.role==='HIDER'?'HIDER':'—';
 $('active').textContent=g.players.filter(p=>p.status==='ACTIVE').length;$('hiders').textContent=g.players.filter(p=>p.role==='HIDER'&&p.status==='ACTIVE').length;$('out').textContent=g.players.filter(p=>p.status!=='ACTIVE').length;
 const started=['LIVE','PAUSED','FINISHED'].includes(g.status),isHiding=g.status==='HIDING';
 $('mapPanel').classList.toggle('hidden',!started);$('statsBar').classList.toggle('hidden',!started);$('hidingNotice').classList.toggle('hidden',!isHiding);
 $('roundClock').classList.toggle('hidden',!started);
 if(isHiding&&g.hideEndsAt){$('clockLabel').textContent='HIDING PHASE';}
 else $('clockLabel').textContent='ROUND TIME REMAINING';
 const alertBox=$('zoneAlert');if(g.me?.role==='HIDER'&&g.me.outsideSince&&g.status==='LIVE'){const remaining=Math.max(0,180-Math.floor((Date.now()-g.me.outsideSince)/1000));alertBox.classList.add('on');alertBox.textContent='YOU ARE OUTSIDE THE SAFE ZONE · RETURN NOW · ELIMINATION IN '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0');}else{alertBox.classList.remove('on');alertBox.textContent='';}
 $('lobbyControls').classList.toggle('hidden',g.status!=='LOBBY');$('hostControls').classList.toggle('hidden',!(g.status==='LOBBY'&&g.hostId===me.id));
 $('liveControls').classList.toggle('hidden',!['HIDING','LIVE','PAUSED'].includes(g.status));$('leaveControls').classList.remove('hidden');
 $('hunterPanel').classList.toggle('hidden',g.me?.role!=='HUNTER');$('hiderPanel').classList.toggle('hidden',g.me?.role!=='HIDER');$('catchCode').textContent=g.me?.catchCode||'------';
 $('hostRoundControls').classList.toggle('hidden',g.hostId!==me.id||!['LIVE','PAUSED'].includes(g.status));$('hideHostControls').classList.toggle('hidden',g.hostId!==me.id||g.status!=='HIDING');
 $('pauseBtn').textContent=g.status==='PAUSED'?'RESUME GAME':'PAUSE GAME';$('pauseBtn').disabled=g.status==='FINISHED';
 $('gps').textContent=watch!==null?'STOP LOCATION SHARING':'ENABLE LOCATION SHARING';$('gps').disabled=g.status!=='LIVE'&&watch===null;
 $('roster').innerHTML=g.players.map(p=>'<div class="player'+(p.role==='HUNTER'?' is-hunter':'')+'"><b>'+esc(p.name)+'</b> '+(p.role==='HUNTER'?'<span class="badge hunter">★ HUNTER</span>':p.role==='HIDER'?'<span class="badge hider">HIDER</span>':'')+' <span class="pill">'+esc(p.status)+'</span>'+(g.status==='LIVE'&&g.me?.role==='HUNTER'&&p.role==='HIDER'&&p.status==='ACTIVE'?' <button onclick="tagPlayer(\''+esc(p.id)+'\')">CONFIRM CAUGHT</button>':'')+'</div>').join('')||'No players yet';
 $('feed').innerHTML=g.incidents.slice(-8).reverse().map(x=>'<div class="feed">'+esc(x.message)+'<br><small>'+new Date(x.at).toLocaleTimeString()+'</small></div>').join('')||'No incidents yet';
 if(isHiding&&g.hideEndsAt){const sec=Math.max(0,Math.ceil((g.hideEndsAt-Date.now())/1000));$('hideTimer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');$('timer').textContent=$('hideTimer').textContent;}
 if(started){
  ensureMap();
  if(g.roundStartedAt&&g.roundEndsAt){const clockNow=g.pausedAt||g.endedAt||Date.now();const sec=Math.max(0,Math.ceil((g.roundEndsAt-clockNow)/1000));$('timer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');}
  if(g.zone){const c=[g.zone.center.lat,g.zone.center.lng];if(!circle){circle=L.circle(c,{radius:g.zone.radius,color:'#e43d42',fillOpacity:.08}).addTo(map);map.setView(c,15)}else{circle.setLatLng(c);circle.setRadius(g.zone.radius)}}
  const seenMarkers=new Set();for(const p of g.players){if(!p.location||p.status!=='ACTIVE')continue;seenMarkers.add(p.id);let pos=[p.location.lat,p.location.lng],iconHtml=p.id===me.id?'<div class="you-marker"></div>':p.role==='HUNTER'?'<div class="hunter-marker"></div>':'<div class="hider-marker"></div>';if(!markers[p.id])markers[p.id]=L.marker(pos,{icon:L.divIcon({className:'',html:iconHtml,iconSize:p.id===me.id?[160,30]:[28,28],iconAnchor:p.id===me.id?[13,13]:[14,14]})}).addTo(map).bindPopup(esc(p.id===me.id?'YOU ARE HERE':p.role==='HUNTER'?'HUNTER · '+p.name:'HIDER · '+p.name));else{markers[p.id].setLatLng(pos);markers[p.id].setIcon(L.divIcon({className:'',html:iconHtml,iconSize:p.id===me.id?[160,30]:[28,28],iconAnchor:p.id===me.id?[13,13]:[14,14]}));}}
  for(const id of Object.keys(markers)){if(!seenMarkers.has(id)){map.removeLayer(markers[id]);delete markers[id];}}
 }else{
  if(map){for(const m of Object.values(markers))map.removeLayer(m);markers={};if(circle){map.removeLayer(circle);circle=null;}}
 }
}
const revealSeen=new Set();
function maybeReveal(g){
 if(!g||!g.me||!me||!['HIDING','LIVE','PAUSED'].includes(g.status))return;
 const role=g.me.role;if(role!=='HUNTER'&&role!=='HIDER')return;
 const key='mh_reveal_'+g.id+'_'+me.id;
 if(revealSeen.has(key))return;revealSeen.add(key);
 let seen=false;try{seen=!!localStorage.getItem(key)}catch(e){}
 if(seen)return;
 try{localStorage.setItem(key,'1')}catch(e){}
 showReveal(role);
}
function showReveal(role){
 const o=$('roleReveal'),hunter=role==='HUNTER';
 o.className='rr '+(hunter?'hunter':'hider');
 $('rrTitle').textContent=hunter?'YOU ARE THE HUNTER':'YOU ARE A HIDER';
 $('rrSub').textContent=hunter?'Find the hiders before time runs out.':'Use your head start. Stay out of sight.';
 updateRevealTimer();
}
function updateRevealTimer(){
 const o=$('roleReveal');if(o.classList.contains('hidden'))return;
 if(G&&G.status==='HIDING'&&G.hideEndsAt){const sec=Math.max(0,Math.ceil((G.hideEndsAt-Date.now())/1000));$('rrTimer').textContent='HIDING PHASE · '+String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');}else $('rrTimer').textContent='';
}
$('rrBtn').onclick=()=>$('roleReveal').classList.add('hidden');
setInterval(updateRevealTimer,1000);
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function act(url,data){try{await req(url,data);location.reload()}catch(e){alert(e.message)}}
setInterval(()=>{if(G?.status==='HIDING'&&G.hideEndsAt){const sec=Math.max(0,Math.ceil((G.hideEndsAt-Date.now())/1000));$('hideTimer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');$('timer').textContent=$('hideTimer').textContent;}if(G&&G.roundStartedAt&&G.roundEndsAt){const clockNow=G.pausedAt||Date.now();const sec=Math.max(0,Math.ceil((G.roundEndsAt-clockNow)/1000));$('timer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');}if(G&&G.me?.role==='HIDER'&&G.me.outsideSince&&G.status==='LIVE'){const left=Math.max(0,180-Math.floor((Date.now()-G.me.outsideSince)/1000));$('zoneAlert').classList.add('on');$('zoneAlert').textContent='YOU ARE OUTSIDE THE SAFE ZONE · RETURN NOW · ELIMINATION IN '+Math.floor(left/60)+':'+String(left%60).padStart(2,'0');}},1000);
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
