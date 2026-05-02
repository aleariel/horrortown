/**
 * Horror Town — Servidor Multijugador v3.0
 * Node.js + Socket.io
 * Ejecutar: node server.js
 */
const http = require('http');
const path = require('path');
const fs   = require('fs');

// ─── Minimal HTTP server (serves client.html + assets) ───────────────────────
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html':'text/html','.js':'application/javascript',
  '.css':'text/css','.ico':'image/x-icon','.png':'image/png'
};

const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/client.html' : req.url;
  filePath = path.join(__dirname, '..', filePath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain',
                          'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
const { Server } = require('socket.io');
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 30000,
  pingInterval: 10000
});

// ─── Game Data ────────────────────────────────────────────────────────────────
const MONSTERS = {
  1:[{e:'🧛',n:'Vampiro',o:1},{e:'🐊',n:'Pantano',o:2},{e:'🐺',n:'H.Lobo',o:3},{e:'🏺',n:'Momia',o:4}],
  2:[{e:'👤',n:'Invisible',o:1},{e:'🧟',n:'Zombie',o:2},{e:'🛸',n:'Marciano',o:3},{e:'⚡',n:'Frankenstein',o:4}],
  3:[{e:'🐕',n:'Cadejos',o:1},{e:'👻',n:'Sin Cabeza',o:2},{e:'😭',n:'Llorona',o:3},{e:'🐴',n:'Segua',o:4}]
};
const ROLES = [
  {id:'alcalde',  e:'🎩',n:'El Alcalde',     p:'Voto definitivo en empates de hoguera.',             u:'ilim'},
  {id:'policia',  e:'👮',n:'El Policía',      p:'Bloquea una zona del mapa permanentemente.',          u:'once'},
  {id:'porrista', e:'📣',n:'La Porrista',     p:'Su voto en hoguera cuenta doble.',                    u:'once'},
  {id:'chismosa', e:'🗣️',n:'La Chismosa',    p:'Ve la carta oculta de otro jugador.',                 u:'once'},
  {id:'cientifico',e:'🔬',n:'El Científico', p:'Intercambia dos jugadores de zona.',                  u:'once'},
  {id:'sacerdote',e:'✝️',n:'El Sacerdote',   p:'Salva al condenado en la hoguera.',                   u:'once'},
  {id:'sepulturero',e:'⚰️',n:'El Sepulturero',p:'Anula el poder de un jugador.',                     u:'once'},
  {id:'famosa',   e:'🌟',n:'La Famosa',       p:'Protección total en Plaza una ronda.',                u:'once'},
  {id:'granjera', e:'🌽',n:'La Granjera',     p:'Esconde a otro jugador una ronda completa.',          u:'once'},
  {id:'rebelde',  e:'✊',n:'El Rebelde',      p:'Puede ser el 4to en una zona.',                       u:'once'},
  {id:'lenador',  e:'🪓',n:'El Leñador',      p:'Sobrevive un ataque; 1 ronda inactivo en Plaza.',     u:'once'},
  {id:'bibliotecaria',e:'📚',n:'La Bibliotecaria',p:'Silencia el voto de un jugador en hoguera.',    u:'once'}
];
const ZONES = ['plaza','bosque','lago','mansion','sembrad','iglesia','policia','biblio','cementerio','univ'];
const ADJ = {
  bosque:['univ','lago'], lago:['bosque','mansion'], mansion:['lago','sembrad'],
  sembrad:['mansion','iglesia'], iglesia:['sembrad','policia'], policia:['iglesia','biblio'],
  biblio:['policia','cementerio'], cementerio:['biblio','univ'], univ:['cementerio','bosque']
};

// ─── Room store ───────────────────────────────────────────────────────────────
const rooms = {}; // roomId → { players, G, timer }

function shuffle(a){const b=[...a];for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];}return b;}
function numMon(n){return n<=4?1:n<=6?2:n<=9?3:4;}

// ─── Sanitize state for a viewer ─────────────────────────────────────────────
function sanitize(G, viewerId) {
  const s = JSON.parse(JSON.stringify(G));
  const viewer = s.players.find(p => p.id === viewerId);
  const iMon = viewer?.isMon;
  const known = iMon ? getKnown(G, viewerId) : [];
  s.players = s.players.map(p => {
    if (p.id === viewerId || p.eliminated) return p;
    if (iMon && known.includes(p.id)) return p;
    return { ...p, isMon: false, monOrder: null, monE: null, monN: null };
  });
  return s;
}
function getKnown(G, pid) {
  const k = [];
  (G.knowledge || []).forEach(pair => {
    if (pair.includes(pid)) pair.forEach(id => { if (id !== pid) k.push(id); });
  });
  return k;
}

