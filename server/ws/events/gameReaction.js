const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");
const gameScheduler = require("../gameScheduler");

function handleGameReaction(ctx, packet) {
  const uid = ctx.uid;
  if (!uid) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_REQUIRED,
      message: "需要先登录",
    });
    return;
  }

  const roomId = packet?.roomId;
  const action = String(packet?.payload?.action || "");
  const typeIdx = packet?.payload?.typeIdx;
  const ret = ctx.roomService.applyReaction(roomId, uid, action, {
    typeIdx,
  });
  if (ret?.error) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS[ret.error] || ret.error,
      message: ret.error,
    });
    return;
  }

  ctx.reply(packet, EVENTS.GAME_REACTION_ACK, {
    accepted: true,
    action,
    seq: ret.action.seq,
  });
  gameScheduler.broadcastActionToHumans(ctx, ret.room, ret.action);
  gameScheduler.scheduleAfterAction(ctx, roomId);
}

module.exports = {
  handleGameReaction,
};
