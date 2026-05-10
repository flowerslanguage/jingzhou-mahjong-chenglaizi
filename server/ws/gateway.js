const { EVENTS } = require("../../shared/events");
const { ERRORS, ERROR_MESSAGES } = require("../../shared/errors");
const { isValidPacket, makePacket } = require("../../shared/protocol");
const roomService = require("../room/roomService");
const settlement = require("../room/settlement");
const { handleAuthLogin } = require("./events/authLogin");
const { handleRoomCreate } = require("./events/roomCreate");
const { handleRoomJoin } = require("./events/roomJoin");
const { handleRoomReady } = require("./events/roomReady");
const { handleRoomSetBots } = require("./events/roomSetBots");
const { handleRoomNextRound } = require("./events/roomNextRound");
const { handleGameDiscard } = require("./events/gameDiscard");
const { handleGameReaction } = require("./events/gameReaction");
const { handleSysReconnect } = require("./events/sysReconnect");

/**
 * WebSocket 网关（最小可运行版）
 * - 连接管理
 * - 消息路由
 * - 房间内广播
 */
function createGateway(wss) {
  const uidToSocket = new Map();
  const socketToMeta = new Map();
  const roomToSockets = new Map();

  function sendRaw(ws, packet) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(packet));
  }

  function reply(ws, reqPacket, event, payload) {
    const packet = makePacket({
      event,
      reqId: reqPacket?.reqId || "",
      seq: reqPacket?.seq || 0,
      roomId: reqPacket?.roomId || "",
      tableId: reqPacket?.tableId || "",
      payload,
    });
    sendRaw(ws, packet);
  }

  function attachRoom(ws, roomId) {
    const meta = socketToMeta.get(ws);
    if (!meta) return;
    if (meta.roomId && roomToSockets.has(meta.roomId)) {
      roomToSockets.get(meta.roomId).delete(ws);
    }
    meta.roomId = roomId;
    if (!roomToSockets.has(roomId)) {
      roomToSockets.set(roomId, new Set());
    }
    roomToSockets.get(roomId).add(ws);
  }

  function broadcastRoomState(roomId) {
    const room = roomService.getRoomById(roomId);
    if (!room) return;
    const sockets = roomToSockets.get(roomId);
    if (!sockets || sockets.size === 0) return;

    const safeRoom = {
      roomId: room.roomId,
      roomNo: room.roomNo,
      ownerUid: room.ownerUid,
      status: room.status,
      maxPlayers: room.maxPlayers,
      botCount: room.botCount || 0,
      baseStake: settlement.normalizeBaseStake(room.baseStake),
      players: (room.players || []).map((p) => ({
        uid: p.uid,
        seat: p.seat,
        nickname: p.nickname,
        ready: p.ready,
        online: p.online,
        isBot: !!p.isBot,
      })),
    };

    const packet = makePacket({
      event: EVENTS.ROOM_STATE,
      roomId,
      payload: safeRoom,
    });
    for (const ws of sockets) {
      sendRaw(ws, packet);
    }
  }

  function broadcastToRoom(roomId, event, payload = {}) {
    const sockets = roomToSockets.get(roomId);
    if (!sockets || sockets.size === 0) return;
    const packet = makePacket({
      event,
      roomId,
      payload,
    });
    for (const ws of sockets) {
      sendRaw(ws, packet);
    }
  }

  function sendToUid(uid, event, payload = {}, roomId = "") {
    const ws = uidToSocket.get(uid);
    if (!ws) return;
    const packet = makePacket({
      event,
      roomId,
      payload,
    });
    sendRaw(ws, packet);
  }

  function makeCtx(ws) {
    const meta = socketToMeta.get(ws) || {};
    return {
      ws,
      uid: meta.uid || "",
      nickname: meta.nickname || "",
      roomService,
      bindUser(uid, nickname = "") {
        meta.uid = uid;
        meta.nickname = nickname;
        socketToMeta.set(ws, meta);
        uidToSocket.set(uid, ws);
      },
      attachRoom(roomId) {
        attachRoom(ws, roomId);
      },
      broadcastRoomState,
      broadcastToRoom,
      sendToUid,
      reply(reqPacket, event, payload) {
        reply(ws, reqPacket, event, payload);
      },
    };
  }

  function replyError(ws, reqPacket, code) {
    reply(ws, reqPacket, EVENTS.ERROR, {
      code,
      message: ERROR_MESSAGES[code] || code,
    });
  }

  function onPacket(ws, packet) {
    const ctx = makeCtx(ws);
    switch (packet.event) {
      case EVENTS.AUTH_LOGIN:
        return handleAuthLogin(ctx, packet);
      case EVENTS.ROOM_CREATE:
        return handleRoomCreate(ctx, packet);
      case EVENTS.ROOM_JOIN:
        return handleRoomJoin(ctx, packet);
      case EVENTS.ROOM_READY:
        return handleRoomReady(ctx, packet);
      case EVENTS.ROOM_SET_BOTS:
        return handleRoomSetBots(ctx, packet);
      case EVENTS.ROOM_NEXT_ROUND:
        return handleRoomNextRound(ctx, packet);
      case EVENTS.GAME_DISCARD:
        return handleGameDiscard(ctx, packet);
      case EVENTS.GAME_REACTION:
        return handleGameReaction(ctx, packet);
      case EVENTS.SYS_PING:
        return ctx.reply(packet, EVENTS.SYS_PONG, { ok: true });
      case EVENTS.SYS_RECONNECT:
        return handleSysReconnect(ctx, packet);
      default:
        return replyError(ws, packet, ERRORS.E_BAD_REQUEST);
    }
  }

  wss.on("connection", (ws) => {
    socketToMeta.set(ws, {
      uid: "",
      nickname: "",
      roomId: "",
    });

    ws.on("message", async (raw) => {
      let packet = null;
      try {
        packet = JSON.parse(String(raw || "{}"));
      } catch (err) {
        replyError(ws, {}, ERRORS.E_BAD_REQUEST);
        return;
      }
      if (packet && typeof packet === "object" && "seq" in packet) {
        const n = Number(packet.seq);
        packet.seq = Number.isFinite(n) ? Math.trunc(n) : 0;
      }
      if (!isValidPacket(packet)) {
        replyError(ws, packet, ERRORS.E_BAD_REQUEST);
        return;
      }
      await onPacket(ws, packet);
    });

    ws.on("close", () => {
      const meta = socketToMeta.get(ws);
      socketToMeta.delete(ws);
      if (!meta) return;

      if (meta.uid) {
        uidToSocket.delete(meta.uid);
        const room = roomService.setPlayerOnline(meta.uid, false);
        if (room) broadcastRoomState(room.roomId);
      }
      if (meta.roomId && roomToSockets.has(meta.roomId)) {
        roomToSockets.get(meta.roomId).delete(ws);
      }
    });
  });

  return {
    broadcastRoomState,
  };
}

module.exports = {
  createGateway,
};
