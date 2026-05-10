/**
 * README 结算（联机权威）：底钱、软/硬胡、油、直杠、顶果碰、暗杠。
 * 金额记在 gameSnapshot.scoreDeltaByUid（本局累计，进程内）。
 */

const BASE_STAKE_OPTIONS = [1, 2, 5, 10];
const DEFAULT_BASE_STAKE = 5;

function normalizeBaseStake(n) {
  const v = Number(n);
  if (BASE_STAKE_OPTIONS.includes(v)) return v;
  return DEFAULT_BASE_STAKE;
}

/** 将「以 5 元为基准」的参考金额换算为当前房间底金（四舍五入为整数元） */
function stakeMoney(room, refAtBase5) {
  const stake = normalizeBaseStake(room?.baseStake);
  return Math.round((Number(refAtBase5) * stake) / 5);
}

function initRoundMoney(ss, room) {
  if (!ss.chengCountBySeat) {
    ss.chengCountBySeat = { 0: 0, 1: 0, 2: 0, 3: 0 };
  }
  for (let s = 0; s < 4; s++) {
    if (ss.chengCountBySeat[s] == null) ss.chengCountBySeat[s] = 0;
  }
  if (ss.oilEligibleSeat === undefined) ss.oilEligibleSeat = null;
  if (!ss.scoreDeltaByUid) ss.scoreDeltaByUid = {};
  for (const p of room.players) {
    if (ss.scoreDeltaByUid[p.uid] == null) ss.scoreDeltaByUid[p.uid] = 0;
  }
}

function addScoreDelta(ss, uid, delta) {
  ss.scoreDeltaByUid[uid] = (ss.scoreDeltaByUid[uid] || 0) + delta;
}

function handHasLaiziInWinningHand(ss, room, seat) {
  const p = room.players.find((x) => x.seat === seat);
  if (!p || ss.laiziTypeIdx == null) return false;
  const h = ss.handsByUid[p.uid] || [];
  return h.some((t) => t.typeIdx === ss.laiziTypeIdx);
}

/** 直杠：点杠者付杠牌者 15 */
function settleZhigang(room, gangSeat, fromSeat) {
  const ss = room.gameSnapshot;
  initRoundMoney(ss, room);
  const gangP = room.players.find((p) => p.seat === gangSeat);
  const fromP = room.players.find((p) => p.seat === fromSeat);
  if (!gangP || !fromP) return;
  const m = stakeMoney(room, 15);
  addScoreDelta(ss, fromP.uid, -m);
  addScoreDelta(ss, gangP.uid, m);
}

/**
 * 顶果：手上一对顶果，别人打顶果，碰牌 — 打牌者当时付碰牌者 15
 * @param {boolean} hadPairInHand 碰前手牌里是否已有至少 2 张顶果
 */
function settleDingguoPeng(room, pengSeat, fromSeat, hadPairInHand) {
  if (!hadPairInHand) return;
  const ss = room.gameSnapshot;
  initRoundMoney(ss, room);
  const pengP = room.players.find((p) => p.seat === pengSeat);
  const fromP = room.players.find((p) => p.seat === fromSeat);
  if (!pengP || !fromP) return;
  const m = stakeMoney(room, 15);
  addScoreDelta(ss, fromP.uid, -m);
  addScoreDelta(ss, pengP.uid, m);
}

/**
 * 自摸结算（README：仅自摸；油 / 软硬胡 + 逞倍数）
 * @param {boolean} isOil 是否「逞后补摸立即胡」
 */
function settleSelfHu(room, winnerSeat, isOil) {
  const ss = room.gameSnapshot;
  initRoundMoney(ss, room);
  const winP = room.players.find((p) => p.seat === winnerSeat);
  if (!winP) {
    return { kind: "hu", label: "", isOil: false };
  }

  const soft = handHasLaiziInWinningHand(ss, room, winnerSeat);
  let totalGain = 0;

  if (isOil) {
    const per = stakeMoney(room, soft ? 20 : 40);
    for (const p of room.players) {
      if (p.seat === winnerSeat) continue;
      addScoreDelta(ss, p.uid, -per);
      totalGain += per;
    }
    addScoreDelta(ss, winP.uid, totalGain);
    return {
      kind: "oil",
      label: soft ? "软油" : "黑油",
      isOil: true,
      perPerson: per,
    };
  }

  const base = stakeMoney(room, soft ? 5 : 10);
  const chengMult = (count) => {
    const n = Math.max(0, Number(count) || 0);
    return 2 ** n;
  };
  const wCheng = ss.chengCountBySeat[winnerSeat] || 0;
  const wMult = chengMult(wCheng);
  for (const p of room.players) {
    if (p.seat === winnerSeat) continue;
    const pCheng = ss.chengCountBySeat[p.seat] || 0;
    const pMult = chengMult(pCheng);
    const pay = base * wMult * pMult;
    addScoreDelta(ss, p.uid, -pay);
    totalGain += pay;
  }
  addScoreDelta(ss, winP.uid, totalGain);
  return {
    kind: "hu",
    label: soft ? "软胡" : "硬胡",
    isOil: false,
    base,
    winnerChengMult: wMult,
  };
}

/** 暗杠：三家各付 10，杠牌者共收 30 */
function settleAnGang(room, gangSeat) {
  const ss = room.gameSnapshot;
  initRoundMoney(ss, room);
  const gangP = room.players.find((p) => p.seat === gangSeat);
  if (!gangP) return;
  const pay = stakeMoney(room, 10);
  let gain = 0;
  for (const p of room.players) {
    if (p.seat === gangSeat) continue;
    addScoreDelta(ss, p.uid, -pay);
    gain += pay;
  }
  addScoreDelta(ss, gangP.uid, gain);
}

function cloneScoreDelta(ss) {
  return { ...(ss.scoreDeltaByUid || {}) };
}

module.exports = {
  initRoundMoney,
  addScoreDelta,
  settleZhigang,
  settleDingguoPeng,
  settleAnGang,
  settleSelfHu,
  handHasLaiziInWinningHand,
  cloneScoreDelta,
  normalizeBaseStake,
  stakeMoney,
};
