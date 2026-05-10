const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");
const { broadcastGameDeal } = require("../broadcastGameDeal");

function handleRoomNextRound(ctx, packet) {
  const uid = ctx.uid;
  if (!uid) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_REQUIRED,
      message: "需要先登录",
    });
    return;
  }

  const roomId = packet?.roomId;
  const prep = ctx.roomService.prepareNextRound(roomId, uid);
  if (prep?.error) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS[prep.error] || prep.error,
      message: prep.error,
    });
    return;
  }

  const deal = broadcastGameDeal(ctx, roomId);
  if (deal?.error) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS[deal.error] || deal.error,
      message: deal.error,
    });
    return;
  }

  ctx.reply(packet, EVENTS.ROOM_NEXT_ROUND_ACK, { ok: true });
}

module.exports = {
  handleRoomNextRound,
};
