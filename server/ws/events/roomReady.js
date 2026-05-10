const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");
const { MAHJONG_TABLE_SIZE } = require("../../room/roomService");
const { broadcastGameDeal } = require("../broadcastGameDeal");

function handleRoomReady(ctx, packet) {
  const uid = ctx.uid;
  if (!uid) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_REQUIRED,
      message: "需要先登录",
    });
    return;
  }

  const roomId = packet?.roomId;
  const ready = Boolean(packet?.payload?.ready);
  const ret = ctx.roomService.setReady(roomId, uid, ready);
  if (ret?.error) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS[ret.error] || ret.error,
      message: ret.error,
    });
    return;
  }

  ctx.reply(packet, EVENTS.ROOM_READY_ACK, { ok: true, ready });
  ctx.broadcastRoomState(roomId);

  // 固定四人桌满座且全员准备后才开局（不依赖可能被误设为 3 的 maxPlayers）
  const room = ret.room;
  const players = Array.isArray(room?.players) ? room.players : [];
  const need = MAHJONG_TABLE_SIZE;
  const canStart =
    players.length === need && players.every((p) => p.ready);
  if (canStart && room.status === "waiting") {
    room.status = "gaming";
    const deal = broadcastGameDeal(ctx, roomId);
    if (deal?.error) {
      ctx.broadcastToRoom(roomId, EVENTS.ERROR, {
        code: deal.error,
        message: deal.error,
      });
    }
  }
}

module.exports = {
  handleRoomReady,
};
