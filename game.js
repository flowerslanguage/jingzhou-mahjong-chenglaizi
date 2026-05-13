// 引入麻将游戏逻辑层模块，包含游戏规则、牌型定义、核心算法等
const {
  createMahjongGame,
  tileGlyph,
  tileName,
  TILE_KIND_COUNT,
} = require("./logic.js");
const { createMultiplayerClient } = require("./client/multiplayer.js");

// 开启真机调试面板
wx.setEnableDebug({
  enableDebug: true,
});

// 创建微信小游戏 Canvas 实例，作为游戏绘制载体
const canvas = wx.createCanvas();
// 获取 Canvas 2D 渲染上下文，所有绘制操作都通过该上下文执行
const ctx = canvas.getContext("2d");

/**
 * 逻辑尺寸（触摸、布局坐标）与画布像素比；由 applyCanvasLayout 写入。
 * 从分享卡片冷启动时，首帧 getSystemInfo 的 window* 可能偏小，需在 onShow/onWindowResize 再适配。
 */
let SCREEN_W = 375;
let SCREEN_H = 667;
let CANVAS_DPR = 2;
/** 微信胶囊位置（用于右上角按钮避让）；随 applyCanvasLayout 刷新 */
let menuButtonRect =
  typeof wx !== "undefined" &&
  typeof wx.getMenuButtonBoundingClientRect === "function"
    ? wx.getMenuButtonBoundingClientRect()
    : null;

// FPS 计算相关变量：用于监控游戏渲染帧率
let lastFrameTime = Date.now(); // 上一帧的时间戳
let fps = 0; // 当前帧率值

// 存储需要显示三角的牌ID（用于控制消失）
const newTileIds = new Set();
// 三角消失时长（默认3秒）
const TRIANGLE_DURATION = 3000;
// 新摸牌高亮闪烁状态（闪两次）
const drawFlashState = {
  tileId: null,
  visible: false,
  togglesLeft: 0,
  timer: null,
};

/** 先播「上家已出牌」等，再隔这么久显示「已摸牌…」与高亮（毫秒） */
const STATUS_AFTER_UPSTREAM_BEFORE_DRAW_MS = 1800;
let statusStaggerTimer = null;
/** 新摸牌后，反应按钮（如胡）延迟出现，避免按钮先于新牌可见 */
const REACTION_AFTER_DRAW_DELAY_MS = 220;
let reactionStaggerTimer = null;

function clearStatusStaggerTimer() {
  if (statusStaggerTimer) {
    clearTimeout(statusStaggerTimer);
    statusStaggerTimer = null;
  }
}

function clearReactionStaggerTimer() {
  if (reactionStaggerTimer) {
    clearTimeout(reactionStaggerTimer);
    reactionStaggerTimer = null;
  }
}

function applyReactionState(r) {
  game.reaction = r || null;
  game.canHu = !!game.reaction?.canHu;
  game.canCheng = !!game.reaction?.canCheng;
}

/**
 * 先显示上一条局面提示，再延迟显示摸牌提示并启动摸牌高亮（不拼在同一句里）
 */
function scheduleDrawHintAfterUpstream(upstream, tileId, drawHint) {
  clearStatusStaggerTimer();
  setStatus(upstream);
  statusStaggerTimer = setTimeout(() => {
    statusStaggerTimer = null;
    setStatus(drawHint);
    startDrawFlash(tileId);
  }, STATUS_AFTER_UPSTREAM_BEFORE_DRAW_MS);
}

/**
 * 联机排障：需要 [MJ] 快照/操作日志时在文件顶部将此项改为 `true`。
 * 默认可减少控制台 I/O，避免在模拟器里与大量日志叠加时卡顿。
 */
const MJ_DEBUG_LOG = false;

/**
 * 真机/开发者工具中过滤 `MJ` 即可。勿在热路径（每帧 loop）中调用。
 */
function mjLog(tag, data) {
  if (!MJ_DEBUG_LOG) return;
  if (data !== undefined) {
    console.log(`[MJ][${tag}]`, data);
  } else {
    console.log(`[MJ][${tag}]`);
  }
}

function mjFmtReactionForLog(r) {
  if (!r) return null;
  return {
    p: !!r.canPeng,
    g: !!r.canGang,
    h: !!r.canHu,
    pass: !!r.canPass,
    cheng: !!r.canCheng,
    aG: !!r.canAnGang,
    aGn: Array.isArray(r.anGangTypeIdxs) ? r.anGangTypeIdxs.length : 0,
  };
}

/**
 * 分享链路日志：从分享卡片进入、layout、join 等。控制台过滤 `share`。
 * 右上角「转发给好友」在选好联系人并发送后，还会额外打一条与开关无关的：
 * `[share] outgoing.appMessage`（见 onShareAppMessage 内 console.log）。
 * 不需要时改为 `false`。
 */
const SHARE_DEBUG_LOG = true;

function shareLog(tag, data) {
  if (!SHARE_DEBUG_LOG) return;
  if (data !== undefined) {
    console.log(`[share][${tag}]`, data);
  } else {
    console.log(`[share][${tag}]`);
  }
}

/** 进入参数里与分享相关的字段（避免整包 opts 刷屏） */
function pickShareSurfaceOpts(o) {
  if (!o || typeof o !== "object") return {};
  const ref = o.referrerInfo;
  let refPick = ref;
  if (ref && typeof ref === "object") {
    refPick = {
      appId: ref.appId,
      extraData: ref.extraData,
      gameEntryPoint: ref.gameEntryPoint,
    };
  }
  return {
    path: o.path,
    query: o.query,
    scene: o.scene,
    shareTicket: o.shareTicket ? "(present)" : o.shareTicket,
    referrerInfo: refPick,
  };
}

function readLayoutSystemInfo() {
  if (typeof wx === "undefined") {
    return { windowWidth: 375, windowHeight: 667, pixelRatio: 2 };
  }
  /** 基础库 2.25.3+，从分享等入口冷启动时往往比 getSystemInfoSync 更贴近真实窗口 */
  let s = {};
  if (typeof wx.getWindowInfo === "function") {
    try {
      s = { ...(wx.getWindowInfo() || {}) };
    } catch (e) {
      s = {};
    }
  }
  if (
    (!Number(s.windowWidth) || !Number(s.windowHeight)) &&
    typeof wx.getSystemInfoSync === "function"
  ) {
    s = { ...(wx.getSystemInfoSync() || {}), ...s };
  }
  let w = Number(s.windowWidth) || 0;
  let h = Number(s.windowHeight) || 0;
  const sw = Number(s.screenWidth) || 0;
  const sh = Number(s.screenHeight) || 0;
  const pr = Math.min(Math.max(Number(s.pixelRatio) || 1, 1), 3);
  if ((!w || !h) && sw > 0 && sh > 0) {
    w = Math.max(sw, sh);
    h = Math.min(sw, sh);
  } else if (sw > 0 && sh > 0 && w > 0 && h > 0) {
    const winArea = w * h;
    const scrArea = sw * sh;
    if (scrArea > 0 && winArea < scrArea * 0.52) {
      w = Math.max(sw, sh);
      h = Math.min(sw, sh);
    }
  }
  if (!w) w = 375;
  if (!h) h = 667;
  return { windowWidth: w, windowHeight: h, pixelRatio: pr };
}

/** 按当前系统信息重置画布 backing 与 ctx 缩放（逻辑坐标不变） */
function applyCanvasLayout(reason) {
  const { windowWidth, windowHeight, pixelRatio } = readLayoutSystemInfo();
  const expW = windowWidth * pixelRatio;
  const expH = windowHeight * pixelRatio;
  const unchanged =
    windowWidth === SCREEN_W &&
    windowHeight === SCREEN_H &&
    pixelRatio === CANVAS_DPR &&
    canvas.width === expW &&
    canvas.height === expH;
  if (!unchanged) {
    SCREEN_W = windowWidth;
    SCREEN_H = windowHeight;
    CANVAS_DPR = pixelRatio;
    // 从分享卡片回到前台时，部分机型需先打断再设宽高，主画布才会铺满
    if (reason === "onShow") {
      canvas.width = 0;
      canvas.height = 0;
    }
    canvas.width = SCREEN_W * CANVAS_DPR;
    canvas.height = SCREEN_H * CANVAS_DPR;
    if (
      typeof wx !== "undefined" &&
      typeof wx.getMenuButtonBoundingClientRect === "function"
    ) {
      try {
        menuButtonRect = wx.getMenuButtonBoundingClientRect();
      } catch (e) {
        // ignore
      }
    }
    shareLog("layout.apply", { reason, SCREEN_W, SCREEN_H, CANVAS_DPR });
  }
  // 小游戏运行库偶发把 CTM 重置为单位阵：backing 已是物理像素但绘制仍按逻辑坐标 → 画面挤在一角、其余黑屏
  ctx.setTransform(CANVAS_DPR, 0, 0, CANVAS_DPR, 0, 0);
  if (typeof ctx.imageSmoothingQuality === "string") {
    ctx.imageSmoothingQuality = "high";
  }
}

applyCanvasLayout("startup");

// ========================== 游戏逻辑初始化 ==========================
// 从逻辑层创建麻将游戏实例，解构核心方法和状态
const {
  game, // 全局游戏状态对象（包含玩家、手牌、弃牌、癞子等信息）
  newGame, // 初始化新游戏（重置状态、发牌）
  humanDiscardByIndex, // 玩家根据手牌索引出牌的核心方法
  setStatus, // 设置游戏状态
  handlePostDiscard, // 处理出牌后的回合/碰杠检测（logic 层暴露）
  onPeng,
  onGang,
  onPass,
  onCheng,
  endGame,
  on,
  emit,
} = createMahjongGame();

// on("new-tile-drawn", (data) => {
//   const { tileId, playerIdx, tile } = data;
//   // 只处理人类玩家的新牌动画（可根据需求调整）
//   if (playerIdx === 0) {
//     // 调用你的动画方法
//     startNewTileAnimation(tileId);
//     // 重新渲染手牌
//     drawHands(game.players[0]);
//   }
// });

// // 5. 监听“出牌”事件，停止动画
// on("tile-discarded", (data) => {
//   stopAllNewTileAnimations();
//   // 重新渲染手牌（出牌后更新界面）
//   drawHands(game.players[0]);
// });

// 启动时不自动发牌，等待后端广播 gameStart 再开局

// 存储玩家手牌的可点击区域信息（用于触摸命中检测）
// 结构：[{index: 手牌索引, left/right/top/bottom: 区域坐标}, ...]
let handSlots = [];

// let gameStatus = "";

// 当前可交互的反应按钮区域（绘制后会填充）
let reactionButtons = [];

// 绘制按钮“逞” 按钮
let chengButton = null;
// // 绘制按钮“胡” 按钮
// let huButton = null;
// 联机局末「再来一局」按钮（房主点击）
let playAgainButton = null;
// 联机按钮集合
let onlineButtons = [];
/** 底金 1/2/5/10 元选择按钮（未开局时显示） */
let baseStakeButtons = [];
const BASE_STAKE_CHOICES = [1, 2, 5, 10];
/** 大厅未建房时的默认底金；建房时传给云端 */
let lobbyPreferredBaseStake = 5;
let lobbyBaseStakeStorageLoaded = false;

function ensureLobbyBaseStakeLoaded() {
  if (lobbyBaseStakeStorageLoaded) return;
  lobbyBaseStakeStorageLoaded = true;
  if (typeof wx === "undefined") return;
  try {
    const v = Number(wx.getStorageSync(STORAGE_KEYS.LOBBY_BASE_STAKE));
    if (BASE_STAKE_CHOICES.includes(v)) lobbyPreferredBaseStake = v;
  } catch (e) {
    /* ignore */
  }
}

function persistLobbyPreferredBaseStake() {
  if (typeof wx === "undefined") return;
  try {
    wx.setStorageSync(
      STORAGE_KEYS.LOBBY_BASE_STAKE,
      String(lobbyPreferredBaseStake),
    );
  } catch (e) {
    /* ignore */
  }
}
let localSeatToRealSeat = [0, 1, 2, 3];
let realSeatToLocalSeat = { 0: 0, 1: 1, 2: 2, 3: 3 };
let playerScoreByLocal = [0, 0, 0, 0];
let playerChengByLocal = [0, 0, 0, 0];
let discardHistoryView = [];
/** 联机：最近一次 actionResult 的 seq，用于忽略比它更旧的 snapshot 覆盖（避免「该北摸却回到南」） */
let lastAppliedMjActionSeq = 0;
/** 临时调试：为 true 时根据服务端 botHandsBySeat 画电脑手牌；关闭请改 false */
const DEBUG_SHOW_BOT_HANDS = false;
/**
 * null：三家电脑都画；1/2/3：只画本地「右/上/左」一家（仅当 DEBUG_SHOW_BOT_HANDS 为 true 时有效）
 */
const DEBUG_BOT_HANDS_ONLY_LOCAL = null;
const avatarImageCache = new Map();
/** @type {Map<string, { img: any, ok: boolean, failed?: boolean, loading?: boolean }>} */
const tileImageCache = new Map();
let latestChengHint = "";
let chengCountByRealSeat = { 0: 0, 1: 0, 2: 0, 3: 0 };

function getAvatarImage(url) {
  const key = String(url || "").trim();
  if (!key || typeof wx === "undefined" || typeof wx.createImage !== "function")
    return null;
  const cached = avatarImageCache.get(key);
  if (cached) return cached.ok ? cached.img : null;
  const img = wx.createImage();
  avatarImageCache.set(key, { img, ok: false, loading: true });
  img.onload = () => {
    avatarImageCache.set(key, { img, ok: true, loading: false });
  };
  img.onerror = () => {
    avatarImageCache.set(key, { img: null, ok: false, loading: false });
  };
  img.src = key;
  return null;
}

/**
 * 本地牌面贴图 `images/tiles/{typeIdx}.jpg`；未就绪或失败时返回 null，由 drawTileFace 回退为字符。
 * @param {number} typeIdx
 * @returns {any | null}
 */
function getTileImage(typeIdx) {
  const n = Number(typeIdx);
  if (!Number.isFinite(n) || n < 0 || n >= TILE_KIND_COUNT) return null;
  if (typeof wx === "undefined" || typeof wx.createImage !== "function")
    return null;
  const key = `tile:${n}`;
  const cached = tileImageCache.get(key);
  if (cached) return cached.ok ? cached.img : null;
  const img = wx.createImage();
  tileImageCache.set(key, { img, ok: false, loading: true });
  img.onload = () => {
    tileImageCache.set(key, { img, ok: true, loading: false });
  };
  img.onerror = () => {
    tileImageCache.set(key, {
      img: null,
      ok: false,
      failed: true,
      loading: false,
    });
  };
  img.src = `images/tiles/${n}.jpg`;
  return null;
}

/** 退出房间后回到大厅：清空牌局渲染态，避免残留弃牌/顶果/癞子 */
function resetGameViewToLobby() {
  clearStatusStaggerTimer();
  clearReactionStaggerTimer();
  reactionButtons = [];
  chengButton = null;
  playAgainButton = null;
  handSlots = [];
  newTileIds.clear();
  if (drawFlashState.timer) {
    clearInterval(drawFlashState.timer);
    drawFlashState.timer = null;
  }
  drawFlashState.tileId = null;
  drawFlashState.visible = false;
  drawFlashState.togglesLeft = 0;
  lastAppliedMjActionSeq = 0;

  game.players = [0, 1, 2, 3].map((i) => ({
    name: i === 0 ? "你" : `玩家${i + 1}`,
    uid: "",
    seat: i,
    isHuman: i === 0,
    hand: [],
    discards: [],
    melds: [],
  }));
  game.current = 0;
  game.phase = "idle";
  game.busy = false;
  game.status = "房间大厅，请先建房或入房";
  game.dingGuoTypeIdx = null;
  game.laiziTypeIdx = null;
  game.lastDiscard = null;
  game.reaction = null;
  game.lastDrawTileId = null;
  game.winner = null;
  game.huTypeLabel = "";
  game.score = 0;
  game.chengTimes = 0;
  game.justChengThenDraw = false;
  game.canCheng = false;
  game.canHu = false;
  game.wall = [];
  game.winnerExposeHand = null;
  latestChengHint = "";
  chengCountByRealSeat = { 0: 0, 1: 0, 2: 0, 3: 0 };
  discardHistoryView = [];
  playerScoreByLocal = [0, 0, 0, 0];
  playerChengByLocal = [0, 0, 0, 0];
}

