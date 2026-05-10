/**
 * 房间服务（内存版）：
 * - 仅用于第一版联调
 * - 进程重启后数据会丢失
 */

const roomsById = new Map();
const roomIdByNo = new Map();
const { canHuByTypes } = require("../../logic");
const { chooseBotDiscardTileId: chooseBotDiscardTileIdAi } = require("../../shared/botDiscardAi");
const settlement = require("./settlement");
const { normalizeBaseStake } = settlement;

/** 与客户端东南西北四座、牌局逻辑一致，固定四人桌 */
const MAHJONG_TABLE_SIZE = 4;

let roomInc = 1000;

const TILE_KIND_COUNT = 27;
/** 逆时针：南(0)→东(3)→北(2)→西(1)，与客户端 seatPos 一致 */
const PLAY_ORDER_CCW = [0, 3, 2, 1];

function makeRoomId() {
  roomInc += 1;
  return `R${roomInc}`;
}

function makeRoomNo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createRoom(ownerUid, ownerNickname = "", rule = {}) {
  const roomId = makeRoomId();
  let roomNo = makeRoomNo();
  while (roomIdByNo.has(roomNo)) {
    roomNo = makeRoomNo();
  }
  const room = {
    roomId,
    roomNo,
    ownerUid,
    status: "waiting",
    rule,
    baseStake: normalizeBaseStake(rule.baseStake),
    // 忽略客户端误传的 2/3 人上限，避免「差一人却已开局」
    maxPlayers: MAHJONG_TABLE_SIZE,
    players: [
      {
        uid: ownerUid,
        seat: 0,
        nickname: ownerNickname || ownerUid,
        ready: false,
        online: true,
      },
    ],
    gameSnapshot: null,
    _botLoopRunning: false,
  };
  roomsById.set(roomId, room);
  roomIdByNo.set(roomNo, roomId);
  return room;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function buildWall() {
  const wall = [];
  let id = 1;
  for (let typeIdx = 0; typeIdx < TILE_KIND_COUNT; typeIdx++) {
    for (let k = 0; k < 4; k++) {
      wall.push({ id: id++, typeIdx });
    }
  }
  shuffleInPlace(wall);
  return wall;
}

function nextInSuit(typeIdx) {
  const suit = Math.floor(typeIdx / 9);
  const num = (typeIdx % 9) + 1;
  const nextNum = num === 9 ? 1 : num + 1;
  return suit * 9 + (nextNum - 1);
}

function tileName(typeIdx) {
  const suit = Math.floor(typeIdx / 9);
  const num = (typeIdx % 9) + 1;
  const suitName = suit === 0 ? "万" : suit === 1 ? "筒" : "条";
  return `${num}${suitName}`;
}

function getRoomByNo(roomNo) {
  const roomId = roomIdByNo.get(roomNo);
  if (!roomId) return null;
  return roomsById.get(roomId) || null;
}

function getRoomById(roomId) {
  return roomsById.get(roomId) || null;
}

function joinRoom(roomNo, uid, nickname = "") {
  const room = getRoomByNo(roomNo);
  if (!room) return { error: "E_ROOM_NOT_FOUND" };
  if (room.status !== "waiting") return { error: "E_ROOM_ALREADY_STARTED" };
  if (room.players.some((p) => p.uid === uid)) {
    return { room, seat: room.players.find((p) => p.uid === uid).seat };
  }
  if (room.players.length >= room.maxPlayers) return { error: "E_ROOM_FULL" };

  const usedSeats = new Set(room.players.map((p) => p.seat));
  let seat = 0;
  while (usedSeats.has(seat)) seat += 1;

  room.players.push({
    uid,
    seat,
    nickname: nickname || uid,
    ready: false,
    online: true,
  });
  return { room, seat };
}

function setPlayerOnline(uid, online) {
  for (const room of roomsById.values()) {
    const player = room.players.find((p) => p.uid === uid);
    if (player) {
      player.online = online;
      return room;
    }
  }
  return null;
}

function setReady(roomId, uid, ready) {
  const room = getRoomById(roomId);
  if (!room) return { error: "E_ROOM_NOT_FOUND" };
  const player = room.players.find((p) => p.uid === uid);
  if (!player) return { error: "E_ROOM_NOT_IN" };
  player.ready = Boolean(ready);
  return { room };
}

function setBotCount(roomId, uid, botCount) {
  const room = getRoomById(roomId);
  if (!room) return { error: "E_ROOM_NOT_FOUND" };
  if (room.ownerUid !== uid) return { error: "E_ROOM_NOT_OWNER" };
  if (room.status !== "waiting") return { error: "E_ROOM_INVALID_STATE" };

  const humans = room.players.filter((p) => !p.isBot);
  const cap = Math.max(2, Number(room.maxPlayers) || 4);
  const maxBots = Math.max(0, cap - humans.length);
  const target = Math.max(0, Math.min(Number(botCount) || 0, maxBots));

  // 先移除旧机器人
  room.players = humans.slice();

  const usedSeats = new Set(room.players.map((p) => p.seat));
  let botIndex = 1;
  while (botIndex <= target) {
    let seat = 0;
    while (usedSeats.has(seat)) seat += 1;
    usedSeats.add(seat);
    room.players.push({
      uid: `bot_${room.roomId}_${botIndex}`,
      seat,
      nickname: `电脑${botIndex}`,
      ready: true, // 机器人默认已准备
      online: true,
      isBot: true,
    });
    botIndex += 1;
  }

  room.players.sort((a, b) => a.seat - b.seat);
  room.botCount = target;
  return { room };
}

/**
 * 后端权威发牌：
 * - 洗牌、发13张
 * - 庄家座位0补1张
 * - 计算顶果和癞子
 */
function startGame(roomId) {
  const room = getRoomById(roomId);
  if (!room) return { error: "E_ROOM_NOT_FOUND" };

  const wall = buildWall();
  const bySeat = [...room.players].sort((a, b) => a.seat - b.seat);
  const handsByUid = {};

  for (const p of bySeat) {
    handsByUid[p.uid] = [];
  }

  // 每人13张
  for (let r = 0; r < 13; r++) {
    for (const p of bySeat) {
      const t = wall.pop();
      if (t) handsByUid[p.uid].push(t);
    }
  }

  // 顶果和癞子
  const indicator = wall.pop() || null;
  const dingGuoTypeIdx = indicator ? indicator.typeIdx : null;
  const laiziTypeIdx =
    indicator && typeof indicator.typeIdx === "number"
      ? nextInSuit(indicator.typeIdx)
      : null;

  // 庄家（座位0）摸第14张
  const dealer = bySeat.find((p) => p.seat === 0);
  if (dealer) {
    const t = wall.pop();
    if (t) handsByUid[dealer.uid].push(t);
  }

  // 手牌排序
  for (const p of bySeat) {
    handsByUid[p.uid].sort((a, b) => a.typeIdx - b.typeIdx || a.id - b.id);
  }

  const snapshot = {
    roomId: room.roomId,
    roomNo: room.roomNo,
    players: bySeat.map((p) => ({ uid: p.uid, seat: p.seat })),
    dealerSeat: 0,
    currentSeat: 0,
    phase: "discard",
    seq: 1,
    status: "游戏开始，请庄家先出牌",
    dingGuoTypeIdx,
    laiziTypeIdx,
    wallCount: wall.length,
    _wallInternal: wall,
    handsByUid,
    meldsBySeat: {
      0: [],
      1: [],
      2: [],
      3: [],
    },
    discardsBySeat: {
      0: [],
      1: [],
      2: [],
      3: [],
    },
    reaction: null,
    reactionQueue: null,
    reactionIndex: 0,
    reactionFromSeat: null,
    reactionTile: null,
    winnerSeat: null,
    /** 出牌阶段点「过（不胡）」的座位：本手不再提示胡，打出一张后清除 */
    huPassSkipSeat: null,
    /** 明碰/明杠他人打出牌后须先打出一张（含逞癞子）才允许胡，禁碰胡/杠胡 */
    pengNoHuUntilDiscardSeat: null,
    chengCountBySeat: { 0: 0, 1: 0, 2: 0, 3: 0 },
    oilEligibleSeat: null,
    scoreDeltaByUid: {},
    selfReaction: null,
  };

  settlement.initRoundMoney(snapshot, room);
  room.gameSnapshot = snapshot;
  room._botLoopRunning = false;
  afterPlayerDraw(room, 0);
  return { room, snapshot };
}

function buildPresentSeatsForTurn(room, ss) {
  const tryLists = [];
  if (ss && Array.isArray(ss.players) && ss.players.length > 0) {
    tryLists.push(ss.players);
  }
  tryLists.push(room.players || []);
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

function getSnapshot(roomId) {
  const room = getRoomById(roomId);
  if (!room || !room.gameSnapshot) return null;
  return room.gameSnapshot;
}

function getAnGangCandidates(hand) {
  if (!hand || hand.length < 4) return [];
  const counts = new Map();
  for (const t of hand) {
    counts.set(t.typeIdx, (counts.get(t.typeIdx) || 0) + 1);
  }
  const out = [];
  for (const [typeIdx, n] of counts) {
    if (n >= 4) out.push(typeIdx);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 每次摸牌后：可暗杠则进入 self_react，否则进入出牌阶段
 */
function afterPlayerDraw(room, seat) {
  const ss = room.gameSnapshot;
  const player = room.players.find((p) => p.seat === seat);
  if (!ss || !player || ss.phase === "gameover") return;
  settlement.initRoundMoney(ss, room);
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
    ss.status = `座位${seat} 可选择暗杠或过`;
    return;
  }
  ss.selfReaction = null;
  ss.phase = "discard";
  ss.currentSeat = seat;
  applyHuangzhuangIfEmptyWallAndCannotHu(ss, room, seat);
}

function drawOneToSeat(room, seat) {
  const ss = room.gameSnapshot;
  const player = room.players.find((p) => p.seat === seat);
  if (!ss || !player) return null;
  const wall = ss._wallInternal || [];
  const t = wall.pop() || null;
  if (!t) return null;
  ss.handsByUid[player.uid].push(t);
  ss.handsByUid[player.uid].sort((a, b) => a.typeIdx - b.typeIdx || a.id - b.id);
  ss.wallCount = wall.length;
  afterPlayerDraw(room, seat);
  return t;
}

function canSeatHu(ss, room, seat) {
  const player = room.players.find((p) => p.seat === seat);
  if (!player) return false;
  const hand = (ss.handsByUid[player.uid] || []).map((t) => t.typeIdx);
  const melds = ss.meldsBySeat?.[seat] || [];
  // 胡牌计算里，碰/杠都按3张面子计算
  for (const m of melds) {
    for (let i = 0; i < 3; i++) hand.push(m.tileTypeIdx);
  }
  return canHuByTypes(hand, ss.laiziTypeIdx);
}

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
    canHu: cur.canHu,
  };
  ss.currentSeat = cur.seat;
}

/**
 * 从出牌者逆时针下家起依次询问可碰/杠（顺序与 getNextSeat：南0→东3→北2→西1 一致）
 * 优先级：杠 > 碰，同级按逆时针先后
 */
function buildReactionQueue(room, fromSeat, discardTile) {
  const ss = room.gameSnapshot;
  if (!ss) return [];

  const orderedSeats = [];
  let seat = getNextSeat(room, fromSeat, ss);
  for (let i = 0; i < room.players.length - 1; i++) {
    orderedSeats.push(seat);
    seat = getNextSeat(room, seat, ss);
  }
  const orderIndex = (s) => orderedSeats.indexOf(s);

  const entries = [];
  for (const s of orderedSeats) {
    const p = room.players.find((x) => x.seat === s);
    if (!p) continue;
    const hand = ss.handsByUid[p.uid] || [];
    const same = hand.filter((t) => t.typeIdx === discardTile.typeIdx).length;
    const canPeng = same >= 2;
    const canGang = same >= 3;
    if (canPeng || canGang) {
      entries.push({
        seat: s,
        uid: p.uid,
        canPeng,
        canGang,
        canHu: false,
        isBot: !!p.isBot,
      });
    }
  }

  function tier(e) {
    if (e.canGang) return 0;
    if (e.canPeng) return 1;
    return 2;
  }
  entries.sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    return orderIndex(a.seat) - orderIndex(b.seat);
  });
  return entries;
}

