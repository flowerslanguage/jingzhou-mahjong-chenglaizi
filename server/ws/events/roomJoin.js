const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");

function handleRoomJoin(ctx, packet) {
  const uid = ctx.uid;
  if (!uid) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_REQUIRED,
      message: "需要先登录",
    });
    return;
  }

  const roomNo = packet?.payload?.roomNo;
  const ret = ctx.roomService.joinRoom(roomNo, uid, ctx.nickname || uid);
  if (ret?.error) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS[ret.error] || ret.error,
      message: ret.error,
    });
    return;
  }

  const { room, seat } = ret;
  ctx.attachRoom(room.roomId);
  ctx.reply(packet, EVENTS.ROOM_JOIN_ACK, {
    roomId: room.roomId,
    seat,
  });
  ctx.broadcastRoomState(room.roomId);
}

module.exports = {
  handleRoomJoin,
};
