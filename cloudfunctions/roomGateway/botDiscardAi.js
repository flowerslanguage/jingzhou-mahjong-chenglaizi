/**
 * 联机/单机共用的电脑出牌选张（轻量启发式）
 * - 用「四张暗杠材→刻→顺」迭代吃定已成型的面子，仅从未被吃定的余张里选打（避免乱拆顺/刻/暗杠）
 * - 顺子提取时临时屏蔽癞子点数，避免把癞子当普通张锁进顺子
 * - 在候选上用进张数（听牌张数）最大化，避免明显倒退听牌质量
 * - 多癞子优先打癞子（与上层 runBots 逻辑一致，此处再兜底）
 *
 * 维护：修改后请同步复制到 cloudfunctions/roomGateway/botDiscardAi.js（微信云仅上传该目录时依赖本地副本）
 */

const TILE_KIND_COUNT = 27;

function countsKey(counts) {
  return counts.join(",");
}

/** 递归判断剩余牌是否都能组成面子（刻子/顺子），会修改 counts 调用方需 clone */
function canFormMelds(counts, memo) {
  const key = countsKey(counts);
  if (memo.has(key)) return memo.get(key);
  let i = 0;
  while (i < TILE_KIND_COUNT && counts[i] === 0) i += 1;
  if (i === TILE_KIND_COUNT) {
    memo.set(key, true);
    return true;
  }
  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canFormMelds(counts, memo)) {
      counts[i] += 3;
      memo.set(key, true);
      return true;
    }
    counts[i] += 3;
  }
  const suit = Math.floor(i / 9);
  const pos = i % 9;
  if (pos <= 6 && Math.floor((i + 2) / 9) === suit && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i] -= 1;
    counts[i + 1] -= 1;
    counts[i + 2] -= 1;
    if (canFormMelds(counts, memo)) {
      counts[i] += 1;
      counts[i + 1] += 1;
      counts[i + 2] += 1;
      memo.set(key, true);
      return true;
    }
    counts[i] += 1;
    counts[i + 1] += 1;
    counts[i + 2] += 1;
  }
  memo.set(key, false);
  return false;
}

function canFormMeldsWithLaizi(counts, laizi, memo) {
  const key = countsKey(counts) + "|" + laizi;
  if (memo.has(key)) return memo.get(key);

  let total = 0;
  for (let v of counts) total += v;

  if ((total + laizi) % 3 !== 0) {
    memo.set(key, false);
    return false;
  }

  if (total === 0) {
    const ok = laizi % 3 === 0;
    memo.set(key, ok);
    return ok;
  }

  let i = 0;
  while (i < TILE_KIND_COUNT && counts[i] === 0) i += 1;
  if (i === TILE_KIND_COUNT) {
    const ok = laizi % 3 === 0;
    memo.set(key, ok);
    return ok;
  }

  for (let use = Math.min(counts[i], 3); use >= 0; use -= 1) {
    const need = 3 - use;
    if (need > laizi) continue;
    const cp = counts.slice();
    cp[i] -= use;
    if (canFormMeldsWithLaizi(cp, laizi - need, memo)) {
      memo.set(key, true);
      return true;
    }
  }

  const pos = i % 9;
  if (pos <= 6 && Math.floor((i + 2) / 9) === Math.floor(i / 9)) {
    const j = i + 1;
    const k = i + 2;
    const combinations = [
      { ni: 0, nj: 0, nk: 0, need: 0 },
      { ni: 1, nj: 0, nk: 0, need: 1 },
      { ni: 0, nj: 1, nk: 0, need: 1 },
      { ni: 0, nj: 0, nk: 1, need: 1 },
    ];
    for (const combo of combinations) {
      const { ni, nj, nk, need } = combo;
      if (need > laizi) continue;
      const okI = counts[i] >= 1 - ni;
      const okJ = counts[j] >= 1 - nj;
      const okK = counts[k] >= 1 - nk;
      if (!okI || !okJ || !okK) continue;
      const cp = counts.slice();
      if (ni === 0) cp[i] -= 1;
      if (nj === 0) cp[j] -= 1;
      if (nk === 0) cp[k] -= 1;
      if (canFormMeldsWithLaizi(cp, laizi - need, memo)) {
        memo.set(key, true);
        return true;
      }
    }
  }

  memo.set(key, false);
  return false;
}

function isWinningHandCountsNoLaizi(countsIn) {
  const counts = countsIn.slice();
  for (let i = 0; i < TILE_KIND_COUNT; i += 1) {
    if (counts[i] >= 2) {
      counts[i] -= 2;
      if (canFormMelds(counts, new Map())) {
        return true;
      }
      counts[i] += 2;
    }
  }
  return false;
}