// 联机客户端（默认连接本机后端，真机调试时改为局域网 IP）
const multiplayer = createMultiplayerClient({
  wsUrl: "ws://192.168.97.156:3100",
  // 云开发迁移第一阶段：大厅链路改走云函数
  transport: "cloud",
  cloudFunctionName: "roomGateway",
});
const STORAGE_KEYS = {
  PROFILE_READY: "mj_profile_ready_v1",
  NICKNAME: "mj_profile_nickname_v1",
  AVATAR_URL: "mj_profile_avatar_url_v1",
  PENDING_SHARE_ROOM_NO: "mj_pending_share_room_no_v1",
  LOBBY_BASE_STAKE: "mj_lobby_base_stake_v1",
};
// 云开发环境 ID：已配置为当前项目环境
const CLOUD_ENV_ID = "cloudbase-d0gfk99lqc571db35";
let profileReady = false;
let connectingStarted = false;
let pendingJoinRoomNo = "";
let pendingJoinInFlight = false;
let pendingJoinTryAt = 0;
let startGameEntryButton = null;
let profileAuthInFlight = false;
let profileAuthWatchdogTimer = null;

function clearProfileAuthWatchdog() {
  if (profileAuthWatchdogTimer) {
    clearTimeout(profileAuthWatchdogTimer);
    profileAuthWatchdogTimer = null;
  }
}

/** 读取本地缓存字符串并做 trim，失败时返回空串 */
function readStorageString(key) {
  if (typeof wx === "undefined") return "";
  try {
    return String(wx.getStorageSync(key) || "").trim();
  } catch (err) {
    return "";
  }
}

/** 写入本地缓存字符串，失败时静默处理 */
function writeStorageString(key, value) {
  if (typeof wx === "undefined") return;
  try {
    wx.setStorageSync(key, String(value || ""));
  } catch (err) {
    // ignore
  }
}

/** 先完成隐私授权（若基础库支持），成功后再执行后续能力调用 */
function ensurePrivacyAuthorized(next) {
  if (typeof next !== "function") return;
  if (typeof wx === "undefined") {
    next();
    return;
  }
  if (typeof wx.requirePrivacyAuthorize !== "function") {
    next();
    return;
  }
  wx.requirePrivacyAuthorize({
    success: () => next(),
    fail: (err) => {
      const msg = String(err?.errMsg || "");
      console.log("[auth] requirePrivacyAuthorize fail", err);
      if (msg.includes("auth deny") || msg.includes("cancel")) {
        setStatus("你取消了隐私授权，请再次点击开始");
      } else if (
        msg.includes("click action before resolve is needed") ||
        String(err?.error || "") === "104"
      ) {
        setStatus("隐私授权未完成，请重启小游戏后重试");
      } else {
        setStatus("隐私授权失败，请稍后重试");
      }
    },
  });
}

/** 首次进入：引导授权头像昵称，成功后再开始联机流程 */
function requestProfileAndStart() {
  if (profileReady) {
    console.log("[auth] skip: profileReady already true");
    setStatus("已授权，无需重复操作");
    return;
  }
  if (typeof wx === "undefined") {
    console.log("[auth] skip: wx undefined");
    setStatus("当前环境不支持微信授权");
    return;
  }
  if (profileAuthInFlight) {
    setStatus("授权处理中，请稍候或再点一次开始");
    return;
  }
  profileAuthInFlight = true;
  console.log("[auth] begin request profile");
  setStatus("正在请求授权...");
  clearProfileAuthWatchdog();
  profileAuthWatchdogTimer = setTimeout(() => {
    profileAuthInFlight = false;
    profileAuthWatchdogTimer = null;
    setStatus("授权流程无响应，请再次点击开始");
  }, 8000);
  const onProfile = (userInfo) => {
    try {
      const nick = String(userInfo?.nickName || "").trim() || "微信玩家";
      const avatarUrl = String(userInfo?.avatarUrl || "").trim();
      console.log("[auth] success", {
        nick,
        hasAvatar: !!avatarUrl,
      });
      profileReady = true;
      writeStorageString(STORAGE_KEYS.PROFILE_READY, "1");
      writeStorageString(STORAGE_KEYS.NICKNAME, nick);
      writeStorageString(STORAGE_KEYS.AVATAR_URL, avatarUrl);
      multiplayer.setPreferredNickname(nick);
      if (typeof multiplayer.setPreferredAvatar === "function") {
        multiplayer.setPreferredAvatar(avatarUrl);
      }
      refreshPendingJoinFromRuntime();
      clearProfileAuthWatchdog();
      profileAuthInFlight = false;
      setStatus(`欢迎你，${nick}`);
      ensureConnected();
    } catch (err) {
      console.log("[auth] success-handler error", err);
      profileReady = false;
      clearProfileAuthWatchdog();
      profileAuthInFlight = false;
      setStatus("授权成功，但初始化失败，请重试");
    }
  };
  if (typeof wx.getUserProfile === "function") {
    setStatus("正在请求隐私授权...");
    ensurePrivacyAuthorized(() => {
      setStatus("隐私已确认，等待头像昵称授权...");
      console.log("[auth] call wx.getUserProfile");
      wx.getUserProfile({
        desc: "用于展示你的头像和昵称",
        success: (res) => onProfile(res?.userInfo || {}),
        fail: (err) => {
          const msg = String(err?.errMsg || "unknown");
          console.log("[auth] getUserProfile fail", err);
          clearProfileAuthWatchdog();
          profileAuthInFlight = false;
          if (msg.includes("auth deny") || msg.includes("cancel")) {
            setStatus("你取消了授权，请再次点击按钮");
          } else if (msg.includes("can only be invoked by user TAP gesture")) {
            setStatus("授权失败：请直接单击按钮（不要滑动）");
          } else if (
            msg.includes("please go to mp open official popup") ||
            msg.includes("wx.onNeedPrivacyAuthorization") ||
            msg.includes("errno: 1026")
          ) {
            setStatus("请先同意隐私协议后再授权头像昵称");
          } else {
            setStatus(`授权失败：${msg}`);
          }
        },
      });
    });
    return;
  }
  if (typeof wx.getUserInfo === "function") {
    console.log("[auth] fallback call wx.getUserInfo");
    wx.getUserInfo({
      success: (res) => onProfile(res?.userInfo || {}),
      fail: (err) => {
        const msg = String(err?.errMsg || "unknown");
        console.log("[auth] getUserInfo fail", err);
        clearProfileAuthWatchdog();
        profileAuthInFlight = false;
        setStatus(`获取用户信息失败：${msg}`);
      },
    });
    return;
  }
  console.log("[auth] no user profile api available");
  clearProfileAuthWatchdog();
  profileAuthInFlight = false;
  setStatus("当前微信版本不支持获取头像昵称");
}

/** 从启动参数中提取待自动加入的房号（query/scene 都兼容） */
function extractPendingJoinFromLaunch() {
  if (typeof wx === "undefined") return;
  try {
    const launchOpts =
      typeof wx.getLaunchOptionsSync === "function"
        ? wx.getLaunchOptionsSync() || {}
        : {};
    const enterOpts =
      typeof wx.getEnterOptionsSync === "function"
        ? wx.getEnterOptionsSync() || {}
        : {};
    const opts = {
      query: {
        ...asQueryRecord(launchOpts.query),
        ...asQueryRecord(enterOpts.query),
      },
      path: String(enterOpts.path || launchOpts.path || "").trim(),
      scene: enterOpts.scene || launchOpts.scene || "",
    };
    const roomNo = getRoomNoFromEnterOptions(opts);
    shareLog("entry.coldStart", {
      launch: pickShareSurfaceOpts(launchOpts),
      enter: pickShareSurfaceOpts(enterOpts),
      mergedQuery: opts.query,
      mergedPath: opts.path,
      mergedScene: opts.scene,
      parsedRoomNo: roomNo || null,
    });
    if (roomNo) prepareJoinSharedRoom(roomNo);
  } catch (err) {
    shareLog(
      "entry.coldStart.error",
      String(err && err.message ? err.message : err),
    );
  }
}

/** 运行中再次刷新一次分享房号（用于授权后回流场景） */
function refreshPendingJoinFromRuntime() {
  if (typeof wx === "undefined") return;
  try {
    const enterOpts =
      typeof wx.getEnterOptionsSync === "function"
        ? wx.getEnterOptionsSync() || {}
        : {};
    const launchOpts =
      typeof wx.getLaunchOptionsSync === "function"
        ? wx.getLaunchOptionsSync() || {}
        : {};
    const opts = {
      query: {
        ...asQueryRecord(launchOpts.query),
        ...asQueryRecord(enterOpts.query),
      },
      path: String(enterOpts.path || launchOpts.path || "").trim(),
      scene: enterOpts.scene || launchOpts.scene || "",
    };
    const roomNo = getRoomNoFromEnterOptions(opts);
    shareLog("entry.runtimeRefresh", {
      launch: pickShareSurfaceOpts(launchOpts),
      enter: pickShareSurfaceOpts(enterOpts),
      mergedQuery: opts.query,
      mergedPath: opts.path,
      mergedScene: opts.scene,
      parsedRoomNo: roomNo || null,
    });
    if (roomNo) prepareJoinSharedRoom(roomNo);
  } catch (err) {
    shareLog(
      "entry.runtimeRefresh.error",
      String(err && err.message ? err.message : err),
    );
  }
}

/** 从 scene 字符串中解析 roomNo 参数 */
function parseRoomNoFromScene(sceneValue) {
  const raw = String(sceneValue || "").trim();
  if (!raw) return "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (err) {
    // keep raw
  }
  const m = decoded.match(/(?:^|[?&])roomNo=([^&]+)/i);
  if (m && m[1]) return String(m[1]).trim();
  if (/^\d{6,8}$/.test(decoded)) return decoded;
  return "";
}

/** 从 querystring/path 中解析 roomNo（兼容 roomNo/roomno） */
function parseRoomNoFromQueryString(rawQuery) {
  const qs = String(rawQuery || "")
    .trim()
    .replace(/^\?/, "");
  if (!qs) return "";
  const m =
    qs.match(/(?:^|&)roomNo=([^&]+)/i) || qs.match(/(?:^|&)roomno=([^&]+)/i);
  if (!m || !m[1]) return "";
  try {
    return String(decodeURIComponent(m[1])).trim();
  } catch (err) {
    return String(m[1]).trim();
  }
}

/**
 * 将 onShow / getLaunchOptionsSync 里的 query 转为对象。
 * 部分场景下 query 为字符串 `roomNo=xx&from=share`，直接展开到对象会出错。
 */
function asQueryRecord(raw) {
  if (raw == null) return {};
  // 浅拷贝，避免与 pickShareSurfaceOpts(res).query 同一引用导致 vConsole 报 <Circular>
  if (typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  if (typeof raw !== "string") return {};
  const out = {};
  const s = String(raw).trim().replace(/^\?/, "");
  if (!s) return out;
  for (const part of s.split("&")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    let k = part.slice(0, i);
    let v = part.slice(i + 1);
    try {
      k = decodeURIComponent(k);
      v = decodeURIComponent(v.replace(/\+/g, " "));
    } catch (e) {
      // 保留原始子串
    }
    out[k] = v;
  }
  return out;
}

/** 统一从进入参数提取 roomNo（query/scene/path/referrerInfo.extraData 全兼容） */
function getRoomNoFromEnterOptions(opts = {}) {
  const q = asQueryRecord(opts.query);
  const byQuery = String(q.roomNo || q.roomno || "").trim();
  if (byQuery) return byQuery;
  const byScene = parseRoomNoFromScene(opts.scene);
  if (byScene) return byScene;
  const path = String(opts.path || "").trim();
  const idx = path.indexOf("?");
  if (idx >= 0) {
    const byPath = parseRoomNoFromQueryString(path.slice(idx + 1));
    if (byPath) return byPath;
  }
  const ref = opts.referrerInfo;
  if (ref && typeof ref === "object") {
    const ex = ref.extraData;
    if (ex && typeof ex === "object") {
      const n = String(ex.roomNo || ex.roomno || "").trim();
      if (n) return n;
    }
  }
  return "";
}

/**
 * 从分享卡片进房时，房号可能在 onShow 的 res 里，也可能只在 getEnterOptionsSync / getLaunchOptionsSync 中。
 * 合并后再解析，避免 parsedRoomNo 一直为 null。
 */
function buildMergedEnterOptsFromShow(surfaceRes) {
  const launch =
    typeof wx !== "undefined" && typeof wx.getLaunchOptionsSync === "function"
      ? wx.getLaunchOptionsSync() || {}
      : {};
  const enter =
    typeof wx !== "undefined" && typeof wx.getEnterOptionsSync === "function"
      ? wx.getEnterOptionsSync() || {}
      : {};
  const r = surfaceRes || {};
  const query = {
    ...asQueryRecord(launch.query),
    ...asQueryRecord(enter.query),
    ...asQueryRecord(r.query),
  };
  const path = String(r.path || enter.path || launch.path || "").trim();
  const pickScene = (a, b, c) => {
    const xs = [a, b, c];
    for (const x of xs) {
      if (x !== undefined && x !== null && x !== "") return x;
    }
    return "";
  };
  const scene = pickScene(r.scene, enter.scene, launch.scene);
  const referrerInfo =
    r.referrerInfo || enter.referrerInfo || launch.referrerInfo;
  return { query, path, scene, referrerInfo };
}

/** 从分享/scene 带房号进入时，优先该房间，避免先重连本地旧房 */
function prepareJoinSharedRoom(roomNo) {
  const no = String(roomNo || "").trim();
  if (!no) return;
  shareLog("join.prepare", { roomNo: no });
  pendingJoinRoomNo = no;
  pendingJoinInFlight = false;
  pendingJoinTryAt = 0;
  writeStorageString(STORAGE_KEYS.PENDING_SHARE_ROOM_NO, no);
  if (typeof wx !== "undefined") {
    try {
      wx.removeStorageSync("mj_roomId");
    } catch (err) {
      // ignore
    }
  }
}

/** 初始化微信云开发 SDK（绑定 env 与 traceUser） */
function initCloud() {
  if (
    typeof wx === "undefined" ||
    !wx.cloud ||
    typeof wx.cloud.init !== "function"
  )
    return;
  try {
    const cfg = { traceUser: true };
    if (CLOUD_ENV_ID) cfg.env = CLOUD_ENV_ID;
    wx.cloud.init(cfg);
  } catch (err) {
    // ignore
  }
}

/** 保证只触发一次联机连接，避免重复 connect */
function ensureConnected() {
  if (connectingStarted) return;
  connectingStarted = true;
  multiplayer.connect();
}

/** 尝试自动加入分享带入的房间，含节流与重试保护 */
function tryAutoJoinPendingRoom() {
  if (!pendingJoinRoomNo) return;
  if (multiplayer.state.lastErrorCode === "E_ROOM_ALREADY_STARTED") {
    writeStorageString(STORAGE_KEYS.PENDING_SHARE_ROOM_NO, "");
    pendingJoinRoomNo = "";
    pendingJoinInFlight = false;
    return;
  }
  if (!multiplayer.state.uid) return;
  const currentNo = String(multiplayer.state.roomNo || "").trim();
  if (currentNo && currentNo === pendingJoinRoomNo) {
    writeStorageString(STORAGE_KEYS.PENDING_SHARE_ROOM_NO, "");
    pendingJoinRoomNo = "";
    pendingJoinInFlight = false;
    return;
  }
  const now = Date.now();
  if (pendingJoinInFlight && now - pendingJoinTryAt < 1800) return;
  shareLog("join.autoJoin", {
    roomNo: pendingJoinRoomNo,
    uid: multiplayer.state.uid,
    currentRoomNo: multiplayer.state.roomNo,
  });
  multiplayer.joinRoom(pendingJoinRoomNo);
  pendingJoinInFlight = true;
  pendingJoinTryAt = now;
  setStatus(`正在加入房间 ${pendingJoinRoomNo}...`);
}

/** 初始化进入流程：云能力、昵称、分享参数、onShow 回流处理 */
function initEntryFlow() {
  initCloud();
  const storedNick = readStorageString(STORAGE_KEYS.NICKNAME);
  const storedAvatar = readStorageString(STORAGE_KEYS.AVATAR_URL);
  const readyFlag = readStorageString(STORAGE_KEYS.PROFILE_READY) === "1";
  // 必须同时具备昵称+头像才视为已完成授权，防止旧缓存误判
  profileReady = !!(readyFlag && storedNick && storedAvatar);
  if (!profileReady) {
    writeStorageString(STORAGE_KEYS.PROFILE_READY, "");
  }
  if (storedNick) {
    multiplayer.setPreferredNickname(storedNick);
  }
  if (storedAvatar) {
    if (typeof multiplayer.setPreferredAvatar === "function") {
      multiplayer.setPreferredAvatar(storedAvatar);
    }
  }
  const pendingNo = readStorageString(STORAGE_KEYS.PENDING_SHARE_ROOM_NO);
  if (pendingNo) {
    pendingJoinRoomNo = pendingNo;
  }
  extractPendingJoinFromLaunch();
  if (typeof wx !== "undefined" && typeof wx.onShow === "function") {
    wx.onShow((res) => {
      applyCanvasLayout("onShow");
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          applyCanvasLayout("onShow-raf1");
          requestAnimationFrame(() => applyCanvasLayout("onShow-raf2"));
        });
      }
      const merged = buildMergedEnterOptsFromShow(res || {});
      const roomNo = getRoomNoFromEnterOptions(merged);
      shareLog("entry.onShow", {
        surface: pickShareSurfaceOpts(res || {}),
        mergedQueryKeys: Object.keys(merged.query || {}),
        mergedQuery: merged.query,
        mergedPath: merged.path || null,
        mergedScene:
          merged.scene !== "" && merged.scene !== undefined
            ? merged.scene
            : null,
        parsedRoomNo: roomNo || null,
      });
      if (roomNo) prepareJoinSharedRoom(roomNo);
      if (profileReady) {
        ensureConnected();
      }
    });
  }
  if (profileReady) {
    ensureConnected();
  } else {
    setStatus("首次进入请点击按钮授权头像昵称");
  }
}

