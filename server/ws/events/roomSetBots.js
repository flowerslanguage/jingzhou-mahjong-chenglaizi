const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");

function handleRoomSetBots(ctx, packet) {
  const uid = ctx.uid;
  if (!uid) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_REQUIRED,
      message: "需要先登录",
    });
    return;
  }

  const roomId = packet?.roomId;
  const botCount = Number(packet?.payload?.botCount ?? 0);
  const ret = ctx.roomService.setBotCount(roomId, uid, botCount);
  if (ret?.error) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS[ret.error] || ret.error,
      message: ret.error,
    });
    return;
  }

  ctx.reply(packet, EVENTS.ROOM_SET_BOTS_ACK, {
    ok: true,
    botCount: ret.room.botCount || 0,
  });
  ctx.broadcastRoomState(roomId);
}

module.exports = {
  handleRoomSetBots,
};