function isWinningWithLaizi(originalCounts, laiziIdx) {
  const counts = originalCounts.slice();
  let laizi = counts[laiziIdx] || 0;
  counts[laiziIdx] = 0;

  const total = counts.reduce((a, b) => a + b, 0) + laizi;
  if (total !== 14) return false;

  const memo = new Map();
  for (let i = 0; i < TILE_KIND_COUNT; i += 1) {
    const have = counts[i];
    const need = Math.max(2 - have, 0);
    if (need > laizi) continue;
    const cp = counts.slice();
    cp[i] -= Math.min(2, have);
    if (canFormMeldsWithLaizi(cp, laizi - need, memo)) return true;
  }
  if (laizi >= 2 && canFormMeldsWithLaizi(counts, laizi - 2, memo)) return true;
  return false;
}

function canHuByTypes(typeIdxs, laiziTypeIdx) {
  if (!Array.isArray(typeIdxs) || typeIdxs.length !== 14) return false;
  const counts = new Array(TILE_KIND_COUNT).fill(0);
  for (const t of typeIdxs) counts[t] += 1;
  if (laiziTypeIdx == null || laiziTypeIdx < 0) {
    return isWinningHandCountsNoLaizi(counts);
  }
  const laiziCount = counts[laiziTypeIdx] || 0;
  if (laiziCount > 1) return false;
  return isWinningWithLaizi(counts, laiziTypeIdx);
}

function isTingByTypes(typeIdxs, laiziTypeIdx) {
  const hand = Array.isArray(typeIdxs) ? typeIdxs.slice() : [];
  for (let t = 0; t < TILE_KIND_COUNT; t += 1) {
    const test = hand.concat([t]);
    if (canHuByTypes(test, laiziTypeIdx)) return true;
  }
  return false;
}

function handToCounts(handTiles) {
  const c = new Array(TILE_KIND_COUNT).fill(0);
  for (const t of handTiles || []) {
    const v = Number(t?.typeIdx);
    if (Number.isInteger(v) && v >= 0 && v < TILE_KIND_COUNT) c[v] += 1;
  }
  return c;
}

function mergeHandMeldTypes(handTiles, melds) {
  const types = (handTiles || []).map((t) => t.typeIdx);
  for (const m of melds || []) {
    for (let i = 0; i < 3; i += 1) types.push(Number(m.tileTypeIdx));
  }
  return types;
}

function typesAfterDiscardHandTile(handTiles, melds, tileId) {
  const idx = (handTiles || []).findIndex((t) => t.id === tileId);
  if (idx < 0) return null;
  const types = handTiles.map((t) => t.typeIdx);
  types.splice(idx, 1);
  for (const m of melds || []) {
    for (let i = 0; i < 3; i += 1) types.push(Number(m.tileTypeIdx));
  }
  return types;
}

/** 四张同色为暗杠机会，整组视为锁定，不得拆打其中一张（先于刻子吃掉） */
function oneRoundAnGangBlock(rem) {
  let did = false;
  for (let t = 0; t < TILE_KIND_COUNT; t += 1) {
    while (rem[t] >= 4) {
      rem[t] -= 4;
      did = true;
    }
  }
  return did;
}

function oneRoundTriplet(rem) {
  let did = false;
  for (let t = 0; t < TILE_KIND_COUNT; t += 1) {
    while (rem[t] >= 3) {
      rem[t] -= 3;
      did = true;
    }
  }
  return did;
}

/** 顺子只吃「非癞子」三张（癞子可当万能牌，不锁进固定顺） */
function oneRoundChiNoLaizi(rem, laiziTypeIdx) {
  let did = false;
  for (let suit = 0; suit < 3; suit += 1) {
    const b = suit * 9;
    for (let s = 0; s <= 6; s += 1) {
      const i = b + s;
      if (laiziTypeIdx != null && laiziTypeIdx >= 0) {
        if (i === laiziTypeIdx || i + 1 === laiziTypeIdx || i + 2 === laiziTypeIdx) continue;
      }
      if (rem[i] >= 1 && rem[i + 1] >= 1 && rem[i + 2] >= 1) {
        rem[i] -= 1;
        rem[i + 1] -= 1;
        rem[i + 2] -= 1;
        did = true;
      }
    }
  }
  return did;
}

/**
 * 迭代吃定「暗杠四张→刻子 +（不含癞子点的）顺子」后的余量；癞子张数在顺子阶段临时置 0 避免误锁
 */
function extractSurplusCounts(handCountsIn, laiziTypeIdx) {
  const rem = handCountsIn.slice();
  let guard = 0;
  while (guard < 120) {
    guard += 1;
    let changed = false;
    while (oneRoundAnGangBlock(rem)) changed = true;
    while (oneRoundTriplet(rem)) changed = true;
    const savedLz =
      laiziTypeIdx != null && laiziTypeIdx >= 0 ? rem[laiziTypeIdx] : null;
    if (savedLz != null) rem[laiziTypeIdx] = 0;
    let chiRound = 0;
    while (chiRound < 40 && oneRoundChiNoLaizi(rem, laiziTypeIdx)) {
      chiRound += 1;
      changed = true;
    }
    if (savedLz != null) rem[laiziTypeIdx] = savedLz;
    if (!changed) break;
  }
  return rem;
}