initEntryFlow();

if (typeof wx !== "undefined" && typeof wx.onWindowResize === "function") {
  wx.onWindowResize(() => applyCanvasLayout("windowResize"));
}
if (typeof wx !== "undefined" && typeof setTimeout === "function") {
  setTimeout(() => applyCanvasLayout("deferred-0ms"), 0);
  setTimeout(() => applyCanvasLayout("deferred-200ms"), 200);
}

/** 启动时打一条，确认分享 API 是否挂上（与 SHARE_DEBUG_LOG 无关） */
if (typeof wx !== "undefined") {
  console.log("[share] api", {
    showShareMenu: typeof wx.showShareMenu === "function",
    onShareAppMessage: typeof wx.onShareAppMessage === "function",
    onShareTimeline: typeof wx.onShareTimeline === "function",
  });
}

/** 组装分享标题与 query（携带 roomNo 用于好友点开自动入房） */
function buildSharePayload() {
  const roomNo = String(multiplayer.state.roomNo || "").trim();
  const inviter = String(multiplayer.state.preferredNickname || "").trim();
  let title;
  let query;
  if (roomNo) {
    title = inviter
      ? `${inviter} 邀你打荆州麻将（房号 ${roomNo}）`
      : `荆州麻将 · 房号 ${roomNo}`;
    query = `roomNo=${encodeURIComponent(roomNo)}&from=share`;
  } else {
    title = inviter ? `${inviter} 邀你打荆州麻将` : "荆州麻将 · 逞癞子";
    query = "";
  }
  shareLog("payload.build", {
    title,
    query,
    roomNo: roomNo || null,
    inviter: inviter || null,
  });
  return { title, query };
}

let shareListenersRegistered = false;

/**
 * 注册被动分享监听，再打开右上角分享菜单。
 * 注意：showShareMenu 的 menus 参数在官方文档为 Beta 且「暂只在 Android 支持」，在 iOS 上可能导致不触发 onShareAppMessage，故此处不传 menus。
 */
function registerShareListeners() {
  if (typeof wx === "undefined" || shareListenersRegistered) return;
  shareListenersRegistered = true;
  if (typeof wx.onShareAppMessage === "function") {
    wx.onShareAppMessage((res) => {
      try {
        console.log("[share] onShareAppMessage.callback", res);
        const payload = buildSharePayload();
        console.log("[share] outgoing.appMessage", {
          title: payload.title,
          query: payload.query,
        });
        shareLog("outgoing.appMessage", {
          title: payload.title,
          query: payload.query,
        });
        return {
          title: payload.title,
          query: payload.query,
        };
      } catch (err) {
        console.error("[share] onShareAppMessage build error", err);
        return { title: "荆州麻将 · 逞癞子", query: "" };
      }
    });
  } else {
    console.warn(
      "[share] wx.onShareAppMessage 不存在，无法监听转发（请查基础库与后台「分享给朋友」能力）",
    );
  }
  if (typeof wx.onShareTimeline === "function") {
    wx.onShareTimeline((res) => {
      try {
        console.log("[share] onShareTimeline.callback", res);
        const payload = buildSharePayload();
        console.log("[share] outgoing.timeline", {
          title: payload.title,
          query: payload.query,
        });
        shareLog("outgoing.timeline", {
          title: payload.title,
          query: payload.query,
        });
        return { title: payload.title, query: payload.query };
      } catch (err) {
        console.error("[share] onShareTimeline build error", err);
        return { title: "荆州麻将 · 逞癞子", query: "" };
      }
    });
  }
}

registerShareListeners();

if (typeof wx !== "undefined" && typeof wx.showShareMenu === "function") {
  wx.showShareMenu({
    withShareTicket: false,
    success() {
      console.log("[share] showShareMenu success");
    },
    fail(err) {
      console.warn("[share] showShareMenu fail", err);
    },
  });
}

/** 生成并展示房间二维码（历史保留逻辑，当前 UI 不再入口调用） */
function openRoomQrFor(roomNo) {
  const no = String(roomNo || "").trim();
  if (!no) return;
  setStatus("正在生成房间二维码...");
  multiplayer
    .fetchRoomQr(no)
    .then((data) => {
      const qrUrl = data?.qrImageUrl;
      const inviteUrl = data?.inviteUrl || "";
      const mode = data?.mode || "invite";
      if (
        typeof wx !== "undefined" &&
        qrUrl &&
        typeof wx.previewImage === "function"
      ) {
        wx.previewImage({
          current: qrUrl,
          urls: [qrUrl],
        });
      }
      if (
        typeof wx !== "undefined" &&
        typeof wx.setClipboardData === "function" &&
        inviteUrl
      ) {
        wx.setClipboardData({ data: inviteUrl });
      }
      if (mode === "room_no_only") {
        setStatus(`房号码已生成（房号 ${no}，扫码后手动输入）`);
      } else {
        setStatus(`房码已生成（房号 ${no}）`);
      }
    })
    .catch(() => {
      setStatus("生成房码失败，请检查服务与网络");
    });
}

/** 从后端结算载荷同步“我的分数变化”到本地 UI */
function syncScoreFromSettlementPayload(payload) {
  if (typeof payload.selfScoreDelta === "number") {
    game.score = payload.selfScoreDelta;
    return;
  }
  const uid = multiplayer.state.uid;
  if (
    uid &&
    payload.scoreDeltaByUid &&
    typeof payload.scoreDeltaByUid[uid] === "number"
  ) {
    game.score = payload.scoreDeltaByUid[uid];
  }
}

/** 同步四家「逞次数/分数」到本地可视态（按本地座位顺序） */
function syncAllPlayersStatsFromPayload(payload) {
  if (!payload) return;
  if (payload.chengCountBySeat) {
    for (const localIdx of [0, 1, 2, 3]) {
      const realSeat = localSeatToRealSeat[localIdx];
      const v = Number(payload.chengCountBySeat?.[realSeat]);
      playerChengByLocal[localIdx] = Number.isFinite(v) ? v : 0;
    }
  } else if (typeof payload.selfChengCount === "number") {
    playerChengByLocal[0] = Number(payload.selfChengCount) || 0;
  }
  if (payload.scoreDeltaByUid) {
    const scoreMap = payload.scoreDeltaByUid;
    for (const localIdx of [0, 1, 2, 3]) {
      const uid = game.players?.[localIdx]?.uid || "";
      if (uid && typeof scoreMap[uid] === "number") {
        playerScoreByLocal[localIdx] = scoreMap[uid];
      }
    }
  } else if (typeof payload.selfScoreDelta === "number") {
    playerScoreByLocal[0] = payload.selfScoreDelta;
  }
}

/** 从服务端 status 中解析「胡牌（类型）」括号内文案（快照常不带 huSettlement） */
function parseHuTypeLabelFromStatus(statusStr) {
  const m = String(statusStr || "").match(/胡牌[（(]([^）)]+)[）)]/);
  return m && m[1] ? String(m[1]).trim() : "";
}

function resolveHuTypeLabelFromPayload(payload) {
  const direct = String(payload?.huSettlement?.label || "").trim();
  if (direct) return direct;
  return parseHuTypeLabelFromStatus(payload?.status);
}

function cloneTileListForView(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => ({
    id: Number(t.id),
    typeIdx: Number(t.typeIdx),
  }));
}

/** 将服务端下发的机器人手牌写入本地座位（不含自己） */
function syncBotHandsFromPayload(payload) {
  if (!DEBUG_SHOW_BOT_HANDS) return;
  const bh = payload && payload.botHandsBySeat;
  if (!bh || typeof bh !== "object" || !Array.isArray(game.players)) return;
  for (let localIdx = 1; localIdx <= 3; localIdx += 1) {
    const pl = game.players[localIdx];
    if (!pl) continue;
    if (
      DEBUG_BOT_HANDS_ONLY_LOCAL != null &&
      localIdx !== DEBUG_BOT_HANDS_ONLY_LOCAL
    ) {
      pl.hand = [];
      continue;
    }
    const rs = localSeatToRealSeat[localIdx];
    const arr = bh[rs];
    pl.hand = Array.isArray(arr) ? cloneTileListForView(arr) : [];
  }
}

/**
 * 使用后端下发的 gameStart 数据初始化本地渲染态
 */
function applyServerGameStart(payload) {
  const seats = Array.isArray(payload?.players) ? payload.players : [];
  const hand = Array.isArray(payload?.hand) ? payload.hand : [];
  const mySeat =
    Number.isInteger(multiplayer.state.seat) &&
    multiplayer.state.seat >= 0 &&
    multiplayer.state.seat <= 3
      ? multiplayer.state.seat
      : 0;

  const seatToUid = {};
  for (const p of seats) {
    seatToUid[p.seat] = p.uid;
  }
  const roomPlayers = multiplayer.state.roomState?.players || [];
  const uidToNick = {};
  for (const p of roomPlayers) {
    uidToNick[p.uid] = p.nickname || p.uid;
  }

  // 把“自己座位”旋转到本地索引0，保持现有渲染/交互代码可复用
  localSeatToRealSeat = [0, 1, 2, 3].map((i) => (mySeat + i) % 4);
  realSeatToLocalSeat = {};
  for (let i = 0; i < localSeatToRealSeat.length; i++) {
    realSeatToLocalSeat[localSeatToRealSeat[i]] = i;
  }
  game.players = [0, 1, 2, 3].map((localIdx) => {
    const realSeat = localSeatToRealSeat[localIdx];
    const uid = seatToUid[realSeat] || "";
    return {
      name: uid ? uidToNick[uid] || uid : `座位${realSeat}`,
      uid,
      seat: realSeat,
      isHuman: localIdx === 0,
      hand: localIdx === 0 ? hand.slice() : [],
      discards: [],
      melds: [],
    };
  });
  game.current = Number.isInteger(realSeatToLocalSeat[payload?.currentSeat])
    ? realSeatToLocalSeat[payload.currentSeat]
    : 0;
  game.winnerExposeHand = null;
  if (
    Array.isArray(payload?.winnerExposeHand) &&
    payload.winnerExposeHand.length > 0
  ) {
    game.winnerExposeHand = cloneTileListForView(payload.winnerExposeHand);
  }
  const startSeq = Number(payload?.seq || 0);
  if (startSeq > 0) {
    lastAppliedMjActionSeq = Math.max(lastAppliedMjActionSeq, startSeq);
  }
  game.phase =
    payload?.phase === "gameover" ? "gameover" : payload?.phase || "discard";
  game.busy = false;
  game.status = payload?.status || "后端发牌完成，请庄家先出牌";
  game.dingGuoTypeIdx = payload?.dingGuoTypeIdx ?? null;
  game.laiziTypeIdx = payload?.laiziTypeIdx ?? null;
  game.lastDiscard = null;
  game.reaction = null;
  game.lastDrawTileId = hand.length > 0 ? hand[hand.length - 1].id : null;
  game.score = 0;
  syncScoreFromSettlementPayload(payload);
  playerScoreByLocal = [0, 0, 0, 0];
  playerChengByLocal = [0, 0, 0, 0];
  syncAllPlayersStatsFromPayload(payload);
  game.chengTimes = 0;
  game.justChengThenDraw = false;
  game.canCheng = hand.some((t) => t.typeIdx === game.laiziTypeIdx);
  game.canHu = false;
  game.wall = new Array(Number(payload?.wallCount || 0)).fill({
    id: 0,
    typeIdx: 0,
  });

  if (payload.discardsBySeat) {
    for (const localIdx of [0, 1, 2, 3]) {
      const realSeat = localSeatToRealSeat[localIdx];
      const arr = payload.discardsBySeat[realSeat] || [];
      if (game.players[localIdx]) {
        game.players[localIdx].discards = arr.slice();
      }
    }
  }
  if (Array.isArray(payload.discardHistory)) {
    discardHistoryView = payload.discardHistory.slice();
  } else {
    discardHistoryView = [];
  }
  if (payload.meldsBySeat) {
    for (const localIdx of [0, 1, 2, 3]) {
      const realSeat = localSeatToRealSeat[localIdx];
      const arr = payload.meldsBySeat[realSeat] || [];
      if (game.players[localIdx]) {
        game.players[localIdx].melds = arr.slice();
      }
    }
  }

  if (game.phase === "gameover") {
    if (payload?.winnerSeat != null && payload.winnerSeat >= 0) {
      const wl = realSeatToLocalSeat[payload.winnerSeat];
      game.winner = Number.isInteger(wl) ? wl : 0;
      game.huTypeLabel = resolveHuTypeLabelFromPayload(payload);
    } else {
      game.winner = -1;
      game.huTypeLabel = "";
    }
  } else {
    game.winner = null;
    game.huTypeLabel = "";
  }
  latestChengHint = "";
  chengCountByRealSeat = {
    ...(payload?.chengCountBySeat || { 0: 0, 1: 0, 2: 0, 3: 0 }),
  };

  syncBotHandsFromPayload(payload);
}

/**
 * 碰/杠响应阶段：提示「谁打了哪张牌」（不再用笼统的「请选择碰杠过」）
 */
function formatReactDiscardHint(payload) {
  const tile =
    payload.reaction?.tile ||
    payload.reactionTile ||
    payload.discardTile ||
    null;
  const fromSeat =
    payload.reaction?.fromSeat != null
      ? payload.reaction.fromSeat
      : payload.reactionFromSeat;
  const fromLocal =
    fromSeat != null && Number.isInteger(realSeatToLocalSeat[fromSeat])
      ? realSeatToLocalSeat[fromSeat]
      : null;
  const fromName =
    fromLocal != null && game.players[fromLocal]
      ? game.players[fromLocal].name
      : fromSeat != null
        ? `座位${fromSeat}`
        : "上家";
  const tName =
    tile && typeof tile.typeIdx === "number" ? tileName(tile.typeIdx) : "牌";
  return `${fromName} 打出 ${tName}`;
}

multiplayer.on("gameStart", (payload) => {
  // 新局 seq 从 1 起计；若保留上一局的 lastApplied，会导致后续 applyGameSnapshot 误判过期而整局不同步
  lastAppliedMjActionSeq = 0;
  applyServerGameStart(payload);
  game.reaction = payload?.reactionForSelf || null;
  game.canHu = !!game.reaction?.canHu;
  game.canCheng = !!game.reaction?.canCheng;
  const dealerRealSeat = Number(payload?.dealerSeat ?? 0);
  const dealerLocalSeat = realSeatToLocalSeat[dealerRealSeat];
  const dealerName =
    Number.isInteger(dealerLocalSeat) && game.players[dealerLocalSeat]
      ? game.players[dealerLocalSeat].name
      : `座位${dealerRealSeat}`;
  const mySeat = multiplayer.state.seat;
  if (Number.isInteger(mySeat) && mySeat >= 0 && mySeat === dealerRealSeat) {
    setStatus("你是庄家，等你出牌");
  } else {
    setStatus(`${dealerName}是庄家，等${dealerName}出牌`);
  }
});