function clearReactionState(ss) {
  ss.reactionQueue = null;
  ss.reactionIndex = 0;
  ss.reactionFromSeat = null;
  ss.reactionTile = null;
  ss.reaction = null;
}

/** 局末有胜者时组装胡家手牌，供客户端亮牌（与云函数 buildWinnerExposeHand 一致） */
function buildWinnerExposeHand(room, ss) {
  if (ss.phase !== "gameover" || ss.winnerSeat == null) return null;
  const wp = room.players.find((p) => p.seat === ss.winnerSeat);
  if (!wp) return null;
  const tiles = ss.handsByUid[wp.uid] || [];
  return tiles.map((t) => ({ id: t.id, typeIdx: t.typeIdx }));
}

function maybeWinnerExposeActionFields(room, ss) {
  const expose = buildWinnerExposeHand(room, ss);
  return expose && expose.length ? { winnerExposeHand: expose } : {};
}

/**
 * 牌山已摸空且当前摸牌者无法胡牌 → 立即荒庄流局（无需再打出一张才判流局）
 */
function applyHuangzhuangIfEmptyWallAndCannotHu(ss, room, seat) {
  if (ss.wallCount !== 0) return;
  if (canSeatHu(ss, room, seat)) return;
  ss.phase = "gameover";
  ss.winnerSeat = null;
  ss.selfReaction = null;
  clearReactionState(ss);
  ss.status = "流局：最后一张摸牌后未能胡牌";
}

