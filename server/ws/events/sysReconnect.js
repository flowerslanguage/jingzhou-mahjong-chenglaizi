const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");
const { scheduleAfterAction } = require("../gameScheduler");

function handleSysReconnect(ctx, packet) {
  const uid = ctx.uid;
  if (!uid) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_REQUIRED,
      message: "需要先登录",
    });
    return;
  }

  const roomId = String(packet?.roomId || "").trim();
  if (!roomId) {
    ctx.reply(packet, EVENTS.SYS_RECONNECT_ACK, {
      ok: false,
      code: ERRORS.E_BAD_REQUEST,
    });
    return;
  }

  const room = ctx.roomService.getRoomById(roomId);
  if (!room) {
    ctx.reply(packet, EVENTS.SYS_RECONNECT_ACK, {
      ok: false,
      code: ERRORS.E_ROOM_NOT_FOUND,
    });
    return;
  }

  if (!room.players.some((p) => p.uid === uid)) {
    ctx.reply(packet, EVENTS.SYS_RECONNECT_ACK, {
      ok: false,
      code: ERRORS.E_ROOM_NOT_IN,
    });
    return;
  }

  ctx.attachRoom(roomId);
  ctx.roomService.setPlayerOnline(uid, true);
  ctx.broadcastRoomState(roomId);

  if (room.status === "gaming" && room.gameSnapshot) {
    const snap = ctx.roomService.buildSnapshotForPlayer(roomId, uid);
    if (snap) {
      ctx.sendToUid(uid, EVENTS.GAME_SNAPSHOT, snap, roomId);
    }
  }

  scheduleAfterAction(ctx, roomId);

  ctx.reply(packet, EVENTS.SYS_RECONNECT_ACK, { ok: true, roomId });
}

module.exports = {
  handleSysReconnect,
};
