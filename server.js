// ══════════════════════════════════════════════════════
// HexCiv WebSocket Server  v1.0
// 支援：30 人連線、多房間、封包廣播、JOIN 驗證
// 啟動方式：node server.js
// ══════════════════════════════════════════════════════

const { WebSocketServer } = require('ws');

const PORT     = 8080;
const MAX_ROOM = 30;   // 每房間最多玩家數

// rooms Map：roomID → { players: Map<ws, playerInfo> }
const rooms = new Map();

const wss = new WebSocketServer({ port: PORT });
console.log(`[Server] HexCiv WS Server 啟動，監聽 port ${PORT}`);

// ── 取得或建立房間 ──────────────────────────────────
function getOrCreateRoom(roomID) {
  if (!rooms.has(roomID)) {
    rooms.set(roomID, { players: new Map() });
    console.log(`[Room] 建立新房間：${roomID}`);
  }
  return rooms.get(roomID);
}

// ── 廣播給同房間所有人（可排除某個連線）──────────────
function broadcast(room, packet, excludeWs = null) {
  const data = JSON.stringify(packet);
  for (const [ws] of room.players) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// ── 廣播給同房間所有人（含自己）────────────────────
function broadcastAll(room, packet) {
  broadcast(room, packet, null);
}

// ══════════════════════════════════════════════════════
// 主連線處理
// ══════════════════════════════════════════════════════
wss.on('connection', function (ws) {
  let currentRoom   = null;
  let currentPlayer = null;

  console.log(`[Connect] 新連線，目前總連線數：${wss.clients.size}`);

  // ── 收到封包 ───────────────────────────────────────
  ws.on('message', function (raw) {
    let packet;
    try { packet = JSON.parse(raw); }
    catch (e) { console.warn('[Server] 無法解析封包'); return; }

    const { type, roomID, payload } = packet;

    // ── 查詢類封包（不需要加入房間）────────────────────
    if(type === 'GET_ROOMS' || type === 'CREATE_ROOM'){
      if(type === 'GET_ROOMS'){
        const roomList = [];
        for(const [rid, r] of rooms){
          roomList.push({
            roomID:      rid,
            playerCount: r.players.size,
            maxPlayers:  MAX_ROOM,
            started:     r.gameStarted || false,
          });
        }
        ws.send(JSON.stringify({ type: 'ROOMS_LIST', payload: { rooms: roomList } }));
      } else {
        const newRoomID = 'room' + String(Date.now()).slice(-6);
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', payload: { roomID: newRoomID } }));
      }
      return;
    }

    // ── JOIN：加入房間 ────────────────────────────────
    if (type === 'JOIN') {
      if (!roomID) { ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '缺少 roomID' } })); return; }

      const room = getOrCreateRoom(roomID);

      if (room.players.size >= MAX_ROOM) {
        ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '房間已滿（30人）' } }));
        ws.close();
        return;
      }

       // 伺服器分配唯一 playerID（房間內從 1 開始遞增）
      if(!room.nextPID) room.nextPID = 1;
      const assignedPID = room.nextPID++;

      currentRoom   = room;
      currentPlayer = { playerID: assignedPID, team: payload?.team, name: payload?.name || `玩家${assignedPID}` };
      room.players.set(ws, currentPlayer);

      console.log(`[Join] ${currentPlayer.name} 加入房間 ${roomID}，目前 ${room.players.size} 人`);

      // 回應加入成功（含房間內現有玩家清單）
      const existingPlayers = [];
      for(const [, p] of room.players){
        if(p !== currentPlayer) existingPlayers.push({ playerID: p.playerID, team: p.team, name: p.name });
      }
      ws.send(JSON.stringify({
        type: 'JOIN_ACK',
        roomID,
        payload: {
          playerCount:     room.players.size,
          playerID:        assignedPID,
          existingPlayers: existingPlayers,
          mapConfig:       room.mapConfig || null,
          msg:             `歡迎加入房間 ${roomID}，目前 ${room.players.size} 人`
        }
      }));

      // 通知同房其他人
      broadcast(room, {
        type: 'PLAYER_JOINED',
        roomID,
        payload: { playerID: currentPlayer.playerID, team: currentPlayer.team, playerCount: room.players.size }
      }, ws);

      return;
    }

    // ── 其他封包：驗證房間，再廣播 ────────────────────
    if (!currentRoom) {
      ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '請先 JOIN 房間' } }));
      return;
    }

    // 驗證 roomID 一致（防串房）
    if (roomID && packet.roomID !== getRoomID(currentRoom)) {
      console.warn(`[Security] roomID 不符，丟棄封包`);
      return;
    }

    // 以下封包全部轉發給同房其他人
    switch (type) {
     case 'MAP_INIT':
        currentRoom.mapConfig = packet.payload;
        broadcast(currentRoom, packet, ws);
        console.log(`[Map] 房間 ${roomID} 地圖設定：種子=${packet.payload?.seed}, 類型=${packet.payload?.mapType}`);
        break;

      case 'TEAM_LOADOUT_UPDATE':
        currentPlayer.team        = packet.payload?.team;
        currentPlayer.previewLoad = packet.payload?.loadout;
        // 附上發送者 PID，讓接收方知道是誰的選角
        packet.fromPID = currentPlayer.playerID;
        broadcast(currentRoom, packet, ws);
        break;

      case 'PLAYER_READY':
        // 記錄玩家準備狀態與編制
        currentRoom.readyPlayers = currentRoom.readyPlayers || {};
        currentRoom.readyPlayers[currentPlayer.playerID] = packet.payload;
        currentPlayer.team    = packet.payload?.team;
        currentPlayer.loadout = packet.payload?.loadout;
        console.log(`[Ready] 玩家${currentPlayer.playerID} 準備就緒，房間共 ${Object.keys(currentRoom.readyPlayers).length} 人準備`);
        // 廣播給所有人（含自己），讓所有人更新等待室狀態
        broadcastAll(currentRoom, {
          type: 'READY_UPDATE',
          roomID,
          payload: {
            playerID:    currentPlayer.playerID,
            team:        currentPlayer.team,
            readyCount:  Object.keys(currentRoom.readyPlayers).length,
            totalCount:  currentRoom.players.size,
          }
        });
        break;

      case 'GAME_START':
        // 只有房主（PID=1）可以發送
        if(currentPlayer.playerID !== 1){
          ws.send(JSON.stringify({ type:'ERROR', payload:{ msg:'只有房主可以開始遊戲' } }));
          break;
        }
        // 儲存房主送來的地圖種子
        if(packet.payload?.seed){
          currentRoom.mapConfig = { seed: packet.payload.seed, mapType: packet.payload.mapType };
        }
        currentRoom.gameStarted = true;
        console.log(`[Start] 房主啟動遊戲，房間 ${roomID}，種子=${currentRoom.mapConfig?.seed}`);
        broadcastAll(currentRoom, {
          type: 'GAME_START',
          roomID,
          payload: {
            seed:    currentRoom.mapConfig?.seed,
            mapType: currentRoom.mapConfig?.mapType,
            players: Array.from(currentRoom.players.values()).map(p=>({
              playerID: p.playerID,
              team:     p.team,
              loadout:  p.loadout,
            }))
          }
        });
        break;

      case 'UNIT_SPAWN':
        // 記錄單位到房間快取（key = uid）
        if(!currentRoom.units) currentRoom.units = {};
        if(packet.payload?.uid){
          currentRoom.units[packet.payload.uid] = {
            ...packet.payload,
            ownerPID: currentPlayer.playerID
          };
        }
        broadcast(currentRoom, packet, ws);
        break;

      case 'UNIT_MOVE':
        // 更新房間單位位置快取
        if(currentRoom.units && packet.payload?.uid){
          const u = currentRoom.units[packet.payload.uid];
          if(u){ u.q = packet.payload.q; u.r = packet.payload.r; }
        }
        broadcast(currentRoom, packet, ws);
        break;

      case 'REQUEST_UNITS':
        // 玩家要求取得目前所有其他玩家的單位
        if(!currentRoom.units) break;
        const myPID = currentPlayer.playerID;
        for(const uid of Object.keys(currentRoom.units)){
          const u = currentRoom.units[uid];
          if(u.ownerPID !== myPID){
            ws.send(JSON.stringify({
              type: 'UNIT_SPAWN',
              roomID,
              payload: u
            }));
          }
        }
        console.log(`[Units] 推送 ${Object.keys(currentRoom.units).length} 個單位給玩家${myPID}`);
        break;

      case 'ATTACK_RESULT':
        broadcast(currentRoom, packet, ws);
        break;

      case 'INTEL_SYNC':
        broadcast(currentRoom, packet, ws);
        break;

      case 'END_TURN':
        if(!currentRoom.endedPlayers) currentRoom.endedPlayers = new Set();
        currentRoom.endedPlayers.add(currentPlayer.playerID);
        console.log(`[Turn] 玩家${currentPlayer.playerID} 結束回合 ${currentRoom.endedPlayers.size}/${currentRoom.players.size}`);

        // 通知所有人目前進度
        broadcastAll(currentRoom, {
          type: 'PLAYER_END_TURN',
          roomID,
          payload: {
            playerID:   currentPlayer.playerID,
            endedCount: currentRoom.endedPlayers.size,
            totalCount: currentRoom.players.size,
          }
        });

        // 全員結束 → 推進回合
        if(currentRoom.endedPlayers.size >= currentRoom.players.size){
          currentRoom.endedPlayers.clear();
          currentRoom.turnCount = (currentRoom.turnCount || 1) + 1;
          console.log(`[Turn] 推進到第 ${currentRoom.turnCount} 回合`);
          broadcastAll(currentRoom, {
            type: 'TURN_ADVANCE',
            roomID,
            payload: { turnCount: currentRoom.turnCount }
          });
        }
        break;

      default:
        console.log(`[Server] 未知封包類型：${type}`);
    }
  });

  // ── 斷線處理 ───────────────────────────────────────
  ws.on('close', function () {
    if (currentRoom && currentPlayer) {
      currentRoom.players.delete(ws);
      console.log(`[Leave] ${currentPlayer.name || '玩家'} 離線，房間剩 ${currentRoom.players.size} 人`);

      broadcast(currentRoom, {
        type: 'PLAYER_LEFT',
        payload: { playerID: currentPlayer.playerID, playerCount: currentRoom.players.size }
      });

      // 房間空了就清除
      if (currentRoom.players.size === 0) {
        for (const [id, r] of rooms) {
          if (r === currentRoom) { rooms.delete(id); console.log(`[Room] 房間已清除`); break; }
        }
      }
    }
    console.log(`[Disconnect] 目前總連線數：${wss.clients.size}`);
  });

  ws.on('error', function (err) {
    console.error('[WS Error]', err.message);
  });
});

// ── 輔助：取得房間 ID ──────────────────────────────
function getRoomID(targetRoom) {
  for (const [id, r] of rooms) { if (r === targetRoom) return id; }
  return null;
}
