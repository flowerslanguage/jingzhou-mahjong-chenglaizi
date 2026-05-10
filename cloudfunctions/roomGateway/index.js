const cloud = require("wx-server-sdk");
const { chooseBotDiscardTileId: chooseBotDiscardTileIdAi } = require("./botDiscardAi");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ROOM_COLLECTION = "mj_rooms";
const TABLE_SIZE = 4;
const TILE_KIND_COUNT = 27;
/** 结算底金（元）：与 README 中「5/10 为基准」的倍数关系，仅允许下列档位 */
const BASE_STAKE_OPTIONS = [1, 2, 5, 10];
const DEFAULT_BASE_STAKE = 5;

function normalizeBaseStake(n) {
  const v = Number(n);
  if (BASE_STAKE_OPTIONS.includes(v)) return v;
  return DEFAULT_BASE_STAKE;
}

/** 将「以 5 元为基准」的参考金额换算为当前房间底金（四舍五入为整数元） */
function stakeMoney(room, refAtBase5) {
  const stake = normalizeBaseStake(room?.baseStake);
  return Math.round((Number(refAtBase5) * stake) / 5);
}
/** 行牌/反应顺序：逆时针 南(0)→东(3)→北(2)→西(1)，与客户端 seatPos 一致（非座位号+1 的顺时针） */
const PLAY_ORDER_CCW = [0, 3, 2, 1];

/** 返回当前时间戳（毫秒） */
function now() {
  return Date.now();
}

/**
 * 写入 gameSnapshot 时必须整对象替换。若直接 `update({ gameSnapshot: ss })`，
 * 云数据库会对嵌套字段做路径级合并，易在 reaction 从 { canGang… } 变为 `null` 时产生
 * “Cannot create field 'canGang' in element {reaction: null}” 及后续 500。
 * @param {object|null|undefined} ss
 */
function gameSnapshotWrite(ss) {
  if (ss == null) {
    // 用 set(null) 整段替换该字段，避免对嵌套子路径做合并
    return _.set(null);
  }
  // 去掉 undefined，避免部分字段未序列化导致合并行为异常
  return _.set(JSON.parse(JSON.stringify(ss)));
}

/** 生成一个 6 位数字房号（不保证唯一） */
function makeRoomNo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 从 uid 中提取末尾片段，生成临时真人展示名（后续可替换为微信昵称） */
function humanNameFromUid(uid = "") {
  const raw = String(uid || "").trim();
  if (!raw) return "玩家";
  const seg = raw.split("_").filter(Boolean).pop() || raw.slice(-6);
  return `玩家_${seg}`;
}

/** 统一玩家展示名：机器人用昵称，真人先用 uid 末段 */
function displayNameFromPlayer(player) {
  if (!player) return "玩家";
  if (player.isBot) return String(player.nickname || player.uid || "电脑");
  return String(player.nickname || player.uid || humanNameFromUid(player.uid));
}

/** 根据 uid 取展示名（行牌提示以操作者 uid 为准，避免快照 seat 映射与房间不同步时错名） */
function displayNameByUid(room, uid) {
  const u = String(uid || "").trim();
  if (!u) return "玩家";
  const p = normalizePlayers(room.players || []).find((x) => x.uid === u);
  return displayNameFromPlayer(p);
}

/**
 * 根据座位取展示名。
 * 优先 room.players 中该座位唯一成员（与当前房间一致）；若同座多人则用快照 ss.players 的 uid 再解析。
 */
function displayNameBySeat(room, seat, ss) {
  const s = Number(seat);
  if (!Number.isInteger(s) || s < 0 || s > 3) return "玩家";
  const norm = normalizePlayers(room.players || []);
  const sameSeat = norm.filter((p) => Number(p.seat) === s);
  if (sameSeat.length === 1) return displayNameFromPlayer(sameSeat[0]);
  if (ss && Array.isArray(ss.players)) {
    const row = ss.players.find((p) => Number(p.seat) === s);
    const uid = row && String(row.uid || "").trim();
    if (uid) {
      const p = norm.find((x) => x.uid === uid);
      return displayNameFromPlayer(p);
    }
  }
  return displayNameFromPlayer(sameSeat[0] || norm.find((x) => Number(x.seat) === s));
}

/** 生成唯一房号：若冲突则重试，最终兜底返回时间片段 */
async function uniqueRoomNo() {
  // 生成 6 位房号，最多重试 20 次，避免重复
  for (let i = 0; i < 20; i += 1) {
    const roomNo = makeRoomNo();
    const found = await db.collection(ROOM_COLLECTION).where({ roomNo }).limit(1).get();
    if (!found.data || found.data.length === 0) return roomNo;
  }
  return `${Math.floor(now() / 1000)}`.slice(-6);
}

/** 规范化玩家数组，统一字段并按座位排序 */
function normalizePlayers(players = []) {
  return players
    .map((p) => ({
      uid: String(p.uid || ""),
      seat: Number(p.seat || 0),
      nickname: p.isBot
        ? String(p.nickname || p.uid || "电脑")
        : String(p.nickname || humanNameFromUid(p.uid)),
      avatarUrl: String(p.avatarUrl || ""),
      ready: !!p.ready,
      online: p.online !== false,
      isBot: !!p.isBot,
    }))
    .sort((a, b) => a.seat - b.seat);
}

/** 构建可下发给客户端的安全房间状态 */
function safeRoomState(room) {
  return {
    roomId: room.roomId,
    roomNo: room.roomNo,
    ownerUid: room.ownerUid,
    status: room.status,
    maxPlayers: room.maxPlayers || TABLE_SIZE,
    botCount: Number(room.botCount || 0),
    players: normalizePlayers(room.players || []),
    updatedAt: room.updatedAt || now(),
  };
}

/** 通过 roomId 查询房间文档 */
async function getRoomById(roomId) {
  const ret = await db.collection(ROOM_COLLECTION).where({ roomId }).limit(1).get();
  if (!ret.data || ret.data.length === 0) return null;
  return ret.data[0];
}

/** 通过 roomNo 查询房间文档 */
async function getRoomByNo(roomNo) {
  const ret = await db.collection(ROOM_COLLECTION).where({ roomNo }).limit(1).get();
  if (!ret.data || ret.data.length === 0) return null;
  return ret.data[0];
}

/** 处理登录：返回 OPENID 作为 uid */
async function actionLogin(event, wxContext) {
  // 使用 OPENID 作为云端用户唯一标识，不依赖自建登录服务
  const uid = String(wxContext.OPENID || "");
  const nickname = String(event?.payload?.nickname || "").trim();
  const avatarUrl = String(event?.payload?.avatarUrl || "").trim();
  return {
    ok: true,
    uid,
    token: "",
    nickname: nickname || uid,
    avatarUrl,
    ts: now(),
  };
}

/** 处理建房：创建房间并让房主占座位 0 */
async function actionCreateRoom(event, wxContext) {
  const uid = String(wxContext.OPENID || "");
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  const nickname = String(event?.payload?.nickname || uid).trim() || uid;
  const avatarUrl = String(event?.payload?.avatarUrl || "").trim();
  const roomNo = await uniqueRoomNo();
  const roomId = `CR_${now()}_${Math.random().toString(36).slice(2, 8)}`;
  const baseStake = normalizeBaseStake(event?.payload?.baseStake);
  const room = {
    roomId,
    roomNo,
    ownerUid: uid,
    status: "waiting",
    maxPlayers: TABLE_SIZE,
    botCount: 0,
    baseStake,
    players: [
      {
        uid,
        seat: 0,
        nickname,
        avatarUrl,
        ready: false,
        online: true,
        isBot: false,
      },
    ],
    createdAt: now(),
    updatedAt: now(),
  };
  await db.collection(ROOM_COLLECTION).add({ data: room });
  return {
    ok: true,
    roomId,
    roomNo,
    seat: 0,
    ownerUid: uid,
    roomState: safeRoomState(room),
  };
}

/** 处理入房：校验状态并分配空闲座位 */
async function actionJoinRoom(event, wxContext) {
  const uid = String(wxContext.OPENID || "");
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  const roomNo = String(event?.payload?.roomNo || "").trim();
  if (!roomNo) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const nickname = String(event?.payload?.nickname || uid).trim() || uid;
  const avatarUrl = String(event?.payload?.avatarUrl || "").trim();
  const room = await getRoomByNo(roomNo);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  if (room.status !== "waiting") return { ok: false, code: "E_ROOM_ALREADY_STARTED" };
  const players = normalizePlayers(room.players || []);
  const hasMe = players.find((p) => p.uid === uid);
  if (hasMe) {
    return {
      ok: true,
      roomId: room.roomId,
      roomNo: room.roomNo,
      seat: hasMe.seat,
      roomState: safeRoomState(room),
    };
  }
  if (players.length >= TABLE_SIZE) return { ok: false, code: "E_ROOM_FULL" };
  const usedSeats = new Set(players.map((p) => p.seat));
  let seat = 0;
  while (usedSeats.has(seat)) seat += 1;
  players.push({
    uid,
    seat,
    nickname,
    avatarUrl,
    ready: false,
    online: true,
    isBot: false,
  });
  const nextRoom = {
    ...room,
    players: normalizePlayers(players),
    botCount: normalizePlayers(players).filter((p) => p.isBot).length,
    updatedAt: now(),
  };
  await db.collection(ROOM_COLLECTION).doc(room._id).update({
    data: {
      players: nextRoom.players,
      botCount: nextRoom.botCount,
      updatedAt: nextRoom.updatedAt,
    },
  });
  return {
    ok: true,
    roomId: nextRoom.roomId,
    roomNo: nextRoom.roomNo,
    seat,
    roomState: safeRoomState(nextRoom),
  };
}

/** 处理房态查询：用于重连恢复与主动拉取 */
async function actionGetRoomState(event) {
  const roomId = String(event?.roomId || event?.payload?.roomId || "").trim();
  if (!roomId) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  return { ok: true, roomState: safeRoomState(room) };
}