function getCurrentReactionEntry(roomId) {
  const room = getRoomById(roomId);
  const ss = room?.gameSnapshot;
  if (!ss?.reactionQueue?.length) return null;
  return ss.reactionQueue[ss.reactionIndex] || null;
}

function getSelfOps(roomId, uid) {
  const room = getRoomById(roomId);
  if (!room || !room.gameSnapshot) return null;
  const ss = room.gameSnapshot;
  const player = room.players.find((p) => p.uid === uid);
  if (!player) return null;

  if (ss.phase === "gameover") {
    return null;
  }

  if (ss.phase === "self_react" && ss.selfReaction) {
    if (player.uid !== ss.selfReaction.uid) {
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
    const canHu =
      ss.pengNoHuUntilDiscardSeat !== player.seat &&
      canSeatHu(ss, room, player.seat);
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
        canHu: !!cur.canHu,
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
    const blockedOpenMeldHu = ss.pengNoHuUntilDiscardSeat === player.seat;
    const rawHu = !blockedOpenMeldHu && canSeatHu(ss, room, player.seat);
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

function applyDiscard(roomId, uid, tileId) {
  const room = getRoomById(roomId);
  if (!room) return { error: "E_ROOM_NOT_FOUND" };
  const ss = room.gameSnapshot;
  if (!ss) return { error: "E_GAME_NOT_FOUND" };
  if (ss.phase !== "discard") return { error: "E_INVALID_PHASE" };

  const actor = room.players.find((p) => p.uid === uid);
  if (!actor) return { error: "E_ROOM_NOT_IN" };
  if (actor.seat !== ss.currentSeat) return { error: "E_NOT_YOUR_TURN" };

  settlement.initRoundMoney(ss, room);
  if (ss.oilEligibleSeat === actor.seat) {
    ss.oilEligibleSeat = null;
  }
  if (ss.huPassSkipSeat === actor.seat) {
    ss.huPassSkipSeat = null;
  }
  if (ss.pengNoHuUntilDiscardSeat === actor.seat) {
    ss.pengNoHuUntilDiscardSeat = null;
  }

  const hand = ss.handsByUid[uid] || [];
  const i = hand.findIndex((t) => t.id === tileId);
  if (i < 0) return { error: "E_ILLEGAL_TILE" };

  const [discardTile] = hand.splice(i, 1);
  if (!ss.discardsBySeat[actor.seat]) ss.discardsBySeat[actor.seat] = [];
  ss.discardsBySeat[actor.seat].push(discardTile);

  const reactionQueue = buildReactionQueue(room, actor.seat, discardTile);
  let drawnTile = null;
  if (reactionQueue.length > 0) {
    ss.phase = "react";
    ss.reactionFromSeat = actor.seat;
    ss.reactionTile = discardTile;
    ss.reactionQueue = reactionQueue;
    ss.reactionIndex = 0;
    syncReactionPointer(ss);
    ss.status = `座位${actor.seat} 出牌 ${tileName(discardTile.typeIdx)}，等待座位${ss.reaction.seat} 响应`;
  } else {
    const nextSeat = getNextSeat(room, actor.seat, ss);
    const nextPlayer = room.players.find((p) => p.seat === nextSeat);
    clearReactionState(ss);
    if (ss.wallCount > 0 && nextPlayer) {
      drawnTile = drawOneToSeat(room, nextSeat);
      if (ss.phase !== "self_react" && ss.phase !== "gameover") {
        if (drawnTile) {
          ss.status = `座位${actor.seat} 出牌 ${tileName(discardTile.typeIdx)}，座位${nextSeat} 摸牌 ${tileName(drawnTile.typeIdx)}，请出牌`;
        } else {
          ss.status = `座位${actor.seat} 出牌，轮到座位${nextSeat}`;
        }
      }
    } else {
      ss.phase = "gameover";
      ss.winnerSeat = null;
      ss.currentSeat = nextSeat;
      ss.status = "流局：牌山没了";
    }
  }

  ss.seq += 1;

  return {
    room,
    snapshot: ss,
    action: {
      seq: ss.seq,
      phase: ss.phase,
      actorSeat: actor.seat,
      discardTile,
      nextSeat: ss.currentSeat,
      wallCount: ss.wallCount,
      status: ss.status,
      drawnSeat: drawnTile ? ss.currentSeat : null,
      drawnTileId: drawnTile ? drawnTile.id : null,
      drawnTileTypeIdx: drawnTile ? drawnTile.typeIdx : null,
      reaction: ss.reaction,
      winnerSeat: ss.phase === "gameover" ? ss.winnerSeat : undefined,
      scoreDeltaByUid: settlement.cloneScoreDelta(ss),
    },
  };
}

function applyReaction(roomId, uid, action, options = {}) {
  const room = getRoomById(roomId);
  if (!room) return { error: "E_ROOM_NOT_FOUND" };
  const ss = room.gameSnapshot;
  if (!ss) return { error: "E_GAME_NOT_FOUND" };

  const actor = room.players.find((p) => p.uid === uid);
  if (!actor) return { error: "E_ROOM_NOT_IN" };

  // 摸牌后暗杠选择：杠 / 过 / 可胡则胡
  if (ss.phase === "self_react" && ss.selfReaction?.uid === uid) {
    const sr = ss.selfReaction;
    if (action === "pass") {
      ss.selfReaction = null;
      ss.phase = "discard";
      ss.currentSeat = sr.seat;
      ss.seq += 1;
      ss.status = `座位${sr.seat} 请出牌`;
      applyHuangzhuangIfEmptyWallAndCannotHu(ss, room, actor.seat);
      return {
        room,
        snapshot: ss,
        action: {
          seq: ss.seq,
          phase: ss.phase,
          actorSeat: sr.seat,
          discardTile: null,
          nextSeat: ss.currentSeat,
          wallCount: ss.wallCount,
          status: ss.status,
          reaction: null,
          winnerSeat: ss.phase === "gameover" ? ss.winnerSeat : undefined,
          scoreDeltaByUid: settlement.cloneScoreDelta(ss),
        },
      };
    }
    if (action === "hu") {
      if (ss.pengNoHuUntilDiscardSeat === actor.seat) {
        return { error: "E_INVALID_ACTION" };
      }
      if (!canSeatHu(ss, room, actor.seat)) {
        return { error: "E_INVALID_ACTION" };
      }
      settlement.initRoundMoney(ss, room);
      const isOil = ss.oilEligibleSeat === actor.seat;
      if (isOil) ss.oilEligibleSeat = null;
      const huSettlement = settlement.settleSelfHu(room, actor.seat, isOil);
      ss.phase = "gameover";
      ss.winnerSeat = actor.seat;
      ss.selfReaction = null;
      clearReactionState(ss);
      ss.seq += 1;
      ss.status = `座位${actor.seat} 胡牌（${huSettlement.label || "自摸"}）`;
      return {
        room,
        snapshot: ss,
        action: {
          seq: ss.seq,
          phase: ss.phase,
          actorSeat: actor.seat,
          discardTile: null,
          nextSeat: ss.currentSeat,
          wallCount: ss.wallCount,
          status: ss.status,
          reaction: null,
          winnerSeat: actor.seat,
          huSettlement,
          ...maybeWinnerExposeActionFields(room, ss),
          scoreDeltaByUid: settlement.cloneScoreDelta(ss),
        },
      };
    }
    if (action === "an_gang") {
      const typeIdx = Number(options.typeIdx);
      if (!Number.isInteger(typeIdx) || typeIdx < 0) {
        return { error: "E_INVALID_ACTION" };
      }
      if (!sr.anGangCandidates.includes(typeIdx)) {
        return { error: "E_INVALID_ACTION" };
      }
      settlement.initRoundMoney(ss, room);
      const hand = ss.handsByUid[uid] || [];
      if (hand.filter((t) => t.typeIdx === typeIdx).length < 4) {
        return { error: "E_INVALID_ACTION" };
      }
      for (let k = 0; k < 4; k++) {
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
      settlement.settleAnGang(room, actor.seat);
      ss.seq += 1;
      const drawn = drawOneToSeat(room, actor.seat);
      if (!drawn) {
        ss.phase = "gameover";
        ss.winnerSeat = null;
        ss.selfReaction = null;
        ss.status = "流局：杠后无牌可摸";
        return {
          room,
          snapshot: ss,
          action: {
            seq: ss.seq,
            phase: ss.phase,
            actorSeat: actor.seat,
            discardTile: null,
            nextSeat: ss.currentSeat,
            wallCount: ss.wallCount,
            status: ss.status,
            reaction: null,
            winnerSeat: ss.winnerSeat,
            scoreDeltaByUid: settlement.cloneScoreDelta(ss),
          },
        };
      }
      if (ss.phase !== "self_react" && ss.phase !== "gameover") {
        ss.status = `座位${actor.seat} 暗杠，摸牌 ${tileName(drawn.typeIdx)}，请出牌`;
      }
      return {
        room,
        snapshot: ss,
        action: {
          seq: ss.seq,
          phase: ss.phase,
          actorSeat: actor.seat,
          discardTile: null,
          nextSeat: ss.currentSeat,
          wallCount: ss.wallCount,
          status: ss.status,
          drawnSeat: actor.seat,
          drawnTileId: drawn.id,
          drawnTileTypeIdx: drawn.typeIdx,
          reaction: ss.reaction,
          winnerSeat: ss.phase === "gameover" ? ss.winnerSeat : undefined,
          scoreDeltaByUid: settlement.cloneScoreDelta(ss),
        },
      };
    }
    return { error: "E_INVALID_ACTION" };
  }

  // 出牌阶段可胡时点「过」：本手不再提示胡，须再打出一张后清除标记
  if (action === "pass" && ss.phase === "discard") {
    if (actor.seat !== ss.currentSeat) return { error: "E_NOT_YOUR_TURN" };
    if (!canSeatHu(ss, room, actor.seat)) return { error: "E_INVALID_ACTION" };
    ss.huPassSkipSeat = actor.seat;
    ss.seq += 1;
    return {
      room,
      snapshot: ss,
      action: {
        seq: ss.seq,
        phase: ss.phase,
        actorSeat: actor.seat,
        discardTile: null,
        nextSeat: ss.currentSeat,
        wallCount: ss.wallCount,
        status: `座位${actor.seat} 过（不胡），请出牌`,
        drawnSeat: null,
        drawnTileId: null,
        drawnTileTypeIdx: null,
        reaction: null,
        scoreDeltaByUid: settlement.cloneScoreDelta(ss),
      },
    };
  }

  // 逞：在自己的 discard 阶段可用
  if (action === "cheng" && ss.phase === "discard") {
    if (actor.seat !== ss.currentSeat) return { error: "E_NOT_YOUR_TURN" };
    settlement.initRoundMoney(ss, room);
    const hand = ss.handsByUid[uid] || [];
    const i = hand.findIndex((t) => t.typeIdx === ss.laiziTypeIdx);
    if (i < 0) return { error: "E_INVALID_ACTION" };
    const [discardTile] = hand.splice(i, 1);
    if (ss.pengNoHuUntilDiscardSeat === actor.seat) {
      ss.pengNoHuUntilDiscardSeat = null;
    }
    ss.discardsBySeat[actor.seat].push(discardTile);
    const drawn = drawOneToSeat(room, actor.seat);
    const s = actor.seat;
    ss.chengCountBySeat[s] = (ss.chengCountBySeat[s] || 0) + 1;
    ss.oilEligibleSeat = s;
    ss.seq += 1;
    if (ss.phase !== "self_react" && ss.phase !== "gameover") {
      ss.status = drawn
        ? `座位${actor.seat} 逞癞子，摸牌 ${tileName(drawn.typeIdx)}，请出牌`
        : `座位${actor.seat} 逞癞子`;
    }
    return {
      room,
      snapshot: ss,
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
        scoreDeltaByUid: settlement.cloneScoreDelta(ss),
      },
    };
  }

  if (action === "hu" && ss.phase === "discard") {
    if (actor.seat !== ss.currentSeat) {
      return { error: "E_NOT_YOUR_TURN" };
    }
    if (ss.pengNoHuUntilDiscardSeat === actor.seat) {
      return { error: "E_INVALID_ACTION" };
    }
    if (!canSeatHu(ss, room, actor.seat)) {
      return { error: "E_INVALID_ACTION" };
    }
    settlement.initRoundMoney(ss, room);
    const isOil = ss.oilEligibleSeat === actor.seat;
    if (isOil) ss.oilEligibleSeat = null;
    const huSettlement = settlement.settleSelfHu(room, actor.seat, isOil);
    ss.phase = "gameover";
    ss.winnerSeat = actor.seat;
    ss.selfReaction = null;
    clearReactionState(ss);
    ss.seq += 1;
    ss.status = `座位${actor.seat} 胡牌（${huSettlement.label || "自摸"}）`;
    return {
      room,
      snapshot: ss,
      action: {
        seq: ss.seq,
        phase: ss.phase,
        actorSeat: actor.seat,
        discardTile: null,
        nextSeat: ss.currentSeat,
        wallCount: ss.wallCount,
        status: ss.status,
        reaction: null,
        winnerSeat: actor.seat,
        huSettlement,
        ...maybeWinnerExposeActionFields(room, ss),
        scoreDeltaByUid: settlement.cloneScoreDelta(ss),
      },
    };
  }

  if (ss.phase !== "react" || !ss.reactionQueue?.length) return { error: "E_INVALID_PHASE" };
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
      ss.status = `等待座位${ss.reaction.seat} 响应`;
      return {
        room,
        snapshot: ss,
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
          scoreDeltaByUid: settlement.cloneScoreDelta(ss),
        },
      };
    }

    const nextSeat = getNextSeat(room, fromSeat, ss);
    clearReactionState(ss);
    let drawn = null;
    if (ss.wallCount > 0) {
      drawn = drawOneToSeat(room, nextSeat);
      if (drawn) {
        drawnSeat = nextSeat;
        drawnTileId = drawn.id;
        drawnTileTypeIdx = drawn.typeIdx;
      }
      ss.seq += 1;
      if (!drawn) {
        ss.phase = "gameover";
        ss.winnerSeat = null;
        ss.status = "流局：牌山没了";
      } else if (ss.phase !== "self_react" && ss.phase !== "gameover") {
        ss.status = `座位${actor.seat} 选择过，座位${nextSeat} 摸牌 ${tileName(drawn.typeIdx)}，请出牌`;
      }
    } else {
      ss.phase = "gameover";
      ss.winnerSeat = null;
      ss.seq += 1;
      ss.status = "流局：牌山没了";
    }
  } else if (action === "peng" || action === "gang") {
    if (action === "peng" && !cur.canPeng) return { error: "E_INVALID_ACTION" };
    if (action === "gang" && !cur.canGang) return { error: "E_INVALID_ACTION" };
    settlement.initRoundMoney(ss, room);
    const hand = ss.handsByUid[uid] || [];
    const dg = ss.dingGuoTypeIdx;
    const dingPairForPeng =
      action === "peng" &&
      dg != null &&
      tile.typeIdx === dg &&
      hand.filter((t) => t.typeIdx === dg).length >= 2;
    const need = action === "peng" ? 2 : 3;
    const removeIdx = [];
    for (let i = 0; i < hand.length && removeIdx.length < need; i++) {
      if (hand[i].typeIdx === tile.typeIdx) removeIdx.push(i);
    }
    if (removeIdx.length < need) return { error: "E_INVALID_ACTION" };
    for (let i = removeIdx.length - 1; i >= 0; i--) {
      hand.splice(removeIdx[i], 1);
    }
    const fromDiscards = ss.discardsBySeat[fromSeat] || [];
    fromDiscards.pop();
    ss.meldsBySeat[actor.seat].push({
      kind: action,
      tileTypeIdx: tile.typeIdx,
      fromSeat,
      size: action === "peng" ? 3 : 4,
    });
    if (action === "peng" && dingPairForPeng) {
      settlement.settleDingguoPeng(room, actor.seat, fromSeat, true);
    }
    if (action === "gang") {
      settlement.settleZhigang(room, actor.seat, fromSeat);
      ss.pengNoHuUntilDiscardSeat = actor.seat;
      const drawn = drawOneToSeat(room, actor.seat);
      if (drawn) {
        drawnSeat = actor.seat;
        drawnTileId = drawn.id;
        drawnTileTypeIdx = drawn.typeIdx;
      }
      if (!drawn) {
        ss.phase = "gameover";
        ss.winnerSeat = null;
        ss.status = "流局：杠后无牌可摸";
      } else if (ss.phase !== "self_react" && ss.phase !== "gameover") {
        ss.status = `座位${actor.seat} 杠牌，摸牌 ${tileName(drawn.typeIdx)}，请出牌`;
      }
    } else {
      ss.status = `座位${actor.seat} 碰牌，请出牌`;
      ss.phase = "discard";
      ss.currentSeat = actor.seat;
      ss.pengNoHuUntilDiscardSeat = actor.seat;
    }
    clearReactionState(ss);
    ss.seq += 1;
  } else {
    return { error: "E_INVALID_ACTION" };
  }

  return {
    room,
    snapshot: ss,
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
      scoreDeltaByUid: settlement.cloneScoreDelta(ss),
    },
  };
}

