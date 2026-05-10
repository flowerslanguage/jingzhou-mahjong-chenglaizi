/**
 * 前后端共享协议工具与消息体说明。
 * 当前项目为 JS，先采用轻量运行时校验。
 */

/**
 * 构造标准 Socket 消息包。
 * @param {object} input
 * @param {string} input.event 事件名
 * @param {string=} input.reqId 请求唯一标识（幂等）
 * @param {number=} input.seq 牌局内递增序号
 * @param {string=} input.roomId 房间 ID
 * @param {string=} input.tableId 牌桌 ID
 * @param {object=} input.payload 业务数据
 */
function makePacket(input) {
  return {
    event: input.event,
    reqId: input.reqId || "",
    seq: Number.isInteger(input.seq) ? input.seq : 0,
    ts: Date.now(),
    roomId: input.roomId || "",
    tableId: input.tableId || "",
    payload: input.payload || {},
  };
}

/**
 * 通用消息包基础校验。
 * 仅做结构检查，具体 payload 字段由各事件处理器单独校验。
 */
function isValidPacket(packet) {
  if (!packet || typeof packet !== "object") return false;
  if (typeof packet.event !== "string" || !packet.event) return false;
  if ("reqId" in packet && typeof packet.reqId !== "string") return false;
  if ("seq" in packet && !Number.isInteger(packet.seq)) return false;
  if ("roomId" in packet && typeof packet.roomId !== "string") return false;
  if ("tableId" in packet && typeof packet.tableId !== "string") return false;
  if ("payload" in packet && typeof packet.payload !== "object") return false;
  return true;
}

/**
 * 常用 payload 约定速查：
 *
 * auth.login
 *   req.payload = { code: string }
 *   ack.payload = { uid: string, token: string, profile: { nickname, avatar } }
 *
 * room.create
 *   req.payload = { rule: object, maxPlayers?: number }
 *   ack.payload = { roomId: string, roomNo: string, ownerUid: string }
 *
 * room.join
 *   req.payload = { roomNo: string }
 *   ack.payload = { roomId: string, seat: number }
 *
 * room.state（广播）
 *   payload = {
 *     roomId, roomNo, ownerUid, status, maxPlayers,
 *     players: [{ uid, seat, nickname, ready, online }]
 *   }
 *
 * game.discard
 *   req.payload = { tileId: number }
 *   ack.payload = { accepted: true }
 *
 * game.reaction
 *   req.payload = { action: "peng"|"gang"|"hu"|"pass"|"cheng", tileId?: number }
 *   ack.payload = { accepted: true }
 *
 * game.actionResult（广播）
 *   payload = {
 *     action, actorUid, targetUid?, fromUid?,
 *     tile?: { id, typeIdx },
 *     seq, nextTurnUid, phase
 *   }
 *
 * game.snapshot
 *   payload = {
 *     roomId, tableId, seq, phase, currentUid,
 *     self: { hand: Tile[], melds: Meld[] },
 *     others: [{ uid, handCount, melds, discards }],
 *     public: { wallCount, laiziTypeIdx, dingGuoTypeIdx, lastDiscard }
 *   }
 */

module.exports = {
  makePacket,
  isValidPacket,
};
