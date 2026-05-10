const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");

function handleRoomCreate(ctx, packet) {
  const uid = ctx.uid;
  if (!uid) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_REQUIRED,
      message: "需要先登录",
    });
    return;
  }

  const rule = packet?.payload?.rule || {};
  // 房人数由服务端固定为四人桌，忽略 payload.maxPlayers，防止误传 3 导致三人即开局
  const room = ctx.roomService.createRoom(uid, ctx.nickname || uid, rule);

  ctx.attachRoom(room.roomId);
  ctx.reply(packet, EVENTS.ROOM_CREATE_ACK, {
    roomId: room.roomId,
    roomNo: room.roomNo,
    ownerUid: room.ownerUid,
    seat: 0,
  });

  ctx.broadcastRoomState(room.roomId);
}

module.exports = {
  handleRoomCreate,
};