function applySelfReactPass(roomId) {
  const room = getRoomById(roomId);
  const ss = room?.gameSnapshot;
  if (ss?.phase !== "self_react" || !ss.selfReaction) return null;
  return applyReaction(roomId, ss.selfReaction.uid, "pass");
}

function applyReactionTimeoutPass(roomId) {
  const cur = getCurrentReactionEntry(roomId);
  if (!cur) return null;
  return applyReaction(roomId, cur.uid, "pass");
}

/** 临时调试：各机器人座位的完整手牌（与云函数 buildBotHandsBySeat 一致） */
function buildBotHandsBySeat(room) {
  const ss = room?.gameSnapshot;
  const out = {};
  if (!ss || !ss.handsByUid) return out;
  for (const p of room.players || []) {
    if (p.isBot && p.seat >= 0 && p.seat <= 3) {
      const tiles = ss.handsByUid[p.uid] || [];
      out[p.seat] = tiles.map((t) => ({ id: t.id, typeIdx: t.typeIdx }));
    }
  }
  return out;
}

function buildSnapshotForPlayer(roomId, uid) {
  const room = getRoomById(roomId);
  if (!room || !room.gameSnapshot) return null;
  const ss = room.gameSnapshot;
  const selfOps = getSelfOps(roomId, uid);
  const seat = room.players.find((p) => p.uid === uid)?.seat;
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
    meldsBySeat: ss.meldsBySeat,
    hand: ss.handsByUid[uid] || [],
    reactionForSelf: selfOps,
    status: ss.status,
    winnerSeat: ss.winnerSeat,
    reactionQueue: ss.reactionQueue,
    reactionIndex: ss.reactionIndex,
    reactionFromSeat: ss.reactionFromSeat,
    reactionTile: ss.reactionTile,
    scoreDeltaByUid: settlement.cloneScoreDelta(ss),
    chengCountBySeat: ss.chengCountBySeat || { 0: 0, 1: 0, 2: 0, 3: 0 },
    selfChengCount:
      typeof ss.chengCountBySeat?.[seat] === "number"
        ? ss.chengCountBySeat[seat]
        : 0,
    winnerExposeHand: buildWinnerExposeHand(room, ss),
  };
}