// ─── Broadcast state to all in room ──────────────────────────────────────────
function broadcastState(room) {
  const { G, players } = room;
  players.forEach(p => {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit('state', sanitize(G, p.id));
  });
}

function emitToPlayer(room, pid, event, data) {
  const p = room.players.find(x => x.id === pid);
  if (!p) return;
  const sock = io.sockets.sockets.get(p.socketId);
  if (sock) sock.emit(event, data);
}

function emitAll(room, event, data) {
  room.players.forEach(p => {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit(event, data);
  });
}

// ─── Build initial game state ─────────────────────────────────────────────────
function buildGame(players, cfg) {
  const n = players.length;
  const nMon = numMon(n);
  const monGroup = shuffle(MONSTERS[cfg.group]).slice(0, nMon);

  let pool = [...ROLES];
  pool.splice(pool.findIndex(r => r.id === 'alcalde'), 1);
  pool = shuffle(pool);
  const pubRoles = shuffle([ROLES[0], ...pool.slice(0, n - 1)]);

  const hiddenPool = shuffle([
    ...monGroup.map(m => ({ isMon: true, monE: m.e, monN: m.n, monOrder: m.o })),
    ...Array(n - nMon).fill(null).map(() => ({ isMon: false, monE: null, monN: null, monOrder: null }))
  ]);

  const zoneState = {};
  ZONES.forEach(z => { zoneState[z] = { blocked: false, players: [] }; });

  const gamePlayers = players.map((p, i) => ({
    id: p.id, name: p.name,
    pubRole: pubRoles[i].id,
    isMon: hiddenPool[i].isMon,
    monOrder: hiddenPool[i].monOrder,
    monE: hiddenPool[i].monE,
    monN: hiddenPool[i].monN,
    eliminated: false, zone: 'plaza', prevZone: null,
    powerUsed: false, inRecovery: false, silenced: false,
    hidden: false, famosaActive: false, connected: true
  }));

  gamePlayers.forEach(p => zoneState['plaza'].players.push(p.id));

  return {
    players: gamePlayers,
    zones: zoneState,
    phase: 'morning', round: 1,
    lunarIdx: 0, lunarCycle: 0, nightCount: 0,
    group: cfg.group, diff: cfg.diff,
    threat: nMon,
    gameOver: false, winner: null,
    hostId: players[0].id,
    mainId: players[0].id,
    nightQueue: [], nightQIdx: 0, activeAtk: null,
    nightVictims: [],
    consVotes: {}, torchVotes: {},
    knowledge: [], revealed: {},
    log: []
  };
}

function addLog(G, msg, cls = '') {
  G.log.unshift({ msg, cls, t: Date.now() });
  if (G.log.length > 50) G.log.pop();
}

function rmZone(G, p) {
  if (p.zone && G.zones[p.zone]) {
    G.zones[p.zone].players = G.zones[p.zone].players.filter(x => x !== p.id);
  }
}

function alivePlayers(G) { return G.players.filter(p => !p.eliminated); }
function aliveMons(G)    { return G.players.filter(p => !p.eliminated && p.isMon); }
function aliveVils(G)    { return G.players.filter(p => !p.eliminated && !p.isMon); }

function buildNightQ(G) {
  return aliveMons(G).sort((a, b) => a.monOrder - b.monOrder).map(p => p.id);
}

function updateKnowledge(G) {
  const { diff, lunarIdx, round } = G;
  const mons = aliveMons(G).sort((a, b) => a.monOrder - b.monOrder);
  const addK = (a, b) => {
    if (!a || !b || a === b) return;
    if (!G.knowledge.find(p => (p[0]===a&&p[1]===b)||(p[0]===b&&p[1]===a)))
      G.knowledge.push([a, b]);
  };
  if (diff === 'impossible') {
    for (let i = 0; i < mons.length; i++) for (let j = i+1; j < mons.length; j++) addK(mons[i].id, mons[j].id);
    return;
  }
  if (diff === 'hard') {
    for (let i = 0; i < Math.min(round, mons.length); i++)
      for (let j = i+1; j < Math.min(round, mons.length); j++) addK(mons[i].id, mons[j].id);
    return;
  }
  if (lunarIdx >= 1 && mons.length >= 2) addK(mons[0]?.id, mons[1]?.id);
  if (lunarIdx >= 2) for (let i = 0; i < mons.length; i++) for (let j = i+1; j < mons.length; j++) addK(mons[i].id, mons[j].id);
}