function applyServerActionResult(payload) {
  clearStatusStaggerTimer();
  clearReactionStaggerTimer();
  const arSeq = Number(payload?.seq || 0);
  if (arSeq > 0) {
    lastAppliedMjActionSeq = Math.max(lastAppliedMjActionSeq, arSeq);
  }
  const actorLocal = realSeatToLocalSeat[payload.actorSeat];
  const nextLocal = realSeatToLocalSeat[payload.nextSeat];

  // 游戏结束：优先处理，避免被 reactionForSelf / 摸牌提示覆盖
  if (payload.phase === "gameover") {
    if (Array.isArray(payload.selfHand) && game.players[0]) {
      game.players[0].hand = payload.selfHand.slice();
    }
    syncBotHandsFromPayload(payload);
    game.phase = "gameover";
    game.reaction = null;
    game.busy = false;
    syncScoreFromSettlementPayload(payload);
    if (payload.winnerSeat != null && payload.winnerSeat >= 0) {
      const wl = realSeatToLocalSeat[payload.winnerSeat];
      game.winner = Number.isInteger(wl) ? wl : 0;
      game.winnerExposeHand = null;
      if (
        Array.isArray(payload.winnerExposeHand) &&
        payload.winnerExposeHand.length > 0
      ) {
        game.winnerExposeHand = cloneTileListForView(payload.winnerExposeHand);
      }
      const name =
        game.players[game.winner]?.name || `座位${payload.winnerSeat}`;
      const huLabel =
        String(payload.huSettlement?.label || "").trim() ||
        parseHuTypeLabelFromStatus(payload.status);
      game.huTypeLabel = huLabel;
      game.status = huLabel
        ? `${name} 胡牌（${huLabel}），本局结束`
        : `${name} 胡牌，本局结束`;
      setStatus(game.status);
    } else {
      game.winner = -1;
      game.huTypeLabel = "";
      game.status = payload.status || "流局";
      setStatus(game.status);
    }
    mjLog("actionResult", {
      end: "gameover",
      winnerSeat: payload.winnerSeat,
      code: payload.code,
    });
    return;
  }
  if (String(payload?.status || "").includes("逞")) {
    latestChengHint = String(payload.status || "").replace("，请出牌", "");
  }
  if (
    payload?.chengCountBySeat &&
    typeof payload.chengCountBySeat === "object"
  ) {
    chengCountByRealSeat = { ...payload.chengCountBySeat };
  }

  // 同步自己的最新手牌（后端权威）
  if (Array.isArray(payload.selfHand) && game.players[0]) {
    game.players[0].hand = payload.selfHand.slice();
  }
  syncBotHandsFromPayload(payload);

  // 同步各座位弃牌
  if (payload.discardsBySeat) {
    for (const localIdx of [0, 1, 2, 3]) {
      const realSeat = localSeatToRealSeat[localIdx];
      const arr = payload.discardsBySeat[realSeat] || [];
      if (game.players[localIdx]) {
        game.players[localIdx].discards = arr.slice();
      }
    }
  } else if (
    Number.isInteger(actorLocal) &&
    game.players[actorLocal] &&
    payload.discardTile
  ) {
    game.players[actorLocal].discards.push(payload.discardTile);
  }
  if (Array.isArray(payload.discardHistory)) {
    discardHistoryView = payload.discardHistory.slice();
  } else if (payload.discardTile && Number.isInteger(payload.actorSeat)) {
    discardHistoryView.push({
      seat: payload.actorSeat,
      tile: payload.discardTile,
    });
  }

  if (payload.meldsBySeat) {
    for (const localIdx of [0, 1, 2, 3]) {
      const realSeat = localSeatToRealSeat[localIdx];
      const arr = payload.meldsBySeat[realSeat] || [];
      if (game.players[localIdx]) {
        game.players[localIdx].melds = arr.slice();
      }
    }
  }

  if (Number.isInteger(nextLocal)) {
    game.current = nextLocal;
  }
  game.phase = payload.phase || "discard";

  const myRealSeat = localSeatToRealSeat[0];

  // 只显示与自己相关的摸牌/操作提示，不展示其他玩家摸到的具体牌
  let deferDrawFlashForStagger = false;
  if (payload.selfLastDrawTileId != null) {
    const my = game.players[0];
    const tile = (my?.hand || []).find(
      (t) => t.id === payload.selfLastDrawTileId,
    );
    const drawHint = tile
      ? `已摸牌 ${tileName(tile.typeIdx)}，请出牌`
      : "已摸牌，请出牌";
    const upstream = String(payload.status || "").trim();
    const shouldStagger =
      upstream &&
      upstream !== drawHint &&
      (upstream.includes("已出牌") ||
        upstream.includes("碰牌") ||
        upstream.includes("杠牌") ||
        upstream.includes("已过") ||
        upstream.includes("胡牌"));
    if (shouldStagger) {
      scheduleDrawHintAfterUpstream(
        upstream,
        payload.selfLastDrawTileId,
        drawHint,
      );
      deferDrawFlashForStagger = true;
    } else {
      game.status = drawHint;
    }
  } else if (
    payload.phase === "discard" &&
    Number.isInteger(payload.actorSeat) &&
    payload.actorSeat === myRealSeat &&
    String(payload.status || "").includes("碰牌")
  ) {
    game.status = "已碰牌，请出牌";
  } else if (
    payload.phase === "react" &&
    payload.reactionForSelf &&
    (payload.reactionForSelf.canPeng || payload.reactionForSelf.canGang)
  ) {
    game.status = formatReactDiscardHint(payload);
  } else if (
    payload.reactionForSelf &&
    (payload.reactionForSelf.canPeng ||
      payload.reactionForSelf.canGang ||
      payload.reactionForSelf.canHu ||
      payload.reactionForSelf.canPass)
  ) {
    game.status = payload.status || "请选择操作";
  } else if (Number.isInteger(nextLocal)) {
    const n = game.players[nextLocal]?.name || `座位${payload.nextSeat}`;
    game.status = `等待 ${n} 出牌`;
  } else {
    game.status = "等待其他玩家出牌";
  }
  const nextReaction = payload.reactionForSelf || null;
  if (payload.selfLastDrawTileId != null && nextReaction) {
    // 先让新牌渲染出来，再短延迟展示胡/过/暗杠按钮
    applyReactionState(null);
    reactionStaggerTimer = setTimeout(() => {
      reactionStaggerTimer = null;
      applyReactionState(nextReaction);
    }, REACTION_AFTER_DRAW_DELAY_MS);
  } else {
    applyReactionState(nextReaction);
  }
  const myHand = game.players[0]?.hand || [];
  if (!game.canCheng) {
    game.canCheng =
      game.phase === "discard" &&
      game.current === 0 &&
      myHand.some((t) => t.typeIdx === game.laiziTypeIdx);
  }
  game.wall = new Array(Number(payload.wallCount || 0)).fill({
    id: 0,
    typeIdx: 0,
  });
  if (typeof payload.selfChengCount === "number") {
    game.chengTimes = payload.selfChengCount;
  }
  syncScoreFromSettlementPayload(payload);
  syncAllPlayersStatsFromPayload(payload);
  if (payload.selfLastDrawTileId != null && !deferDrawFlashForStagger) {
    startDrawFlash(payload.selfLastDrawTileId);
  }
  mjLog("actionResult", {
    phase: game.phase,
    current: game.current,
    selfLastDrawTileId: payload.selfLastDrawTileId,
    seq: payload.seq,
    actorSeat: payload.actorSeat,
    nextSeat: payload.nextSeat,
    reaction: mjFmtReactionForLog(game.reaction),
  });
}

/**
 * 新摸牌边框高亮闪烁两次
 */
function startDrawFlash(tileId) {
  if (drawFlashState.timer) {
    clearInterval(drawFlashState.timer);
    drawFlashState.timer = null;
  }
  drawFlashState.tileId = tileId;
  drawFlashState.visible = true;
  drawFlashState.togglesLeft = 4; // 两次闪烁：亮灭亮灭
  drawFlashState.timer = setInterval(() => {
    drawFlashState.visible = !drawFlashState.visible;
    drawFlashState.togglesLeft -= 1;
    if (drawFlashState.togglesLeft <= 0) {
      clearInterval(drawFlashState.timer);
      drawFlashState.timer = null;
      drawFlashState.tileId = null;
      drawFlashState.visible = false;
    }
  }, 220);
}

multiplayer.on("actionResult", (payload) => {
  applyServerActionResult(payload);
});

