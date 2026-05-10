/**
 * 牌局自动化调度：机器人出牌、反应阶段机器人自动过。
 * 真人玩家在 react / self_react 阶段不设超时自动「过」，须显式发 game.reaction。
 */

const { EVENTS } = require("../../shared/events");

const BOT_DISCARD_DELAY_MS = 1800;
const BOT_REACT_PASS_DELAY_MS = 900;
const REACTION_TIMEOUT_MS = 12000;

function buildPayloadForUid(ctx, room, action, uid) {
  const ss = ctx.roomService.getSnapshot(room.roomId);
  const self = room.players.find((p) => p.uid === uid);
  const reactionForSelf = ctx.roomService.getSelfOps(room.roomId, uid);
  const scoreMap = action.scoreDeltaByUid || ss?.scoreDeltaByUid || {};
  const selfScoreDelta =
    typeof scoreMap[uid] === "number" ? scoreMap[uid] : 0;
  const selfChengCount =
    typeof ss?.chengCountBySeat?.[self?.seat] === "number"
      ? ss.chengCountBySeat[self.seat]
      : 0;
  return {
    ...action,
    botHandsBySeat: ctx.roomService.buildBotHandsBySeat(room),
    selfSeat: self ? self.seat : -1,
    selfHand: ss?.handsByUid?.[uid] || [],
    selfLastDrawTileId:
      action.drawnSeat === (self ? self.seat : -1) ? action.drawnTileId : null,
    discardsBySeat: ss?.discardsBySeat || {},
    meldsBySeat: ss?.meldsBySeat || {},
    reactionForSelf,
    scoreDeltaByUid: scoreMap,
    selfScoreDelta,
    chengCountBySeat: ss?.chengCountBySeat || { 0: 0, 1: 0, 2: 0, 3: 0 },
    selfChengCount,
  };
}

function broadcastActionToHumans(ctx, room, action) {
  for (const p of room.players) {
    if (p.isBot) continue;
    ctx.sendToUid(
      p.uid,
      EVENTS.GAME_ACTION_RESULT,
      buildPayloadForUid(ctx, room, action, p.uid),
      room.roomId,
    );
  }
}

function clearReactionTimeout(room) {
  if (room._reactionTimer) {
    clearTimeout(room._reactionTimer);
    room._reactionTimer = null;
  }
}

function clearBotDiscardLoop(room) {
  if (room._botDiscardTimer) {
    clearTimeout(room._botDiscardTimer);
    room._botDiscardTimer = null;
  }
  room._botLoopRunning = false;
}

/**
 * 任意牌局动作之后调用：安排超时、机器人反应、机器人出牌
 */
function scheduleAfterAction(ctx, roomId) {
  const room = ctx.roomService.getRoomById(roomId);
  if (!room) return;
  const ss = ctx.roomService.getSnapshot(roomId);
  if (!ss) return;

  clearReactionTimeout(room);

  if (ss.phase === "gameover") {
    clearBotDiscardLoop(room);
    return;
  }

  if (ss.phase === "self_react") {
    clearBotDiscardLoop(room);
    const sr = ss.selfReaction;
    if (!sr) return;
    const player = room.players.find((p) => p.uid === sr.uid);
    if (player && player.isBot) {
      room._reactionTimer = setTimeout(() => {
        room._reactionTimer = null;
        const r = ctx.roomService.getRoomById(roomId);
        const s2 = r?.gameSnapshot;
        const uid0 = s2?.selfReaction?.uid;
        const c0 = s2?.selfReaction?.anGangCandidates;
        if (!uid0) {
          scheduleAfterAction(ctx, roomId);
          return;
        }
        const ret =
          c0 && c0.length > 0
            ? ctx.roomService.applyReaction(roomId, uid0, "an_gang", {
                typeIdx: c0[0],
              })
            : ctx.roomService.applySelfReactPass(roomId);
        if (!ret || ret.error) {
          scheduleAfterAction(ctx, roomId);
          return;
        }
        const roomAfter = ctx.roomService.getRoomById(roomId);
        broadcastActionToHumans(ctx, roomAfter, ret.action);
        scheduleAfterAction(ctx, roomId);
      }, BOT_REACT_PASS_DELAY_MS);
      return;
    }
    // 真人「摸牌后暗杠/过」：暂不自动超时，必须由玩家发 game.reaction 后才流转
    // room._reactionTimer = setTimeout(() => {
    //   room._reactionTimer = null;
    //   const ret = ctx.roomService.applySelfReactPass(roomId);
    //   if (!ret || ret.error) return;
    //   const roomAfter = ctx.roomService.getRoomById(roomId);
    //   broadcastActionToHumans(ctx, roomAfter, ret.action);
    //   scheduleAfterAction(ctx, roomId);
    // }, REACTION_TIMEOUT_MS);
    return;
  }

  if (ss.phase === "react") {
    clearBotDiscardLoop(room);
    const cur = ctx.roomService.getCurrentReactionEntry(roomId);
    if (!cur) return;
    const player = room.players.find((p) => p.uid === cur.uid);
    if (player && player.isBot) {
      room._reactionTimer = setTimeout(() => {
        room._reactionTimer = null;
        const live = ctx.roomService.getCurrentReactionEntry(roomId);
        if (!live) {
          scheduleAfterAction(ctx, roomId);
          return;
        }
        const ret = ctx.roomService.applyReaction(roomId, live.uid, "pass");
        if (ret?.error) {
          scheduleAfterAction(ctx, roomId);
          return;
        }
        broadcastActionToHumans(ctx, ret.room, ret.action);
        scheduleAfterAction(ctx, roomId);
      }, BOT_REACT_PASS_DELAY_MS);
      return;
    }
    // 真人「碰/杠/过」：暂不自动超时，必须由玩家发 game.reaction 后才流转
    // room._reactionTimer = setTimeout(() => {
    //   room._reactionTimer = null;
    //   const ret = ctx.roomService.applyReactionTimeoutPass(roomId);
    //   if (!ret || ret.error) return;
    //   broadcastActionToHumans(ctx, ret.room, ret.action);
    //   scheduleAfterAction(ctx, roomId);
    // }, REACTION_TIMEOUT_MS);
    return;
  }

  if (ss.phase === "discard") {
    const current = room.players.find((p) => p.seat === ss.currentSeat);
    if (current && current.isBot) {
      // 每次重新调度前先清掉旧定时器，避免「标志仍为 true / 定时器已没了」时直接 return 导致永久卡住
      clearBotDiscardLoop(room);
      room._botLoopRunning = true;
      room._botDiscardTimer = setTimeout(() => {
        room._botDiscardTimer = null;
        const action = ctx.roomService.runOneBotTurn(roomId);
        if (!action) {
          room._botLoopRunning = false;
          // eslint-disable-next-line no-console
          console.error(
            "[bot] runOneBotTurn returned null",
            roomId,
            ctx.roomService.getSnapshot(roomId)?.phase,
            ctx.roomService.getSnapshot(roomId)?.currentSeat,
          );
          return;
        }
        const r = ctx.roomService.getRoomById(roomId);
        broadcastActionToHumans(ctx, r, action);
        room._botLoopRunning = false;
        scheduleAfterAction(ctx, roomId);
      }, BOT_DISCARD_DELAY_MS);
      return;
    }
    room._botLoopRunning = false;
  }
}

module.exports = {
  broadcastActionToHumans,
  scheduleAfterAction,
  clearReactionTimeout,
  clearBotDiscardLoop,
  BOT_DISCARD_DELAY_MS,
  REACTION_TIMEOUT_MS,
};