function checkVictory(room) {
  const { G } = room;
  if (G.gameOver) return;
  if (aliveMons(G).length === 0) { G.gameOver = true; G.winner = 'villagers'; endGame(room); }
  else if (aliveVils(G).length === 0) { G.gameOver = true; G.winner = 'monsters'; endGame(room); }
}

function endGame(room) {
  broadcastState(room);
  emitAll(room, 'game_over', { winner: room.G.winner, players: room.G.players });
}

function eliminatePlayer(room, pid, reason) {
  const { G } = room;
  const p = G.players.find(x => x.id === pid);
  if (!p || p.eliminated) return;
  const wasZone = p.zone; // BUG FIX: save before nulling
  p.eliminated = true; p.elimReason = reason;
  rmZone(G, p); p.zone = null;
  if (reason === 'night' && wasZone && wasZone !== 'plaza') G.zones[wasZone].blocked = true;
  if (p.isMon) G.threat = Math.max(0, G.threat - 1);
  G.revealed[pid] = { isMon: p.isMon, monN: p.monN, monE: p.monE };
  addLog(G, `💀 ${p.name} — ${p.isMon ? p.monN : 'Aldeano'}${reason==='bonfire'?' (hoguera)':''}`, p.isMon ? 'gd' : 'bl');
  // Broadcast reveal to all
  emitAll(room, 'reveal', { player: { ...p }, survived: false });
}

function startNight(room) {
  const { G } = room;
  G.phase = 'night';
  G.nightVictims = [];
  G.nightQueue = buildNightQ(G);
  G.nightQIdx = 0; G.activeAtk = null;
  updateKnowledge(G);
  addLog(G, '── Noche ──', 'bl');
  broadcastState(room);
  setTimeout(() => nextAttacker(room), 800);
}

function nextAttacker(room) {
  const { G } = room;
  const maxAtk = G.lunarIdx === 3 ? 2 : 1;
  if (G.nightQIdx >= Math.min(maxAtk, G.nightQueue.length)) {
    G.activeAtk = null;
    broadcastState(room);
    return;
  }
  const pid = G.nightQueue[G.nightQIdx++];
  G.activeAtk = pid;
  broadcastState(room);
  // Send attack prompt to this monster
  emitToPlayer(room, pid, 'your_attack_turn', { G: sanitize(G, pid) });
}

function resolveNight(room) {
  const { G } = room;
  G.nightCount++;
  // Advance lunar AFTER first night
  if (G.nightCount > 1) {
    G.lunarIdx = (G.lunarIdx + 1) % 4;
    if (G.lunarIdx === 0) G.lunarCycle++;
  }

  const victims = [...new Set(G.nightVictims)];
  victims.forEach(vid => {
    const p = G.players.find(x => x.id === vid);
    if (!p || p.eliminated) return;
    if (p.pubRole === 'lenador' && !p.powerUsed) {
      p.powerUsed = true; p.inRecovery = true;
      rmZone(G, p); p.zone = 'plaza'; G.zones['plaza'].players.push(vid);
      G.revealed[vid] = { isMon: p.isMon, monN: p.monN, monE: p.monE };
      addLog(G, `🪓 ${p.name} sobrevivió el ataque. Inactivo 1 ronda.`, 'gd');
      emitAll(room, 'reveal', { player: { ...p }, survived: true });
    } else {
      eliminatePlayer(room, vid, 'night');
    }
  });
  if (victims.length === 0) addLog(G, 'La noche pasa sin víctimas.');

  checkVictory(room);
  if (G.gameOver) return;

  if (G.round === 1) {
    startNewRound(room);
  } else {
    G.phase = 'noon'; G.consVotes = {};
    addLog(G, '── Mediodía ──', 'gd');
    broadcastState(room);
  }
}

function startNewRound(room) {
  const { G } = room;
  G.round++; G.phase = 'morning';
  G.consVotes = {}; G.torchVotes = {};
  G.nightVictims = []; G.nightQIdx = 0; G.activeAtk = null;
  G.players.forEach(p => {
    if (!p.eliminated) {
      p.prevZone = p.zone;
      rmZone(G, p); p.zone = 'plaza';
      if (p.inRecovery) p.inRecovery = false;
      p.silenced = false; p.hidden = false; p.famosaActive = false;
    }
  });
  G.zones['plaza'].players = [];
  G.players.filter(p => !p.eliminated).forEach(p => G.zones['plaza'].players.push(p.id));
  const al = alivePlayers(G);
  const ci = al.findIndex(p => p.id === G.mainId);
  G.mainId = al[(ci + 1) % al.length].id;
  addLog(G, `── Ronda ${G.round} ──`, 'gd');
  broadcastState(room);
}

