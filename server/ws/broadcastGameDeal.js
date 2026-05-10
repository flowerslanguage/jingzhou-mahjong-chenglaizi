const { EVENTS } = require("../../shared/events");
const gameScheduler = require("./gameScheduler");

/**
 * 洗牌发牌并向房间内玩家广播 ROOM_START + 各席 GAME_START（与首局 room.ready 逻辑一致）。
 */
function broadcastGameDeal(ctx, roomId) {
  const room = ctx.roomService.getRoomById(roomId);
  if (!room) return { error: "E_ROOM_NOT_FOUND" };
  const gameRet = ctx.roomService.startGame(roomId);
  if (gameRet?.error) return { error: gameRet.error };
  const snapshot = gameRet.snapshot;
  ctx.broadcastToRoom(roomId, EVENTS.ROOM_START, {
    roomId,
    roomNo: room.roomNo,
    players: room.players,
  });
  const botHandsBySeat = ctx.roomService.buildBotHandsBySeat(room);
  for (const player of room.players) {
    const selfOps = ctx.roomService.getSelfOps(roomId, player.uid);
    ctx.sendToUid(
      player.uid,
      EVENTS.GAME_START,
      {
        roomId,
        roomNo: room.roomNo,
        dealerSeat: snapshot.dealerSeat,
        currentSeat: snapshot.currentSeat,
        phase: snapshot.phase,
        players: snapshot.players,
        dingGuoTypeIdx: snapshot.dingGuoTypeIdx,
        laiziTypeIdx: snapshot.laiziTypeIdx,
        wallCount: snapshot.wallCount,
        discardsBySeat: snapshot.discardsBySeat,
        meldsBySeat: snapshot.meldsBySeat,
        hand: snapshot.handsByUid[player.uid] || [],
        reactionForSelf: selfOps,
        scoreDeltaByUid: snapshot.scoreDeltaByUid || {},
        botHandsBySeat,
        ts: Date.now(),
      },
      roomId,
    );
  }
  ctx.broadcastRoomState(roomId);
  gameScheduler.scheduleAfterAction(ctx, roomId);
  return { ok: true };
}

module.exports = { broadcastGameDeal };