/** 处理准备/取消准备，并在满员全员准备后切到 gaming */
async function actionSetReady(event, wxContext) {
  const uid = String(wxContext.OPENID || "");
  const roomId = String(event?.roomId || "").trim();
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const wantReady = !!event?.payload?.ready;
  const players = normalizePlayers(room.players || []);
  const me = players.find((p) => p.uid === uid);
  if (!me) return { ok: false, code: "E_ROOM_NOT_IN" };
  me.ready = wantReady;
  const canStart = players.length === TABLE_SIZE && players.every((p) => p.ready);
  const nextStatus = canStart ? "gaming" : "waiting";
  let nextSnapshot = room.gameSnapshot || null;
  if (canStart) {
    // 满员且全员准备时由云端统一发牌
    nextSnapshot = createGameSnapshot({
      ...room,
      players,
    });
  }
  await db.collection(ROOM_COLLECTION).doc(room._id).update({
    data: {
      players,
      status: nextStatus,
      gameSnapshot: gameSnapshotWrite(nextSnapshot),
      updatedAt: now(),
      gameUpdatedAt: canStart ? now() : room.gameUpdatedAt || null,
    },
  });
  return {
    ok: true,
    ready: wantReady,
    roomState: safeRoomState({
      ...room,
      players,
      status: nextStatus,
      updatedAt: now(),
    }),
    started: canStart,
    // 仅返回给当前调用者的开局载荷（其他玩家通过 watch + snapshot 拉取）
    startPayload: canStart ? buildSnapshotForUid({ ...room, players }, uid, nextSnapshot) : null,
  };
}

/** 处理机器人数量设置：仅房主可在 waiting 状态修改 */
async function actionSetBots(event, wxContext) {
  const uid = String(wxContext.OPENID || "");
  const roomId = String(event?.roomId || "").trim();
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  if (room.ownerUid !== uid) return { ok: false, code: "E_ROOM_NOT_OWNER" };
  if (room.status !== "waiting") return { ok: false, code: "E_ROOM_INVALID_STATE" };
  const players = normalizePlayers(room.players || []);
  const humans = players.filter((p) => !p.isBot);
  const maxBots = Math.max(0, TABLE_SIZE - humans.length);
  const target = Math.max(0, Math.min(Number(event?.payload?.botCount || 0), maxBots));
  const usedSeats = new Set(humans.map((p) => p.seat));
  let botIndex = 1;
  while (botIndex <= target) {
    let seat = 0;
    while (usedSeats.has(seat)) seat += 1;
    usedSeats.add(seat);
    humans.push({
      uid: `bot_${room.roomId}_${botIndex}`,
      seat,
      nickname: `电脑${botIndex}`,
      ready: true,
      online: true,
      isBot: true,
    });
    botIndex += 1;
  }
  const merged = normalizePlayers(humans);
  await db.collection(ROOM_COLLECTION).doc(room._id).update({
    data: {
      players: merged,
      botCount: target,
      updatedAt: now(),
    },
  });
  return {
    ok: true,
    botCount: target,
    roomState: safeRoomState({
      ...room,
      players: merged,
      botCount: target,
      updatedAt: now(),
    }),
  };
}

/** 房主在等待阶段设置结算底金（1/2/5/10 元） */
async function actionSetBaseStake(event, wxContext) {
  const uid = String(wxContext.OPENID || "");
  const roomId = String(event?.roomId || "").trim();
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  if (!roomId) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  if (room.ownerUid !== uid) return { ok: false, code: "E_ROOM_NOT_OWNER" };
  if (room.status !== "waiting") return { ok: false, code: "E_ROOM_INVALID_STATE" };
  const baseStake = normalizeBaseStake(event?.payload?.baseStake);
  await db.collection(ROOM_COLLECTION).doc(room._id).update({
    data: { baseStake, updatedAt: now() },
  });
  const nextRoom = { ...room, baseStake, updatedAt: now() };
  return { ok: true, baseStake, roomState: safeRoomState(nextRoom) };
}

/** 处理再来一局：将全员置为已准备并更新房间状态 */
async function actionNextRound(event, wxContext) {
  const uid = String(wxContext.OPENID || "");
  const roomId = String(event?.roomId || "").trim();
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  if (room.ownerUid !== uid) return { ok: false, code: "E_ROOM_NOT_OWNER" };
  const players = normalizePlayers(room.players || []).map((p) => ({ ...p, ready: true }));
  const canStart = players.length === TABLE_SIZE;
  const nextSnapshot = canStart
    ? createGameSnapshot({
        ...room,
        players,
      })
    : room.gameSnapshot || null;
  await db.collection(ROOM_COLLECTION).doc(room._id).update({
    data: {
      players,
      status: canStart ? "gaming" : "waiting",
      gameSnapshot: gameSnapshotWrite(nextSnapshot),
      updatedAt: now(),
      gameUpdatedAt: canStart ? now() : room.gameUpdatedAt || null,
    },
  });
  return {
    ok: true,
    roomState: safeRoomState({
      ...room,
      players,
      status: canStart ? "gaming" : "waiting",
      updatedAt: now(),
    }),
    startPayload: canStart ? buildSnapshotForUid({ ...room, players }, uid, nextSnapshot) : null,
  };
}

/** 退出房间：当前实现为直接关闭整间房（删除房间文档） */
async function actionLeaveRoom(event, wxContext) {
  const uid = String(wxContext.OPENID || "");
  const roomId = String(event?.roomId || "").trim();
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  if (!roomId) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: true, closed: true };
  const inRoom = normalizePlayers(room.players || []).some((p) => p.uid === uid);
  if (!inRoom) return { ok: false, code: "E_ROOM_NOT_IN" };
  await db.collection(ROOM_COLLECTION).doc(room._id).remove();
  return { ok: true, closed: true };
}

/** 关闭当前房间并由房主立即新建一个房间 */
async function actionRecreateRoom(event, wxContext) {
  const uid = String(wxContext.OPENID || "");
  const roomId = String(event?.roomId || "").trim();
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  if (!roomId) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  if (room.ownerUid !== uid) return { ok: false, code: "E_ROOM_NOT_OWNER" };
  // 直接关房：删除当前房间文档，避免后续扫码回到旧局
  const prevStake = normalizeBaseStake(room.baseStake);
  await db.collection(ROOM_COLLECTION).doc(room._id).remove();
  // 复用建房逻辑，新房默认仅房主入座，底金沿用上一局
  return actionCreateRoom(
    {
      payload: {
        nickname: String(event?.payload?.nickname || uid).trim() || uid,
        avatarUrl: String(event?.payload?.avatarUrl || "").trim(),
        baseStake: prevStake,
      },
    },
    wxContext,
  );
}

/** 云函数统一入口：按 action 路由到对应处理方法 */
exports.main = async (event = {}) => {
  try {
    const action = String(event?.action || "").trim();
    const wxContext = cloud.getWXContext();
    const uid = String(wxContext.OPENID || "");
    const roomId = String(event?.roomId || "").trim();
    if (action === "auth.login") return actionLogin(event, wxContext);
    if (action === "room.create") return actionCreateRoom(event, wxContext);
    if (action === "room.join") return actionJoinRoom(event, wxContext);
    if (action === "room.state") return actionGetRoomState(event, wxContext);
    if (action === "room.ready") return actionSetReady(event, wxContext);
    if (action === "room.setBots") return actionSetBots(event, wxContext);
    if (action === "room.setBaseStake") return actionSetBaseStake(event, wxContext);
    if (action === "room.leave") return actionLeaveRoom(event, wxContext);
    if (action === "room.nextRound") return actionNextRound(event, wxContext);
    if (action === "room.recreate") return actionRecreateRoom(event, wxContext);
    if (action === "game.snapshot") return actionGameSnapshot(roomId, uid);
    if (action === "game.discard") return actionGameDiscard(roomId, uid, event?.payload || {});
    if (action === "game.reaction") return actionGameReaction(roomId, uid, event?.payload || {});
    return { ok: false, code: "E_NOT_IMPLEMENTED", message: action || "unknown action" };
  } catch (err) {
    return { ok: false, code: "E_INTERNAL", message: err?.message || "internal error" };
  }
};

/** 就地打乱数组（Fisher-Yates） */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** 构建整副牌墙（万/筒/条共 27 种，每种 4 张） */
function buildWall() {
  const wall = [];
  let id = 1;
  for (let typeIdx = 0; typeIdx < TILE_KIND_COUNT; typeIdx += 1) {
    for (let k = 0; k < 4; k += 1) {
      wall.push({ id: id++, typeIdx });
    }
  }
  shuffleInPlace(wall);
  return wall;
}

/** 计算顶果的下一张（同花色内循环） */
function nextInSuit(typeIdx) {
  const suit = Math.floor(typeIdx / 9);
  const num = (typeIdx % 9) + 1;
  const nextNum = num === 9 ? 1 : num + 1;
  return suit * 9 + (nextNum - 1);
}

/** 牌型索引转中文名（如 1万、5筒） */
function tileName(typeIdx) {
  const suit = Math.floor(typeIdx / 9);
  const num = (typeIdx % 9) + 1;
  const suitName = suit === 0 ? "万" : suit === 1 ? "筒" : "条";
  return `${num}${suitName}`;
}

/** 统计数组转缓存 key */
function countsKey(counts) {
  return counts.join(",");
}