function resolveTorch(room) {
  const { G } = room;
  const counts = {};
  Object.values(G.torchVotes).forEach(t => { if (t != null && !counts[t]) counts[t] = 0; });
  Object.entries(G.torchVotes).forEach(([voter, target]) => {
    if (target == null) return;
    const v = G.players.find(p => p.id === voter);
    const mult = (v?.pubRole === 'porrista' && !v.powerUsed) ? 2 : 1;
    if (v?.pubRole === 'porrista' && !v.powerUsed) v.powerUsed = true;
    if (counts[target] !== undefined) counts[target] += mult;
  });
  if (!Object.keys(counts).length) { addLog(G,'Sin votos. No hay ejecución.'); startNight(room); return; }
  const maxV = Math.max(...Object.values(counts));
  if (maxV === 0) { addLog(G,'Sin votos.'); startNight(room); return; }
  const cond = Object.entries(counts).filter(([, v]) => v === maxV).map(([id]) => id);
  const finalId = cond[0];
  if (cond.length > 1) addLog(G, `Empate — El Alcalde decide: ${G.players.find(p=>p.id===finalId)?.name}`);
  addLog(G, `🔥 ${G.players.find(p=>p.id===finalId)?.name} es condenado.`, 'bl');
  eliminatePlayer(room, finalId, 'bonfire');
  checkVictory(room);
  if (!G.gameOver) startNight(room);
}

// ─── Power resolution ─────────────────────────────────────────────────────────
function resolvePower(room, pid, payload) {
  const { G } = room;
  const p = G.players.find(x => x.id === pid);
  if (!p || p.powerUsed || p.eliminated) return;
  const { zoneId, targetId, target2Id } = payload;

  switch (p.pubRole) {
    case 'policia': {
      if (!zoneId || zoneId === 'plaza' || !G.zones[zoneId]) return;
      G.zones[zoneId].blocked = true;
      G.players.filter(x => !x.eliminated && x.zone === zoneId).forEach(x => {
        rmZone(G, x); x.zone = 'plaza'; G.zones['plaza'].players.push(x.id);
      });
      G.zones[zoneId].players = [];
      p.powerUsed = true;
      addLog(G, `👮 ${p.name} bloqueó zona.`, 'gd'); break;
    }
    case 'chismosa': {
      if (!targetId) return;
      const t = G.players.find(x => x.id === targetId);
      if (!t || t.eliminated) return;
      p.powerUsed = true;
      const info = t.isMon ? `🧛 MONSTRUO: ${t.monN}` : '👤 HUMANO';
      emitToPlayer(room, pid, 'whisper', { msg: `Carta de ${t.name}: ${info}`, secret: true });
      addLog(G, `🗣️ La Chismosa usó su poder.`); break;
    }
    case 'cientifico': {
      if (!targetId || !target2Id) return;
      const a = G.players.find(x => x.id === targetId), b = G.players.find(x => x.id === target2Id);
      if (!a || !b || a.eliminated || b.eliminated) return;
      if (G.zones[a.zone]) G.zones[a.zone].players = G.zones[a.zone].players.map(x => x===targetId ? target2Id : x);
      if (G.zones[b.zone]) G.zones[b.zone].players = G.zones[b.zone].players.map(x => x===target2Id ? targetId : x);
      [a.zone, b.zone] = [b.zone, a.zone];
      p.powerUsed = true;
      addLog(G, `🔬 ${a.name} ↔ ${b.name}`, 'gd'); break;
    }
    case 'sacerdote': {
      if (!targetId) return;
      const t = G.players.find(x => x.id === targetId);
      if (!t || !t.eliminated) return;
      t.eliminated = false; t.elimReason = null; t.zone = 'plaza';
      G.zones['plaza'].players.push(targetId);
      if (t.isMon) G.threat = Math.min(numMon(G.players.length), G.threat + 1);
      p.powerUsed = true;
      addLog(G, `✝️ Sacerdote salvó a ${t.name}!`, 'gd'); break;
    }
    case 'sepulturero': {
      if (!targetId) return;
      const t = G.players.find(x => x.id === targetId);
      if (!t || t.eliminated || t.pubRole === 'alcalde') return;
      t.powerUsed = true; p.powerUsed = true;
      addLog(G, `⚰️ Sepulturero anuló poder de ${t.name}.`, 'bl'); break;
    }
    case 'famosa': {
      p.powerUsed = true; p.famosaActive = true;
      rmZone(G, p); p.zone = 'plaza'; G.zones['plaza'].players.push(pid);
      addLog(G, `🌟 La Famosa se protegió en la Plaza.`, 'gd'); break;
    }
    case 'granjera': {
      if (!targetId || targetId === pid) return;
      const t = G.players.find(x => x.id === targetId);
      if (!t || t.eliminated) return;
      t.hidden = true; p.powerUsed = true;
      addLog(G, `🌽 Granjera escondió a ${t.name}.`, 'gd'); break;
    }
    case 'rebelde': {
      if (!zoneId || !G.zones[zoneId] || G.zones[zoneId].blocked) return;
      rmZone(G, p); p.zone = zoneId; G.zones[zoneId].players.push(pid);
      p.powerUsed = true;
      addLog(G, `✊ Rebelde: 4to en zona.`, 'gd'); break;
    }
    case 'porrista': { p.powerUsed = true; addLog(G, `📣 Porrista activa voto doble.`, 'gd'); break; }
    case 'bibliotecaria': {
      if (!targetId) return;
      const t = G.players.find(x => x.id === targetId);
      if (!t || t.eliminated) return;
      t.silenced = true; p.powerUsed = true;
      addLog(G, `📚 Bibliotecaria silenció a ${t.name}.`, 'bl'); break;
    }
  }
  broadcastState(room);
}