function runBotAutoTurns(roomId, maxTurns = 20) {
  const room = getRoomById(roomId);
  if (!room || !room.gameSnapshot) return [];
  const actions = [];

  let guard = 0;
  while (guard < maxTurns) {
    guard += 1;
    const ss = room.gameSnapshot;
    if (ss.phase !== "discard") break;
    const current = room.players.find((p) => p.seat === ss.currentSeat);
    if (!current || !current.isBot) break;
    const hand = ss.handsByUid[current.uid] || [];
    if (hand.length === 0) break;
    const discardId = hand[0].id;
    const ret = applyDiscard(roomId, current.uid, discardId);
    if (ret?.error) break;
    actions.push(ret.action);
  }
  return actions;
}

/**
 * 本局已结束（gameover）时由房主发起下一局：校验状态，并将全员标为已准备（不写库，仅内存）。
 */
function prepareNextRound(roomId, requesterUid) {
  const room = getRoomById(roomId);
  if (!room) return { error: "E_ROOM_NOT_FOUND" };
  if (room.ownerUid !== requesterUid) return { error: "E_ROOM_NOT_OWNER" };
  if (room.status !== "gaming") return { error: "E_ROOM_INVALID_STATE" };
  const ss = room.gameSnapshot;
  if (!ss || ss.phase !== "gameover") return { error: "E_ROOM_INVALID_STATE" };
  if (room.players.length !== MAHJONG_TABLE_SIZE) {
    return { error: "E_ROOM_INVALID_STATE" };
  }
  for (const p of room.players) {
    p.ready = true;
  }
  return { room };
}