/** 递归判断剩余牌是否都能组成面子（刻子/顺子） */
function canFormMelds(counts, memo) {
  const key = countsKey(counts);
  if (memo.has(key)) return memo.get(key);
  let i = 0;
  while (i < TILE_KIND_COUNT && counts[i] === 0) i += 1;
  if (i === TILE_KIND_COUNT) {
    memo.set(key, true);
    return true;
  }
  // 刻子
  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canFormMelds(counts, memo)) {
      counts[i] += 3;
      memo.set(key, true);
      return true;
    }
    counts[i] += 3;
  }
  // 顺子（同花色且 i,i+1,i+2 都有）
  const suit = Math.floor(i / 9);
  const pos = i % 9;
  if (pos <= 6 && Math.floor((i + 2) / 9) === suit && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i] -= 1;
    counts[i + 1] -= 1;
    counts[i + 2] -= 1;
    if (canFormMelds(counts, memo)) {
      counts[i] += 1;
      counts[i + 1] += 1;
      counts[i + 2] += 1;
      memo.set(key, true);
      return true;
    }
    counts[i] += 1;
    counts[i + 1] += 1;
    counts[i + 2] += 1;
  }
  memo.set(key, false);
  return false;
}

/**
 * 带癞子的面子分解（癞子可替代任意牌；与 logic.js 一致）
 * counts 中癞子点数已为 0，laizi 为剩余可用癞子张数
 */
function canFormMeldsWithLaizi(counts, laizi, memo) {
  const key = countsKey(counts) + "|" + laizi;
  if (memo.has(key)) return memo.get(key);

  let total = 0;
  for (let v of counts) total += v;

  if ((total + laizi) % 3 !== 0) {
    memo.set(key, false);
    return false;
  }

  if (total === 0) {
    const ok = laizi % 3 === 0;
    memo.set(key, ok);
    return ok;
  }

  let i = 0;
  while (i < TILE_KIND_COUNT && counts[i] === 0) i += 1;
  if (i === TILE_KIND_COUNT) {
    const ok = laizi % 3 === 0;
    memo.set(key, ok);
    return ok;
  }

  for (let use = Math.min(counts[i], 3); use >= 0; use -= 1) {
    const need = 3 - use;
    if (need > laizi) continue;
    const cp = counts.slice();
    cp[i] -= use;
    if (canFormMeldsWithLaizi(cp, laizi - need, memo)) {
      memo.set(key, true);
      return true;
    }
  }

  const pos = i % 9;
  if (pos <= 6 && Math.floor((i + 2) / 9) === Math.floor(i / 9)) {
    const j = i + 1;
    const k = i + 2;
    const combinations = [
      { ni: 0, nj: 0, nk: 0, need: 0 },
      { ni: 1, nj: 0, nk: 0, need: 1 },
      { ni: 0, nj: 1, nk: 0, need: 1 },
      { ni: 0, nj: 0, nk: 1, need: 1 },
    ];
    for (const combo of combinations) {
      const { ni, nj, nk, need } = combo;
      if (need > laizi) continue;
      const okI = counts[i] >= 1 - ni;
      const okJ = counts[j] >= 1 - nj;
      const okK = counts[k] >= 1 - nk;
      if (!okI || !okJ || !okK) continue;
      const cp = counts.slice();
      if (ni === 0) cp[i] -= 1;
      if (nj === 0) cp[j] -= 1;
      if (nk === 0) cp[k] -= 1;
      if (canFormMeldsWithLaizi(cp, laizi - need, memo)) {
        memo.set(key, true);
        return true;
      }
    }
  }

  memo.set(key, false);
  return false;
}

/** 无癞子胡牌判定（4 面子 + 1 将） */
function isWinningHandCountsNoLaizi(counts) {
  for (let i = 0; i < TILE_KIND_COUNT; i += 1) {
    if (counts[i] >= 2) {
      counts[i] -= 2;
      if (canFormMelds(counts, new Map())) {
        counts[i] += 2;
        return true;
      }
      counts[i] += 2;
    }
  }
  return false;
}

/** 有癞子（最多 1 张）胡牌判定：雀头与面子均可消耗癞子（与 logic.js 一致） */
function isWinningWithLaizi(originalCounts, laiziIdx) {
  const counts = originalCounts.slice();
  let laizi = counts[laiziIdx] || 0;
  counts[laiziIdx] = 0;

  const total = counts.reduce((a, b) => a + b, 0) + laizi;
  if (total !== 14) return false;

  const memo = new Map();
  for (let i = 0; i < TILE_KIND_COUNT; i += 1) {
    const have = counts[i];
    const need = Math.max(2 - have, 0);
    if (need > laizi) continue;
    const cp = counts.slice();
    cp[i] -= Math.min(2, have);
    if (canFormMeldsWithLaizi(cp, laizi - need, memo)) return true;
  }
  if (laizi >= 2 && canFormMeldsWithLaizi(counts, laizi - 2, memo)) return true;
  return false;
}

/** 胡牌判定入口（支持最多 1 张癞子） */
function canHuByTypes(typeIdxs, laiziTypeIdx) {
  if (!Array.isArray(typeIdxs) || typeIdxs.length !== 14) return false;
  const counts = new Array(TILE_KIND_COUNT).fill(0);
  for (const t of typeIdxs) counts[t] += 1;
  if (laiziTypeIdx == null || laiziTypeIdx < 0) {
    return isWinningHandCountsNoLaizi(counts);
  }
  const laiziCount = counts[laiziTypeIdx] || 0;
  if (laiziCount > 1) return false;
  return isWinningWithLaizi(counts, laiziTypeIdx);
}

/** 判断指定座位当前手牌是否可胡（仅自摸） */
function canSeatHu(room, ss, seat) {
  const player = normalizePlayers(room.players || []).find((p) => p.seat === seat);
  if (!player) return false;
  const hand = (ss.handsByUid[player.uid] || []).map((t) => t.typeIdx);
  const melds = ss.meldsBySeat?.[seat] || [];
  for (const m of melds) {
    for (let i = 0; i < 3; i += 1) hand.push(m.tileTypeIdx);
  }
  return canHuByTypes(hand, ss.laiziTypeIdx);
}

/** 判断手牌是否处于听牌：补任意一张牌存在可胡可能 */
function isTingByTypes(typeIdxs, laiziTypeIdx) {
  const hand = Array.isArray(typeIdxs) ? typeIdxs.slice() : [];
  for (let t = 0; t < TILE_KIND_COUNT; t += 1) {
    const test = hand.slice();
    test.push(t);
    if (canHuByTypes(test, laiziTypeIdx)) return true;
  }
  return false;
}

/**
 * 是否满足“该逞”：
 * 手牌仅1个癞子时：若再出一张（非癞子）即可听牌，则应逞
 */
function shouldSeatCheng(room, ss, seat) {
  if (ss.laiziTypeIdx == null || ss.laiziTypeIdx < 0) return false;
  const p = normalizePlayers(room.players || []).find((x) => x.seat === seat);
  if (!p) return false;
  const handTiles = ss.handsByUid[p.uid] || [];
  const laiziTypeIdx = ss.laiziTypeIdx;
  const types = handTiles.map((t) => t.typeIdx);
  const melds = ss.meldsBySeat?.[seat] || [];
  for (const m of melds) {
    for (let i = 0; i < 3; i += 1) types.push(m.tileTypeIdx);
  }
  const laiziCount = types.filter((t) => t === laiziTypeIdx).length;
  if (laiziCount !== 1) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === laiziTypeIdx) continue;
    const rest = types.slice(0, i).concat(types.slice(i + 1));
    if (isTingByTypes(rest, laiziTypeIdx)) return true;
  }
  return false;
}

/** 统计公开弃牌中每种牌型已出现张数（仅用公开信息，不看牌山） */
function buildDiscardTypeCounts(ss) {
  const counts = new Array(TILE_KIND_COUNT).fill(0);
  const bySeat = ss?.discardsBySeat || {};
  for (const seatKey of Object.keys(bySeat)) {
    const arr = Array.isArray(bySeat[seatKey]) ? bySeat[seatKey] : [];
    for (const t of arr) {
      const idx = Number(t?.typeIdx);
      if (Number.isInteger(idx) && idx >= 0 && idx < TILE_KIND_COUNT) counts[idx] += 1;
    }
  }
  return counts;
}

/** 基于“逞后手牌”计算所有可胡进张牌型（听牌列表） */
function getWinningTypesAfterCheng(room, ss, seat) {
  if (ss.laiziTypeIdx == null || ss.laiziTypeIdx < 0) return [];
  const player = normalizePlayers(room.players || []).find((p) => p.seat === seat);
  if (!player) return [];
  const types = (ss.handsByUid[player.uid] || []).map((t) => t.typeIdx);
  const melds = ss.meldsBySeat?.[seat] || [];
  for (const m of melds) {
    for (let i = 0; i < 3; i += 1) types.push(m.tileTypeIdx);
  }
  const laiziIdx = types.indexOf(ss.laiziTypeIdx);
  if (laiziIdx < 0) return [];
  // 模拟逞：先打掉1张癞子，再看摸哪张可胡
  const base = types.slice(0, laiziIdx).concat(types.slice(laiziIdx + 1));
  const out = [];
  for (let t = 0; t < TILE_KIND_COUNT; t += 1) {
    const test = base.slice();
    test.push(t);
    if (canHuByTypes(test, ss.laiziTypeIdx)) out.push(t);
  }
  return out;
}

/**
 * 可胡且有癞子时，是否仍应优先逞：
 * - 只看公开弃牌，不看牌山（避免作弊）
 * - 若逞后可胡进张大多已被打出 >=3 张，则改为直接胡
 */
function shouldBotChengWhenCanHu(room, ss, seat) {
  const wins = getWinningTypesAfterCheng(room, ss, seat);
  if (!wins.length) return false;
  const discardCounts = buildDiscardTypeCounts(ss);
  let hardSeen = 0;
  for (const t of wins) {
    if ((discardCounts[t] || 0) >= 3) hardSeen += 1;
  }
  // 多数可胡进张都已见3张以上：概率太差，不逞，直接胡
  return hardSeen * 2 < wins.length;
}

