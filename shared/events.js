/**
 * 前后端共享事件名。
 * 统一放在这里，避免字符串手写导致拼写错误。
 */
const EVENTS = {
  // 鉴权相关
  AUTH_LOGIN: "auth.login",
  AUTH_LOGIN_ACK: "auth.login.ack",

  // 房间相关
  ROOM_CREATE: "room.create",
  ROOM_CREATE_ACK: "room.create.ack",
  ROOM_JOIN: "room.join",
  ROOM_JOIN_ACK: "room.join.ack",
  ROOM_LEAVE: "room.leave",
  ROOM_LEAVE_ACK: "room.leave.ack",
  ROOM_READY: "room.ready",
  ROOM_READY_ACK: "room.ready.ack",
  ROOM_SET_BOTS: "room.setBots",
  ROOM_SET_BOTS_ACK: "room.setBots.ack",
  ROOM_SET_BASE_STAKE: "room.setBaseStake",
  ROOM_SET_BASE_STAKE_ACK: "room.setBaseStake.ack",
  ROOM_RECREATE: "room.recreate",
  ROOM_RECREATE_ACK: "room.recreate.ack",
  ROOM_STATE: "room.state",
  ROOM_START: "room.start",
  ROOM_NEXT_ROUND: "room.nextRound",
  ROOM_NEXT_ROUND_ACK: "room.nextRound.ack",

  // 牌局相关
  GAME_START: "game.start",
  GAME_TURN: "game.turn",
  GAME_DISCARD: "game.discard",
  GAME_DISCARD_ACK: "game.discard.ack",
  GAME_REACTION: "game.reaction",
  GAME_REACTION_ACK: "game.reaction.ack",
  GAME_ACTION_RESULT: "game.actionResult",
  GAME_SNAPSHOT: "game.snapshot",
  GAME_OVER: "game.over",

  // 系统连接相关
  SYS_PING: "sys.ping",
  SYS_PONG: "sys.pong",
  SYS_RECONNECT: "sys.reconnect",
  SYS_RECONNECT_ACK: "sys.reconnect.ack",

  // 通用事件
  ERROR: "error",
};

/**
 * 可用的响应动作枚举。
 */
const REACTIONS = {
  PENG: "peng",
  GANG: "gang",
  HU: "hu",
  PASS: "pass",
  CHENG: "cheng",
};

module.exports = {
  EVENTS,
  REACTIONS,
};