function countUkeire13(types13, laiziTypeIdx) {
  let c = 0;
  for (let w = 0; w < TILE_KIND_COUNT; w += 1) {
    if (canHuByTypes(types13.concat([w]), laiziTypeIdx)) c += 1;
  }
  return c;
}

function suitOf(typeIdx) {
  return Math.floor(typeIdx / 9);
}

function numberOf(typeIdx) {
  return (typeIdx % 9) + 1;
}

/** 分数越高越应「保留」；选打时在同 ukeire 下取 usefulness 最低 */
function usefulnessScore(typeIdx, counts) {
  let score = 0;
  const c = counts[typeIdx] || 0;
  if (c >= 3) score += 30;
  else if (c === 2) score += 15;
  else if (c === 1) score += 3;

  const s = suitOf(typeIdx);
  const n = numberOf(typeIdx);
  const base = s * 9;
  const get = (num) => {
    if (num < 1 || num > 9) return 0;
    return counts[base + (num - 1)] || 0;
  };
  if (n <= 7 && get(n + 1) > 0 && get(n + 2) > 0) score += 25;
  if (n >= 2 && n <= 8 && get(n - 1) > 0 && get(n + 1) > 0) score += 25;
  if (n >= 3 && get(n - 1) > 0 && get(n - 2) > 0) score += 25;
  if (n <= 8 && get(n + 1) > 0) score += 12;
  if (n >= 2 && get(n - 1) > 0) score += 12;
  if (n <= 7 && get(n + 2) > 0) score += 8;
  if (n >= 3 && get(n - 2) > 0) score += 8;
  if (n === 1 && get(2) > 0 && get(3) > 0) score += 6;
  if (n === 9 && get(8) > 0 && get(7) > 0) score += 6;
  return score;
}

function discardDesirability(typeIdx, counts) {
  let d = 0;
  const n = numberOf(typeIdx);
  if (n === 1 || n === 9) d += 6;
  const c = counts[typeIdx] || 0;
  if (c <= 1) d += 4;
  if (c === 4) d += 5;
  return d;
}

/**
 * @param {{id:number,typeIdx:number}[]} handTiles
 * @param {object[]} melds
 * @param {number|null} laiziTypeIdx
 * @returns {number|null} 要打出的牌的 id
 */
function chooseBotDiscardTileId(handTiles, melds, laiziTypeIdx) {
  const hand = Array.isArray(handTiles) ? handTiles.slice() : [];
  if (hand.length === 0) return null;

  const merged = mergeHandMeldTypes(hand, melds);
  if (merged.length !== 14) {
    return hand[hand.length - 1].id;
  }

  if (laiziTypeIdx != null && laiziTypeIdx >= 0) {
    const lzTiles = hand.filter((t) => t.typeIdx === laiziTypeIdx);
    if (lzTiles.length > 1) return lzTiles[0].id;
  }

  const handCounts = handToCounts(hand);
  const surplus = extractSurplusCounts(handCounts, laiziTypeIdx);
  let candidates = hand.filter((t) => surplus[t.typeIdx] > 0);
  if (candidates.length === 0) candidates = hand.slice();

  let bestU = -1;
  const scored = [];
  for (const t of candidates) {
    const types13 = typesAfterDiscardHandTile(hand, melds, t.id);
    if (!types13 || types13.length !== 13) continue;
    const u = countUkeire13(types13, laiziTypeIdx);
    scored.push({ tile: t, u });
    if (u > bestU) bestU = u;
  }
  if (bestU < 0) return hand[hand.length - 1].id;

  const tier = scored.filter((x) => x.u === bestU);
  tier.sort((a, b) => {
    const ua = usefulnessScore(a.tile.typeIdx, handCounts);
    const ub = usefulnessScore(b.tile.typeIdx, handCounts);
    if (ua !== ub) return ua - ub;
    const da = discardDesirability(a.tile.typeIdx, handCounts);
    const db = discardDesirability(b.tile.typeIdx, handCounts);
    if (da !== db) return db - da;
    if (a.tile.typeIdx !== b.tile.typeIdx) return b.tile.typeIdx - a.tile.typeIdx;
    return a.tile.id - b.tile.id;
  });
  return tier[0].tile.id;
}

module.exports = {
  TILE_KIND_COUNT,
  chooseBotDiscardTileId,
  canHuByTypes,
  isTingByTypes,
  mergeHandMeldTypes,
  extractSurplusCounts,
};