/** 初始化本局计分容器与逞次数容器 */
function initRoundMoney(ss, room) {
  if (!ss.chengCountBySeat) ss.chengCountBySeat = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (let s = 0; s < 4; s += 1) {
    if (ss.chengCountBySeat[s] == null) ss.chengCountBySeat[s] = 0;
  }
  if (ss.oilEligibleSeat === undefined) ss.oilEligibleSeat = null;
  if (!ss.scoreDeltaByUid) ss.scoreDeltaByUid = {};
  for (const p of normalizePlayers(room.players || [])) {
    if (ss.scoreDeltaByUid[p.uid] == null) ss.scoreDeltaByUid[p.uid] = 0;
  }
}

/** 对指定 uid 叠加本局收支 */
function addScoreDelta(ss, uid, delta) {
  ss.scoreDeltaByUid[uid] = (ss.scoreDeltaByUid[uid] || 0) + delta;
}

/** 克隆本局收支快照，避免直接引用内部对象 */
function cloneScoreDelta(ss) {
  return { ...(ss.scoreDeltaByUid || {}) };
}

/** 判断胡牌手牌里是否包含癞子（软胡/油判断） */
function handHasLaiziInWinningHand(ss, room, seat) {
  const p = normalizePlayers(room.players || []).find((x) => x.seat === seat);
  if (!p || ss.laiziTypeIdx == null) return false;
  const h = ss.handsByUid[p.uid] || [];
  return h.some((t) => t.typeIdx === ss.laiziTypeIdx);
}

/** 直杠结算：点杠者付 15，杠牌者收 15 */
function settleZhigang(room, ss, gangSeat, fromSeat) {
  initRoundMoney(ss, room);
  const gangP = normalizePlayers(room.players || []).find((p) => p.seat === gangSeat);
  const fromP = normalizePlayers(room.players || []).find((p) => p.seat === fromSeat);
  if (!gangP || !fromP) return;
  const m = stakeMoney(room, 15);
  addScoreDelta(ss, fromP.uid, -m);
  addScoreDelta(ss, gangP.uid, m);
}

/** 顶果碰结算：若碰前手里有顶果对子，则打牌者付碰牌者 15 */
function settleDingguoPeng(room, ss, pengSeat, fromSeat, hadPairInHand) {
  if (!hadPairInHand) return;
  initRoundMoney(ss, room);
  const pengP = normalizePlayers(room.players || []).find((p) => p.seat === pengSeat);
  const fromP = normalizePlayers(room.players || []).find((p) => p.seat === fromSeat);
  if (!pengP || !fromP) return;
  const m = stakeMoney(room, 15);
  addScoreDelta(ss, fromP.uid, -m);
  addScoreDelta(ss, pengP.uid, m);
}

/** 暗杠结算：其余三家各付 10，杠牌者共收 30 */
function settleAnGang(room, ss, gangSeat) {
  initRoundMoney(ss, room);
  const gangP = normalizePlayers(room.players || []).find((p) => p.seat === gangSeat);
  if (!gangP) return;
  const pay = stakeMoney(room, 10);
  let gain = 0;
  for (const p of normalizePlayers(room.players || [])) {
    if (p.seat === gangSeat) continue;
    addScoreDelta(ss, p.uid, -pay);
    gain += pay;
  }
  addScoreDelta(ss, gangP.uid, gain);
}

/** 自摸胡结算：油/软硬胡 + 逞倍数，返回胡牌标签 */
function settleSelfHu(room, ss, winnerSeat, isOil) {
  initRoundMoney(ss, room);
  const winP = normalizePlayers(room.players || []).find((p) => p.seat === winnerSeat);
  if (!winP) return { kind: "hu", label: "", isOil: false };
  const soft = handHasLaiziInWinningHand(ss, room, winnerSeat);
  let totalGain = 0;
  if (isOil) {
    const per = stakeMoney(room, soft ? 20 : 40);
    for (const p of normalizePlayers(room.players || [])) {
      if (p.seat === winnerSeat) continue;
      addScoreDelta(ss, p.uid, -per);
      totalGain += per;
    }
    addScoreDelta(ss, winP.uid, totalGain);
    return { kind: "oil", label: soft ? "软油" : "黑油", isOil: true, perPerson: per };
  }
  const base = stakeMoney(room, soft ? 5 : 10);
  const chengMult = (count) => {
    const n = Math.max(0, Number(count) || 0);
    return 2 ** n;
  };
  const wCheng = ss.chengCountBySeat[winnerSeat] || 0;
  const wMult = chengMult(wCheng);
  for (const p of normalizePlayers(room.players || [])) {
    if (p.seat === winnerSeat) continue;
    const pCheng = ss.chengCountBySeat[p.seat] || 0;
    const pMult = chengMult(pCheng);
    const pay = base * wMult * pMult;
    addScoreDelta(ss, p.uid, -pay);
    totalGain += pay;
  }
  addScoreDelta(ss, winP.uid, totalGain);
  return {
    kind: "hu",
    label: soft ? "软胡" : "硬胡",
    isOil: false,
    base,
    winnerChengMult: wMult,
  };
}

/** 计算暗杠候选牌型（同牌>=4） */
function getAnGangCandidates(hand) {
  if (!Array.isArray(hand) || hand.length < 4) return [];
  const counts = new Map();
  for (const t of hand) {
    counts.set(t.typeIdx, (counts.get(t.typeIdx) || 0) + 1);
  }
  const out = [];
  for (const [typeIdx, n] of counts.entries()) {
    if (n >= 4) out.push(typeIdx);
  }
  return out.sort((a, b) => a - b);
}

/** 摸牌后的阶段流转：暗杠自反应 / 出牌 / 最后一张后流局 */
function enterAfterDraw(room, ss, seat) {
  const player = normalizePlayers(room.players || []).find((p) => p.seat === seat);
  if (!player) return;
  const hand = ss.handsByUid[player.uid] || [];
  const cands = getAnGangCandidates(hand);
  ss.reaction = null;
  if (cands.length > 0) {
    ss.phase = "self_react";
    ss.selfReaction = {
      seat,
      uid: player.uid,
      anGangCandidates: cands,
    };
    ss.currentSeat = seat;
    ss.status = `${displayNameByUid(room, player.uid)}可暗杠或过`;
    return;
  }
  ss.selfReaction = null;
  ss.phase = "discard";
  ss.currentSeat = seat;
  if (ss.wallCount === 0 && !canSeatHu(room, ss, seat)) {
    ss.phase = "gameover";
    ss.winnerSeat = null;
    clearReactionState(ss);
    ss.status = "流局：最后一张摸牌后未能胡牌";
  }
}

/** 参与行牌的座位集合：优先快照开局时的 ss.players，避免 room.players 座位字段异常导致摸牌顺序算错 */
function buildPresentSeatsForTurn(room, ss) {
  const tryLists = [];
  if (ss && Array.isArray(ss.players) && ss.players.length > 0) {
    tryLists.push(ss.players);
  }
  tryLists.push(normalizePlayers(room.players || []));
  for (const list of tryLists) {
    const present = new Set();
    for (const p of list) {
      const s = Number(p.seat);
      if (Number.isInteger(s) && s >= 0 && s <= 3) present.add(s);
    }
    if (present.size >= 2) return present;
  }
  return new Set([0, 1, 2, 3]);
}

/** 获取逆时针下一家座位（碰/杠后无人应、或出牌无人碰杠时摸牌顺序与此一致） */
function getNextSeat(room, seat, ss) {
  const present = buildPresentSeatsForTurn(room, ss);
  const s = Number(seat);
  const idx = PLAY_ORDER_CCW.indexOf(s);
  if (idx < 0) {
    for (let k = 0; k < 4; k += 1) {
      const cand = (s + 3 + k) % 4;
      if (present.has(cand)) return cand;
    }
    return s;
  }
  for (let step = 1; step <= 4; step += 1) {
    const next = PLAY_ORDER_CCW[(idx + step) % 4];
    if (present.has(next)) return next;
  }
  return s;
}

/** 构建首局/新局快照（云端权威态） */
function createGameSnapshot(room) {
  const players = normalizePlayers(room.players || []);
  const bySeat = players.slice().sort((a, b) => a.seat - b.seat);
  const wall = buildWall();
  const handsByUid = {};
  for (const p of bySeat) {
    handsByUid[p.uid] = [];
  }
  // 每人 13 张
  for (let r = 0; r < 13; r += 1) {
    for (const p of bySeat) {
      const t = wall.pop();
      if (t) handsByUid[p.uid].push(t);
    }
  }
  // 翻顶果并计算癞子
  const indicator = wall.pop() || null;
  const dingGuoTypeIdx = indicator ? indicator.typeIdx : null;
  const laiziTypeIdx =
    indicator && typeof indicator.typeIdx === "number" ? nextInSuit(indicator.typeIdx) : null;
  // 庄家（座位 0）摸 14 张先出牌
  const dealer = bySeat.find((p) => p.seat === 0);
  let dealerDrawTileId = null;
  if (dealer) {
    const t = wall.pop();
    if (t) {
      handsByUid[dealer.uid].push(t);
      dealerDrawTileId = t.id;
    }
  }
  for (const p of bySeat) {
    handsByUid[p.uid].sort((a, b) => a.typeIdx - b.typeIdx || a.id - b.id);
  }
  const ss = {
    roomId: room.roomId,
    roomNo: room.roomNo,
    players: bySeat.map((p) => ({ uid: p.uid, seat: p.seat })),
    dealerSeat: 0,
    currentSeat: 0,
    phase: "discard",
    seq: 1,
    status: "游戏开始，等庄家出牌",
    dingGuoTypeIdx,
    laiziTypeIdx,
    wallCount: wall.length,
    wall,
    handsByUid,
    meldsBySeat: { 0: [], 1: [], 2: [], 3: [] },
    discardsBySeat: { 0: [], 1: [], 2: [], 3: [] },
    discardHistory: [],
    reaction: null,
    reactionQueue: null,
    reactionIndex: 0,
    reactionFromSeat: null,
    reactionTile: null,
    selfReaction: null,
    winnerSeat: null,
    /** 出牌阶段可胡时点了「过」则本手不再弹胡，打出一张后清除 */
    huPassSkipSeat: null,
    /** 明碰/明杠他人打出牌后须先打出一张（含逞癞子）才允许胡，禁碰胡/杠胡 */
    pengNoHuUntilDiscardSeat: null,
    chengCountBySeat: { 0: 0, 1: 0, 2: 0, 3: 0 },
    oilEligibleSeat: null,
    scoreDeltaByUid: {},
    selfLastDrawTileIdByUid: dealer && dealerDrawTileId != null ? { [dealer.uid]: dealerDrawTileId } : {},
    // 机器人下一次允许行动时间（毫秒时间戳），用于控制动作间隔
    botNextActAt: now() + 1500,
    lastActionAt: now(),
  };
  initRoundMoney(ss, room);
  // 开局时庄家已经有 14 张，先进入“暗杠自反应/出牌”判定
  enterAfterDraw(room, ss, 0);
  return ss;
}