// ─── Socket.io events ─────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  // Create room
  socket.on('create_room', ({ name, group, diff }, cb) => {
    const roomId = 'HT-' + Math.random().toString(36).slice(2,7).toUpperCase();
    const player = { id: socket.id, socketId: socket.id, name, isHost: true };
    rooms[roomId] = { id: roomId, players: [player], G: null, cfg: { group, diff } };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = socket.id;
    cb({ ok: true, roomId, playerId: socket.id });
    console.log(`[ROOM] ${roomId} created by ${name}`);
  });

  // Join room
  socket.on('join_room', ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if (!room) { cb({ ok: false, error: 'Sala no encontrada.' }); return; }
    if (room.G) { cb({ ok: false, error: 'La partida ya comenzó.' }); return; }
    if (room.players.length >= 12) { cb({ ok: false, error: 'Sala llena (máx 12).' }); return; }
    const player = { id: socket.id, socketId: socket.id, name, isHost: false };
    room.players.push(player);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = socket.id;
    // Notify everyone of new player list
    io.to(roomId).emit('lobby_update', { players: room.players.map(p=>({id:p.id,name:p.name,isHost:p.isHost})) });
    cb({ ok: true, roomId, playerId: socket.id });
    console.log(`[ROOM] ${name} joined ${roomId}`);
  });

  // Start game (host only)
  socket.on('start_game', (_, cb) => {
    const room = rooms[socket.data.roomId];
    if (!room) { cb?.({ ok: false }); return; }
    if (socket.id !== room.players[0].id) { cb?.({ ok: false, error: 'Solo el anfitrión puede iniciar.' }); return; }
    if (room.players.length < 2) { cb?.({ ok: false, error: 'Se necesitan al menos 2 jugadores.' }); return; }
    room.G = buildGame(room.players, room.cfg);
    // Send each player their private data + sanitized state
    room.players.forEach(p => {
      const gp = room.G.players.find(x => x.id === p.id);
      const priv = { isMon: gp.isMon, monE: gp.monE, monN: gp.monN, monOrder: gp.monOrder };
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('game_start', { G: sanitize(room.G, p.id), priv });
    });
    addLog(room.G, '¡La partida comienza!', 'gd');
    cb?.({ ok: true });
    console.log(`[GAME] ${room.id} started with ${room.players.length} players`);
  });

  // Player action
  socket.on('action', ({ action, payload }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.G || room.G.gameOver) return;
    const pid = socket.id;
    const G = room.G;

    if (action === 'move') {
      const p = G.players.find(x => x.id === pid);
      if (!p || p.eliminated || p.inRecovery || G.phase !== 'morning') return;
      const zid = payload.zoneId;
      const z = G.zones[zid];
      if (!z || z.blocked) { socket.emit('err', 'Zona bloqueada.'); return; }
      if (zid !== 'plaza' && p.prevZone === zid) { socket.emit('err', 'No puedes repetir zona anterior.'); return; }
      const inZone = G.players.filter(x => !x.eliminated && x.zone === zid);
      if (zid !== 'plaza' && inZone.length >= 3) { socket.emit('err', 'Zona llena (máx 3).'); return; }
      rmZone(G, p); p.zone = zid; z.players.push(pid);
      addLog(G, `${p.name} se movió a ${zid}`);
      broadcastState(room);
    }

    else if (action === 'adv_phase') {
      if (pid !== G.hostId && pid !== G.mainId) return;
      if (G.phase === 'morning') { G.phase = 'afternoon'; addLog(G,'── Tarde ──','gd'); broadcastState(room); }
      else if (G.phase === 'afternoon') startNight(room);
    }

    else if (action === 'cons_vote') {
      if (G.phase !== 'noon') return;
      const p = G.players.find(x => x.id === pid);
      if (!p || p.eliminated) return;
      G.consVotes[pid] = payload.vote;
      broadcastState(room);
      const al = alivePlayers(G);
      if (Object.keys(G.consVotes).length >= al.length) {
        const yes = Object.values(G.consVotes).filter(Boolean).length;
        if (yes > al.length - yes) {
          addLog(G,'Consenso: ¡A la hoguera!','gd');
          G.phase = 'noon_torch'; G.torchVotes = {}; broadcastState(room);
        } else {
          addLog(G,'Consenso: Sin hoguera.'); startNight(room);
        }
      }
    }

    else if (action === 'torch_vote') {
      if (G.phase !== 'noon_torch') return;
      const p = G.players.find(x => x.id === pid);
      if (!p || p.eliminated || p.silenced) return;
      G.torchVotes[pid] = payload.targetId || null;
      broadcastState(room);
      if (Object.keys(G.torchVotes).length >= alivePlayers(G).length) resolveTorch(room);
    }

    else if (action === 'night_atk') {
      if (G.activeAtk !== pid) return;
      if (!payload.abstain && payload.targetId) {
        const atk = G.players.find(x => x.id === pid);
        const tgt = G.players.find(x => x.id === payload.targetId);
        if (tgt && !tgt.eliminated && tgt.zone !== 'plaza' && !tgt.hidden && !tgt.famosaActive) {
          const adj = ADJ[atk.zone] || [];
          if (atk.zone === tgt.zone || adj.includes(tgt.zone)) {
            G.nightVictims.push(payload.targetId);
            addLog(G,'Un monstruo ataca en la oscuridad...','bl');
          }
        }
      }
      G.activeAtk = null; broadcastState(room);
      setTimeout(() => nextAttacker(room), 400);
    }

    else if (action === 'night_done') {
      if (pid !== G.hostId) return;
      resolveNight(room);
    }

    else if (action === 'use_power') {
      resolvePower(room, pid, payload);
    }

    else if (action === 'chat') {
      const p = G.players.find(x => x.id === pid);
      if (!p) return;
      io.to(socket.data.roomId).emit('chat', { name: p.name, msg: payload.msg, t: Date.now() });
    }
  });

  // Voice signaling (WebRTC via Socket.io relay)
  socket.on('voice_signal', ({ to, signal }) => {
    const sock = io.sockets.sockets.get(to);
    if (sock) sock.emit('voice_signal', { from: socket.id, signal });
  });

  socket.on('voice_join', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('voice_peer_joined', { peerId: socket.id });
  });

  socket.on('voice_leave', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('voice_peer_left', { peerId: socket.id });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const p = room.players.find(x => x.socketId === socket.id);
    if (p && room.G) {
      const gp = room.G.players.find(x => x.id === p.id);
      if (gp) gp.connected = false;
      addLog(room.G, `${p.name} se desconectó.`, 'bl');
      broadcastState(room);
    }
    console.log(`[-] ${socket.id} (${p?.name}) disconnected from ${roomId}`);
    // Clean empty rooms
    if (room.players.every(pl => !io.sockets.sockets.has(pl.socketId))) {
      delete rooms[roomId];
      console.log(`[ROOM] ${roomId} deleted (empty)`);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  🎃 Horror Town Server v3.0      ║`);
  console.log(`║  http://localhost:${PORT}           ║`);
  console.log(`╚══════════════════════════════════╝\n`);
});

module.exports = { httpServer, io };
