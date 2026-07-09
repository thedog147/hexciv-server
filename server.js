// ══════════════════════════════════════════════════════
// HexCiv WebSocket Server  v1.0
// 支援：30 人連線、多房間、封包廣播、JOIN 驗證
// 啟動方式：node server.js
// ══════════════════════════════════════════════════════

const { WebSocketServer } = require('ws');

// ── 對局紀錄／回放：不寫入磁碟（免費方案沒有 Volume 也能用），
//    改成存在記憶體裡，玩家可隨時用 EXPORT_REPLAY 請求下載到自己電腦 ──

const PORT     = 8080;
const MAX_ROOM = 30;   // 每房間最多玩家數

// ⏱️ 每回合行動時間限制（秒）── IGO-UGO 制下，輪到的陣營全員行動的思考時間上限。
//    時間到會強制結束該陣營回合、換對方行動。要調整回合秒數，直接改這個數字即可。
const TURN_TIME_LIMIT_SECONDS = 120;

// rooms Map：roomID → { players: Map<ws, playerInfo> }
const rooms = new Map();

// ── 六角格方向向量（與前端 HEX_DIRS 完全一致）──────────
const HEX_DIRS = [{q:1,r:0},{q:1,r:-1},{q:0,r:-1},{q:-1,r:0},{q:-1,r:1},{q:0,r:1}];

// ── 檢查房間內是否已有其他單位佔用該座標 ───────────────
function isCellOccupiedByOther(room, q, r, excludeUID){
  if(!room.units) return false;
  for(const uid in room.units){
    if(uid === excludeUID) continue;
    const u = room.units[uid];
    if(u.q === q && u.r === r) return true;
  }
  return false;
}