/** 判断当前是否轮到机器人执行动作（包含 react/self_react） */
function isBotPending(room, ss) {
  const players = normalizePlayers(room.players || []);
  if (ss.phase === "discard") {
    const current = players.find((p) => p.seat === ss.currentSeat);
    return !!current?.isBot;
  }
  if (ss.phase === "react" && ss.reactionQueue?.length) {
    const cur = ss.reactionQueue[ss.reactionIndex];
    return !!cur?.isBot;
  }
  if (ss.phase === "self_react" && ss.selfReaction) {
    const cur = players.find((p) => p.uid === ss.selfReaction.uid);
    return !!cur?.isBot;
  }
  return false;
}

/** 为下一步机器人动作设置延时窗口（避免瞬时连跳） */
function armBotDelay(ss, delayMs = 1500) {
  ss.botNextActAt = Date.now() + Math.max(500, Number(delayMs) || 1500);
}

/** 真人回合时清门控，机器人回合时设延时，避免上一拍时间门把局卡死 */
function syncBotGate(room, ss) {
  if (isBotPending(room, ss)) armBotDelay(ss, 1500);
  else ss.botNextActAt = 0;
}

/** 根据房间与 uid 计算当前可执行操作 */
function getSelfOps(room, uid, ss) {
  const player = normalizePlayers(room.players || []).find((p) => p.uid === uid);
  if (!player || !ss) return null;
  if (ss.phase === "gameover") return null;
  if (ss.phase === "self_react" && ss.selfReaction) {
    if (ss.selfReaction.uid !== uid) {
      return {
        canPeng: false,
        canGang: false,
        canHu: false,
        canPass: false,
        canCheng: false,
        canAnGang: false,
        anGangTypeIdxs: [],
      };
    }
    const seat = ss.selfReaction.seat;
    const canHu =
      ss.pengNoHuUntilDiscardSeat !== seat && canSeatHu(room, ss, seat);
    return {
      canPeng: false,
      canGang: false,
      canHu,
      canPass: true,
      canCheng: false,
      canAnGang: ss.selfReaction.anGangCandidates.length > 0,
      anGangTypeIdxs: ss.selfReaction.anGangCandidates.slice(),
    };
  }
  if (ss.phase === "react" && ss.reactionQueue?.length) {
    const cur = ss.reactionQueue[ss.reactionIndex];
    if (cur && cur.uid === uid) {
      return {
        canPeng: !!cur.canPeng,
        canGang: !!cur.canGang,
        canHu: false,
        canPass: true,
        canCheng: false,
        canAnGang: false,
        anGangTypeIdxs: [],
      };
    }
    return {
      canPeng: false,
      canGang: false,
      canHu: false,
      canPass: false,
      canCheng: false,
      canAnGang: false,
      anGangTypeIdxs: [],
    };
  }
  if (ss.phase === "discard" && ss.currentSeat === player.seat) {
    const hand = ss.handsByUid[player.uid] || [];
    const canCheng =
      ss.laiziTypeIdx != null && hand.some((t) => t.typeIdx === ss.laiziTypeIdx);
    const blockedPengHu = ss.pengNoHuUntilDiscardSeat === player.seat;
    const rawHu =
      !blockedPengHu && canSeatHu(room, ss, player.seat);
    const canHu = rawHu && ss.huPassSkipSeat !== player.seat;
    return {
      canPeng: false,
      canGang: false,
      canHu,
      canPass: rawHu && ss.huPassSkipSeat !== player.seat,
      canCheng,
      canAnGang: false,
      anGangTypeIdxs: [],
    };
  }
  return {
    canPeng: false,
    canGang: false,
    canHu: false,
    canPass: false,
    canCheng: false,
    canAnGang: false,
    anGangTypeIdxs: [],
  };
}

/** 临时调试：各「机器人座位」的完整手牌（真人座位不在此对象中） */
function buildBotHandsBySeat(room, ss) {
  const out = {};
  if (!room || !ss || !ss.handsByUid) return out;
  for (const p of normalizePlayers(room.players || [])) {
    if (p.isBot && p.seat >= 0 && p.seat <= 3) {
      const tiles = ss.handsByUid[p.uid] || [];
      out[p.seat] = tiles.map((t) => ({ id: t.id, typeIdx: t.typeIdx }));
    }
  }
  return out;
}

/** 局末亮牌：胡牌者手牌（仅 gameover 且有胜者时下发） */
function buildWinnerExposeHand(room, ss) {
  if (ss.phase !== "gameover" || ss.winnerSeat == null) return null;
  const wp = normalizePlayers(room.players || []).find((p) => p.seat === ss.winnerSeat);
  if (!wp) return null;
  const tiles = ss.handsByUid[wp.uid] || [];
  return tiles.map((t) => ({ id: t.id, typeIdx: t.typeIdx }));
}

/** 构建可下发给当前玩家的游戏快照（仅包含本人手牌） */
function buildSnapshotForUid(room, uid, ss) {
  const seat = normalizePlayers(room.players || []).find((p) => p.uid === uid)?.seat;
  return {
    roomId: room.roomId,
    roomNo: room.roomNo,
    dealerSeat: ss.dealerSeat ?? 0,
    currentSeat: ss.currentSeat,
    phase: ss.phase,
    seq: ss.seq,
    players: ss.players,
    dingGuoTypeIdx: ss.dingGuoTypeIdx,
    laiziTypeIdx: ss.laiziTypeIdx,
    wallCount: ss.wallCount,
    discardsBySeat: ss.discardsBySeat,
    discardHistory: ss.discardHistory || [],
    meldsBySeat: ss.meldsBySeat,
    hand: ss.handsByUid[uid] || [],
    selfLastDrawTileId: ss.selfLastDrawTileIdByUid?.[uid] ?? null,
    reactionForSelf: getSelfOps(room, uid, ss),
    status: ss.status,
    winnerSeat: ss.winnerSeat,
    reactionFromSeat: ss.reactionFromSeat,
    reactionTile: ss.reactionTile,
    scoreDeltaByUid: cloneScoreDelta(ss),
    chengCountBySeat: ss.chengCountBySeat || { 0: 0, 1: 0, 2: 0, 3: 0 },
    selfChengCount:
      typeof ss.chengCountBySeat?.[seat] === "number" ? ss.chengCountBySeat[seat] : 0,
    botHandsBySeat: buildBotHandsBySeat(room, ss),
    winnerExposeHand: buildWinnerExposeHand(room, ss),
  };
}

/** 同步 reaction 指针到当前等待响应的玩家 */
function syncReactionPointer(ss) {
  if (!ss.reactionQueue?.length || ss.reactionIndex >= ss.reactionQueue.length) {
    ss.reaction = null;
    return;
  }
  const cur = ss.reactionQueue[ss.reactionIndex];
  ss.reaction = {
    fromSeat: ss.reactionFromSeat,
    tile: ss.reactionTile,
    seat: cur.seat,
    uid: cur.uid,
    canPeng: cur.canPeng,
    canGang: cur.canGang,
    canHu: false,
  };
  ss.currentSeat = cur.seat;
}

/** 清理响应阶段状态 */
function clearReactionState(ss) {
  ss.reactionQueue = null;
  ss.reactionIndex = 0;
  ss.reactionFromSeat = null;
  ss.reactionTile = null;
  ss.reaction = null;
}

/** 从出牌者下家开始构建可碰/杠响应队列（杠优先） */
function buildReactionQueue(room, fromSeat, discardTile, ss) {
  const orderedSeats = [];
  let seat = getNextSeat(room, fromSeat, ss);
  for (let i = 0; i < normalizePlayers(room.players || []).length - 1; i += 1) {
    orderedSeats.push(seat);
    seat = getNextSeat(room, seat, ss);
  }
  const orderIndex = (s) => orderedSeats.indexOf(s);
  const entries = [];
  for (const s of orderedSeats) {
    const p = normalizePlayers(room.players || []).find((x) => x.seat === s);
    if (!p) continue;
    const hand = ss.handsByUid[p.uid] || [];
    const same = hand.filter((t) => t.typeIdx === discardTile.typeIdx).length;
    const canPeng = same >= 2;
    const canGang = same >= 3;
    if (canPeng || canGang) {
      entries.push({ seat: s, uid: p.uid, canPeng, canGang, isBot: !!p.isBot });
    }
  }
  entries.sort((a, b) => {
    const ta = a.canGang ? 0 : 1;
    const tb = b.canGang ? 0 : 1;
    if (ta !== tb) return ta - tb;
    return orderIndex(a.seat) - orderIndex(b.seat);
  });
  return entries;
}

