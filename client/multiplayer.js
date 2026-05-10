const { EVENTS } = require("../shared/events");
const { makePacket } = require("../shared/protocol");
const { createSocketClient } = require("./net/socket");

/**
 * 为 true 时输出「去重 skip」等高频 [MJ] 日志；默认可减轻控制台压力，避免拖慢微信模拟器。
 * 真机/模拟器联机排障时改为 true 即可。
 */
const MJ_VERBOSE_CLOUD = false;

/**
 * 联机客户端最小实现：
 * - 连接与登录
 * - 建房/入房/准备
 * - 接收房间状态
 */
function createMultiplayerClient(options = {}) {
  const wsUrl = options.wsUrl || "ws://127.0.0.1:3000";
  const httpBaseUrl = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  // 传输层：ws（原有）/cloud（云开发）
  const transport = String(options.transport || "ws");
  const cloudFunctionName = String(options.cloudFunctionName || "roomGateway");
  const state = {
    connected: false,
    uid: "",
    token: "",
    roomId: "",
    roomNo: "",
    seat: -1,
    roomState: null,
    gameStarted: false,
    gameStartPayload: null,
    tip: "未连接",
    lastErrorCode: "",
    preferredNickname: "",
    preferredAvatarUrl: "",
  };
  let seq = 0;
  const listeners = {
    gameStart: [],
    actionResult: [],
    snapshot: [],
    roomCreate: [],
  };
  let roomWatcher = null;
  let cloudSnapshotTimer = null;
  let lastCloudSnapshotSeq = 0;
  /** 与 seq 组合，避免仅按 seq 去重时漏掉同 seq 下 phase/反应 的变化 */
  let lastCloudSnapshotSig = "";

  /** 将 roomId 持久化到本地，便于重连恢复 */
  function persistMjRoomId(roomId) {
    const id = String(roomId || "").trim();
    if (typeof wx === "undefined" || !id) return;
    try {
      wx.setStorageSync("mj_roomId", id);
    } catch (err) {
      // ignore
    }
  }

  const socket = transport === "cloud" ? null : createSocketClient({ url: wsUrl });

  /** 触发本地事件监听器（发布订阅） */
  function emit(event, payload) {
    const list = listeners[event] || [];
    for (const fn of list) {
      try {
        fn(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`${event} listener error`, err);
      }
    }
  }

  /** 生成递增序号，用于 ws 请求包 seq 字段 */
  function nextSeq() {
    seq += 1;
    return seq;
  }

  /** 尝试用本地缓存 roomId 恢复房间（ws/cloud 各自实现） */
  function reconnectStoredRoom() {
    let stored = "";
    if (typeof wx !== "undefined") {
      try {
        stored = wx.getStorageSync("mj_roomId") || "";
      } catch (err) {
        // ignore
      }
    }
    stored = String(stored || "").trim();
    if (!stored) return;
    if (transport === "cloud") {
      callCloudAction(EVENTS.ROOM_STATE, { roomId: stored }, { roomId: stored })
        .then((ret) => {
          if (!ret?.ok || !ret.roomState) return;
          applyRoomState(ret.roomState);
          watchRoom(stored);
          state.tip = "已回到房间";
          if (ret.roomState.status === "gaming") {
            resetCloudSnapshotDedupe("reconnect");
            pullSnapshotCloud();
          }
        })
        .catch(() => {
          // ignore
        });
      return;
    }
    send(EVENTS.SYS_RECONNECT, {}, { roomId: stored });
  }

  /** 通过 ws 发送统一协议包（仅 ws 模式有效） */
  function send(event, payload = {}, extra = {}) {
    if (!socket) return false;
    const packet = makePacket({
      event,
      reqId: `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      seq: nextSeq(),
      roomId: extra.roomId || state.roomId || "",
      tableId: extra.tableId || "",
      payload,
    });
    return socket.send(packet);
  }

  /** 关闭当前房态监听，避免重复 watch */
  function stopRoomWatch() {
    if (roomWatcher && typeof roomWatcher.close === "function") {
      try {
        roomWatcher.close();
      } catch (err) {
        // ignore
      }
    }
    roomWatcher = null;
  }

  /** 停止云模式牌局快照轮询 */
  function stopCloudSnapshotPolling() {
    if (cloudSnapshotTimer) {
      clearInterval(cloudSnapshotTimer);
      cloudSnapshotTimer = null;
    }
  }

  /** 在云模式下定时拉取 game.snapshot，补足实时对局同步 */
  function startCloudSnapshotPolling() {
    if (transport !== "cloud") return;
    stopCloudSnapshotPolling();
    cloudSnapshotTimer = setInterval(() => {
      if (!state.roomId || !state.uid) return;
      pullSnapshotCloud();
    }, 1800);
  }

  /** 应用房间状态到本地 state，并同步触发 roomState 事件 */
  function applyRoomState(payload) {
    state.roomState = payload || null;
    state.roomId = payload?.roomId || state.roomId;
    state.roomNo = payload?.roomNo || state.roomNo;
    if (!payload || payload.status !== "gaming") {
      state.gameStarted = false;
      state.gameStartPayload = null;
    }
    if (state.roomId) persistMjRoomId(state.roomId);
    if (Array.isArray(payload?.players) && state.uid) {
      const me = payload.players.find((p) => p.uid === state.uid);
      if (me && Number.isInteger(me.seat)) {
        state.seat = me.seat;
      }
    }
    emit("roomState", payload);
  }

  /** 在云模式下监听房间文档变化，实现大厅实时同步 */
  function watchRoom(roomId) {
    if (
      transport !== "cloud" ||
      typeof wx === "undefined" ||
      !wx.cloud ||
      !wx.cloud.database ||
      !roomId
    ) {
      return;
    }
    stopRoomWatch();
    try {
      // 监听房间文档变化，实现大厅状态实时同步
      roomWatcher = wx
        .cloud
        .database()
        .collection("mj_rooms")
        .where({ roomId })
        .watch({
          onChange: (snap) => {
            const room = Array.isArray(snap?.docs) ? snap.docs[0] : null;
            if (!room) return;
            const bs = Number(room.baseStake);
            applyRoomState({
              roomId: room.roomId,
              roomNo: room.roomNo,
              ownerUid: room.ownerUid,
              status: room.status,
              maxPlayers: room.maxPlayers,
              botCount: room.botCount || 0,
              baseStake: [1, 2, 5, 10].includes(bs) ? bs : 5,
              players: room.players || [],
            });
            if (room.status === "gaming" && !state.gameStarted) {
              state.tip = "房间已开局";
              resetCloudSnapshotDedupe("watchGaming");
              pullSnapshotCloud();
            }
          },
          onError: () => {
            state.tip = "房态监听中断";
          },
        });
    } catch (err) {
      state.tip = "房态监听失败";
    }
  }

  /** 调用云函数网关，统一传 action/payload/roomId */
  function callCloudAction(action, payload = {}, extra = {}) {
    return new Promise((resolve, reject) => {
      if (
        typeof wx === "undefined" ||
        !wx.cloud ||
        typeof wx.cloud.callFunction !== "function"
      ) {
        reject(new Error("cloud unavailable"));
        return;
      }
      wx.cloud.callFunction({
        name: cloudFunctionName,
        data: {
          action,
          roomId: extra.roomId || state.roomId || "",
          payload,
        },
        success: (res) => resolve(res?.result || {}),
        fail: (err) => reject(err || new Error("cloud call failed")),
      });
    });
  }

  /** 生成牌局“可见态”签名：seq 相同时若任意关键字段变仍须下发 snapshot */
  function cloudSnapshotSignature(snap) {
    if (!snap) return "";
    const r = snap.reactionForSelf;
    const rPart = r
      ? [
          r.canPeng ? 1 : 0,
          r.canGang ? 1 : 0,
          r.canHu ? 1 : 0,
          r.canPass ? 1 : 0,
          r.canCheng ? 1 : 0,
          r.canAnGang ? 1 : 0,
          (r.anGangTypeIdxs || []).join(","),
        ].join(".")
      : "x";
    return [
      Number(snap.seq || 0),
      snap.phase || "",
      snap.currentSeat != null ? String(snap.currentSeat) : "",
      rPart,
      snap.selfLastDrawTileId != null ? String(snap.selfLastDrawTileId) : "",
      Array.isArray(snap.hand) ? snap.hand.length : 0,
    ].join("|");
  }

  function resetCloudSnapshotDedupe(reason) {
    lastCloudSnapshotSeq = 0;
    lastCloudSnapshotSig = "";
    if (MJ_VERBOSE_CLOUD) {
      console.log("[MJ][cloudDedupe] reset", reason || "");
    }
  }

  /** 拉取云端牌局快照并触发 snapshot 事件 */
  function pullSnapshotCloud() {
    if (transport !== "cloud" || !state.roomId) {
      return;
    }
    callCloudAction("game.snapshot", {}, { roomId: state.roomId })
      .then((ret) => {
        if (!ret?.ok) {
          console.log("[MJ][cloudSnapshot] not ok", ret?.code || ret);
          return;
        }
        if (!ret.snapshot) {
          console.log("[MJ][cloudSnapshot] no snapshot in response");
          return;
        }
        const snap = ret.snapshot;
        const seq = Number(snap.seq || 0);
        const sig = cloudSnapshotSignature(snap);
        if (seq > 0 && seq === lastCloudSnapshotSeq && sig === lastCloudSnapshotSig) {
          if (MJ_VERBOSE_CLOUD) {
            console.log("[MJ][cloudSnapshot] skip dedupe", {
              seq,
              phase: snap.phase,
              currentSeat: snap.currentSeat,
              sig,
            });
          }
          return;
        }
        if (seq > 0) lastCloudSnapshotSeq = seq;
        lastCloudSnapshotSig = sig;
        const r = snap.reactionForSelf;
        if (MJ_VERBOSE_CLOUD) {
          console.log("[MJ][cloudSnapshot] emit → applySnapshot", {
            seq,
            phase: snap.phase,
            currentSeat: snap.currentSeat,
            selfLastDrawTileId: snap.selfLastDrawTileId,
            r: r
              ? {
                  p: !!r.canPeng,
                  g: !!r.canGang,
                  h: !!r.canHu,
                  pass: !!r.canPass,
                  aG: !!r.canAnGang,
                  aGn: (r.anGangTypeIdxs && r.anGangTypeIdxs.length) || 0,
                }
              : null,
          });
        }
        state.gameStarted = true;
        state.tip = "牌局已同步";
        emit("snapshot", snap);
      })
      .catch((err) => {
        console.log("[MJ][cloudSnapshot] call failed", err);
      });
  }

  /** 登录：ws 模式发包，cloud 模式调用云函数 */
  function login() {
    // 第一版先使用本地 code 占位，后续替换为 wx.login 真实 code
    const code = `dev_${Date.now()}`;
    const payload = { code };
    if (state.preferredNickname) {
      payload.nickname = state.preferredNickname;
    }
    if (state.preferredAvatarUrl) {
      payload.avatarUrl = state.preferredAvatarUrl;
    }
    if (transport === "cloud") {
      callCloudAction(EVENTS.AUTH_LOGIN, payload)
        .then((ret) => {
          if (!ret?.ok) {
            state.tip = `登录失败: ${ret?.code || "unknown"}`;
            return;
          }
          state.uid = ret.uid || "";
          state.token = ret.token || "";
          const loginName = String(
            ret.nickname || state.preferredNickname || state.uid || "",
          ).trim();
          state.tip = `已登录: ${loginName || state.uid}`;
          startCloudSnapshotPolling();
          reconnectStoredRoom();
        })
        .catch(() => {
          state.tip = "云登录失败";
        });
      return;
    }
    send(EVENTS.AUTH_LOGIN, payload);
  }

  /** 建房：根据传输模式走 ws 或 cloud；opts.baseStake 为 1/2/5/10（元） */
  function createRoom(opts = {}) {
    const bs = Number(opts?.baseStake);
    const baseStake = [1, 2, 5, 10].includes(bs) ? bs : 5;
    if (transport === "cloud") {
      callCloudAction(EVENTS.ROOM_CREATE, {
        rule: {},
        maxPlayers: 4,
        nickname: state.preferredNickname || "",
        avatarUrl: state.preferredAvatarUrl || "",
        baseStake,
      })
        .then((ret) => {
          if (!ret?.ok) {
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          state.roomId = ret.roomId || "";
          state.roomNo = ret.roomNo || "";
          state.seat = Number(ret.seat ?? state.seat);
          persistMjRoomId(state.roomId);
          state.tip = `已建房: ${state.roomNo}`;
          applyRoomState(ret.roomState || null);
          watchRoom(state.roomId);
          resetCloudSnapshotDedupe("createRoom");
          emit("roomCreate", ret);
        })
        .catch(() => {
          state.tip = "建房失败";
        });
      return;
    }
    send(EVENTS.ROOM_CREATE, { rule: { baseStake }, maxPlayers: 4 });
  }

  /** 入房：支持房号加入并同步本地状态 */
  function joinRoom(roomNo) {
    if (transport === "cloud") {
      callCloudAction(EVENTS.ROOM_JOIN, {
        roomNo: String(roomNo || "").trim(),
        nickname: state.preferredNickname || "",
        avatarUrl: state.preferredAvatarUrl || "",
      })
        .then((ret) => {
          if (!ret?.ok) {
            const code = String(ret?.code || "unknown");
            state.lastErrorCode = code;
            console.log("[share-join] join fail", {
              roomNo: String(roomNo || "").trim(),
              code,
            });
            if (code === "E_ROOM_ALREADY_STARTED") {
              state.tip = "此局已开始，不能进入";
            } else {
              state.tip = `错误: ${code}`;
            }
            return;
          }
          state.lastErrorCode = "";
          console.log("[share-join] join success", {
            roomNo: ret.roomNo,
            roomId: ret.roomId,
            seat: ret.seat,
          });
          state.roomId = ret.roomId || "";
          state.roomNo = ret.roomNo || "";
          state.seat = Number(ret.seat ?? -1);
          persistMjRoomId(state.roomId);
          state.tip = `已入房，座位${state.seat}`;
          applyRoomState(ret.roomState || null);
          watchRoom(state.roomId);
          resetCloudSnapshotDedupe("joinRoom");
        })
        .catch(() => {
          state.tip = "入房失败";
        });
      return;
    }
    send(EVENTS.ROOM_JOIN, { roomNo: String(roomNo || "").trim() });
  }

  /** 准备/取消准备 */
  function ready(yes) {
    if (transport === "cloud") {
      callCloudAction(EVENTS.ROOM_READY, { ready: Boolean(yes) }, { roomId: state.roomId || "" })
        .then((ret) => {
          if (!ret?.ok) {
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          state.tip = ret.ready ? "已准备" : "已取消准备";
          applyRoomState(ret.roomState || null);
          if (ret.started) {
            state.gameStarted = true;
            if (ret.startPayload) {
              state.gameStartPayload = ret.startPayload;
              resetCloudSnapshotDedupe("ready+gameStart");
              emit("gameStart", ret.startPayload);
            } else {
              resetCloudSnapshotDedupe("ready+pull");
              pullSnapshotCloud();
            }
          }
        })
        .catch(() => {
          state.tip = "准备失败";
        });
      return;
    }
    send(
      EVENTS.ROOM_READY,
      { ready: Boolean(yes) },
      { roomId: state.roomId || "" },
    );
  }

  /** 房主在等待阶段设置结算底金（1/2/5/10 元） */
  function setRoomBaseStake(amount) {
    const bs = Number(amount);
    const baseStake = [1, 2, 5, 10].includes(bs) ? bs : 5;
    if (transport === "cloud") {
      callCloudAction(
        EVENTS.ROOM_SET_BASE_STAKE,
        { baseStake },
        { roomId: state.roomId || "" },
      )
        .then((ret) => {
          if (!ret?.ok) {
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          state.tip = `底金: ${Number(ret.baseStake || baseStake)}元`;
          applyRoomState(ret.roomState || null);
        })
        .catch(() => {
          state.tip = "设置底金失败";
        });
      return;
    }
    state.tip = "当前模式不支持修改底金";
  }

  /** 设置房间机器人数量（房主操作） */
  function setBots(botCount) {
    if (transport === "cloud") {
      callCloudAction(
        EVENTS.ROOM_SET_BOTS,
        { botCount: Number(botCount) || 0 },
        { roomId: state.roomId || "" },
      )
        .then((ret) => {
          if (!ret?.ok) {
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          state.tip = `电脑玩家数: ${Number(ret.botCount || 0)}`;
          applyRoomState(ret.roomState || null);
        })
        .catch(() => {
          state.tip = "设置机器人失败";
        });
      return;
    }
    send(
      EVENTS.ROOM_SET_BOTS,
      { botCount: Number(botCount) || 0 },
      { roomId: state.roomId || "" },
    );
  }

  /** 本局结束后由房主发起：全员视为已准备并直接发牌 */
  function nextRound() {
    if (transport === "cloud") {
      callCloudAction(EVENTS.ROOM_NEXT_ROUND, {}, { roomId: state.roomId || "" })
        .then((ret) => {
          if (!ret?.ok) {
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          state.tip = "新一局已准备";
          applyRoomState(ret.roomState || null);
          if (ret.startPayload) {
            state.gameStarted = true;
            state.gameStartPayload = ret.startPayload;
            resetCloudSnapshotDedupe("nextRound+gameStart");
            emit("gameStart", ret.startPayload);
          } else {
            resetCloudSnapshotDedupe("nextRound+pull");
            pullSnapshotCloud();
          }
        })
        .catch(() => {
          state.tip = "开局失败";
        });
      return;
    }
    send(EVENTS.ROOM_NEXT_ROUND, {}, { roomId: state.roomId || "" });
  }

  /** 退出房间：云模式下关闭当前房并回到大厅 */
  function leaveRoom() {
    if (transport === "cloud") {
      callCloudAction(EVENTS.ROOM_LEAVE, {}, { roomId: state.roomId || "" })
        .then((ret) => {
          if (!ret?.ok) {
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          stopRoomWatch();
          resetCloudSnapshotDedupe("leaveRoom");
          state.gameStarted = false;
          state.gameStartPayload = null;
          state.roomState = null;
          state.roomId = "";
          state.roomNo = "";
          state.seat = -1;
          if (typeof wx !== "undefined") {
            try {
              wx.removeStorageSync("mj_roomId");
            } catch (err) {
              // ignore
            }
          }
          state.tip = "已退出房间";
          emit("roomState", null);
        })
        .catch(() => {
          state.tip = "退出房间失败";
        });
      return;
    }
    send(EVENTS.ROOM_LEAVE, {}, { roomId: state.roomId || "" });
  }

  /** 关掉当前房间并立即新建新房（仅房主） */
  function recreateRoom() {
    if (transport === "cloud") {
      callCloudAction(EVENTS.ROOM_RECREATE, {
        nickname: state.preferredNickname || "",
      }, { roomId: state.roomId || "" })
        .then((ret) => {
          if (!ret?.ok) {
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          stopRoomWatch();
          resetCloudSnapshotDedupe("recreateRoom");
          state.gameStarted = false;
          state.gameStartPayload = null;
          state.roomState = null;
          state.roomId = ret.roomId || "";
          state.roomNo = ret.roomNo || "";
          state.seat = Number(ret.seat ?? 0);
          persistMjRoomId(state.roomId);
          state.tip = `已重开房: ${state.roomNo}`;
          applyRoomState(ret.roomState || null);
          watchRoom(state.roomId);
          emit("roomCreate", ret);
        })
        .catch(() => {
          state.tip = "重开房失败";
        });
      return;
    }
    send(EVENTS.ROOM_RECREATE, {}, { roomId: state.roomId || "" });
  }

  /** 出牌：云模式调用 game.discard，ws 模式发 GAME_DISCARD */
  function discard(tileId) {
    if (transport === "cloud") {
      callCloudAction("game.discard", { tileId: Number(tileId) }, { roomId: state.roomId || "" })
        .then((ret) => {
          if (!ret?.ok) {
            console.log("[MJ][cloudDiscard] fail", ret?.code || ret);
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          const a = ret.action || {};
          console.log("[MJ][cloudDiscard] ok", {
            phase: a.phase,
            seq: a.seq,
            nextSeat: a.nextSeat,
            selfLastDrawTileId: a.selfLastDrawTileId,
            r: a.reactionForSelf
              ? {
                  p: !!a.reactionForSelf.canPeng,
                  g: !!a.reactionForSelf.canGang,
                  pass: !!a.reactionForSelf.canPass,
                }
              : null,
          });
          state.gameStarted = true;
          emit("actionResult", ret.action || {});
          pullSnapshotCloud();
        })
        .catch((err) => {
          console.log("[MJ][cloudDiscard] err", err);
          state.tip = "出牌失败";
        });
      return;
    }
    send(
      EVENTS.GAME_DISCARD,
      { tileId: Number(tileId) },
      { roomId: state.roomId || "" },
    );
  }

  /** 碰杠胡过等反应动作：云模式调用 game.reaction */
  function react(action, extra = {}) {
    if (transport === "cloud") {
      const payload = { action: String(action || "") };
      if (extra.typeIdx !== undefined && extra.typeIdx !== null && extra.typeIdx !== "") {
        payload.typeIdx = Number(extra.typeIdx);
      }
      callCloudAction("game.reaction", payload, { roomId: state.roomId || "" })
        .then((ret) => {
          if (!ret?.ok) {
            console.log("[MJ][cloudReact] fail", { action: payload.action, code: ret?.code || ret });
            state.tip = `错误: ${ret?.code || "unknown"}`;
            return;
          }
          const a = ret.action || {};
          console.log("[MJ][cloudReact] ok", {
            req: payload.action,
            phase: a.phase,
            seq: a.seq,
            nextSeat: a.nextSeat,
            r: a.reactionForSelf
              ? {
                  p: !!a.reactionForSelf.canPeng,
                  g: !!a.reactionForSelf.canGang,
                  pass: !!a.reactionForSelf.canPass,
                  aG: !!a.reactionForSelf.canAnGang,
                }
              : null,
          });
          state.gameStarted = true;
          emit("actionResult", ret.action || {});
          pullSnapshotCloud();
        })
        .catch((err) => {
          console.log("[MJ][cloudReact] err", err);
          state.tip = "操作失败";
        });
      return;
    }
    const payload = { action: String(action || "") };
    if (extra.typeIdx !== undefined && extra.typeIdx !== null && extra.typeIdx !== "") {
      payload.typeIdx = Number(extra.typeIdx);
    }
    send(EVENTS.GAME_REACTION, payload, { roomId: state.roomId || "" });
  }

  /** 获取房间二维码（云函数优先，http/纯前端兜底） */
  function fetchRoomQr(roomNo = "") {
    const no = String(roomNo || state.roomNo || "").trim();
    return new Promise((resolve, reject) => {
      if (!no) {
        reject(new Error("roomNo empty"));
        return;
      }
      const fallbackQr = () => {
        const text = `荆州麻将房号:${no}`;
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(text)}`;
        resolve({
          ok: true,
          roomNo: no,
          inviteUrl: "",
          qrImageUrl,
          mode: "room_no_only",
        });
      };
      const tryCloudFirst = () => {
        if (
          typeof wx === "undefined" ||
          !wx.cloud ||
          typeof wx.cloud.callFunction !== "function"
        ) {
          return false;
        }
        wx.cloud.callFunction({
          name: "getRoomQr",
          data: { roomNo: no },
          success: (res) => {
            const out = res?.result || {};
            const ok = !!out?.ok;
            const qrImageUrl = String(out?.qrImageUrl || out?.tempFileURL || "").trim();
            if (ok && qrImageUrl) {
              resolve({
                ok: true,
                roomNo: no,
                inviteUrl: String(out?.inviteUrl || "").trim(),
                qrImageUrl,
                mode: "cloud",
              });
              return;
            }
            tryHttpThenFallback();
          },
          fail: () => {
            tryHttpThenFallback();
          },
        });
        return true;
      };
      const tryHttpThenFallback = () => {
        if (typeof wx === "undefined" || typeof wx.request !== "function") {
          fallbackQr();
          return;
        }
        wx.request({
          url: `${httpBaseUrl}/room/qrcode?roomNo=${encodeURIComponent(no)}`,
          method: "GET",
          timeout: 10000,
          success: (res) => {
            if (res.statusCode >= 200 && res.statusCode < 300 && res.data?.ok) {
              resolve(res.data);
            } else {
              fallbackQr();
            }
          },
          fail: () => fallbackQr(),
        });
      };
      if (tryCloudFirst()) return;
      tryHttpThenFallback();
    });
  }

  if (socket) {
    socket.on("open", () => {
    state.connected = true;
    state.tip = "已连接，登录中...";
    login();
    });

    socket.on("close", () => {
    state.connected = false;
    state.tip = "连接已断开，重连中...";
    });

    socket.on("error", () => {
      state.tip = "网络异常";
    });

    socket.on("message", (msg) => {
      const payload = msg?.payload || {};
      switch (msg.event) {
      case EVENTS.AUTH_LOGIN_ACK:
        state.uid = payload.uid || "";
        state.token = payload.token || "";
        {
          const loginName = String(
            payload.nickname || state.preferredNickname || state.uid || "",
          ).trim();
          state.tip = `已登录: ${loginName || state.uid}`;
        }
        reconnectStoredRoom();
        break;
      case EVENTS.ROOM_CREATE_ACK:
        state.roomId = payload.roomId || "";
        state.roomNo = payload.roomNo || "";
        state.seat = Number(payload.seat ?? state.seat);
        persistMjRoomId(state.roomId);
        state.tip = `已建房: ${state.roomNo}`;
        emit("roomCreate", payload);
        break;
      case EVENTS.ROOM_JOIN_ACK:
        state.roomId = payload.roomId || "";
        state.seat = Number(payload.seat ?? -1);
        persistMjRoomId(state.roomId);
        state.tip = `已入房，座位${state.seat}`;
        break;
      case EVENTS.ROOM_READY_ACK:
        state.tip = payload.ready ? "已准备" : "已取消准备";
        break;
      case EVENTS.ROOM_SET_BOTS_ACK:
        state.tip = `电脑玩家数: ${Number(payload.botCount || 0)}`;
        break;
      case EVENTS.ROOM_STATE:
        applyRoomState(payload);
        break;
      case EVENTS.ROOM_START:
        state.tip = "房间已开局";
        break;
      case EVENTS.GAME_START:
        state.gameStarted = true;
        state.gameStartPayload = payload;
        if (state.roomId) persistMjRoomId(state.roomId);
        state.tip = "游戏开始";
        emit("gameStart", payload);
        break;
      case EVENTS.GAME_ACTION_RESULT:
        emit("actionResult", payload);
        break;
      case EVENTS.GAME_SNAPSHOT:
        state.gameStarted = true;
        state.tip = "牌局已同步";
        emit("snapshot", payload);
        break;
      case EVENTS.SYS_RECONNECT_ACK:
        if (payload && payload.ok) {
          state.roomId = payload.roomId || state.roomId;
          persistMjRoomId(state.roomId);
          state.tip = "已回到房间";
        } else if (payload && payload.ok === false) {
          state.tip = `重连失败: ${payload.code || "unknown"}`;
          if (typeof wx !== "undefined") {
            try {
              wx.removeStorageSync("mj_roomId");
            } catch (err) {
              // ignore
            }
          }
        }
        break;
      case EVENTS.ERROR: {
        const code = payload.code || "unknown";
        state.tip = `错误: ${code}`;
        const clearRoomCodes = new Set([
          "E_ROOM_ALREADY_STARTED",
          "E_ROOM_NOT_FOUND",
          "E_ROOM_FULL",
          "E_ROOM_NOT_IN",
        ]);
        if (clearRoomCodes.has(code) && typeof wx !== "undefined") {
          try {
            wx.removeStorageSync("mj_roomId");
          } catch (err) {
            // ignore
          }
        }
        break;
      }
      default:
        break;
      }
    });
  }

  /** 建立连接入口：cloud 直接登录，ws 建 socket */
  function connect() {
    if (transport === "cloud") {
      // 云模式下不建立 socket，直接走云函数登录
      state.connected = true;
      state.tip = "云模式已连接，登录中...";
      login();
      return;
    }
    const ok = socket.connect();
    if (!ok) {
      state.tip = "连接初始化失败";
    }
  }

  return {
    state,
    setPreferredNickname(nickname) {
      state.preferredNickname = String(nickname || "").trim();
    },
    setPreferredAvatar(avatarUrl) {
      state.preferredAvatarUrl = String(avatarUrl || "").trim();
    },
    connect,
    createRoom,
    joinRoom,
    ready,
    setBots,
    setRoomBaseStake,
    nextRound,
    leaveRoom,
    recreateRoom,
    discard,
    react,
    fetchRoomQr,
    on(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    // 供页面销毁时释放云监听资源（当前小游戏常驻可不主动调用）
    dispose() {
      stopRoomWatch();
      stopCloudSnapshotPolling();
    },
  };
}

module.exports = {
  createMultiplayerClient,
};
