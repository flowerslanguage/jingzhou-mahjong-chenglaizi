const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");
const gameScheduler = require("../gameScheduler");

function handleGameDiscard(ctx, packet) {
  const uid = ctx.uid;
  if (!uid) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_REQUIRED,
      message: "需要先登录",
    });
    return;
  }

  const roomId = packet?.roomId;
  const tileId = Number(packet?.payload?.tileId);
  const ret = ctx.roomService.applyDiscard(roomId, uid, tileId);
  if (ret?.error) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS[ret.error] || ret.error,
      message: ret.error,
    });
    return;
  }

  ctx.reply(packet, EVENTS.GAME_DISCARD_ACK, {
    accepted: true,
    seq: ret.action.seq,
  });
  gameScheduler.broadcastActionToHumans(ctx, ret.room, ret.action);
  gameScheduler.scheduleAfterAction(ctx, roomId);
}

module.exports = {
  handleGameDiscard,
};