/** 与 drawReactionButtons 一致：存在可点选项（含「过」或暗杠）时返回 true */
function reactionForSelfHasClickableOptions(r) {
  if (!r) return false;
  if (r.canPeng || r.canGang || r.canHu || r.canPass) return true;
  if (
    r.canAnGang &&
    Array.isArray(r.anGangTypeIdxs) &&
    r.anGangTypeIdxs.length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * 断线重连：服务端下发完整牌局快照
 */
function applyGameSnapshot(payload) {
  clearStatusStaggerTimer();
  clearReactionStaggerTimer();
  const snapSeq = Number(payload?.seq || 0);
  // 仅收到 snapshot、未再走 gameStart 时（如房态 watch 开局拉快照），seq 会回到 1～2，须清掉上一局的 lastApplied
  if (
    multiplayer.state.gameStarted &&
    snapSeq > 0 &&
    snapSeq <= 2 &&
    lastAppliedMjActionSeq > snapSeq + 8
  ) {
    lastAppliedMjActionSeq = 0;
  }
  if (
    multiplayer.state.gameStarted &&
    snapSeq > 0 &&
    snapSeq < lastAppliedMjActionSeq
  ) {
    mjLog("applySnapshot:skipStaleSnapshot", {
      snapSeq,
      lastAppliedMjActionSeq,
    });
    return;
  }
  mjLog("applySnapshot:enter", {
    seq: payload?.seq,
    phase: payload?.phase,
    currentSeat: payload?.currentSeat,
    selfLastDrawTileId: payload?.selfLastDrawTileId,
    preReaction: mjFmtReactionForLog(payload?.reactionForSelf),
  });
  applyServerGameStart(payload);
  if (String(payload?.status || "").includes("逞")) {
    latestChengHint = String(payload.status || "").replace("，请出牌", "");
  }
  if (
    payload?.chengCountBySeat &&
    typeof payload.chengCountBySeat === "object"
  ) {
    chengCountByRealSeat = { ...payload.chengCountBySeat };
  }
  if (typeof payload.selfChengCount === "number") {
    game.chengTimes = payload.selfChengCount;
  }
  syncAllPlayersStatsFromPayload(payload);
  const nextReaction = payload?.reactionForSelf || null;
  if (payload?.selfLastDrawTileId != null && nextReaction) {
    // 先渲染手牌，再展示反应按钮，视觉顺序更自然
    applyReactionState(null);
    reactionStaggerTimer = setTimeout(() => {
      reactionStaggerTimer = null;
      applyReactionState(nextReaction);
    }, REACTION_AFTER_DRAW_DELAY_MS);
  } else {
    applyReactionState(nextReaction);
  }
  const myHand = game.players[0]?.hand || [];
  if (!game.canCheng) {
    game.canCheng =
      game.phase === "discard" &&
      game.current === 0 &&
      myHand.some((t) => t.typeIdx === game.laiziTypeIdx);
  }
  if (game.phase === "gameover") {
    if (game.winner != null && game.winner >= 0) {
      const name = game.players[game.winner]?.name || "玩家";
      const huLbl = resolveHuTypeLabelFromPayload(payload);
      game.huTypeLabel = huLbl;
      setStatus(
        huLbl ? `${name} 胡牌（${huLbl}），本局结束` : `${name} 胡牌，本局结束`,
      );
    } else {
      game.huTypeLabel = "";
      setStatus(payload?.status || "流局");
    }
    game.busy = false;
    mjLog("applySnapshot:early", { reason: "gameover" });
    return;
  }
  const needSelfReactUi =
    (game.phase === "react" || game.phase === "self_react") &&
    reactionForSelfHasClickableOptions(payload?.reactionForSelf);
  // 云端快照若标记了“自己刚摸牌”，优先恢复高亮；但若当前须碰/过/暗杠，不能提前 return 以免漏掉状态分支
  if (payload?.selfLastDrawTileId != null && !needSelfReactUi) {
    const isInitialDealerDraw =
      Number(payload?.seq || 0) <= 1 &&
      Number.isInteger(multiplayer.state.seat) &&
      Number(payload?.dealerSeat ?? 0) === multiplayer.state.seat;
    if (isInitialDealerDraw) {
      setStatus("你是庄家，等你出牌");
      game.busy = false;
      mjLog("applySnapshot:early", {
        reason: "dealerFirstDiscard",
        needSelfReactUi,
        selfLastDrawTileId: payload.selfLastDrawTileId,
      });
      return;
    }
    const my = game.players[0];
    const tile = (my?.hand || []).find(
      (t) => t.id === payload.selfLastDrawTileId,
    );
    const drawHint = tile
      ? `已摸牌 ${tileName(tile.typeIdx)}，请出牌`
      : "已摸牌，请出牌";
    const upstream = String(payload?.status || game.status || "").trim();
    const shouldStagger =
      upstream &&
      upstream !== drawHint &&
      (upstream.includes("已出牌") ||
        upstream.includes("碰牌") ||
        upstream.includes("杠牌") ||
        upstream.includes("已过") ||
        upstream.includes("胡牌"));
    if (shouldStagger) {
      scheduleDrawHintAfterUpstream(
        upstream,
        payload.selfLastDrawTileId,
        drawHint,
      );
    } else {
      setStatus(drawHint);
      startDrawFlash(payload.selfLastDrawTileId);
    }
    game.busy = false;
    mjLog("applySnapshot:early", {
      reason: "selfLastDrawTile",
      needSelfReactUi,
      selfLastDrawTileId: payload.selfLastDrawTileId,
      afterReaction: mjFmtReactionForLog(game.reaction),
    });
    return;
  }
  let statusBranch = "";
  if (
    game.phase === "react" &&
    game.reaction &&
    (game.reaction.canPeng || game.reaction.canGang)
  ) {
    setStatus(formatReactDiscardHint(payload));
    statusBranch = "reactPengGang";
  } else if (
    game.reaction &&
    (game.reaction.canPeng ||
      game.reaction.canGang ||
      game.reaction.canHu ||
      game.reaction.canPass)
  ) {
    setStatus(payload.status || "请选择操作");
    statusBranch = "reactionMenu";
  } else if (game.phase === "discard" && game.current === 0) {
    setStatus(game.status || "请出牌");
    statusBranch = "selfDiscard";
  } else {
    setStatus(game.status || "等待其他玩家");
    statusBranch = "wait";
  }
  if (needSelfReactUi && payload?.selfLastDrawTileId != null) {
    startDrawFlash(payload.selfLastDrawTileId);
  }
  game.busy = false;
  mjLog("applySnapshot:done", {
    statusBranch,
    needSelfReactUi,
    phase: game.phase,
    current: game.current,
    reaction: mjFmtReactionForLog(game.reaction),
    selfLastDrawKeptFlash: !!(
      needSelfReactUi && payload?.selfLastDrawTileId != null
    ),
  });
}

multiplayer.on("snapshot", (payload) => {
  applyGameSnapshot(payload);
});

multiplayer.on("roomState", (payload) => {
  if (!payload) {
    resetGameViewToLobby();
    setStatus("已退出房间");
    return;
  }
  if (payload.status !== "gaming") {
    resetGameViewToLobby();
  }
  const roomNo = String(payload?.roomNo || "").trim();
  if (!roomNo) return;
  if (pendingJoinRoomNo && roomNo === pendingJoinRoomNo) {
    pendingJoinRoomNo = "";
    pendingJoinInFlight = false;
  }
});

/**
 * 仅屏蔽「有人出牌后、轮到下家」时本地写入的顶栏提示（等待 xx 出牌 / 等待其他玩家出牌），其余文案原样显示。
 */
function hideTopBarAfterDiscardWaitTurn(raw) {
  const t = String(raw || "").trim();
  if (t === "等待其他玩家出牌") return "";
  if (/^等待\s+.+\s*出牌$/.test(t)) return "";
  return String(raw || "");
}

/**
 * 绘制 FPS 帧率信息（左上角）
 */
function drawFPS() {
  ctx.fillStyle = "#ffffff"; // 文字颜色：白色
  ctx.textAlign = "left"; // 文字左对齐
  ctx.font = "10px monospace"; // 等宽字体，保证数字对齐
  // 显示保留1位小数的帧率值
  ctx.fillText(`FPS: ${fps.toFixed(1)}`, 8, 16);
}

function drawBackground() {
  ctx.fillStyle = "#1A5F44"; // 设置背景填充色
  // 填充整个 Canvas 区域
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  // 绘制中间弃牌区域
  drawDiscardsArea();
  // 牌桌中间淡水印（后续弃牌/手牌会覆盖在其上）
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "32px sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
  ctx.fillText("荆州麻将  逞癞子", SCREEN_W / 2, SCREEN_H / 2);
  ctx.restore();
}

/**
 * 左上角信息区用的小牌面：浅色底 + 与手牌相同的贴图/字符 + 细边框
 */
function drawHeaderMiniTile(x, y, w, h, typeIdx) {
  const cornerR = Math.min(8, Math.max(3, Math.floor(Math.min(w, h) * 0.14)));
  ctx.fillStyle = "#f5f4ef";
  ctx.beginPath();
  addRoundRectPath(ctx, x, y, w, h, cornerR);
  ctx.fill();
  drawTileFace(x, y, w, h, typeIdx);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.32)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  addRoundRectPath(ctx, x, y, w, h, cornerR);
  ctx.stroke();
}

/**
 * 绘制顶部状态区：联机信息、牌局信息与中间状态提示
 */
function drawHeader() {
  ctx.fillStyle = "#ffffff"; // 文字颜色：白色
  const mp = multiplayer.state;
  const inRound = !!multiplayer.state.gameStarted;
  const roomText = mp.roomNo ? `房号: ${mp.roomNo}` : "房号: -";

  // 仅在大厅显示联机状态；对局中隐藏，给牌局信息腾空间
  if (!inRound) {
    ctx.textAlign = "left";
    ctx.font = "12px sans-serif";
    ctx.fillText(`[联机] ${mp.tip}`, 8, 14);
    ctx.fillText(`[联机] ${roomText}`, 8, 30);
  }

  // 癞子：文案 + 实牌渲染；剩余牌数单独一行（不显示顶果）
  ctx.font = "14px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  // 避开安全区/圆角描边，避免贴边或裁出屏幕左缘
  const headerInfoLeft = 20;
  const hasLaizi =
    game.laiziTypeIdx != null &&
    game.laiziTypeIdx >= 0 &&
    Number.isFinite(game.laiziTypeIdx);
  const row1Y = inRound ? 22 : 98;
  // 癞子小牌高约 38、以 row1Y 垂直居中，底边约在 row1Y+19；剩余牌数再下移避免与牌重叠
  const row2Y = inRound && hasLaizi ? 54 : inRound ? 40 : 0;
  const miniTw = 28;
  const miniTh = 38;

  if (hasLaizi) {
    ctx.fillStyle = "#ffffff";
    const label = "癞子：";
    ctx.fillText(label, headerInfoLeft, row1Y);
    const lw = ctx.measureText(label).width;
    const tileX = headerInfoLeft + lw + 4;
    const tileY = row1Y - miniTh / 2;
    drawHeaderMiniTile(tileX, tileY, miniTw, miniTh, game.laiziTypeIdx);
    ctx.fillStyle = "#ff0000";
    ctx.beginPath();
    ctx.arc(tileX + miniTw - 5, tileY + 6, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (inRound) {
    ctx.fillStyle = "#ffffff";
    const wallLine = `剩余牌数: ${game.wall.length}`;
    if (hasLaizi) {
      ctx.fillText(wallLine, headerInfoLeft, row2Y);
    } else {
      ctx.fillText(wallLine, headerInfoLeft, row1Y);
    }
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = "20px sans-serif";
  ctx.fillStyle = "#ffffff";
  const midStatus = hideTopBarAfterDiscardWaitTurn(game.status);
  if (midStatus) ctx.fillText(midStatus, SCREEN_W / 2, 24);

  // 「xx 逞癞子」紧挨顶栏主提示下方，略小字号、少量间距
  if (inRound && latestChengHint) {
    ctx.font = "14px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffd666";
    const chengY = midStatus ? 40 : 34;
    ctx.fillText(latestChengHint, SCREEN_W / 2, chengY);
    ctx.fillStyle = "#ffffff";
  }
  ctx.textBaseline = "alphabetic";
}

/**
 * 绘制房间玩家信息（东南西北座位布局）
 */
function drawRoomPlayersPanel() {
  const mp = multiplayer.state;
  const inGame = !!mp.gameStarted;
  const room = mp.roomState;
  const players = Array.isArray(room?.players) ? room.players : [];
  const tableCenterAreaHeight = SCREEN_H / 2;
  const tableY = (SCREEN_H - tableCenterAreaHeight) / 2 + 6;
  const tableHeight = SCREEN_H - tableCenterAreaHeight + 6;
  const tableBottom = tableY + tableHeight;
  // 南玩家卡片高度为40，中心点=下边界-20，可实现“卡片下边贴牌桌下边”
  const southCardCenterY = Math.min(SCREEN_H - 24, tableBottom - 20);
  // 东、西家信息卡略下移，避免与牌桌/碰杠区挤在一起
  const eastWestCardY = SCREEN_H / 2 + 48;

  // 座位到方位映射：0南、1西、2北、3东；服务端行牌/摸牌为逆时针 南→东→北→西
  const seatPos = {
    0: {
      x: SCREEN_W / 2,
      y: southCardCenterY,
      align: "center",
      dir: "南",
    },
    1: { x: 56, y: eastWestCardY, align: "left", dir: "西" },
    2: { x: SCREEN_W / 2, y: 84, align: "center", dir: "北" },
    3: {
      x: SCREEN_W - 8,
      y: eastWestCardY,
      align: "right",
      dir: "东",
    },
  };

  for (let localSeat = 0; localSeat < 4; localSeat++) {
    const realSeat = Array.isArray(localSeatToRealSeat)
      ? localSeatToRealSeat[localSeat]
      : localSeat;
    const p = players.find((x) => x.seat === realSeat);
    const pos = seatPos[localSeat];
    if (!pos) continue;

    const meTag = p && p.uid === mp.uid ? "我" : "";
    const onlineText = p ? (p.online ? "在线" : "离线") : "-";
    const nick = p ? p.nickname || "匿名" : "等待加入";
    const botTag = p && p.isBot ? " [电脑]" : "";
    const ownerTag = room && p && p.uid === room.ownerUid ? " [房主]" : "";
    const chengTimes = Number(chengCountByRealSeat[realSeat] || 0);
    const chengTag = chengTimes > 0 ? ` [逞x${chengTimes}]` : "";
    const isCurrentDiscardPlayer =
      inGame &&
      game.phase === "discard" &&
      game.current === localSeat &&
      game.phase !== "gameover";
    const actionTag = isCurrentDiscardPlayer ? " 出牌中" : "";
    const titleMain = `${nick}${meTag ? `(${meTag})` : ""}${ownerTag}${botTag}`;
    const localIdx =
      realSeatToLocalSeat && Number.isInteger(realSeatToLocalSeat[realSeat])
        ? realSeatToLocalSeat[realSeat]
        : localSeat;
    const scoreAmt = Number(playerScoreByLocal[localIdx] || 0);
    const readyLobbyText = p ? (p.ready ? "已准备" : "未准备") : "等待";
    const secondSeg = inGame ? `${scoreAmt}元` : readyLobbyText;
    const status = `${onlineText} | ${secondSeg}`;

    // 玩家信息底板：按内容自适应宽度
    const avatarReserve = p && !p.isBot ? 28 : 0;
    ctx.font = "12px sans-serif";
    const titleW = ctx.measureText(titleMain + chengTag + actionTag).width;
    const statusW = ctx.measureText(status).width;
    const contentW = Math.max(titleW, statusW) + avatarReserve + 18;
    let cardW = Math.max(110, Math.min(contentW, 190));
    if (localSeat === 3) cardW = Math.max(104, Math.min(cardW - 12, 176));
    const cardH = 40;
    let left =
      pos.align === "center"
        ? pos.x - cardW / 2
        : pos.align === "right"
          ? pos.x - cardW
          : pos.x;
    const top = pos.y - cardH / 2;
    if (localSeat === 2) {
      left = Math.min(left, SCREEN_W - cardW - 8);
      left = Math.max(8, left);
    }

    ctx.save();
    if (isCurrentDiscardPlayer) {
      const pulse = (Math.sin(Date.now() / 260) + 1) / 2;
      ctx.shadowColor = "rgba(255, 228, 94, 0.85)";
      ctx.shadowBlur = 8 + pulse * 8;
      ctx.fillStyle = "rgba(255, 215, 106, 0.30)";
      ctx.beginPath();
      addRoundRectPath(ctx, left, top, cardW, cardH, 8);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(255, 228, 94, ${0.72 + pulse * 0.28})`;
      ctx.beginPath();
      addRoundRectPath(ctx, left - 1, top - 1, cardW + 2, cardH + 2, 9);
      ctx.stroke();
    } else {
      ctx.fillStyle =
        p && p.uid === mp.uid
          ? "rgba(255, 215, 106, 0.22)"
          : "rgba(0, 0, 0, 0.28)";
      ctx.beginPath();
      addRoundRectPath(ctx, left, top, cardW, cardH, 8);
      ctx.fill();
    }
    ctx.restore();

    // 真人玩家显示头像；机器人保持文字样式
    if (p && !p.isBot) {
      const avatarSize = 20;
      const avatarX =
        pos.align === "right" ? left + cardW - avatarSize - 6 : left + 6;
      const avatarY = top + (cardH - avatarSize) / 2;
      const img = getAvatarImage(p.avatarUrl);
      if (img) {
        try {
          ctx.save();
          ctx.beginPath();
          ctx.arc(
            avatarX + avatarSize / 2,
            avatarY + avatarSize / 2,
            avatarSize / 2,
            0,
            Math.PI * 2,
          );
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(img, avatarX, avatarY, avatarSize, avatarSize);
          ctx.restore();
        } catch (err) {
          // ignore draw failures for incomplete image decode
        }
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.arc(
          avatarX + avatarSize / 2,
          avatarY + avatarSize / 2,
          avatarSize / 2,
          0,
          Math.PI * 2,
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    const textX =
      pos.align === "left" || pos.align === "right" ? left + cardW / 2 : pos.x;
    const textAlign = "center";
    ctx.textAlign = textAlign;
    ctx.textBaseline = "middle";
    ctx.font = "12px sans-serif";
    if (!chengTag && !actionTag) {
      ctx.fillStyle = "#ffffff";
      ctx.fillText(titleMain, textX, pos.y - 8);
    } else {
      ctx.textAlign = "left";
      const mainW = ctx.measureText(titleMain).width;
      const chengW = ctx.measureText(chengTag).width;
      const actionW = ctx.measureText(actionTag).width;
      const startX = textX - (mainW + chengW + actionW) / 2;
      let tx = startX;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(titleMain, tx, pos.y - 8);
      tx += mainW;
      if (chengTag) {
        ctx.fillStyle = "#ffd35a";
        ctx.fillText(chengTag, tx, pos.y - 8);
        tx += chengW;
      }
      if (actionTag) {
        ctx.fillStyle = "#ffe45e";
        ctx.fillText(actionTag, tx, pos.y - 8);
      }
      ctx.textAlign = textAlign;
    }
    const scoreColor = scoreAmt !== 0 ? "#ffd35a" : "#d7f3ff";
    const readyLobbyColor = !p ? "#d7f3ff" : p.ready ? "#8ef58e" : "#d7f3ff";
    const secondColor = inGame ? scoreColor : readyLobbyColor;
    const sep = " | ";
    const pOnline = onlineText;
    let lx = textX - ctx.measureText(status).width / 2;
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(pOnline, lx, pos.y + 8);
    lx += ctx.measureText(pOnline).width;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(sep, lx, pos.y + 8);
    lx += ctx.measureText(sep).width;
    ctx.fillStyle = secondColor;
    ctx.fillText(secondSeg, lx, pos.y + 8);
    ctx.textAlign = textAlign;
  }
}

/** 与 drawDiscardsArea 一致的牌桌内框，供胡牌蒙层等复用 */
function getTableInnerRect() {
  const centerAreaWidth = Math.max(300, Math.floor(SCREEN_W * 0.52));
  const centerAreaHeight = SCREEN_H / 2;
  const x = (SCREEN_W - centerAreaWidth) / 2;
  const y = (SCREEN_H - centerAreaHeight) / 2 + 6;
  const width = centerAreaWidth;
  const height = SCREEN_H - centerAreaHeight + 6;
  return { x, y, width, height };
}

/** 牌桌内框圆角半径，须与 drawDiscardsArea / 结算蒙层一致 */
const TABLE_INNER_CORNER_RADIUS = 20;

/**
 * 当前路径设为牌桌内框圆角矩形（闭合）。用于蒙层填充或与牌桌轮廓对齐的 clip。
 */
function pathTableInnerRoundedRect() {
  const { x, y, width, height } = getTableInnerRect();
  const r = TABLE_INNER_CORNER_RADIUS;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** 牌桌区域半透明蒙层（圆角与木质牌桌边框一致） */
function fillTableDimOverlay() {
  pathTableInnerRoundedRect();
  ctx.fillStyle = "rgba(0, 0, 0, 0.52)";
  ctx.fill();
}

// 绘制弃牌区域
function drawDiscardsArea() {
  const discardAreaColor = "#D2B48C"; // 弃牌区域线条颜色（仿木质）
  const discardAreaWidth = 4; // 线条宽度
  const { x, y, width, height } = getTableInnerRect();
  const radius = TABLE_INNER_CORNER_RADIUS;

  // 开始绘制路径
  ctx.beginPath();
  // 绘制圆角矩形
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.arcTo(x + width, y, x + width, y + radius, radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  ctx.lineTo(x + radius, y + height);
  ctx.arcTo(x, y + height, x, y + height - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();

  // 设置线条样式
  ctx.strokeStyle = discardAreaColor;
  ctx.lineWidth = discardAreaWidth;
  ctx.shadowColor = "rgba(0,0,0,0.2)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  // 绘制线条
  ctx.stroke();

  // 重置阴影（避免影响后续绘制）
  ctx.shadowColor = "transparent";

  // 牌桌四向淡水印（东南西北），与座位方位一致；弃牌叠在中间会略挡字边
  ctx.save();
  ctx.font = "22px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
  ctx.textBaseline = "middle";
  const inset = 24;
  const cx = x + width / 2;
  const cy = y + height / 2;
  ctx.textAlign = "center";
  ctx.fillText("北", cx, y + inset);
  ctx.fillText("南", cx, y + height - inset);
  ctx.textAlign = "left";
  ctx.fillText("西", x + inset, cy);
  ctx.textAlign = "right";
  ctx.fillText("东", x + width - inset, cy);
  ctx.restore();

  // 绘制所有玩家弃牌
  drawDiscards(x + 10, y + 10, width - 20);

  //   // 绘制所有玩家的弃牌
  //   for (let i = 0; i < game.players.length; i++) {
  //     const player = game.players[i];
  //     for (let j = 0; j < player.discards.length; j++) {
  //       const tile = player.discards[j];
  //       const x =
  //         i === 0
  //           ? x + j * 40
  //           : i === 1
  //           ? x + width - j * 40 - 40
  //     }
  //   }
}

// 绘制所有玩家手牌和弃牌
function drawHandsAndDiscards() {
  const bottomIdx = 0; // 南（己方）
  const rightIdx = 1; // 本地 seat1 = 西（UI 屏左，与 seatPos 一致）
  const topIdx = 2; // 北
  const leftIdx = 3; // 本地 seat3 = 东（UI 屏右）

  // 绘制己方手牌
  drawHands(game.players[bottomIdx]);

  // 绘制碰/杠牌（胡家亮牌在 drawGameOver 中蒙层之后绘制，避免被半透明层盖住）
  drawMeldsForPlayer();
  drawDebugOpponentHands();
}

// 绘制玩家手牌
function drawHands(player) {
  const tileW = 45; // 牌宽
  const tileH = 60; // 牌高
  //   const startX = (SCREEN_W - player.hand.length * tileW) / 2;
  const startX = 20;
  handSlots = [];
  // 绘制玩家手牌
  for (let i = 0; i < player.hand.length; i++) {
    const tile = player.hand[i];
    // const x = i * 40 + 20;
    // const y = SCREEN_H - 40;
    // drawTile(tile, x, y);
    const x = startX + i * tileW;
    const y = SCREEN_H - 70;
    // const isNewTile =
    //   tile.id === game.lastDrawTileId && newTileAnimations.has(tile.id);

    drawTileFace(x, y, tileW, tileH, player.hand[i].typeIdx);

    // 新摸牌高亮边框闪烁（两次），圆角与牌面圆角贴图风格一致
    if (tile.id === drawFlashState.tileId && drawFlashState.visible) {
      const bx = x - 1;
      const by = y - 1;
      const bw = tileW + 2;
      const bh = tileH + 2;
      const cornerR = Math.min(
        12,
        Math.max(4, Math.floor(Math.min(bw, bh) * 0.14)),
      );
      ctx.strokeStyle = "#ffe45e";
      ctx.lineWidth = 3;
      ctx.shadowColor = "#ffe45e";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      addRoundRectPath(ctx, bx, by, bw, bh, cornerR);
      ctx.stroke();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }

    // 如果是癞子牌，在牌面右上角绘制一个小红点标记
    if (player.hand[i].typeIdx === game.laiziTypeIdx) {
      ctx.fillStyle = "#ff0000"; // 红色
      ctx.beginPath();
      // 靠右上、略偏内，避免与圆角牌面贴边重叠
      ctx.arc(x + tileW - 5, y + 5, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. 仅当牌ID在newTileIds中时，绘制静态三角
    if (newTileIds.has(tile.id)) {
      drawStaticTriangle(x, y, tileW, tileH);
    }

    // // 2. 绘制旋转三角形（仅新牌且动画未结束）
    // if (isNewTile) {
    //   const anim = newTileAnimations.get(tile.id);
    //   drawRotatingTriangle(x, y, tileW, tileH, anim.angle);
    //   // 更新旋转角度（每次+1度，循环360度）
    //   anim.angle = (anim.angle + 1) % 360;
    // }

    handSlots.push({
      index: i,
      left: x,
      right: x + tileW,
      top: y,
      bottom: y + tileH,
    });
  }

  //   // 3. 继续请求动画帧（保持旋转）
  //   if (newTileAnimations.size > 0) {
  //     animationFrameId = requestAnimationFrame(() =>
  //       //   renderPlayerHand(ctx, player, lastDrawTileId, startX, startY, tileWidth, tileHeight, gap)
  //       drawHands(player),
  //     );
  //   }

  //   // 绘制玩家弃牌
  //   for (let i = 0; i < player.discards.length; i++) {
  //     const tile = player.discards[i];
  //     const x = i * 40 + 20;
  //     const y = SCREEN_H - 80;
  //     drawTile(tile, x, y);
  //   }
}

/** 临时调试：在左/上/右三边用小牌展示电脑手牌（依赖 botHandsBySeat） */
function drawDebugOpponentHands() {
  if (!DEBUG_SHOW_BOT_HANDS) return;
  const tw = 24;
  const th = 32;
  const gap = 2;
  const perCol = 7;
  ctx.save();
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255, 255, 220, 0.92)";

  for (let localIdx = 1; localIdx <= 3; localIdx += 1) {
    if (
      DEBUG_BOT_HANDS_ONLY_LOCAL != null &&
      localIdx !== DEBUG_BOT_HANDS_ONLY_LOCAL
    )
      continue;
    const pl = game.players[localIdx];
    if (!pl || !pl.hand.length) continue;

    if (localIdx === 2) {
      const rowW = pl.hand.length * (tw + gap) - gap;
      const baseX = Math.max(6, (SCREEN_W - rowW) / 2);
      const baseY = 108;
      ctx.textAlign = "center";
      ctx.fillText("[调]上家(电脑)手牌", SCREEN_W / 2, baseY - 14);
      ctx.textAlign = "left";
      for (let i = 0; i < pl.hand.length; i += 1) {
        const x = baseX + i * (tw + gap);
        const y = baseY;
        drawTileFace(x, y, tw, th, pl.hand[i].typeIdx);
        if (
          game.laiziTypeIdx != null &&
          pl.hand[i].typeIdx === game.laiziTypeIdx
        ) {
          ctx.fillStyle = "#ff0000";
          ctx.beginPath();
          ctx.arc(x + tw - 3, y + 3, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255, 255, 220, 0.92)";
        }
      }
    } else if (localIdx === 1) {
      const baseX = SCREEN_W - tw - 8;
      const baseY = 132;
      ctx.textAlign = "right";
      ctx.fillText("[调]右家(电脑)", SCREEN_W - 8, baseY - 14);
      ctx.textAlign = "left";
      for (let i = 0; i < pl.hand.length; i += 1) {
        const col = Math.floor(i / perCol);
        const row = i % perCol;
        const x = baseX - col * (tw + gap);
        const y = baseY + row * (th + gap);
        drawTileFace(x, y, tw, th, pl.hand[i].typeIdx);
        if (
          game.laiziTypeIdx != null &&
          pl.hand[i].typeIdx === game.laiziTypeIdx
        ) {
          ctx.fillStyle = "#ff0000";
          ctx.beginPath();
          ctx.arc(x + tw - 3, y + 3, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255, 255, 220, 0.92)";
        }
      }
    } else {
      const baseX = 8;
      const baseY = 132;
      ctx.fillText("[调]左家(电脑)", baseX, baseY - 14);
      for (let i = 0; i < pl.hand.length; i += 1) {
        const col = Math.floor(i / perCol);
        const row = i % perCol;
        const x = baseX + col * (tw + gap);
        const y = baseY + row * (th + gap);
        drawTileFace(x, y, tw, th, pl.hand[i].typeIdx);
        if (
          game.laiziTypeIdx != null &&
          pl.hand[i].typeIdx === game.laiziTypeIdx
        ) {
          ctx.fillStyle = "#ff0000";
          ctx.beginPath();
          ctx.arc(x + tw - 3, y + 3, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255, 255, 220, 0.92)";
        }
      }
    }
  }
  ctx.restore();
}

/**
 * 绘制静态三角形（无旋转，固定位置）
 */
function drawStaticTriangle(x, y, w, h) {
  // 三角尺寸（小而精致）
  const triangleSize = 8;
  // 三角位置：牌的右上角（位置不变，仅调整顶点方向）
  const centerX = x + w / 2;
  const centerY = y + h / 2 - 5;

  ctx.save();
  // 静态倒三角样式（仅顶点坐标修改）
  ctx.fillStyle = "#ff0000";
  ctx.beginPath();
  ctx.moveTo(centerX, centerY + triangleSize); // 下顶点（原上顶点位置下移）
  ctx.lineTo(centerX - triangleSize, centerY - triangleSize); // 左上顶点（原左下顶点上移）
  ctx.lineTo(centerX + triangleSize, centerY - triangleSize); // 右上顶点（原右下顶点上移）
  ctx.closePath();
  ctx.fill();
  // 白色细边框（增加层次感）
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/**
 * 显示新牌三角 + 定时消失
 */
function showNewTileTriangle(tileId) {
  // 添加牌ID到集合（标记需要显示三角）
  newTileIds.add(tileId);
  // 立即重绘（显示三角）
  drawHands(game.players[0]);

  // 3秒后清除标记 + 重绘（三角消失）
  setTimeout(() => {
    newTileIds.delete(tileId);
    drawHands(game.players[0]);
  }, TRIANGLE_DURATION);
}

/**
 * 停止所有三角显示（出牌/碰/杠时调用）
 */
function stopAllTriangles() {
  newTileIds.clear();
  drawHands(game.players[0]);
}

// 监听“摸新牌”事件（仅手动摸牌触发）
on("new-tile-drawn", (data) => {
  const { tileId, playerIdx } = data;
  // 仅人类玩家显示三角
  if (playerIdx === 0) {
    showNewTileTriangle(tileId);
  }
});

// 监听“出牌”事件（立即清除所有三角）
on("tile-discarded", () => {
  stopAllTriangles();
});

/**
 * 绘制旋转三角形（核心动画）
 * @param {CanvasRenderingContext2D} ctx - Canvas上下文
 * @param {number} x/y - 牌的坐标
 * @param {number} w/h - 牌的尺寸
 * @param {number} angle - 旋转角度（度）
 */
// function drawRotatingTriangle(x, y, w, h, angle) {
//   // 三角位置：牌的右上角（可调整）
//   const centerX = x + w - 20;
//   const centerY = y + 20;
//   const triangleSize = 15;

//   ctx.save(); // 保存当前画布状态
//   // 1. 平移到三角中心（旋转锚点）
//   ctx.translate(centerX, centerY);
//   // 2. 旋转（角度转弧度）
//   ctx.rotate((angle * Math.PI) / 180);
//   // 3. 绘制三角形
//   ctx.fillStyle = "#ff4444"; // 三角颜色（可改）
//   ctx.beginPath();
//   ctx.moveTo(0, -triangleSize); // 上顶点
//   ctx.lineTo(-triangleSize, triangleSize); // 左下顶点
//   ctx.lineTo(triangleSize, triangleSize); // 右下顶点
//   ctx.closePath();
//   ctx.fill();
//   // 4. 绘制三角边框（可选，增加层次感）
//   ctx.strokeStyle = "#ffffff";
//   ctx.lineWidth = 2;
//   ctx.stroke();
//   ctx.restore(); // 恢复画布状态（避免影响其他绘制）
// }
// /**
//  * 绘制旋转三角形（调整后：更小、更慢）
//  * @param {CanvasRenderingContext2D} ctx - Canvas上下文
//  * @param {number} x/y - 牌的坐标
//  * @param {number} w/h - 牌的尺寸
//  * @param {number} angle - 旋转角度（度）
//  */
// function drawRotatingTriangle(x, y, w, h, angle) {
//   // ✅ 调整1：三角尺寸从15→8（更小更精致）
//   const triangleSize = 8;
//   // 三角位置：牌的右上角（微调位置，避免太靠边）
//   const centerX = x + w - 15;
//   const centerY = y + 15;

//   ctx.save();
//   ctx.translate(centerX, centerY);
//   ctx.rotate((angle * Math.PI) / 180);

//   // 三角颜色（可选：浅红更柔和）
//   ctx.fillStyle = "#ff6666";
//   ctx.beginPath();
//   ctx.moveTo(0, -triangleSize); // 上顶点
//   ctx.lineTo(-triangleSize, triangleSize); // 左下顶点
//   ctx.lineTo(triangleSize, triangleSize); // 右下顶点
//   ctx.closePath();
//   ctx.fill();

//   // 边框（更细：2→1）
//   ctx.strokeStyle = "#ffffff";
//   ctx.lineWidth = 1;
//   ctx.stroke();

//   ctx.restore();
// }

// /**
//  * 启动新牌旋转动画（摸牌后调用）
//  * @param {number} tileId - 新摸牌的ID
//  * @param {number} duration - 动画持续时间（默认3000ms）
//  */
// function startNewTileAnimation(tileId, duration = 3000) {
//   // 1. 初始化动画状态
//   newTileAnimations.set(tileId, {
//     angle: 0, // 初始角度
//     timer: null, // 消失定时器
//   });

//   // 2. 3秒后停止动画并清除标志
//   const anim = newTileAnimations.get(tileId);
//   anim.timer = setTimeout(() => {
//     newTileAnimations.delete(tileId);
//     // 停止动画帧（如果没有其他动画）
//     if (newTileAnimations.size === 0 && animationFrameId) {
//       cancelAnimationFrame(animationFrameId);
//       animationFrameId = null;
//     }
//   }, duration);
// }

// /**
//  * 停止所有新牌动画（出牌/碰/杠时调用）
//  */
// function stopAllNewTileAnimations() {
//   // 清除所有定时器
//   newTileAnimations.forEach((anim) => clearTimeout(anim.timer));
//   newTileAnimations.clear();
//   // 停止动画帧
//   if (animationFrameId) {
//     cancelAnimationFrame(animationFrameId);
//     animationFrameId = null;
//   }
// }

// // 给各个玩家模拟生成一些碰牌和杠牌
// for (let i = 0; i < game.players.length; i++) {
//   const player = game.players[i]; // 当前玩家 对象
//   // 模拟生成1-2组碰牌
//   const meldCount = Math.floor(Math.random() * 2) + 1; // 1或2组
//   for (let j = 0; j < meldCount; j++) {
//     const tileTypeIdx = Math.floor(Math.random() * 34); // 随机牌类型
//     const meld = {
//       kind: "peng", // 碰牌
//       tileTypeIdx, // 碰牌的牌类型索引
//       from: (i + 3) % 4, // 碰牌来源玩家索引（上家）
//       size: 3, // 碰牌包含的牌数量（固定为3张）
//     };

//     player.melds.push(meld);
//   }
//   // 模拟生成0-1组杠牌
//   if (Math.random() < 0.5) {
//     // 50%概率生成杠牌
//     const tileTypeIdx = Math.floor(Math.random() * 34); // 随机牌类型
//     const meld = {
//       kind: "gang", // 杠牌
//       tileTypeIdx, // 杠牌的牌类型索引
//       from: (i + 3) % 4, // 杠牌来源玩家索引（上家）
//       size: 4,
//     };

//     player.melds.push(meld);
//   }
// }

/**
 * 与 drawRoomPlayersPanel 北家（seat 2）一致的玩家卡片左右边界，供碰杠分区。
 */
function computeNorthPlayerCardHorizontalBounds() {
  const mp = multiplayer.state;
  const inGame = !!mp.gameStarted;
  const room = mp.roomState;
  const players = Array.isArray(room?.players) ? room.players : [];
  const posX = SCREEN_W / 2;
  const localSeat = 2;
  const realSeat = Array.isArray(localSeatToRealSeat)
    ? localSeatToRealSeat[localSeat]
    : localSeat;
  const p = players.find((x) => x.seat === realSeat);
  const meTag = p && p.uid === mp.uid ? "我" : "";
  const nick = p ? p.nickname || "匿名" : "等待加入";
  const botTag = p && p.isBot ? " [电脑]" : "";
  const ownerTag = room && p && p.uid === room.ownerUid ? " [房主]" : "";
  const localIdx =
    realSeatToLocalSeat && Number.isInteger(realSeatToLocalSeat[realSeat])
      ? realSeatToLocalSeat[realSeat]
      : localSeat;
  const scoreAmt = Number(playerScoreByLocal[localIdx] || 0);
  const readyLobbyText = p ? (p.ready ? "已准备" : "未准备") : "等待";
  const secondSeg = inGame ? `${scoreAmt}元` : readyLobbyText;
  const onlineText = p ? (p.online ? "在线" : "离线") : "-";
  const titleMain = `${nick}${meTag ? `(${meTag})` : ""}${ownerTag}${botTag}`;
  const chengTimes = Number(chengCountByRealSeat[realSeat] || 0);
  const chengTag = chengTimes > 0 ? ` [逞x${chengTimes}]` : "";
  const status = `${onlineText} | ${secondSeg}`;
  const avatarReserve = p && !p.isBot ? 28 : 0;
  const prevFont = ctx.font;
  ctx.font = "12px sans-serif";
  const titleW = ctx.measureText(titleMain + chengTag).width;
  const statusW = ctx.measureText(status).width;
  ctx.font = prevFont;
  const contentW = Math.max(titleW, statusW) + avatarReserve + 18;
  let cardW = Math.max(110, Math.min(contentW, 190));
  let left = posX - cardW / 2;
  left = Math.min(left, SCREEN_W - cardW - 8);
  left = Math.max(8, left);
  const right = left + cardW;
  return { left, right, centerX: posX, width: cardW };
}

function drawMeldGroupHorizontalAt(meld, startX, startY, meldW, meldH) {
  const tileTypeIdx = meld.tileTypeIdx;
  const size = meld.size;
  for (let j = 0; j < size; j += 1) {
    drawTileFace(startX + j * meldW, startY, meldW, meldH, tileTypeIdx);
  }
  return startX + size * meldW;
}

/**
 * 北家碰/杠：卡片左侧至多 2 组，整体紧贴卡片左缘向左排开（不与牌桌左缘对齐，避免为贴桌而右移后与卡片重叠）；
 * 第 3 组起在卡片右侧。若两组仍过宽，仅靠增大与卡片间距即可；仍不够时可改为「左侧只放 1 组」。
 */
function drawMeldsNorth(playerIdx, startY) {
  const player = game.players[playerIdx];
  if (!player || !Array.isArray(player.melds) || player.melds.length === 0)
    return;

  const tileW = 45;
  const tileH = 60;
  const meldW = tileW * 0.6;
  const meldH = tileH * 0.6;
  const groupGap = 10;
  /** 与北家信息卡之间的水平留白，略大可减少第 2 组碰杠与卡片重叠 */
  const padCard = 14;

  const { left: cardLeft, right: cardRight } =
    computeNorthPlayerCardHorizontalBounds();

  const melds = player.melds;
  const leftGroups = melds.slice(0, 2);
  const rightGroups = melds.slice(2);

  let totalLeftW = 0;
  for (let i = 0; i < leftGroups.length; i += 1) {
    if (i > 0) totalLeftW += groupGap;
    totalLeftW += leftGroups[i].size * meldW;
  }

  // 整块右缘落在 cardLeft - padCard，不再为对齐牌桌把起点右推
  let xLeft = cardLeft - padCard - totalLeftW;
  if (xLeft < 2) xLeft = 2;

  let x = xLeft;
  for (let i = 0; i < leftGroups.length; i += 1) {
    x = drawMeldGroupHorizontalAt(leftGroups[i], x, startY, meldW, meldH);
    if (i < leftGroups.length - 1) x += groupGap;
  }

  let xRight = cardRight + padCard;
  for (let i = 0; i < rightGroups.length; i += 1) {
    xRight = drawMeldGroupHorizontalAt(
      rightGroups[i],
      xRight,
      startY,
      meldW,
      meldH,
    );
    if (i < rightGroups.length - 1) xRight += groupGap;
  }
}

/**
 * 绘制己方碰和杠牌
 * 己方碰牌和杠牌显示在手牌右边，碰牌三张并排显示，杠牌四张并排显示
 * 东/西家碰杠在对应侧一行两组（组内横排），与房间面板 seatPos 一致：西(1)屏左、东(3)屏右
 * @param {number} startX - 南：碰杠区左缘；西(1)：左缘左对齐；东(3)：右缘右对齐
 * @param {number} startY - 牌的左上角 Y
 */
function drawMelds(playerIdx, startX, startY) {
  const tileW = 45; // 牌宽
  const tileH = 60; // 牌高
  const meldW = tileW * 0.6;
  const meldH = tileH * 0.6;
  const player = game.players[playerIdx];
  if (!player || !Array.isArray(player.melds) || player.melds.length === 0)
    return;

  // 东(3)/西(1)：一行两组；西在屏左左对齐，东在屏右右对齐（与 drawRoomPlayersPanel 座位一致）
  if (playerIdx === 1 || playerIdx === 3) {
    const melds = player.melds;
    const groupGap = 10;
    const rowGap = 6;
    const alignRight = playerIdx === 3;
    const margin = 8;
    let rowY = startY;
    for (let i = 0; i < melds.length; i += 2) {
      const a = melds[i];
      const b = melds[i + 1];
      const wA = a.size * meldW;
      const wB = b ? b.size * meldW : 0;
      const rowW = wA + (b ? groupGap + wB : 0);
      let xA;
      if (alignRight) {
        const rightEdge = startX;
        xA = rightEdge - rowW;
        if (xA < margin) xA = margin;
      } else {
        xA = startX;
      }
      drawMeldGroupHorizontalAt(a, xA, rowY, meldW, meldH);
      if (b) {
        drawMeldGroupHorizontalAt(b, xA + wA + groupGap, rowY, meldW, meldH);
      }
      rowY += meldH + rowGap;
    }
    return;
  }

  let meldX = startX;
  let meldY = startY;
  for (let i = 0; i < player.melds.length; i++) {
    const meld = player.melds[i];
    const tileTypeIdx = meld.tileTypeIdx;
    const size = meld.size;
    for (let j = 0; j < size; j++) {
      drawTileFace(meldX, meldY, meldW, meldH, tileTypeIdx);
      meldX += meldW;
    }
    meldX += 10;
  }
}

/**
 * 绘制所有玩家的碰/杠牌（根据玩家位置调整绘制坐标）
 *  @param {number} player - 玩家对象，包含碰/杠牌信息
 *  @param {number} startX - 牌的左上角X坐标（文字参考基准）
 *  @param {number} startY - 牌的左上角Y坐标（文字参考基准）
 */
function drawMeldsForPlayer() {
  const bottomIdx = 0; // 南（己方）
  const rightIdx = 1; // 本地 seat1 = 西（UI 屏左，与 seatPos 一致）
  const topIdx = 2; // 北
  const leftIdx = 3; // 本地 seat3 = 东（UI 屏右）

  const tileW = 45; // 牌宽
  const humanTileCount = game.players[0].hand.length; // 己方玩家手牌数量
  const startX = 20 + humanTileCount * tileW + 20; // 碰/杠牌起始X坐标（在手牌右边）
  // 绘制己方玩家的碰/杠牌（显示在手牌右边）
  drawMelds(bottomIdx, startX, SCREEN_H - 80);
  // 西(本地 1)：屏左，与 seatPos 一致（勿与「右家」命名混淆）
  drawMelds(rightIdx, 20, SCREEN_H / 2 - 90);
  // 绘制顶部（北）玩家碰/杠：牌桌左对齐，卡片左/右分区
  drawMeldsNorth(topIdx, 60);
  // 东(本地 3)：屏右，startX 为碰杠区右缘
  drawMelds(leftIdx, SCREEN_W - 10, SCREEN_H / 2 - 90);
}

/**
 * 在路径上追加圆角矩形（用于 clip）
 * @param {number} r 半径，已在外部限制不超过 w/2、h/2
 */
function addRoundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * 绘制麻将牌正面：优先贴 `images/tiles/{typeIdx}.jpg`，否则回退 Unicode 牌面字符。
 * @param {number} x - 牌的左上角X坐标（文字参考基准）
 * @param {number} y - 牌的左上角Y坐标（文字参考基准）
 * @param {number} w - 牌的宽度（用于适配文字大小）
 * @param {number} h - 牌的高度（用于适配文字大小）
 * @param {number} typeIdx - 与 logic.js 一致的牌型索引（0-26）
 */
function drawTileFace(x, y, w, h, typeIdx) {
  const img = getTileImage(typeIdx);
  if (img && img.width > 0 && img.height > 0) {
    const cornerR = Math.min(
      12,
      Math.max(4, Math.floor(Math.min(w, h) * 0.14)),
    );
    ctx.save();
    ctx.beginPath();
    addRoundRectPath(ctx, x, y, w, h, cornerR);
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    return;
  }

  const glyph = tileGlyph(typeIdx);
  ctx.fillStyle = "#f8f8f8";
  ctx.textAlign = "center"; // 文字水平居中
  ctx.textBaseline = "middle"; // 文字垂直居中（比原80%更精准）

  // 恢复原先的字号与字重，避免“牌面变小变细”
  const fontSize = Math.floor(Math.min(w, h) * 1.2);
  ctx.font = `bold ${fontSize}px system-ui`;

  // 绘制牌面符号（精准居中：X=牌中心，Y=牌中心）
  ctx.fillText(glyph, x + w / 2, y + h / 2);
}

// // 给各个玩家模拟生成一些弃牌
// for (let i = 0; i < game.players.length; i++) {
//   const player = game.players[i];
//   for (let j = 0; j < 5; j++) {
//     player.discards.push({
//       typeIdx: Math.floor(Math.random() * 34),
//     });
//   }
// }
// console.log("玩家弃牌", game.players);

/**
 * 绘制所有玩家弃牌
 * @param {*} startX 弃牌起始X坐标
 * @param {*} startY 弃牌起始Y坐标
 */
function drawDiscards(startX, startY, areaWHint) {
  const tileW = 45; // 牌宽
  const tileH = 60; // 牌高
  const discardW = tileW * 0.6;
  const discardH = tileH * 0.6;
  const gap = 3;
  let history = Array.isArray(discardHistoryView) ? discardHistoryView : [];
  if (!history.length) {
    // 兼容旧快照：若服务端还未下发 discardHistory，则回退到按座位聚合数据渲染
    const fallback = [];
    for (let i = 0; i < game.players.length; i++) {
      const arr = game.players[i]?.discards || [];
      for (const tile of arr) fallback.push({ seat: i, tile });
    }
    history = fallback;
  }
  if (!history.length) return;
  const areaW = Math.max(120, Number(areaWHint) || SCREEN_W / 2 - 20);
  const cols = Math.max(1, Math.floor(areaW / (discardW + gap)));
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    const tile = item?.tile;
    if (!tile) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = startX + col * (discardW + gap);
    const y = startY + row * (discardH + gap);
    drawTileFace(x, y, discardW, discardH, tile.typeIdx);
  }
}

/**
 * 自己回合时，在手牌上方给出醒目的出牌提示。
 */
function drawSelfTurnPrompt() {
  if (!multiplayer.state.gameStarted) return;
  if (game.phase !== "discard" || game.current !== 0) return;

  const label = "轮到你出牌";
  const w = 126;
  const h = 30;
  const x = SCREEN_W / 2 - w / 2;
  const y = SCREEN_H - 108;
  const pulse = (Math.sin(Date.now() / 260) + 1) / 2;

  ctx.save();
  ctx.shadowColor = "rgba(255, 228, 94, 0.7)";
  ctx.shadowBlur = 8 + pulse * 6;
  ctx.fillStyle = "rgba(255, 228, 94, 0.92)";
  ctx.beginPath();
  addRoundRectPath(ctx, x, y, w, h, 15);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.70)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  addRoundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14);
  ctx.stroke();
  ctx.fillStyle = "#4a2b00";
  ctx.font = "bold 15px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, SCREEN_W / 2, y + h / 2);
  ctx.restore();
}

/**
 * 绘制碰/杠/过/胡 按钮（当 game.reaction 存在时显示）
 * 按钮区域会记录到 `reactionButtons` 以便触摸检测
 */
function drawReactionButtons() {
  reactionButtons = [];
  if (!game.reaction) return;

  const btnW = 84;
  const btnH = 40;
  const gap = 12;
  const options = [];
  if (game.reaction.canPeng) options.push({ id: "peng", label: "碰" });
  if (game.reaction.canGang) options.push({ id: "gang", label: "杠" });
  if (game.reaction.canAnGang && Array.isArray(game.reaction.anGangTypeIdxs)) {
    for (const tidx of game.reaction.anGangTypeIdxs) {
      options.push({
        id: `an_gang:${tidx}`,
        label: `暗杠${tileName(tidx)}`,
      });
    }
  }
  if (game.reaction.canHu && game.reaction.canPass) {
    options.push({ id: "pass", label: "过" });
    options.push({ id: "hu", label: "胡" });
  } else {
    if (game.reaction.canHu) options.push({ id: "hu", label: "胡" });
    if (game.reaction.canPass) options.push({ id: "pass", label: "过" });
  }
  if (options.length === 0) return;

  const totalW = options.length * btnW + (options.length - 1) * gap;
  const startX = SCREEN_W / 2 - totalW / 2;
  const y = SCREEN_H / 2; // 在底部手牌上方显示

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const x = startX + i * (btnW + gap);
    // 按钮背景
    ctx.fillStyle = "#f0c040";
    ctx.fillRect(x, y, btnW, btnH);
    // 按钮文字
    ctx.fillStyle = "#000";
    ctx.font = "18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(opt.label, x + btnW / 2, y + btnH / 2);
    // 记录可点击区域
    reactionButtons.push({
      id: opt.id,
      left: x,
      top: y,
      right: x + btnW,
      bottom: y + btnH,
    });
  }
}

/**
 * 绘制逞按钮（当玩家可逞时显示）
 */
function drawChengButton() {
  chengButton = null;
  if (!game.canCheng) return;
  const btnW = 56;
  const btnH = 28;
  const gap = 8;
  const leaveBtn = onlineButtons.find((b) => b.id === "leave_room") || null;
  const x = leaveBtn ? leaveBtn.left - gap - btnW : SCREEN_W - btnW - 172;
  const y = leaveBtn ? leaveBtn.top : 8;
  ctx.fillStyle = "#f0c040";
  ctx.fillRect(x, y, btnW, btnH);
  ctx.fillStyle = "#000";
  ctx.font = "16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("逞", x + btnW / 2, y + btnH / 2);
  chengButton = { left: x, top: y, right: x + btnW, bottom: y + btnH };
}

// /**
//  * 绘制胡按钮（当玩家可胡时显示）
//  */
// function drawHuButton() {
//   if (!game.canHu) return;
//   const btnW = 64;
//   const btnH = 30;
//   const x = SCREEN_W / 2 + 200;
//   const y = 5;
//   ctx.fillStyle = "#f0c040";
//   ctx.fillRect(x, y, btnW, btnH);
//   ctx.fillStyle = "#000";
//   ctx.font = "18px sans-serif";
//   ctx.textAlign = "center";
//   ctx.textBaseline = "middle";
//   ctx.fillText("胡", x + btnW / 2, y + btnH / 2);
//   huButton = { left: x, top: y, right: x + btnW, bottom: y + btnH };
// }

/**
 * 绘制局末「再来一局」按钮（仅联机且本局已结束时显示）
 */
function drawPlayAgainButton() {
  const btnW = 88;
  const btnH = 32;
  const x = SCREEN_W / 2 - btnW / 2;
  // 与 drawGameOver 文案对齐：胡牌结算时紧挨「你的本局收支」下方；流局时在「流局」下方
  let y;
  if (game.winner != null && game.winner !== -1) {
    const scoreLineY = SCREEN_H / 2 + 6;
    const scoreFontPx = 22;
    const gapBelowScore = 10;
    y = scoreLineY + scoreFontPx / 2 + gapBelowScore;
  } else {
    const liujuLineY = SCREEN_H / 2;
    const liujuFontPx = 24;
    const gapBelowLiuju = 12;
    y = liujuLineY + liujuFontPx / 2 + gapBelowLiuju;
  }
  ctx.fillStyle = "#f0c040";
  ctx.fillRect(x, y, btnW, btnH);
  ctx.fillStyle = "#102010";
  ctx.font = "16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("再来一局", x + btnW / 2, y + btnH / 2);
  playAgainButton = { left: x, top: y, right: x + btnW, bottom: y + btnH };
}

/**
 * 绘制联机按钮：建房 / 入房 / 准备
 */
function drawOnlineButtons() {
  onlineButtons = [];
  baseStakeButtons = [];
  const roomId = String(multiplayer.state.roomState?.roomId || "").trim();
  const inRoom = !!roomId;
  const inRound = !!multiplayer.state.gameStarted;
  const labels = !inRound
    ? [
        { id: "create_room", text: "建房" },
        { id: "join_room", text: "入房" },
        { id: "ready", text: "准备" },
        { id: "set_bots", text: "电脑人数" },
      ]
    : [];

  const btnW = 62;
  const btnH = 28;
  const gap = 8;
  const startX = 8;
  const y = 58;

  for (let i = 0; i < labels.length; i++) {
    const x = startX + i * (btnW + gap);
    const item = labels[i];
    ctx.fillStyle = "#7dbf5b";
    ctx.fillRect(x, y, btnW, btnH);
    ctx.fillStyle = "#102010";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(item.text, x + btnW / 2, y + btnH / 2);
    onlineButtons.push({
      id: item.id,
      left: x,
      top: y,
      right: x + btnW,
      bottom: y + btnH,
    });
  }

  // 进入房间后始终在右上角显示「退出」按钮（避开微信胶囊）
  if (inRoom) {
    const leaveBtnW = 56;
    const validMenuRect =
      !!menuButtonRect &&
      Number.isFinite(menuButtonRect.left) &&
      Number.isFinite(menuButtonRect.top) &&
      Number.isFinite(menuButtonRect.height) &&
      menuButtonRect.left > SCREEN_W * 0.5 &&
      menuButtonRect.left < SCREEN_W;
    const leaveX = validMenuRect
      ? Math.max(8, menuButtonRect.left - leaveBtnW - 12)
      : SCREEN_W - leaveBtnW - 108;
    const leaveY = validMenuRect
      ? Math.max(0, menuButtonRect.top + (menuButtonRect.height - btnH) / 2)
      : 8;
    ctx.fillStyle = "#7dbf5b";
    ctx.fillRect(leaveX, leaveY, leaveBtnW, btnH);
    ctx.fillStyle = "#102010";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("退出", leaveX + leaveBtnW / 2, leaveY + btnH / 2);
    onlineButtons.push({
      id: "leave_room",
      left: leaveX,
      top: leaveY,
      right: leaveX + leaveBtnW,
      bottom: leaveY + btnH,
    });
  }

  // 未开局：底金选择（大厅预设 / 等待房内房主可调）
  if (!inRound) {
    ensureLobbyBaseStakeLoaded();
    const room = multiplayer.state.roomState;
    const waiting = room?.status === "waiting";
    const bsFromRoom = Number(room?.baseStake);
    const roomStake = BASE_STAKE_CHOICES.includes(bsFromRoom)
      ? bsFromRoom
      : null;
    const effectiveStake =
      inRoom && roomStake != null ? roomStake : lobbyPreferredBaseStake;
    const ownerHere = room && room.ownerUid === multiplayer.state.uid;
    const canEditInRoom = inRoom && waiting && ownerHere;
    const canEditLobby = !inRoom;
    const canTap = canEditLobby || canEditInRoom;

    const optH = 22;
    const optW = 32;
    const optGap = 4;
    const optY = 106;
    const rowMidY = optY + optH / 2;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e8f4ff";
    ctx.font = "11px sans-serif";
    ctx.fillText("底金", 8, rowMidY);
    let ox = 40;
    for (const amt of BASE_STAKE_CHOICES) {
      const sel = amt === effectiveStake;
      ctx.fillStyle = canTap
        ? sel
          ? "#ffd35a"
          : "#7dbf5b"
        : sel
          ? "#a89868"
          : "#5a7050";
      ctx.fillRect(ox, optY, optW, optH);
      ctx.fillStyle = "#102010";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${amt}`, ox + optW / 2, rowMidY);
      baseStakeButtons.push({
        amt,
        left: ox,
        top: optY,
        right: ox + optW,
        bottom: optY + optH,
        disabled: !canTap,
      });
      ox += optW + optGap;
    }
    ctx.textAlign = "left";
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#e8f4ff";
    ctx.fillText("元", ox + 2, rowMidY);
  }
}

function drawStartGameEntryButton() {
  const btnW = 190;
  const btnH = 46;
  const x = SCREEN_W / 2 - btnW / 2;
  const y = SCREEN_H / 2 - btnH / 2;
  ctx.fillStyle = "#7dbf5b";
  ctx.fillRect(x, y, btnW, btnH);
  ctx.fillStyle = "#102010";
  ctx.font = "18px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("开始", x + btnW / 2, y + btnH / 2);
  startGameEntryButton = { left: x, top: y, right: x + btnW, bottom: y + btnH };
}

/** 未授权启动页：仅展示标题和开始按钮 */
function drawAuthGateScreen() {
  ctx.fillStyle = "#1A5F44";
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "28px sans-serif";
  ctx.fillText("荆州麻将  逞癞子", SCREEN_W / 2, 120);
  // 开始页也显示状态，便于定位授权链路问题
  ctx.font = "14px sans-serif";
  ctx.fillStyle = "#e8f4ff";
  // 与居中「开始」按钮拉开间距，避免长句授权提示与按钮重叠
  ctx.fillText(game.status || "请点击开始", SCREEN_W / 2, 148);
  drawStartGameEntryButton();
}

// // 绘制单张弃牌
// function drawDiscard(tile) {
//   const tileW = 45; // 牌宽
//   const tileH = 60; // 牌高

//   // 绘制玩家弃牌
//   const x = i * tileW + 20;
//   const y = SCREEN_H - 80;
//   drawTile(tile, x, y);
// }

/** 侧家（东/西）碰杠区底部 Y（与 drawMelds 一行两组一致） */
function estimateSideMeldsBottomY(playerIdx, startY) {
  const player = game.players[playerIdx];
  if (!player || !Array.isArray(player.melds) || player.melds.length === 0)
    return startY;
  const tileH = 60;
  const meldH = tileH * 0.6;
  const rowGap = 6;
  const numRows = Math.ceil(player.melds.length / 2);
  return startY + numRows * (meldH + rowGap);
}

/** 北家碰杠区下缘（与 drawMeldsNorth 单行高度一致，略留边） */
function estimateNorthMeldsBottomY(playerIdx) {
  const player = game.players[playerIdx];
  if (!player || !Array.isArray(player.melds) || player.melds.length === 0)
    return 60;
  const meldH = 60 * 0.6;
  return 60 + meldH + 12;
}

/**
 * 胡牌结算时展示胡家手牌（仅本地座位非己方的胡家），排在碰杠区下方避免遮挡
 */
function drawWinnerRevealHands() {
  if (
    game.phase !== "gameover" ||
    !Array.isArray(game.winnerExposeHand) ||
    !game.winnerExposeHand.length
  ) {
    return;
  }
  const wl = game.winner;
  if (!Number.isInteger(wl) || wl <= 0 || wl > 3) return;
  const tiles = game.winnerExposeHand;
  const tw = 34;
  const th = 46;
  const gap = 2;
  const n = tiles.length;
  const totalW = n * tw + (n - 1) * gap;

  if (wl === 1) {
    const meldBottom = estimateSideMeldsBottomY(1, SCREEN_H / 2 - 90);
    const y = Math.min(meldBottom + 6, SCREEN_H - th - 20);
    let x = 12;
    for (let i = 0; i < n; i += 1) {
      drawTileFace(x + i * (tw + gap), y, tw, th, tiles[i].typeIdx);
    }
  } else if (wl === 3) {
    const meldBottom = estimateSideMeldsBottomY(3, SCREEN_H / 2 - 90);
    const y = Math.min(meldBottom + 6, SCREEN_H - th - 20);
    let x = SCREEN_W - totalW - 14;
    if (x < 6) x = 6;
    for (let i = 0; i < n; i += 1) {
      drawTileFace(x + i * (tw + gap), y, tw, th, tiles[i].typeIdx);
    }
  } else if (wl === 2) {
    const y = estimateNorthMeldsBottomY(2) + 8;
    let x = Math.max(6, (SCREEN_W - totalW) / 2);
    for (let i = 0; i < n; i += 1) {
      drawTileFace(x + i * (tw + gap), y, tw, th, tiles[i].typeIdx);
    }
  }
}

/**
 * 游戏结束时的界面绘制（显示赢家和结算金额）
 */
function drawGameOver() {
  if (game.phase === "gameover" && game.winner === -1) {
    ctx.save();
    fillTableDimOverlay();
    ctx.fillStyle = "#ff6b6b";
    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("流局", SCREEN_W / 2, SCREEN_H / 2);
    ctx.restore();
  } else if (game.phase === "gameover" && game.winner !== -1) {
    ctx.save();
    fillTableDimOverlay();
    // 蒙层之上展示胡家手牌，再叠结算文案
    drawWinnerRevealHands();
    const name = game.players[game.winner].name;
    const huLbl = String(game.huTypeLabel || "").trim();
    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = 6;
    ctx.fillStyle = "#fff8e1";
    ctx.fillText(
      huLbl ? `${name} 胡牌（${huLbl}）` : `${name} 胡牌`,
      SCREEN_W / 2,
      SCREEN_H / 2 - 40,
    );
    const sign = game.score >= 0 ? "+" : "";
    ctx.font = "22px sans-serif";
    ctx.fillText(
      `你的本局收支：${sign}${game.score} 元`,
      SCREEN_W / 2,
      SCREEN_H / 2 + 6,
    );
    ctx.shadowBlur = 0;
    ctx.restore();
  }
}

/**
 * 游戏主循环（持续渲染界面）
 */
function loop() {
  ctx.setTransform(CANVAS_DPR, 0, 0, CANVAS_DPR, 0, 0);
  // 计算帧率
  const now = Date.now();
  const dt = now - lastFrameTime; // 两帧之间的时间差
  lastFrameTime = now;
  fps = 1000 / (dt || 1); // 帧率 = 1000ms / 帧间隔（避免除以0）

  if (!profileReady) {
    // 未授权：只显示标题和中间开始按钮
    onlineButtons = [];
    drawAuthGateScreen();
    requestAnimationFrame(loop);
    return;
  }

  // 按层级绘制界面（从下到上）
  drawBackground();
  drawHeader();
  startGameEntryButton = null;
  drawOnlineButtons();
  drawRoomPlayersPanel(); // 绘制房间玩家面板
  if (multiplayer.state.gameStarted) {
    drawHandsAndDiscards();
    drawSelfTurnPrompt();
    drawReactionButtons(); //  绘制反应按钮（碰/杠/过）
    drawChengButton(); //  绘制逞按钮
    //   drawHuButton(); //  绘制胡按钮
  }
  if (profileReady) {
    tryAutoJoinPendingRoom();
  }
  // drawFPS(); // 5. 绘制帧率

  playAgainButton = null;
  if (multiplayer.state.gameStarted) {
    drawGameOver();
    if (game.phase === "gameover") {
      drawPlayAgainButton();
    }
  }

  // 请求下一帧渲染（浏览器/小游戏的原生API）
  requestAnimationFrame(loop);
}

// ========================== 交互事件处理 ==========================
/**
 * 触摸出牌：监听Canvas触摸事件，检测是否点击了己方手牌
 */
function handleTouchStart(event) {
  event.preventDefault(); // 阻止默认触摸事件

  // 获取触摸点坐标
  const touchList =
    (event.touches && event.touches.length > 0 && event.touches) ||
    (event.changedTouches &&
      event.changedTouches.length > 0 &&
      event.changedTouches) ||
    [];
  if (!touchList.length) return;
  const touch = touchList[0];
  const x = Number(
    touch.clientX ?? touch.x ?? touch.pageX ?? touch.screenX ?? -1,
  );
  const y = Number(
    touch.clientY ?? touch.y ?? touch.pageY ?? touch.screenY ?? -1,
  );
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return;
  }

  if (!profileReady) {
    if (
      startGameEntryButton &&
      x >= startGameEntryButton.left &&
      x <= startGameEntryButton.right &&
      y >= startGameEntryButton.top &&
      y <= startGameEntryButton.bottom
    ) {
      console.log("[auth] button tapped", { x, y });
      requestProfileAndStart();
    } else {
      setStatus("请点击中间按钮授权头像昵称");
    }
    return;
  }

  // 检查是否点击联机按钮
  for (const b of onlineButtons) {
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
      if (b.id === "create_room") {
        ensureLobbyBaseStakeLoaded();
        multiplayer.createRoom({ baseStake: lobbyPreferredBaseStake });
      } else if (b.id === "join_room") {
        // 第一版固定房号输入：优先使用已知房号，否则弹窗输入
        let roomNo = multiplayer.state.roomNo;
        if (!roomNo && typeof wx.showModal === "function") {
          wx.showModal({
            title: "请输入房号",
            editable: true,
            placeholderText: "6位房号",
            success: (res) => {
              if (res.confirm) {
                const value = (res.content || "").trim();
                if (value) multiplayer.joinRoom(value);
              }
            },
          });
        } else if (roomNo) {
          multiplayer.joinRoom(roomNo);
        }
      } else if (b.id === "ready") {
        const players = multiplayer.state.roomState?.players || [];
        const me = players.find((p) => p.uid === multiplayer.state.uid);
        multiplayer.ready(!(me && me.ready));
      } else if (b.id === "set_bots") {
        const room = multiplayer.state.roomState;
        const isOwner = room && room.ownerUid === multiplayer.state.uid;
        if (!isOwner) {
          setStatus("只有房主可以设置电脑人数");
          return;
        }
        const bots = (room?.players || []).filter((p) => p.isBot).length;
        const next = (bots + 1) % 4;
        multiplayer.setBots(next);
      } else if (b.id === "leave_room") {
        const room = multiplayer.state.roomState;
        if (!room?.roomId) {
          setStatus("当前不在房间中");
          return;
        }
        multiplayer.leaveRoom();
        setStatus("正在关闭房间并返回大厅...");
      }
      return;
    }
  }

  for (const b of baseStakeButtons) {
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
      if (b.disabled) {
        setStatus("仅房主可在等待阶段调整底金");
        return;
      }
      const amt = Number(b.amt);
      if (!BASE_STAKE_CHOICES.includes(amt)) return;
      const room = multiplayer.state.roomState;
      const inRoom = !!(room && room.roomId);
      const waiting = room?.status === "waiting";
      const ownerHere = room && room.ownerUid === multiplayer.state.uid;
      if (inRoom && waiting && ownerHere) {
        multiplayer.setRoomBaseStake(amt);
      } else if (!inRoom) {
        lobbyPreferredBaseStake = amt;
        persistLobbyPreferredBaseStake();
        setStatus(`底金已设为 ${amt} 元（下次建房生效）`);
      }
      return;
    }
  }

  if (multiplayer.state.gameStarted && game.phase === "gameover") {
    if (playAgainButton) {
      if (
        x >= playAgainButton.left &&
        x <= playAgainButton.right &&
        y >= playAgainButton.top &&
        y <= playAgainButton.bottom
      ) {
        const room = multiplayer.state.roomState;
        const isOwner = room && room.ownerUid === multiplayer.state.uid;
        if (!isOwner) {
          setStatus("仅房主可开下一局");
          return;
        }
        multiplayer.nextRound();
        setStatus("正在开新一局…");
        return;
      }
    }
    return;
  }

  // 1) 反应按钮（碰/杠/胡/过/暗杠等）
  if (
    multiplayer.state.gameStarted &&
    game.reaction &&
    reactionButtons.length > 0
  ) {
    for (const b of reactionButtons) {
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
        if (String(b.id).startsWith("an_gang:")) {
          const typeIdx = Number(String(b.id).slice(8));
          multiplayer.react("an_gang", { typeIdx });
        } else {
          multiplayer.react(b.id);
        }
        return;
      }
    }
  }
  // 2) 逞：与「胡」可同时出现，必须用独立分支；原先写在 else if 里会导致有胡按钮时永远不检测逞
  if (multiplayer.state.gameStarted && chengButton) {
    if (
      x >= chengButton.left &&
      x <= chengButton.right &&
      y >= chengButton.top &&
      y <= chengButton.bottom
    ) {
      multiplayer.react("cheng");
      return;
    }
  }

  const interactive =
    multiplayer.state.gameStarted &&
    game.winner === null &&
    game.current === 0 &&
    game.phase === "discard";
  if (!interactive) return;

  // 遍历手牌位置，判断是否点击了手牌
  for (const slot of handSlots) {
    if (
      x >= slot.left &&
      x <= slot.right &&
      y >= slot.top &&
      y <= slot.bottom
    ) {
      const myHand = game.players[0]?.hand || [];
      const tile = myHand[slot.index];
      if (tile) {
        if (tile.typeIdx === game.laiziTypeIdx) {
          setStatus("癞子不可直接打出，请使用逞");
          return;
        }
        multiplayer.discard(tile.id);
      }
      return;
    }
  }
}

// 微信小游戏真机环境优先使用 wx.onTouchStart
if (typeof wx !== "undefined" && typeof wx.onTouchStart === "function") {
  wx.onTouchStart((event) => {
    handleTouchStart({
      preventDefault: () => {},
      touches: event.touches || [],
      changedTouches: event.changedTouches || [],
    });
  });
} else if (canvas && typeof canvas.addEventListener === "function") {
  // 兼容可用 addEventListener 的环境（例如部分模拟器）
  canvas.addEventListener("touchstart", handleTouchStart);
}

// 启动游戏主循环
loop();

// todo list:
// 1. 添加逞的次数显示
// 2. 测试杠的时候计分是否正确
// 3. 添加自摸的计分逻辑
// 4. 接入微信云服务，添加其他真人玩家，测试网络通信和多人游戏逻辑
// 5. 美化界面，添加牌背图案，优化牌面设计，增加动画效果（如出牌动画、碰杠动画等）