/** 给指定座位摸一张牌并切回 discard 阶段 */
function drawOneToSeat(room, ss, seat) {
  const player = normalizePlayers(room.players || []).find((p) => p.seat === seat);
  if (!player) return null;
  const t = ss.wall.pop() || null;
  if (!t) return null;
  ss.handsByUid[player.uid].push(t);
  if (!ss.selfLastDrawTileIdByUid) ss.selfLastDrawTileIdByUid = {};
  ss.selfLastDrawTileIdByUid[player.uid] = t.id;
  ss.handsByUid[player.uid].sort((a, b) => a.typeIdx - b.typeIdx || a.id - b.id);
  ss.wallCount = ss.wall.length;
  enterAfterDraw(room, ss, seat);
  return t;
}

/** 执行一次出牌动作，返回标准 actionResult */
function applyDiscardCore(room, ss, uid, tileId) {
  initRoundMoney(ss, room);
  if (ss.phase !== "discard") return { error: "E_INVALID_PHASE" };
  const actor = normalizePlayers(room.players || []).find((p) => p.uid === uid);
  if (!actor) return { error: "E_ROOM_NOT_IN" };
  if (actor.seat !== ss.currentSeat) return { error: "E_NOT_YOUR_TURN" };
  if (ss.huPassSkipSeat === actor.seat) {
    ss.huPassSkipSeat = null;
  }
  if (ss.pengNoHuUntilDiscardSeat === actor.seat) {
    ss.pengNoHuUntilDiscardSeat = null;
  }
  if (ss.oilEligibleSeat === actor.seat) {
    ss.oilEligibleSeat = null;
  }
  const hand = ss.handsByUid[uid] || [];
  const idx = hand.findIndex((t) => t.id === Number(tileId));
  if (idx < 0) return { error: "E_ILLEGAL_TILE" };
  if (ss.selfLastDrawTileIdByUid && ss.selfLastDrawTileIdByUid[uid] != null) {
    ss.selfLastDrawTileIdByUid[uid] = null;
  }
  const [discardTile] = hand.splice(idx, 1);
  if (!ss.discardsBySeat[actor.seat]) ss.discardsBySeat[actor.seat] = [];
  ss.discardsBySeat[actor.seat].push(discardTile);
  if (!Array.isArray(ss.discardHistory)) ss.discardHistory = [];
  ss.discardHistory.push({ seat: actor.seat, tile: discardTile });
  const rq = buildReactionQueue(room, actor.seat, discardTile, ss);
  let drawn = null;
  if (rq.length > 0) {
    ss.phase = "react";
    ss.reactionFromSeat = actor.seat;
    ss.reactionTile = discardTile;
    ss.reactionQueue = rq;
    ss.reactionIndex = 0;
    syncReactionPointer(ss);
    ss.status = `${displayNameByUid(room, uid)}已出牌${tileName(discardTile.typeIdx)}`;
  } else {
    const nextSeat = getNextSeat(room, actor.seat, ss);
    clearReactionState(ss);
    if (ss.wallCount > 0) {
      drawn = drawOneToSeat(room, ss, nextSeat);
      const justPlayed = `${displayNameByUid(room, uid)}已出牌${tileName(discardTile.typeIdx)}`;
      // drawOneToSeat 会进入 self_react 等状态，不能覆盖掉 enterAfterDraw 写好的提示
      if (drawn && ss.phase === "self_react") {
        ss.status = `${justPlayed}，${ss.status}`;
      } else if (drawn && ss.phase === "discard") {
        // 有人摸牌后轮到其出牌：保留上家出牌句，避免只看到上家而看不到「轮到谁」
        const who = displayNameBySeat(room, ss.currentSeat, ss);
        ss.status = `${justPlayed}，${who}请出牌`;
      } else {
        ss.status = drawn ? justPlayed : "流局：牌山没了";
      }
      if (!drawn) {
        ss.phase = "gameover";
        ss.winnerSeat = null;
      }
    } else {
      ss.phase = "gameover";
      ss.winnerSeat = null;
      ss.currentSeat = nextSeat;
      ss.status = "流局：牌山没了";
    }
  }
  ss.seq += 1;
  ss.lastActionAt = now();
  syncBotGate(room, ss);
  return {
    action: {
      seq: ss.seq,
      phase: ss.phase,
      actorSeat: actor.seat,
      discardTile,
      nextSeat: ss.currentSeat,
      wallCount: ss.wallCount,
      status: ss.status,
      drawnSeat: drawn ? ss.currentSeat : null,
      drawnTileId: drawn ? drawn.id : null,
      drawnTileTypeIdx: drawn ? drawn.typeIdx : null,
      reaction: ss.reaction,
      winnerSeat: ss.phase === "gameover" ? ss.winnerSeat : undefined,
      scoreDeltaByUid: cloneScoreDelta(ss),
    },
  };
}