function runOneBotTurn(roomId) {
  const room = getRoomById(roomId);
  if (!room || !room.gameSnapshot) return null;
  const ss = room.gameSnapshot;
  if (ss.phase !== "discard") return null;
  const current = room.players.find((p) => p.seat === ss.currentSeat);
  if (!current || !current.isBot) return null;
  if (
    ss.pengNoHuUntilDiscardSeat !== current.seat &&
    canSeatHu(ss, room, current.seat)
  ) {
    const huRet = applyReaction(roomId, current.uid, "hu");
    if (!huRet?.error) return huRet.action;
  }
  const hand = ss.handsByUid[current.uid] || [];
  if (hand.length === 0) return null;
  const melds = ss.meldsBySeat?.[current.seat] || [];
  const pickId = chooseBotDiscardTileIdAi(hand, melds, ss.laiziTypeIdx);
  const discardId = Number.isInteger(pickId) ? pickId : hand[0].id;
  const ret = applyDiscard(roomId, current.uid, discardId);
  if (ret?.error) return null;
  return ret.action;
}

module.exports = {
  MAHJONG_TABLE_SIZE,
  createRoom,
  getRoomById,
  getRoomByNo,
  joinRoom,
  setPlayerOnline,
  setReady,
  setBotCount,
  prepareNextRound,
  startGame,
  getSnapshot,
  getSelfOps,
  getCurrentReactionEntry,
  applyDiscard,
  applyReaction,
  applyReactionTimeoutPass,
  applySelfReactPass,
  buildSnapshotForPlayer,
  buildBotHandsBySeat,
  runBotAutoTurns,
  runOneBotTurn,
};