// ── 出生點碰撞解決：若座標已被佔用，以同心環方式向外搜尋最近的空格 ──
// （伺服器不持有地形資料，僅避免「兩個單位疊在同一格」；地形合法性已由
//   用戶端在選擇出生點/放置部隊時檢查過，這裡只做最後一道保險）
function resolveSpawnCollision(room, q, r, excludeUID){
  if(!isCellOccupiedByOther(room, q, r, excludeUID)) return { q, r, relocated:false };

  for(let radius = 1; radius <= 8; radius++){
    // 從第 radius 圈的其中一個角開始，沿六個邊走一圈
    let cq = q + HEX_DIRS[4].q * radius;
    let cr = r + HEX_DIRS[4].r * radius;
    for(let side = 0; side < 6; side++){
      for(let step = 0; step < radius; step++){
        if(!isCellOccupiedByOther(room, cq, cr, excludeUID)){
          return { q: cq, r: cr, relocated:true };
        }
        cq += HEX_DIRS[side].q;
        cr += HEX_DIRS[side].r;
      }
    }
  }
  // 極端擁擠狀況：找不到空格就維持原位置（機率極低）
  return { q, r, relocated:false };
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[Server] HexCiv WS Server 啟動，監聽 port ${PORT}`);

// ── 取得或建立房間 ──────────────────────────────────
function getOrCreateRoom(roomID) {
  if (!rooms.has(roomID)) {
    const room = { players: new Map() };
    rooms.set(roomID, room);
    console.log(`[Room] 建立新房間：${roomID}`);
    _startReplayLog(room, roomID);
  }
  return rooms.get(roomID);
}

// ── 開始紀錄：房間建立時初始化記憶體陣列（不落地磁碟）──────
function _startReplayLog(room, roomID){
  room.replayStartTime = Date.now();
  room.replayEvents    = [];   // { t, type, fromPID, payload }[]
  console.log(`[Replay] 房間 ${roomID} 開始紀錄（記憶體模式）`);
}

// ── 寫入一筆回放事件（t = 距房間建立的毫秒數，方便重建時間軸）──
function logReplayEvent(room, type, payload, fromPID){
  if(!room || !room.replayEvents) return;
  room.replayEvents.push({
    t:       Date.now() - room.replayStartTime,
    type,
    fromPID: fromPID ?? null,
    payload: payload ?? null,
  });
}

// ── 房間結束時釋放記憶體（沒有人下載走的紀錄就跟著房間一起消失）──
function _closeReplayLog(room){
  if(room) room.replayEvents = null;
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

// ── 只廣播給「同隊」的人（用於彈藥/油料/糧食/士氣等後勤機密數據，
//    這些數字設計上就不該讓敵方看到，跟 hp/位置這種戰場公開資訊不一樣）──
function broadcastToTeam(room, packet, team, excludeWs = null) {
  const data = JSON.stringify(packet);
  for (const [ws, p] of room.players) {
    if (ws !== excludeWs && p.team === team && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// ══════════════════════════════════════════════════════
// § IGO-UGO 回合制：紅軍先動、藍軍後動，雙方輪流交替
// ══════════════════════════════════════════════════════

// ── 清除該房間目前掛著的回合限時計時器 ──────────────
function clearTurnTimer(room){
  if(room.turnTimerHandle){
    clearTimeout(room.turnTimerHandle);
    room.turnTimerHandle = null;
  }
}

// ── 啟動新一段陣營回合的限時倒數（時間到 → 強制推進）──
function startTurnTimer(room, roomID){
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_TIME_LIMIT_SECONDS * 1000;
  room.turnTimerHandle = setTimeout(() => {
    console.log(`[Turn] 房間 ${roomID}：${room.activeTeam} 陣營 ${TURN_TIME_LIMIT_SECONDS} 秒時間到，強制結束回合`);
    advanceToNextTeam(room, roomID, true);
  }, TURN_TIME_LIMIT_SECONDS * 1000);
}

// ── 換下一個陣營行動；藍軍動完才代表一整回合結束，turnCount 才 +1 ──
function advanceToNextTeam(room, roomID, forced){
  clearTurnTimer(room);
  room.endedPlayers = new Set();

  const finishedTeam = room.activeTeam || 'RED';
  room.activeTeam = (finishedTeam === 'RED') ? 'BLUE' : 'RED';
  if(finishedTeam === 'BLUE'){
    room.turnCount = (room.turnCount || 1) + 1;
  }

  console.log(`[Turn] 房間 ${roomID}：${finishedTeam} → ${room.activeTeam} 行動${forced ? '（強制推進）' : ''}，目前第 ${room.turnCount || 1} 回合`);
  logReplayEvent(room, 'TURN_ADVANCE', {
    turnCount:  room.turnCount || 1,
    activeTeam: room.activeTeam,
    forced:     !!forced,
  }, null);

  startTurnTimer(room, roomID);

  broadcastAll(room, {
    type: 'TURN_ADVANCE',
    roomID,
    payload: {
      turnCount:    room.turnCount || 1,
      activeTeam:   room.activeTeam,
      forced:       !!forced,
      deadline:     room.turnDeadline,
      limitSeconds: TURN_TIME_LIMIT_SECONDS,
    }
  });
}

// ── 判斷某玩家目前是否輪到他的陣營行動（room.activeTeam 未設定時視為不限制，相容單機/舊房間）──
function isActiveTeamPlayer(room, player){
  return !room.activeTeam || !player.team || player.team === room.activeTeam;
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

    // ── JOIN：加入房間（支援 rejoinToken 斷線重連，保留原本的 PID）──
    if (type === 'JOIN') {
      if (!roomID) { ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '缺少 roomID' } })); return; }

      const room = getOrCreateRoom(roomID);
      if(!room.playersByToken) room.playersByToken = new Map();

      const rejoinToken = payload?.rejoinToken || null;
      let assignedPID;
      let isReconnect = false;

      if(rejoinToken && room.playersByToken.has(rejoinToken)){
        // ── 重連：沿用先前的玩家身份（PID/隊伍/名稱），單位所有權才能接得回去 ──
        currentPlayer = room.playersByToken.get(rejoinToken);
        assignedPID   = currentPlayer.playerID;
        isReconnect   = true;

        // 若還有殘留的舊連線掛著同一個玩家身份（例如分頁沒關乾淨），強制斷開避免雙重連線
        for(const [oldWs, p] of room.players){
          if(p === currentPlayer && oldWs !== ws){
            try{ oldWs.close(); }catch(e){}
            room.players.delete(oldWs);
          }
        }
        if(payload?.team) currentPlayer.team = payload.team;
      } else {
        if (room.players.size >= MAX_ROOM) {
          ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '房間已滿（30人）' } }));
          ws.close();
          return;
        }
        // 伺服器分配唯一 playerID（房間內從 1 開始遞增）
        if(!room.nextPID) room.nextPID = 1;
        assignedPID   = room.nextPID++;
        currentPlayer = { playerID: assignedPID, team: payload?.team, name: payload?.name || `玩家${assignedPID}` };
        if(rejoinToken) room.playersByToken.set(rejoinToken, currentPlayer);
      }

      currentRoom = room;
      room.players.set(ws, currentPlayer);

      console.log(`[Join] ${currentPlayer.name} ${isReconnect ? '重新連線' : '加入'}房間 ${roomID}，目前 ${room.players.size} 人`);
      logReplayEvent(room, isReconnect ? 'PLAYER_RECONNECTED' : 'PLAYER_JOINED',
        { playerID: assignedPID, name: currentPlayer.name, team: currentPlayer.team }, assignedPID);

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
          reconnected:     isReconnect,
          msg:             isReconnect
                              ? `歡迎回來，房間 ${roomID}，目前 ${room.players.size} 人`
                              : `歡迎加入房間 ${roomID}，目前 ${room.players.size} 人`
        }
      }));

      // 重連成功：把這名玩家自己單位的後勤快取（食物/彈藥/油料/人力）回填給他本人，
      // 只送符合他 PID 前綴（例如 "3_"）的單位，不會外流其他玩家的後勤數據
      if(isReconnect && room.unitLogistics){
        const myPrefix = `${assignedPID}_`;
        const myUnits = Object.values(room.unitLogistics).filter(u => String(u.uid).startsWith(myPrefix));
        if(myUnits.length){
          ws.send(JSON.stringify({
            type: 'LOGISTICS_RESYNC',
            roomID,
            payload: { units: myUnits }
          }));
          console.log(`[Reconnect] 回填 ${myUnits.length} 筆後勤快取給玩家${assignedPID}`);
        }
      }

      // 通知同房其他人（沿用既有的 PLAYER_JOINED 類型，client 端本來就是用 playerID 覆蓋、不會重複）
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
        logReplayEvent(currentRoom, 'MAP_INIT', packet.payload, currentPlayer.playerID);
        console.log(`[Map] 房間 ${roomID} 地圖設定：種子=${packet.payload?.seed}, 類型=${packet.payload?.mapType}`);
        break;

      case 'TEAM_LOADOUT_UPDATE':
        currentPlayer.team        = packet.payload?.team;
        currentPlayer.previewLoad = packet.payload?.loadout;
        // 附上發送者 PID，讓接收方知道是誰的選角
        packet.fromPID = currentPlayer.playerID;
        broadcast(currentRoom, packet, ws);
        logReplayEvent(currentRoom, 'TEAM_LOADOUT_UPDATE', packet.payload, currentPlayer.playerID);
        break;

      case 'PLAYER_READY':
        // 記錄玩家準備狀態與編制
        currentRoom.readyPlayers = currentRoom.readyPlayers || {};
        currentRoom.readyPlayers[currentPlayer.playerID] = packet.payload;
        currentPlayer.team    = packet.payload?.team;
        currentPlayer.loadout = packet.payload?.loadout;
        console.log(`[Ready] 玩家${currentPlayer.playerID} 準備就緒，房間共 ${Object.keys(currentRoom.readyPlayers).length} 人準備`);
        logReplayEvent(currentRoom, 'PLAYER_READY', packet.payload, currentPlayer.playerID);
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

        // ── IGO-UGO：紅軍永遠先手，第 1 回合開始就啟動限時計時器 ──
        currentRoom.activeTeam   = 'RED';
        currentRoom.turnCount    = 1;
        currentRoom.endedPlayers = new Set();
        startTurnTimer(currentRoom, roomID);

        console.log(`[Start] 房主啟動遊戲，房間 ${roomID}，種子=${currentRoom.mapConfig?.seed}，紅軍先手`);
        {
          const gameStartPayload = {
            seed:    currentRoom.mapConfig?.seed,
            mapType: currentRoom.mapConfig?.mapType,
            players: Array.from(currentRoom.players.values()).map(p=>({
              playerID: p.playerID,
              team:     p.team,
              loadout:  p.loadout,
            })),
            activeTeam:   currentRoom.activeTeam,
            turnCount:    currentRoom.turnCount,
            deadline:     currentRoom.turnDeadline,
            limitSeconds: TURN_TIME_LIMIT_SECONDS,
          };
          logReplayEvent(currentRoom, 'GAME_START', gameStartPayload, currentPlayer.playerID);
          broadcastAll(currentRoom, { type: 'GAME_START', roomID, payload: gameStartPayload });
        }
        break;

      case 'UNIT_SPAWN':
        // 記錄單位到房間快取（key = uid），並做出生點碰撞檢查
        if(!currentRoom.units) currentRoom.units = {};
        if(packet.payload?.uid){
          const uid = packet.payload.uid;
          let relocated = false;

          if(typeof packet.payload.q === 'number' && typeof packet.payload.r === 'number'){
            const resolved = resolveSpawnCollision(currentRoom, packet.payload.q, packet.payload.r, uid);
            if(resolved.relocated){
              console.log(`[Spawn] 單位 ${uid} 出生位置與隊友衝突，自動調整 (${packet.payload.q},${packet.payload.r}) → (${resolved.q},${resolved.r})`);
              packet.payload.q = resolved.q;
              packet.payload.r = resolved.r;
              relocated = true;
            }
          }

          currentRoom.units[uid] = {
            ...packet.payload,
            ownerPID: currentPlayer.playerID
          };

          // 若座標被調整過，連建立者本人也要收到校正後的封包，
          // 讓用戶端把自己的單位位置同步到伺服器認可的最終座標
          if(relocated){
            logReplayEvent(currentRoom, 'UNIT_SPAWN', packet.payload, currentPlayer.playerID);
            broadcastAll(currentRoom, packet);
            break;
          }
        }
        logReplayEvent(currentRoom, 'UNIT_SPAWN', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      case 'UNIT_MOVE':
        // ── IGO-UGO：不是你的陣營在動，直接丟棄，避免跟正在行動的陣營打架 ──
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 UNIT_MOVE`);
          break;
        }
        // 更新房間單位位置快取
        if(currentRoom.units && packet.payload?.uid){
          const u = currentRoom.units[packet.payload.uid];
          if(u){ u.q = packet.payload.q; u.r = packet.payload.r; }
        }
        logReplayEvent(currentRoom, 'UNIT_MOVE', packet.payload, currentPlayer.playerID);
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

      case 'EXPORT_REPLAY':
        // 玩家主動請求下載本局回放紀錄（僅回給發送者本人，不廣播）
        ws.send(JSON.stringify({
          type: 'REPLAY_DATA',
          roomID,
          payload: {
            roomID,
            turnCount: currentRoom.turnCount || 1,
            exportedAt: Date.now(),
            events: currentRoom.replayEvents || [],
          }
        }));
        console.log(`[Replay] 玩家${currentPlayer.playerID} 下載房間 ${roomID} 回放紀錄（共 ${(currentRoom.replayEvents||[]).length} 筆事件）`);
        break;

      case 'ATTACK_RESULT':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 ATTACK_RESULT`);
          break;
        }
        logReplayEvent(currentRoom, 'ATTACK_RESULT', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      // ── BVR 座標射擊／TOW 飛彈：遠程攻擊結果（傷害＋城鎮民心同步）──
      case 'RANGED_ATTACK_RESULT':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 RANGED_ATTACK_RESULT`);
          break;
        }
        logReplayEvent(currentRoom, 'RANGED_ATTACK_RESULT', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      // ── 砲宣彈：城鎮民心同步 ──
      case 'PSY_SHELL_RESULT':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 PSY_SHELL_RESULT`);
          break;
        }
        logReplayEvent(currentRoom, 'PSY_SHELL_RESULT', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      // ── 後勤操作結果：裝載/傳輸/補給/配屬補給/領取/掠奪/充填/部署，
      //    同步單位自己的 hp/food/ammo/fuel/supply/cargo* 欄位（可能影響隊友控制的單位）。
      //    只送給「同隊」——彈藥/油料/糧食是設計上要對敵方保密的機密數值，
      //    不能像 hp/位置那樣整房廣播 ──
      case 'UNIT_SUPPLY_SYNC':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 UNIT_SUPPLY_SYNC`);
          break;
        }
        logReplayEvent(currentRoom, 'UNIT_SUPPLY_SYNC', packet.payload, currentPlayer.playerID);
        broadcastToTeam(currentRoom, packet, currentPlayer.team, ws);
        break;

      // ── 地雷佈設：對方步兵佈雷，廣播給房間內其他人 ──
      case 'MINE_PLACE':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 MINE_PLACE`);
          break;
        }
        logReplayEvent(currentRoom, 'MINE_PLACE', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      // ── 地雷拆除：對方步兵拆雷，廣播給房間內其他人 ──
      case 'MINE_DEFUSE':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 MINE_DEFUSE`);
          break;
        }
        logReplayEvent(currentRoom, 'MINE_DEFUSE', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      // ── 城鎮事件結果：進城觸發的隨機事件是在觸發者自己的電腦上算的，
      //    這裡只是單純把最終狀態轉發出去，本身不需要回合檢查以外的邏輯 ──
      case 'TOWN_EVENT_SYNC':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 TOWN_EVENT_SYNC`);
          break;
        }
        logReplayEvent(currentRoom, 'TOWN_EVENT_SYNC', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      // ── 回合結算耗損：斷糧/士氣/逃兵扣血，每回合開始時對「自己」的所有
      //    單位跑一次。裡面含 food/fuel/morale 這種機密後勤數值，跟
      //    UNIT_SUPPLY_SYNC 一樣只送給同隊——不做回合鎖檢查，因為這是
      //    「輪到自己陣營開始時」的被動結算，不是主動操作 ──
      case 'TURN_UPKEEP_SYNC':
        logReplayEvent(currentRoom, 'TURN_UPKEEP_SYNC', packet.payload, currentPlayer.playerID);
        broadcastToTeam(currentRoom, packet, currentPlayer.team, ws);
        break;

      // ── 單位 HP 同步：目前用於車輛維修。HP 是公開戰場資訊（敵方本來就
      //    看得到血量，攻擊判定要用），不像 food/fuel 需要保密，所以跟
      //    ATTACK_RESULT 一樣整房廣播 ──
      case 'UNIT_HP_SYNC':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 UNIT_HP_SYNC`);
          break;
        }
        logReplayEvent(currentRoom, 'UNIT_HP_SYNC', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      case 'INTEL_SYNC':
        logReplayEvent(currentRoom, 'INTEL_SYNC', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      case 'DEPOT_SYNC':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 DEPOT_SYNC`);
          break;
        }
        // 快取進房間狀態，供晚加入/重連玩家用 REQUEST_DEPOTS 補課
        if(packet.payload?.q != null && packet.payload?.r != null){
          if(!currentRoom.depots) currentRoom.depots = {};
          currentRoom.depots[`${packet.payload.q},${packet.payload.r}`] = packet.payload;
        }
        logReplayEvent(currentRoom, 'DEPOT_SYNC', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      case 'DEPOT_REMOVE':
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 DEPOT_REMOVE`);
          break;
        }
        if(currentRoom.depots && packet.payload?.q != null && packet.payload?.r != null){
          delete currentRoom.depots[`${packet.payload.q},${packet.payload.r}`];
        }
        logReplayEvent(currentRoom, 'DEPOT_REMOVE', packet.payload, currentPlayer.playerID);
        broadcast(currentRoom, packet, ws);
        break;

      case 'REQUEST_DEPOTS':
        // 晚加入/重新連線的玩家要求取得目前所有補給點狀態（補課）
        if(currentRoom.depots){
          for(const key of Object.keys(currentRoom.depots)){
            ws.send(JSON.stringify({
              type: 'DEPOT_SYNC',
              roomID,
              payload: currentRoom.depots[key]
            }));
          }
          console.log(`[Depot] 推送 ${Object.keys(currentRoom.depots).length} 個補給點給玩家${currentPlayer.playerID}`);
        }
        break;

      case 'LOGISTICS_SNAPSHOT':
        // 賽後分析用後勤真相快照：只寫進回放紀錄，「絕對不」broadcast 給任何人，
        // 確保正式對戰當下敵方依然看不到彼此的彈藥/油料/人力（安全機制不變）
        logReplayEvent(currentRoom, 'LOGISTICS_SNAPSHOT', packet.payload, currentPlayer.playerID);

        // 同時快取每個單位「最新一次」的後勤數據，供本人斷線重連時要回來
        // （只給本人，見下方 JOIN 重連流程的過濾邏輯，不會外流給其他玩家）
        if(!currentRoom.unitLogistics) currentRoom.unitLogistics = {};
        if(Array.isArray(packet.payload?.units)){
          for(const u of packet.payload.units){
            if(u && u.uid) currentRoom.unitLogistics[u.uid] = u;
          }
        }
        break;

      case 'END_TURN':
        // ── IGO-UGO：不是你的陣營在動，這顆 END_TURN 不算數 ──
        if(!isActiveTeamPlayer(currentRoom, currentPlayer)){
          console.warn(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）非行動陣營（${currentRoom.activeTeam}），忽略 END_TURN`);
          break;
        }

        if(!currentRoom.endedPlayers) currentRoom.endedPlayers = new Set();
        currentRoom.endedPlayers.add(currentPlayer.playerID);

        // 只算「目前行動陣營」的人數，不是全房間人數
        const activeTeamCount = currentRoom.activeTeam
          ? Array.from(currentRoom.players.values()).filter(p => p.team === currentRoom.activeTeam).length
          : currentRoom.players.size;

        console.log(`[Turn] 玩家${currentPlayer.playerID}（${currentPlayer.team}）結束回合 ${currentRoom.endedPlayers.size}/${activeTeamCount}`);
        logReplayEvent(currentRoom, 'END_TURN', { playerID: currentPlayer.playerID, team: currentPlayer.team }, currentPlayer.playerID);

        // 通知所有人目前進度
        broadcastAll(currentRoom, {
          type: 'PLAYER_END_TURN',
          roomID,
          payload: {
            playerID:   currentPlayer.playerID,
            endedCount: currentRoom.endedPlayers.size,
            totalCount: activeTeamCount,
            activeTeam: currentRoom.activeTeam,
          }
        });

        // 該陣營全員結束 → 換對方陣營行動（藍軍動完才是完整一回合，見 advanceToNextTeam）
        if(currentRoom.endedPlayers.size >= activeTeamCount){
          advanceToNextTeam(currentRoom, roomID, false);
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
      logReplayEvent(currentRoom, 'PLAYER_LEFT', { playerID: currentPlayer.playerID }, currentPlayer.playerID);

      broadcast(currentRoom, {
        type: 'PLAYER_LEFT',
        payload: { playerID: currentPlayer.playerID, playerCount: currentRoom.players.size }
      });

      // 房間空了就清除，並關閉該房間的回放紀錄檔
      if (currentRoom.players.size === 0) {
        clearTurnTimer(currentRoom);
        _closeReplayLog(currentRoom);
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