/** 执行一次响应动作（碰/杠/过） */
function applyReactionCore(room, ss, uid, action, options = {}) {
  initRoundMoney(ss, room);
  // 自反应阶段：暗杠/过/可胡则胡
  if (ss.phase === "self_react" && ss.selfReaction?.uid === uid) {
    const actor = normalizePlayers(room.players || []).find((p) => p.uid === uid);
    if (!actor) return { error: "E_ROOM_NOT_IN" };
    if (action === "pass") {
      ss.selfReaction = null;
      ss.phase = "discard";
      ss.currentSeat = actor.seat;
      if (ss.wallCount === 0 && !canSeatHu(room, ss, actor.seat)) {
        ss.phase = "gameover";
        ss.winnerSeat = null;
        ss.status = "流局：最后一张摸牌后未能胡牌";
      } else {
        ss.status = `${displayNameByUid(room, uid)}请出牌`;
      }
      ss.seq += 1;
      ss.lastActionAt = now();
      syncBotGate(room, ss);
      return {
        action: {
          seq: ss.seq,
          phase: ss.phase,
          actorSeat: actor.seat,
          discardTile: null,
          nextSeat: ss.currentSeat,
          wallCount: ss.wallCount,
          status: ss.status,
          drawnSeat: null,
          drawnTileId: null,
          drawnTileTypeIdx: null,
          reaction: null,
          winnerSeat: ss.phase === "gameover" ? ss.winnerSeat : undefined,
          scoreDeltaByUid: cloneScoreDelta(ss),
        },
      };
    }
    if (action === "hu") {
      if (ss.pengNoHuUntilDiscardSeat === actor.seat) return { error: "E_INVALID_ACTION" };
      if (!canSeatHu(room, ss, actor.seat)) return { error: "E_INVALID_ACTION" };
      const isOil = ss.oilEligibleSeat === actor.seat;
      if (isOil) ss.oilEligibleSeat = null;
      const huSettlement = settleSelfHu(room, ss, actor.seat, isOil);
      ss.phase = "gameover";
      ss.winnerSeat = actor.seat;
      ss.selfReaction = null;
      clearReactionState(ss);
      ss.seq += 1;
      ss.lastActionAt = now();
      ss.status = `${displayNameByUid(room, uid)}胡牌（${huSettlement.label || "自摸"}）`;
      return {
        action: {
          seq: ss.seq,
          phase: ss.phase,
          actorSeat: actor.seat,
          discardTile: null,
          nextSeat: ss.currentSeat,
          wallCount: ss.wallCount,
          status: ss.status,
          drawnSeat: null,
          drawnTileId: null,
          drawnTileTypeIdx: null,
          reaction: null,
          winnerSeat: actor.seat,
          huSettlement,
          scoreDeltaByUid: cloneScoreDelta(ss),
        },
      };
    }
    if (action === "an_gang") {
      const typeIdx = Number(options.typeIdx);
      if (!Number.isInteger(typeIdx) || typeIdx < 0) return { error: "E_INVALID_ACTION" };
      if (!ss.selfReaction.anGangCandidates.includes(typeIdx)) {
        return { error: "E_INVALID_ACTION" };
      }
      const hand = ss.handsByUid[uid] || [];
      if (hand.filter((t) => t.typeIdx === typeIdx).length < 4) {
        return { error: "E_INVALID_ACTION" };
      }
      for (let k = 0; k < 4; k += 1) {
        const idx = hand.findIndex((t) => t.typeIdx === typeIdx);
        hand.splice(idx, 1);
      }
      ss.meldsBySeat[actor.seat].push({
        kind: "gang",
        tileTypeIdx: typeIdx,
        fromSeat: actor.seat,
        size: 4,
        concealed: true,
      });
      settleAnGang(room, ss, actor.seat);
      ss.selfReaction = null;
      const drawn = drawOneToSeat(room, ss, actor.seat);
      ss.seq += 1;
      ss.lastActionAt = now();
      if (!drawn) {
        ss.phase = "gameover";
        ss.winnerSeat = null;
        ss.status = "流局：杠后无牌可摸";
      } else if (ss.phase !== "self_react") {
        ss.status = `${displayNameByUid(room, uid)}暗杠，请出牌`;
      }
      syncBotGate(room, ss);
      return {
        action: {
          seq: ss.seq,
          phase: ss.phase,
          actorSeat: actor.seat,
          discardTile: null,
          nextSeat: ss.currentSeat,
          wallCount: ss.wallCount,
          status: ss.status,
          drawnSeat: drawn ? actor.seat : null,
          drawnTileId: drawn ? drawn.id : null,
          drawnTileTypeIdx: drawn ? drawn.typeIdx : null,
          reaction: ss.reaction,
          winnerSeat: ss.phase === "gameover" ? ss.winnerSeat : undefined,
          scoreDeltaByUid: cloneScoreDelta(ss),
        },
      };
    }
    return { error: "E_INVALID_ACTION" };
  }

  // 出牌阶段可胡时点「过」：本手不再提示胡，须再打出一张（与逞可同时存在，由客户端分支处理）
  if (action === "pass" && ss.phase === "discard") {
    const actor = normalizePlayers(room.players || []).find((p) => p.uid === uid);
    if (!actor) return { error: "E_ROOM_NOT_IN" };
    if (actor.seat !== ss.currentSeat) return { error: "E_NOT_YOUR_TURN" };
    if (!canSeatHu(room, ss, actor.seat)) return { error: "E_INVALID_ACTION" };
    ss.huPassSkipSeat = actor.seat;
    ss.seq += 1;
    ss.lastActionAt = now();
    syncBotGate(room, ss);
    return {
      action: {
        seq: ss.seq,
        phase: ss.phase,
        actorSeat: actor.seat,
        discardTile: null,
        nextSeat: ss.currentSeat,
        wallCount: ss.wallCount,
        status: `${displayNameByUid(room, uid)}过（不胡），请出牌`,
        drawnSeat: null,
        drawnTileId: null,
        drawnTileTypeIdx: null,
        reaction: null,
        scoreDeltaByUid: cloneScoreDelta(ss),
      },
    };
  }

  // 逞：只允许在自己的出牌阶段使用，打出癞子后立即补摸一张
  if (action === "cheng" && ss.phase === "discard") {
    const actor = normalizePlayers(room.players || []).find((p) => p.uid === uid);
    if (!actor) return { error: "E_ROOM_NOT_IN" };
    if (actor.seat !== ss.currentSeat) return { error: "E_NOT_YOUR_TURN" };
    const hand = ss.handsByUid[uid] || [];
    const idx = hand.findIndex((t) => t.typeIdx === ss.laiziTypeIdx);
    if (idx < 0) return { error: "E_INVALID_ACTION" };
    const [discardTile] = hand.splice(idx, 1);
    if (ss.pengNoHuUntilDiscardSeat === actor.seat) {
      ss.pengNoHuUntilDiscardSeat = null;
    }
    ss.discardsBySeat[actor.seat].push(discardTile);
    if (!Array.isArray(ss.discardHistory)) ss.discardHistory = [];
    ss.discardHistory.push({ seat: actor.seat, tile: discardTile });
    const drawn = drawOneToSeat(room, ss, actor.seat);
    ss.chengCountBySeat[actor.seat] = (ss.chengCountBySeat[actor.seat] || 0) + 1;
    ss.oilEligibleSeat = actor.seat;
    ss.seq += 1;
    ss.lastActionAt = now();
    ss.status = drawn
      ? `${displayNameByUid(room, uid)}逞癞子，请出牌`
      : `${displayNameByUid(room, uid)}逞癞子`;
    if (!drawn) {
      ss.phase = "gameover";
      ss.winnerSeat = null;
      ss.status = "流局：逞后无牌可摸";
    }
    syncBotGate(room, ss);
    return {
      action: {
        seq: ss.seq,
        phase: ss.phase,
        actorSeat: actor.seat,
        discardTile,
        nextSeat: ss.currentSeat,
        wallCount: ss.wallCount,
        status: ss.status,
        drawnSeat: drawn ? actor.seat : null,
        drawnTileId: drawn ? drawn.id : null,
        drawnTileTypeIdx: drawn ? drawn.typeIdx : null,
        reaction: ss.reaction,
        winnerSeat: ss.phase === "gameover" ? ss.winnerSeat : undefined,
        scoreDeltaByUid: cloneScoreDelta(ss),
      },
    };
  }

  // 胡：当前仅支持自摸胡（discard 阶段自己回合）；明碰/明杠后须出牌后才可胡（禁碰胡/杠胡）
  if (action === "hu" && ss.phase === "discard") {
    const actor = normalizePlayers(room.players || []).find((p) => p.uid === uid);
    if (!actor) return { error: "E_ROOM_NOT_IN" };
    if (actor.seat !== ss.currentSeat) return { error: "E_NOT_YOUR_TURN" };
    if (ss.pengNoHuUntilDiscardSeat === actor.seat) return { error: "E_INVALID_ACTION" };
    if (!canSeatHu(room, ss, actor.seat)) return { error: "E_INVALID_ACTION" };
    const isOil = ss.oilEligibleSeat === actor.seat;
    if (isOil) ss.oilEligibleSeat = null;
    const huSettlement = settleSelfHu(room, ss, actor.seat, isOil);
    ss.phase = "gameover";
    ss.winnerSeat = actor.seat;
    clearReactionState(ss);
    ss.seq += 1;
    ss.lastActionAt = now();
    ss.status = `${displayNameByUid(room, uid)}胡牌（${huSettlement.label || "自摸"}）`;
    return {
      action: {
        seq: ss.seq,
        phase: ss.phase,
        actorSeat: actor.seat,
        discardTile: null,
        nextSeat: ss.currentSeat,
        wallCount: ss.wallCount,
        status: ss.status,
        drawnSeat: null,
        drawnTileId: null,
        drawnTileTypeIdx: null,
        reaction: null,
        winnerSeat: actor.seat,
        huSettlement,
        scoreDeltaByUid: cloneScoreDelta(ss),
      },
    };
  }

  if (ss.phase !== "react" || !ss.reactionQueue?.length) return { error: "E_INVALID_PHASE" };
  const actor = normalizePlayers(room.players || []).find((p) => p.uid === uid);
  if (!actor) return { error: "E_ROOM_NOT_IN" };
  const cur = ss.reactionQueue[ss.reactionIndex];
  if (!cur || cur.uid !== uid) return { error: "E_INVALID_ACTION" };
  const fromSeat = ss.reactionFromSeat;
  const tile = ss.reactionTile;
  if (!tile || fromSeat == null) return { error: "E_INVALID_PHASE" };
  let drawnSeat = null;
  let drawnTileId = null;
  let drawnTileTypeIdx = null;
  if (action === "pass") {
    ss.reactionIndex += 1;
    if (ss.reactionIndex < ss.reactionQueue.length) {
      syncReactionPointer(ss);
      ss.seq += 1;
      ss.status = `${displayNameByUid(room, uid)}已过`;
      syncBotGate(room, ss);
      return {
        action: {
          seq: ss.seq,
          phase: ss.phase,
          actorSeat: actor.seat,
          discardTile: null,
          nextSeat: ss.currentSeat,
          wallCount: ss.wallCount,
          status: ss.status,
          drawnSeat: null,
          drawnTileId: null,
          drawnTileTypeIdx: null,
          reaction: ss.reaction,
          scoreDeltaByUid: cloneScoreDelta(ss),
        },
      };
    }
    const nextSeat = getNextSeat(room, fromSeat, ss);
    clearReactionState(ss);
    if (ss.wallCount > 0) {
      const drawn = drawOneToSeat(room, ss, nextSeat);
      if (!drawn) {
        ss.phase = "gameover";
        ss.winnerSeat = null;
        ss.status = "流局：牌山没了";
      } else {
        drawnSeat = nextSeat;
        drawnTileId = drawn.id;
        drawnTileTypeIdx = drawn.typeIdx;
        ss.status = `${displayNameByUid(room, uid)}已过`;
      }
    } else {
      ss.phase = "gameover";
      ss.winnerSeat = null;
      ss.status = "流局：牌山没了";
    }
  } else if (action === "peng" || action === "gang") {
    if (action === "peng" && !cur.canPeng) return { error: "E_INVALID_ACTION" };
    if (action === "gang" && !cur.canGang) return { error: "E_INVALID_ACTION" };
    const hand = ss.handsByUid[uid] || [];
    const dg = ss.dingGuoTypeIdx;
    const dingPairForPeng =
      action === "peng" &&
      dg != null &&
      tile.typeIdx === dg &&
      hand.filter((t) => t.typeIdx === dg).length >= 2;
    const need = action === "peng" ? 2 : 3;
    const removeIdx = [];
    for (let i = 0; i < hand.length && removeIdx.length < need; i += 1) {
      if (hand[i].typeIdx === tile.typeIdx) removeIdx.push(i);
    }
    if (removeIdx.length < need) return { error: "E_INVALID_ACTION" };
    for (let i = removeIdx.length - 1; i >= 0; i -= 1) {
      hand.splice(removeIdx[i], 1);
    }
    const fromDiscards = ss.discardsBySeat[fromSeat] || [];
    fromDiscards.pop();
    if (Array.isArray(ss.discardHistory) && ss.discardHistory.length > 0) {
      const lastIdx = ss.discardHistory.length - 1;
      const last = ss.discardHistory[lastIdx];
      if (
        last &&
        last.seat === fromSeat &&
        Number(last.tile?.id) === Number(tile?.id)
      ) {
        ss.discardHistory.pop();
      } else {
        for (let i = ss.discardHistory.length - 1; i >= 0; i -= 1) {
          const it = ss.discardHistory[i];
          if (it && it.seat === fromSeat && Number(it.tile?.id) === Number(tile?.id)) {
            ss.discardHistory.splice(i, 1);
            break;
          }
        }
      }
    }
    ss.meldsBySeat[actor.seat].push({
      kind: action,
      tileTypeIdx: tile.typeIdx,
      fromSeat,
      size: action === "peng" ? 3 : 4,
    });
    if (action === "peng" && dingPairForPeng) {
      settleDingguoPeng(room, ss, actor.seat, fromSeat, true);
    }
    if (action === "peng") {
      ss.phase = "discard";
      ss.currentSeat = actor.seat;
      ss.pengNoHuUntilDiscardSeat = actor.seat;
      ss.status = `${displayNameByUid(room, uid)}碰牌${tileName(tile.typeIdx)}，请出牌`;
    } else {
      settleZhigang(room, ss, actor.seat, fromSeat);
      ss.pengNoHuUntilDiscardSeat = actor.seat;
      const drawn = drawOneToSeat(room, ss, actor.seat);
      if (!drawn) {
        ss.phase = "gameover";
        ss.winnerSeat = null;
        ss.status = "流局：杠后无牌可摸";
      } else {
        drawnSeat = actor.seat;
        drawnTileId = drawn.id;
        drawnTileTypeIdx = drawn.typeIdx;
        ss.status = `${displayNameByUid(room, uid)}杠牌${tileName(tile.typeIdx)}，请出牌`;
      }
    }
    clearReactionState(ss);
  } else {
    return { error: "E_INVALID_ACTION" };
  }
  ss.seq += 1;
  ss.lastActionAt = now();
  syncBotGate(room, ss);
  return {
    action: {
      seq: ss.seq,
      phase: ss.phase,
      actorSeat: actor.seat,
      discardTile: null,
      nextSeat: ss.currentSeat,
      wallCount: ss.wallCount,
      status: ss.status,
      drawnSeat,
      drawnTileId,
      drawnTileTypeIdx,
      reaction: ss.reaction,
      winnerSeat: ss.phase === "gameover" ? ss.winnerSeat : undefined,
      scoreDeltaByUid: cloneScoreDelta(ss),
    },
  };
}

/** 机器人自动流转：支持限制最大步数，避免一口气轮转过快 */
function runBots(room, ss, maxSteps = 24) {
  let guard = 0;
  while (guard < maxSteps) {
    guard += 1;
    if (ss.phase === "gameover") break;
    const current = normalizePlayers(room.players || []).find((p) => p.seat === ss.currentSeat);
    if (!current || !current.isBot) break;
    if (ss.phase === "discard") {
      // 机器人策略：
      // 1) 多癞子时，先按普通出牌逻辑打掉多余癞子，并累计逞次数
      // 2) 只剩1个癞子且“出一张即听牌”时，使用逞
      // 3) 可胡时：有癞子则优先逞，无癞子则优先胡
      // 4) 其余按原逻辑出牌
      const hand = ss.handsByUid[current.uid] || [];
      const laiziCount = ss.laiziTypeIdx == null
        ? 0
        : hand.filter((t) => t.typeIdx === ss.laiziTypeIdx).length;
      const canHuNow =
        ss.pengNoHuUntilDiscardSeat !== current.seat &&
        canSeatHu(room, ss, current.seat);
      if (canHuNow) {
        if (laiziCount > 0) {
          if (shouldBotChengWhenCanHu(room, ss, current.seat)) {
            const chengRet = applyReactionCore(room, ss, current.uid, "cheng");
            if (!chengRet?.error) continue;
          }
        }
        const huRet = applyReactionCore(room, ss, current.uid, "hu");
        if (huRet?.error) break;
        continue;
      }
      if (laiziCount > 1 && ss.laiziTypeIdx != null) {
        const laiziTile = hand.find((t) => t.typeIdx === ss.laiziTypeIdx);
        if (laiziTile) {
          const discardRet = applyDiscardCore(room, ss, current.uid, laiziTile.id);
          if (!discardRet?.error) {
            ss.chengCountBySeat[current.seat] = (ss.chengCountBySeat[current.seat] || 0) + 1;
            ss.oilEligibleSeat = current.seat;
            continue;
          }
        }
      }
      const shouldChengNow = shouldSeatCheng(room, ss, current.seat);
      if (shouldChengNow) {
        const chengRet = applyReactionCore(room, ss, current.uid, "cheng");
        if (!chengRet?.error) continue;
      }
      if (!hand.length) break;
      const melds = ss.meldsBySeat?.[current.seat] || [];
      const pickId = chooseBotDiscardTileIdAi(hand, melds, ss.laiziTypeIdx);
      const tileId = Number.isInteger(pickId) ? pickId : hand[0].id;
      const ret = applyDiscardCore(room, ss, current.uid, tileId);
      if (ret?.error) break;
      continue;
    }
    if (ss.phase === "react" && ss.reactionQueue?.length) {
      const cur = ss.reactionQueue[ss.reactionIndex];
      if (!cur || !cur.isBot) break;
      const act = cur.canGang ? "gang" : cur.canPeng ? "peng" : "pass";
      const ret = applyReactionCore(room, ss, cur.uid, act);
      if (ret?.error) {
        applyReactionCore(room, ss, cur.uid, "pass");
      }
      continue;
    }
    if (ss.phase === "self_react" && ss.selfReaction?.uid === current.uid) {
      const canHu =
        ss.pengNoHuUntilDiscardSeat !== current.seat &&
        canSeatHu(room, ss, current.seat);
      if (canHu) {
        const huRet = applyReactionCore(room, ss, current.uid, "hu");
        if (huRet?.error) break;
        continue;
      }
      const cands = ss.selfReaction.anGangCandidates || [];
      if (cands.length > 0) {
        const ret = applyReactionCore(room, ss, current.uid, "an_gang", {
          typeIdx: cands[0],
        });
        if (ret?.error) {
          applyReactionCore(room, ss, current.uid, "pass");
        }
      } else {
        applyReactionCore(room, ss, current.uid, "pass");
      }
      continue;
    }
    break;
  }
}

/** 保存游戏快照到房间文档 */
async function saveSnapshot(roomDoc, ss, statusOverride) {
  await db.collection(ROOM_COLLECTION).doc(roomDoc._id).update({
    data: {
      gameSnapshot: gameSnapshotWrite(ss),
      status: statusOverride || roomDoc.status,
      updatedAt: now(),
      gameUpdatedAt: now(),
    },
  });
}

/** 处理 game.snapshot：返回当前 uid 可见的快照 */
async function actionGameSnapshot(roomId, uid) {
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const ss = room.gameSnapshot;
  if (!ss) return { ok: false, code: "E_GAME_NOT_FOUND" };
  const inRoom = normalizePlayers(room.players || []).some((p) => p.uid === uid);
  if (!inRoom) return { ok: false, code: "E_ROOM_NOT_IN" };
  // 轮到真人时清掉机器人延时门，避免上一步遗留的 botNextActAt 挡住后续快照推进
  if (ss.phase !== "gameover" && !isBotPending(room, ss)) {
    ss.botNextActAt = 0;
  }
  // 节奏控制：快照拉取时若轮到机器人，仅推进一步，避免瞬间连跳多轮
  if (
    ss.phase !== "gameover" &&
    isBotPending(room, ss) &&
    Date.now() >= Number(ss.botNextActAt || 0)
  ) {
    runBots(room, ss, 1);
    syncBotGate(room, ss);
    await saveSnapshot(room, ss, ss.phase === "gameover" ? "waiting" : room.status);
  }
  return { ok: true, snapshot: buildSnapshotForUid(room, uid, ss) };
}

/** 处理 game.discard：出牌并驱动机器人自动流转 */
async function actionGameDiscard(roomId, uid, payload) {
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const ss = room.gameSnapshot;
  if (!ss) return { ok: false, code: "E_GAME_NOT_FOUND" };
  const ret = applyDiscardCore(room, ss, uid, Number(payload?.tileId));
  if (ret?.error) return { ok: false, code: ret.error };
  const selfSeat = normalizePlayers(room.players || []).find((p) => p.uid === uid)?.seat;
  // 玩家动作后不立即推进机器人，保留可感知间隔
  syncBotGate(room, ss);
  await saveSnapshot(room, ss, ss.phase === "gameover" ? "waiting" : room.status);
  const expose = buildWinnerExposeHand(room, ss);
  return {
    ok: true,
    action: {
      ...ret.action,
      ...(expose ? { winnerExposeHand: expose } : {}),
      selfHand: ss.handsByUid[uid] || [],
      reactionForSelf: getSelfOps(room, uid, ss),
      discardsBySeat: ss.discardsBySeat,
      discardHistory: ss.discardHistory || [],
      meldsBySeat: ss.meldsBySeat,
      chengCountBySeat: ss.chengCountBySeat || { 0: 0, 1: 0, 2: 0, 3: 0 },
      wallCount: ss.wallCount,
      phase: ss.phase,
      nextSeat: ss.currentSeat,
      status: ss.status,
      selfLastDrawTileId: ss.selfLastDrawTileIdByUid?.[uid] ?? null,
      selfChengCount: typeof ss.chengCountBySeat?.[selfSeat] === "number" ? ss.chengCountBySeat[selfSeat] : 0,
      botHandsBySeat: buildBotHandsBySeat(room, ss),
    },
  };
}

/** 处理 game.reaction：碰杠过并驱动机器人自动流转 */
async function actionGameReaction(roomId, uid, payload) {
  if (!uid) return { ok: false, code: "E_AUTH_REQUIRED" };
  const room = await getRoomById(roomId);
  if (!room) return { ok: false, code: "E_ROOM_NOT_FOUND" };
  const ss = room.gameSnapshot;
  if (!ss) return { ok: false, code: "E_GAME_NOT_FOUND" };
  const act = String(payload?.action || "").trim();
  const ret = applyReactionCore(room, ss, uid, act, payload || {});
  if (ret?.error) return { ok: false, code: ret.error };
  const selfSeat = normalizePlayers(room.players || []).find((p) => p.uid === uid)?.seat;
  // 玩家动作后不立即推进机器人，保留可感知间隔
  syncBotGate(room, ss);
  await saveSnapshot(room, ss, ss.phase === "gameover" ? "waiting" : room.status);
  const expose = buildWinnerExposeHand(room, ss);
  return {
    ok: true,
    action: {
      ...ret.action,
      ...(expose ? { winnerExposeHand: expose } : {}),
      selfHand: ss.handsByUid[uid] || [],
      reactionForSelf: getSelfOps(room, uid, ss),
      discardsBySeat: ss.discardsBySeat,
      discardHistory: ss.discardHistory || [],
      meldsBySeat: ss.meldsBySeat,
      chengCountBySeat: ss.chengCountBySeat || { 0: 0, 1: 0, 2: 0, 3: 0 },
      wallCount: ss.wallCount,
      phase: ss.phase,
      nextSeat: ss.currentSeat,
      status: ss.status,
      selfLastDrawTileId: ss.selfLastDrawTileIdByUid?.[uid] ?? null,
      selfChengCount: typeof ss.chengCountBySeat?.[selfSeat] === "number" ? ss.chengCountBySeat[selfSeat] : 0,
      botHandsBySeat: buildBotHandsBySeat(room, ss),
    },
  };
}

