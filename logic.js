// ========================== 核心说明 ==========================
// 文件名：麻将核心逻辑模块（logic.js）
// 核心特性：
// 1. 无DOM依赖，可复用（网页版/微信小游戏/Node.js）
// 2. 实现麻将基础逻辑：牌型定义、洗牌发牌、胡牌判定（含癞子规则）、出牌逻辑
// 3. 仅支持万/筒/条三门牌（共27种），适配荆州麻将"逞癞子"规则
// =================================================================
// ========================== 常量定义 ==========================
/** 牌型总数：万(0-8)、筒(9-17)、条(18-26)，共27种 */
const TILE_KIND_COUNT = 27;
/** 与联机/界面一致：逆时针 南(0)→东(3)→北(2)→西(1) */
const PLAY_ORDER_CCW = [0, 3, 2, 1];

function nextSeatCCW(seat) {
  const s = Number(seat);
  const idx = PLAY_ORDER_CCW.indexOf(s);
  if (idx < 0) return (s + 3) % 4;
  return PLAY_ORDER_CCW[(idx + 1) % 4];
}

/** 与联机端一致的电脑选打（Node/小游戏有 require 时启用） */
let botDiscardAi = null;
try {
  botDiscardAi = require("./shared/botDiscardAi");
} catch (e) {
  botDiscardAi = null;
}

/** 花色定义：包含标识、名称、起始索引 */
const SUITS = [
  { key: "m", name: "万", base: 0 }, // 万子：索引0-8
  { key: "p", name: "筒", base: 9 }, // 筒子：索引9-17
  { key: "s", name: "条", base: 18 }, // 条子：索引18-26
];

// ========================== 牌型工具函数 ==========================

/**
 * 校验牌型索引是否为有效花色（万/筒/条）
 * @param {number} typeIdx - 牌型索引
 * @returns {boolean} 是否有效
 */
function isSuit(typeIdx) {
  return typeIdx >= 0 && typeIdx < TILE_KIND_COUNT;
}

/**
 * 获取牌的花色索引（0=万，1=筒，2=条）
 * @param {number} typeIdx - 牌的类型索引（0-26）
 * @returns {number} 花色索引（0/1/2）
 */
function suitOf(typeIdx) {
  return Math.floor(typeIdx / 9);
}

/**
 * 获取牌的数字（1-9）
 * @param {number} typeIdx - 牌的类型索引（0-26）
 * @returns {number} 牌的数字（1-9）
 */
function numberOf(typeIdx) {
  return (typeIdx % 9) + 1;
}

/**
 * 获取牌的中文名称（如"一万"、"五筒"、"七条"）
 * @param {number} typeIdx - 牌的类型索引（0-26）
 * @returns {string} 牌的中文名称
 */
function tileName(typeIdx) {
  const suit = suitOf(typeIdx);
  const num = numberOf(typeIdx);
  return `${num}${SUITS[suit].name}`;
}

/**
 * 获取牌的字符符号（Unicode麻将字符）
 * @param {number} typeIdx - 牌的类型索引（0-26）
 * @returns {string} 牌的符号字符
 */
function tileGlyph(typeIdx) {
  const suit = suitOf(typeIdx);
  const num = numberOf(typeIdx);
  let base;
  if (suit === 0) {
    base = 0x1f007; // 万子Unicode起始值
  } else if (suit === 2) {
    base = 0x1f010; // 条子Unicode起始值
  } else {
    base = 0x1f019; // 筒子Unicode起始值
  }
  return String.fromCodePoint(base + (num - 1));
}

/**
 * 获取同花色的下一张牌（用于计算癞子，9变1）
 * @param {number} typeIdx - 牌型索引
 * @returns {number} 下一张牌的索引
 */
function nextInSuit(typeIdx) {
  const s = suitOf(typeIdx);
  const n = numberOf(typeIdx);
  const nextNum = n === 9 ? 1 : n + 1; // 9的下一张是1
  return s * 9 + (nextNum - 1);
}

/**
 * 根据翻牌计算癞子牌（翻牌+1，同花色，9变1）
 * @param {number} indicatorTypeIdx - 翻牌的索引
 * @returns {number} 癞子牌的索引
 */
function laiziFromIndicator(indicatorTypeIdx) {
  return nextInSuit(indicatorTypeIdx);
}

// ========================== 洗牌/发牌工具函数 ==========================
/**
 * 原地洗牌（Fisher-Yates算法）
 * @param {Array} arr - 要洗牌的数组
 */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    // 随机获取0~i的索引
    const j = (Math.random() * (i + 1)) | 0;
    // 交换位置
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * 构建麻将牌墙（108张：27种牌 × 4张）
 * @returns {Array} 洗牌后的牌墙，每个元素：{id: 唯一标识, typeIdx: 牌型索引}
 */
function buildWall() {
  const wall = [];
  let id = 0; // 每张牌的唯一ID
  // 遍历所有牌型
  for (let typeIdx = 0; typeIdx < TILE_KIND_COUNT; typeIdx++) {
    // 每种牌生成4张
    for (let k = 0; k < 4; k++) {
      wall.push({ id: id++, typeIdx });
    }
  }
  // 洗牌
  shuffleInPlace(wall);
  return wall;
}

/**
 * 异步延迟函数（用于模拟游戏动画/等待效果）
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise} 延迟后的Promise
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 根据滑块值计算游戏速度（0-100 → 900-50ms）
 * @returns {number} 延迟毫秒数
 */
function speedMs() {
  const v = Number(40);
  return Math.round(900 - (v / 100) * 850);
}

/**
 * 创建4个玩家对象
 * @returns {Array} 玩家数组，每个元素：{name, isHuman, hand, discards, melds}
 */
function makePlayers() {
  return [
    { name: "你", isHuman: true, hand: [], discards: [], melds: [] }, // 人类玩家
    { name: "玩家A", isHuman: false, hand: [], discards: [], melds: [] }, // 电脑玩家
    { name: "玩家B", isHuman: false, hand: [], discards: [], melds: [] }, // 电脑玩家
    { name: "玩家C", isHuman: false, hand: [], discards: [], melds: [] }, // 电脑玩家
  ];
}

/**
 * 对手牌进行排序（按牌型索引，再按ID）
 * @param {Array} hand - 手牌数组
 */
function sortHand(hand) {
  hand.sort((a, b) => a.typeIdx - b.typeIdx || a.id - b.id);
}

/**
 * 核心胡牌判断函数（支持癞子规则）
 * @param {Array} typeIdxs - 手牌+碰/杠的牌型索引数组
 * @param {number} laiziTypeIdx - 癞子牌索引（null=无癞子）
 * @returns {boolean} 是否可胡
 */
// function canHuByTypes(typeIdxs, laiziTypeIdx) {
//   // 胡牌必须凑够14张（手牌+碰/杠）
//   if (typeIdxs.length !== 14) return false;

//   // 统计每种牌的数量
//   const counts = new Array(TILE_KIND_COUNT).fill(0);
//   for (const t of typeIdxs) counts[t]++;

//   // 无癞子的胡牌判断
//   if (typeof laiziTypeIdx !== "number" || laiziTypeIdx < 0) {
//     return isWinningHandCountsNoLaizi(counts);
//   }

//   // 有癞子的胡牌判断（最多用1张癞子）
//   const laiziCount = counts[laiziTypeIdx] || 0;
//   if (laiziCount > 1) return false; // 超过1张癞子不能胡
//   return isWinningWithLaizi(counts, laiziTypeIdx);
// }

function canHuByTypes(typeIdxs, laiziTypeIdx) {
  if (typeIdxs.length !== 14) return false;

  const counts = new Array(TILE_KIND_COUNT).fill(0);
  for (const t of typeIdxs) counts[t]++;

  if (laiziTypeIdx == null || laiziTypeIdx < 0) {
    return isWinningHandCountsNoLaizi(counts);
  }

  // 最多 1 张癞子
  const laiziCount = counts[laiziTypeIdx] || 0;
  if (laiziCount > 1) return false;

  return isWinningWithLaizi(counts, laiziTypeIdx);
}

/**
 * 无癞子的胡牌判断（标准麻将规则：4面子+1雀头）
 * @param {Array} counts - 牌型数量统计数组
 * @returns {boolean} 是否可胡
 */
function isWinningHandCountsNoLaizi(counts) {
  // 尝试所有可能的雀头（将牌）
  for (let i = 0; i < TILE_KIND_COUNT; i++) {
    if (counts[i] >= 2) {
      counts[i] -= 2; // 假设该牌为雀头
      // 检查剩余牌能否组成4个面子（刻子/顺子）
      if (canFormMelds(counts, new Map())) {
        counts[i] += 2; // 恢复计数（避免影响后续判断）
        return true;
      }
      counts[i] += 2;
    }
  }
  return false;
}

/**
 * 生成牌型数量统计的唯一键（用于缓存）
 * @param {Array} counts - 牌型数量统计数组
 * @returns {string} 唯一键
 */
function countsKey(counts) {
  return counts.join(","); // 27位数字拼接成字符串
}

/**
 * 递归判断牌型能否组成若干个面子（刻子/顺子），带缓存优化
 * @param {Array} counts - 牌型数量统计数组
 * @param {Map} memo - 缓存对象（避免重复计算）
 * @returns {boolean} 是否能组成面子
 */
function canFormMelds(counts, memo) {
  const key = countsKey(counts);
  if (memo.has(key)) return memo.get(key); // 缓存命中

  // 找到第一个有牌的索引
  let i = 0;
  while (i < TILE_KIND_COUNT && counts[i] === 0) i++;
  if (i === TILE_KIND_COUNT) {
    // 所有牌都用完了（成功组成面子）
    memo.set(key, true);
    return true;
  }

  // 尝试刻子（3张相同）
  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canFormMelds(counts, memo)) {
      counts[i] += 3; // 恢复计数
      memo.set(key, true);
      return true;
    }
    counts[i] += 3;
  }

  // 尝试顺子（3张同花色连续，仅万/筒/条）
  if (isSuit(i)) {
    const num = numberOf(i);
    const s = suitOf(i);
    if (num <= 7) {
      // 7/8/9不能组成顺子（7→8→9，8/9无后续）
      const i2 = s * 9 + (num - 1) + 1; // 下一张
      const i3 = s * 9 + (num - 1) + 2; // 下两张
      if (counts[i2] > 0 && counts[i3] > 0) {
        counts[i]--;
        counts[i2]--;
        counts[i3]--;
        if (canFormMelds(counts, memo)) {
          counts[i]++;
          counts[i2]++;
          counts[i3]++;
          memo.set(key, true);
          return true;
        }
        counts[i]++;
        counts[i2]++;
        counts[i3]++;
      }
    }
  }

  // 无法组成面子
  memo.set(key, false);
  return false;
}

/**
 * 计算牌的有用性分数（用于AI选择出牌，分数越低越容易打出）
 * 优化策略：优先保留刻子、顺子、搭子，优先打出孤张
 * @param {number} typeIdx - 牌型索引
 * @param {Array} counts - 手牌数量统计
 * @returns {number} 有用性分数
 */
function usefulnessScore(typeIdx, counts) {
  let score = 0;
  const c = counts[typeIdx] || 0;

  // 1. 刻子价值最高（3张或4张相同）
  if (c >= 3) {
    score += 30; // 已经是刻子，非常有用，绝对不打
  } else if (c === 2) {
    score += 15; // 对子，可能成为将牌或刻子，很有用
  } else if (c === 1) {
    score += 3; // 单张，基础分
  }

  // 2. 顺子和搭子价值（仅对万/筒/条有效）
  if (isSuit(typeIdx)) {
    const s = suitOf(typeIdx);
    const n = numberOf(typeIdx);
    const base = s * 9;

    // 辅助函数：安全获取牌数
    const get = (num) => {
      if (num < 1 || num > 9) return 0;
      return counts[base + (num - 1)] || 0;
    };

    // 检查是否形成顺子（连续3张）
    // 情况1: 当前牌是顺子的第一张（如123的1）
    if (n <= 7 && get(n + 1) > 0 && get(n + 2) > 0) {
      score += 25; // 形成顺子，非常有用
    }
    // 情况2: 当前牌是顺子的中间张（如123的2）
    if (n >= 2 && n <= 8 && get(n - 1) > 0 && get(n + 1) > 0) {
      score += 25; // 形成顺子，非常有用
    }
    // 情况3: 当前牌是顺子的最后一张（如123的3）
    if (n >= 3 && get(n - 1) > 0 && get(n - 2) > 0) {
      score += 25; // 形成顺子，非常有用
    }

    // 检查两面搭子（如23等14，或45等36）
    if (n <= 8 && get(n + 1) > 0) {
      score += 12; // 两面搭子，比较有用
    }
    if (n >= 2 && get(n - 1) > 0) {
      score += 12; // 两面搭子，比较有用
    }

    // 检查嵌张搭子（如13等2，或57等6）
    if (n <= 7 && get(n + 2) > 0) {
      score += 8; // 嵌张搭子，有一定价值
    }
    if (n >= 3 && get(n - 2) > 0) {
      score += 8; // 嵌张搭子，有一定价值
    }

    // 边张（1和9）价值较低，更容易打出
    if (n === 1 || n === 9) {
      score -= 5; // 边张降权
      // 但如果边张有相邻牌，则保留
      if ((n === 1 && get(2) > 0) || (n === 9 && get(8) > 0)) {
        score += 8; // 边张搭子
      }
    }

    // 中张（4,5,6）价值较高，容易组成顺子
    if (n >= 4 && n <= 6) {
      score += 3;
    }
  } else {
    // 字牌（此处无，预留）更难成顺，倾向打出
    if (c >= 2) score += 5;
    if (c >= 3) score += 10;
  }

  return score;
}

/**
 * 带癞子的胡牌判断（癞子可替代任意牌，最多用1张）
 * @param {Array} originalCounts - 原始牌型数量统计
 * @param {number} laiziIdx - 癞子牌索引
 * @returns {boolean} 是否可胡
 */
// function isWinningWithLaizi(originalCounts, laiziIdx) {
//   const counts = originalCounts.slice(); // 复制数组（避免修改原数据）
//   let laizi = counts[laiziIdx] || 0;
//   counts[laiziIdx] = 0; // 先移除癞子，单独处理

//   // 总牌数必须为14（含癞子）
//   const total = counts.reduce((a, b) => a + b, 0) + laizi;
//   if (total !== 14) return false;

//   const memo = new Map();

//   // 尝试所有可能的雀头（含用癞子补的）
//   for (let i = 0; i < TILE_KIND_COUNT; i++) {
//     const have = counts[i];
//     if (have === 0 && laizi < 2) continue; // 至少需要2张（或1张+1癞子）
//     const needFromLaizi = Math.max(0, 2 - have); // 需要癞子补的数量
//     if (needFromLaizi > laizi) continue; // 癞子不够

//     const nextCounts = counts.slice();
//     const useReal = Math.min(2, have); // 实际用的牌数
//     nextCounts[i] -= useReal;
//     const remainLaizi = laizi - needFromLaizi; // 剩余癞子
//     if (canFormMeldsWithLaizi(nextCounts, remainLaizi, memo)) return true;
//   }

//   // 雀头完全由癞子组成（2张癞子）
//   if (laizi >= 2 && canFormMeldsWithLaizi(counts, laizi - 2, memo)) {
//     return true;
//   }

//   return false;
// }

function isWinningWithLaizi(originalCounts, laiziIdx) {
  const counts = originalCounts.slice();
  let laizi = counts[laiziIdx] || 0;
  counts[laiziIdx] = 0;

  const total = counts.reduce((a, b) => a + b, 0) + laizi;
  if (total !== 14) return false;

  const memo = new Map();

  // 遍历所有可能做将牌
  for (let i = 0; i < TILE_KIND_COUNT; i++) {
    const have = counts[i];
    const need = Math.max(2 - have, 0);
    if (need > laizi) continue;

    const cp = counts.slice();
    cp[i] -= Math.min(2, have);
    if (canFormMeldsWithLaizi(cp, laizi - need, memo)) return true;
  }

  // 癞子自己当将牌（2张）
  if (laizi >= 2) {
    if (canFormMeldsWithLaizi(counts, laizi - 2, memo)) return true;
  }

  return false;
}

/**
 * 带癞子的面子判断（癞子可替代任意牌）
 * @param {Array} counts - 牌型数量统计数组（已移除癞子）
 * @param {number} laizi - 剩余癞子数量
 * @param {Map} memo - 缓存对象
 * @returns {boolean} 是否能组成面子
 */
// function canFormMeldsWithLaizi(counts, laizi, memo) {
//   const key = countsKey(counts) + "|" + laizi;
//   if (memo.has(key)) return memo.get(key);

//   // 计算剩余牌数
//   let remainTiles = 0;
//   for (let i = 0; i < TILE_KIND_COUNT; i++) remainTiles += counts[i];
//   if (remainTiles === 0) {
//     // 剩余全是癞子，能被3整除即可（组成刻子）
//     const ok = laizi % 3 === 0;
//     memo.set(key, ok);
//     return ok;
//   }

//   // 找到第一个有牌的索引
//   let i = 0;
//   while (i < TILE_KIND_COUNT && counts[i] === 0) i++;
//   if (i === TILE_KIND_COUNT) {
//     const ok = laizi % 3 === 0;
//     memo.set(key, ok);
//     return ok;
//   }

//   // 1) 尝试刻子（可能部分用癞子补）
//   const maxUse = Math.min(3, counts[i]);
//   for (let useReal = maxUse; useReal >= 1; useReal--) {
//     const needLaizi = 3 - useReal; // 需要癞子补的数量
//     if (needLaizi > laizi) continue;
//     const nextCounts = counts.slice();
//     nextCounts[i] -= useReal;
//     if (canFormMeldsWithLaizi(nextCounts, laizi - needLaizi, memo)) {
//       memo.set(key, true);
//       return true;
//     }
//   }
// }

function canFormMeldsWithLaizi(counts, laizi, memo) {
  const key = countsKey(counts) + "|" + laizi;
  if (memo.has(key)) return memo.get(key);

  let total = 0;
  for (let v of counts) total += v;

  // 总牌数（实牌+癞子）必须是3的倍数
  if ((total + laizi) % 3 !== 0) {
    memo.set(key, false);
    return false;
  }

  // 没有实牌时，癞子数量必须是3的倍数
  if (total === 0) {
    const ok = laizi % 3 === 0;
    memo.set(key, ok);
    return ok;
  }

  // 找第一张有牌的位置
  let i = 0;
  while (i < TILE_KIND_COUNT && counts[i] === 0) i++;
  if (i === TILE_KIND_COUNT) {
    const ok = laizi % 3 === 0;
    memo.set(key, ok);
    return ok;
  }

  // ======================
  // 1. 尝试刻子（0/1/2/3张实牌 + 癞子补）
  // ======================
  for (let use = Math.min(counts[i], 3); use >= 0; use--) {
    const need = 3 - use;
    if (need > laizi) continue;
    const cp = counts.slice();
    cp[i] -= use;
    if (canFormMeldsWithLaizi(cp, laizi - need, memo)) {
      memo.set(key, true);
      return true;
    }
  }

  // ======================
  // 2. 尝试顺子（修复：允许用1张癞子补位）
  // ======================
  // 尝试顺子
  //   if (isSuit(i)) {
  //     const n = numberOf(i);
  //     if (n <= 7) {
  //       const j = i + 1; // 下一张
  //       const k = i + 2; // 下两张

  //       // 枚举顺子缺的牌数（0 或 1 张）
  //       const combinations = [
  //         { ni: 0, nj: 0, nk: 0, need: 0 }, // 纯实牌（need=0）
  //         { ni: 1, nj: 0, nk: 0, need: 1 }, // 癞子补 i 位
  //         { ni: 0, nj: 1, nk: 0, need: 1 }, // 癞子补 j 位
  //         { ni: 0, nj: 0, nk: 1, need: 1 }, // 癞子补 k 位
  //       ];

  //       for (const combo of combinations) {
  //         const { ni, nj, nk, need } = combo;
  //         if (need > laizi) continue;

  //         // 检查实牌数量是否足够
  //         const okI = counts[i] >= 1 - ni;
  //         const okJ = counts[j] >= 1 - nj;
  //         const okK = counts[k] >= 1 - nk;

  //         if (!okI || !okJ || !okK) continue;

  //         // 扣除实牌
  //         const cp = counts.slice();
  //         if (ni === 0) cp[i]--;
  //         if (nj === 0) cp[j]--;
  //         if (nk === 0) cp[k]--;

  //         // 递归
  //         if (canFormMeldsWithLaizi(cp, laizi - need, memo)) {
  //           memo.set(key, true);
  //           return true;
  //         }
  //       }
  //     }
  //   }
  // 尝试顺子
  if (isSuit(i)) {
    const n = numberOf(i);
    if (n <= 7) {
      const j = i + 1;
      const k = i + 2;

      // 枚举顺子缺的牌数（0 或 1 张）
      const combinations = [
        { ni: 0, nj: 0, nk: 0, need: 0 }, // 纯实牌
        { ni: 1, nj: 0, nk: 0, need: 1 }, // 癞子补 i
        { ni: 0, nj: 1, nk: 0, need: 1 }, // 癞子补 j
        { ni: 0, nj: 0, nk: 1, need: 1 }, // 癞子补 k
      ];

      for (const combo of combinations) {
        const { ni, nj, nk, need } = combo;
        if (need > laizi) continue;

        const okI = counts[i] >= 1 - ni;
        const okJ = counts[j] >= 1 - nj;
        const okK = counts[k] >= 1 - nk;
        if (!okI || !okJ || !okK) continue;

        const cp = counts.slice();
        if (ni === 0) cp[i]--;
        if (nj === 0) cp[j]--;
        if (nk === 0) cp[k]--;

        if (canFormMeldsWithLaizi(cp, laizi - need, memo)) {
          memo.set(key, true);
          return true;
        }
      }
    }
  }

  // 所有情况都不满足
  memo.set(key, false);
  return false;
}

// ========================== 游戏状态管理 ==========================
/**
 * 创建麻将游戏实例
 * @returns {Object} 游戏实例：包含状态和核心方法
 */
function createMahjongGame() {
  // 游戏状态对象
  const game = {
    wall: [], // 牌墙
    players: [], // 玩家列表
    current: 0, // 当前玩家索引
    phase: "idle", // 游戏阶段：idle(空闲) | discard(出牌) | react(碰/杠/过) | gameover(结束)
    winner: null, // 赢家索引（null=未结束，-1=流局）
    busy: false, // 游戏是否处于忙碌状态（防止重复操作）
    // lastEvent: "", // 最后事件描述
    status: "", // 当前状态描述
    dingGuoTypeIdx: null, // 翻牌（顶果）索引
    laiziTypeIdx: null, // 癞子牌索引
    lastDiscard: null, // 最后打出的牌信息
    reaction: null, // 碰/杠/胡/过的反应状态
    lastDrawTileId: null, // 刚摸的牌ID（用于高亮显示）
    score: 0, // 分数（暂未使用）
    chengTimes: 0, // 逞癞子次数
    justChengThenDraw: false, // 是否刚逞癞子需要补牌
    canCheng: false, // 是否可以癞子
    canHu: false, // 是否可以胡
    /** 胡牌类型文案（软油/黑油/软胡/硬胡），联机由服务端写入，单机由 endGame 写入 */
    huTypeLabel: "",
    // 新增：事件回调存储（key: 事件名, value: 回调函数数组）
    eventListeners: {},
  };

  // 新增：注册事件监听（给game.js调用）
  function on(eventName, callback) {
    if (!game.eventListeners[eventName]) {
      game.eventListeners[eventName] = [];
    }
    game.eventListeners[eventName].push(callback);
  }

  // 新增：发布事件（内部逻辑触发）
  function emit(eventName, data) {
    const listeners = game.eventListeners[eventName] || [];
    listeners.forEach((callback) => callback(data));
  }

  /**
   * 开始新游戏（初始化牌墙、发牌、确定癞子）
   */
  function newGame() {
    // 重置游戏状态
    game.wall = buildWall();
    game.players = makePlayers();
    game.current = 0;
    game.phase = "idle";
    game.winner = null;
    game.busy = false;
    game.status = "";
    game.dingGuoTypeIdx = null;
    game.laiziTypeIdx = null;
    game.lastDiscard = null;
    game.reaction = null;
    game.lastDrawTileId = null;
    game.chengTimes = 0;
    game.justChengThenDraw = false;
    game.score = 0;
    game.huTypeLabel = "";

    // 发牌：每人13张
    for (let r = 0; r < 13; r++) {
      for (let i = 0; i < 4; i++) drawOne(i);
    }

    // 翻牌定癞子（荆州麻将规则：顶果+1为癞子）
    const indicator = game.wall.pop();
    if (indicator) {
      game.dingGuoTypeIdx = indicator.typeIdx;
      const s = suitOf(indicator.typeIdx);
      const n = numberOf(indicator.typeIdx);
      // 数字9的下一张是1（循环）
      const nextNum = n === 9 ? 1 : n + 1;
      // 计算癞子牌型索引
      game.laiziTypeIdx = s * 9 + (nextNum - 1);
    }

    // 庄家（玩家0）先摸第14张牌
    const first = drawOne(0);
    game.phase = "discard";
    setStatus("你是庄家：请先出一张");
    // 逞癞子按钮：仅当有癞子且手牌有癞子牌时可用
    if (game.current === 0) {
      //   game.justChengThenDraw = false; // 刚逞癞子后不允许连续逞
      const p0 = game.players[0];

      const canCheng =
        game.winner === null &&
        game.current === 0 &&
        game.phase === "discard" &&
        game.laiziTypeIdx != null &&
        p0.hand.some((t) => t.typeIdx === game.laiziTypeIdx);

      game.canCheng = canCheng;
    }
  }

  /**
   * 设置游戏状态提示文本
   * @param {string} msg - 提示信息
   */
  function setStatus(msg) {
    //   game.lastEvent = msg;
    game.status = msg;
    // ui.txtStatus.textContent = msg;
  }

  /**
   * 切换到下一个玩家
   */
  function nextPlayer() {
    game.current = (game.current + 1) % 4;
    game.phase = "idle";
  }

  /**
   * 摸一张牌
   * @param {Object} game - 游戏状态对象
   * @param {number} playerIdx - 玩家索引
   * @returns {Object|null} 摸到的牌（无牌时返回null）
   */
  function drawOne(playerIdx) {
    // 牌墙为空则返回null
    if (game.wall.length <= 0) return null;
    // 从牌墙末尾摸一张（模拟现实摸牌）
    const t = game.wall.pop();
    // 添加到玩家手牌
    game.players[playerIdx].hand.push(t);
    // 手牌排序
    sortHand(game.players[playerIdx].hand);
    return t;
  }

  /**
   * 人类玩家按手牌索引出牌
   * @param {number} handIndex - 手牌索引
   * @returns {Object|null} 打出的牌
   */
  function humanDiscardByIndex(handIndex) {
    const p0 = game.players[0];
    // 验证索引有效性
    if (handIndex < 0 || handIndex >= p0.hand.length) return null;
    // 获取要出的牌
    const tile = p0.hand[handIndex];
    // 调用出牌方法
    const res = discardById(0, tile.id);

    // ✅ 发布“出牌”事件，通知停止动画
    emit("tile-discarded", { tileId: tile.id, playerIdx: 0 });
    return res;
  }

  /**
   * 根据牌ID出牌
   * @param {Object} game - 游戏状态对象
   * @param {number} playerIdx - 玩家索引
   * @param {number} tileId - 要出的牌ID
   * @returns {Object|null} 打出的牌（无效ID返回null）
   */
  function discardById(playerIdx, tileId) {
    const p = game.players[playerIdx];
    // 查找手牌中对应ID的牌
    const i = p.hand.findIndex((x) => x.id === tileId);
    if (i < 0) return null;
    // 从手牌中移除并添加到弃牌区
    const [t] = p.hand.splice(i, 1);
    p.discards.push(t);
    if (playerIdx === 0) {
      game.justChengThenDraw = false;
    }
    return t;
  }

  /**
   * 处理出牌后的后续逻辑：设置 lastDiscard、检测各家是否可碰/杠并按顺序执行
   * 返回对象 { react: boolean, next: number }
   */
  function handlePostDiscard(fromIdx, tile) {
    game.lastDiscard = { fromIdx, tile };
    game.reaction = null;

    // 仅玩家0（你）可碰/杠，机器人不碰不杠
    if (fromIdx !== 0) {
      const you = game.players[0];
      const same = you.hand.filter((t) => t.typeIdx === tile.typeIdx).length;
      const canPeng = same >= 2; // 碰需要2张相同
      const canGang = same >= 3; // 杠需要3张相同
      if (canPeng || canGang) {
        game.current = 0;
        game.phase = "react"; // 进入碰/杠/过阶段
        game.reaction = { fromIdx, tile, canPeng, canGang };
        setStatus(
          `是否对 ${game.players[fromIdx].name} 打出的牌 ${tileName(
            tile.typeIdx,
          )} ${canGang ? "杠" : "碰"}？`,
        );
        // render();
        return;
      }
    }

    // 没有人反应，轮到下一家
    nextPlayer(game);
    // 继续游戏（AI回合自动执行，人类回合等待操作）
    if (game.winner === null) {
      if (!game.players[game.current].isHuman) {
        void botTurnLoop(game);
      } else {
        void humanTurnStart(game);
      }
    }
  }

  /**
   * AI回合逻辑（自动摸牌→检查胡牌→出牌）
   */
  async function botTurnLoop() {
    if (game.busy) return;
    if (game.winner !== null) return;
    const p = game.players[game.current];
    if (p.isHuman) return;

    game.busy = true;
    try {
      await sleep(speedMs()); // 模拟思考时间
      maybeDrawForCurrent(); // 摸牌
      if (game.phase === "gameover") return; // 摸牌后可能流局，提前结束

      await sleep(speedMs());

      // 检查自摸胡牌（AI也能胡）
      if (p.hand.length === 14) {
        const ok = canHuByTypes(
          p.hand.map((x) => x.typeIdx),
          game.laiziTypeIdx,
        );
        if (ok) {
          endGame(game.current, "自摸");
          return;
        }
      }

      // AI选择出牌
      const discardId = chooseBotDiscardTileId(game.current);
      const disc = discardById(game.current, discardId);
      setStatus(`${p.name} 出牌：${tileName(disc.typeIdx)}`);
      await sleep(Math.max(80, Math.round(speedMs() * 0.6)));
      handlePostDiscard(game.current, disc); // 处理出牌后的逻辑

      // ✅ 关键修复：检查是否进入碰/杠阶段，若是则终止循环，给玩家操作机会
      if (game.phase === "react") {
        game.busy = false; // 释放忙碌状态，允许玩家点击按钮
        return;
      }
    } finally {
      game.busy = false;
    }

    // 继续下一位玩家
    if (game.winner === null) {
      if (!game.players[game.current].isHuman) {
        void botTurnLoop();
      } else {
        void humanTurnStart();
      }
    }
  }

  /**
   * 当前玩家摸牌（并检查流局）
   */
  function maybeDrawForCurrent() {
    if (game.winner !== null) return;
    const p = game.players[game.current];
    if (game.wall.length <= 0) {
      setStatus("流局：牌山没了");
      game.winner = -1;
      game.phase = "gameover";
      return;
    }

    // 使用新版摸牌函数，自动处理暗杠
    const { tile: t, kongs } = drawOneWithAutoKong(game.current);

    game.canCheng =
        game.winner === null &&
        game.current === 0 &&
        game.phase === "discard" &&
        game.laiziTypeIdx != null &&
        p.hand.some((t) => t.typeIdx === game.laiziTypeIdx);

    // 构造状态提示文字
    if (kongs.length > 0) {
      const kongNames = kongs.map((idx) => tileName(idx)).join("、");
      setStatus(
        `${p.name} 暗杠了 ${kongNames}，摸牌：${t ? tileName(t.typeIdx) : "-"}`,
      );
      console.log(
        `${p.name} 暗杠了 ${kongNames}，摸牌：${t ? tileName(t.typeIdx) : "-"}`,
      );
    } else if (t) {
      setStatus(`${p.name} 摸牌：${tileName(t.typeIdx)}`);
      console.log(`${p.name} 摸牌：${tileName(t.typeIdx)}`);
    }

    game.phase = "discard"; // 摸牌后进入出牌阶段

    if (game.current === 0) {
      //   flashLastDraw(t); // 玩家0摸牌高亮
      game.lastDrawTileId = t.id; // 记录刚摸的牌ID
      // / ✅ 关键：发布“摸新牌”事件，传递必要数据
      emit("new-tile-drawn", {
        tileId: t.id,
        playerIdx: 0,
        tile: t,
      });
    }
  }

  /**
   * AI选择要打出的牌（选最没用的）
   * @param {number} playerIdx - AI玩家索引
   * @returns {number|null} 要打出的牌ID
   */
  function chooseBotDiscardTileId(playerIdx) {
    const p = game.players[playerIdx];
    if (
      botDiscardAi &&
      typeof botDiscardAi.chooseBotDiscardTileId === "function" &&
      Array.isArray(p.hand) &&
      p.hand.length > 0
    ) {
      const id = botDiscardAi.chooseBotDiscardTileId(
        p.hand,
        p.melds || [],
        game.laiziTypeIdx,
      );
      if (Number.isInteger(id)) return id;
    }
    const counts = new Array(TILE_KIND_COUNT).fill(0);
    for (const t of p.hand) counts[t.typeIdx] += 1;
    let best = null;
    for (const t of p.hand) {
      const s = usefulnessScore(t.typeIdx, counts);
      if (
        best === null ||
        s < best.score ||
        (s === best.score && t.typeIdx > best.typeIdx)
      ) {
        best = { id: t.id, score: s, typeIdx: t.typeIdx };
      }
    }
    return best ? best.id : (p.hand[0]?.id ?? null);
  }

  /**
   * 摸牌并自动检测暗杠：
   *   1. 调用 drawOne 取得一张牌
   *   2. 如果此时手牌中出现4张同类型的牌，则把它们全部从手牌摘出，
   *      组成一个暗杠 meld 并加入玩家的 melds 中
   *   3. 立刻再摸一张补牌，重复步骤 2 直到没有新的暗杠或牌山空
   * 返回一个对象，包含最后一张摸到的牌以及所有暗杠的牌型索引
   * @param {number} playerIdx - 玩家索引
   * @returns {{tile: Object|null, kongs: Array<number>}}
   */
  function drawOneWithAutoKong(playerIdx) {
    const result = { tile: null, kongs: [] };
    let t = drawOne(playerIdx);
    if (!t) return result;
    result.tile = t;

    // 检查暗杠循环（可能连环暗杠）；上限防止异常状态卡死主线程
    for (let kongRound = 0; kongRound < 32; kongRound += 1) {
      const p = game.players[playerIdx];
      const counts = {};
      for (const tile of p.hand) {
        counts[tile.typeIdx] = (counts[tile.typeIdx] || 0) + 1;
      }
      const kongType = Object.keys(counts).find((k) => counts[k] === 4);
      if (kongType == null) break;

      const typeIdxNum = Number(kongType);
      // 从手牌中移除那 4 张
      for (let i = p.hand.length - 1; i >= 0; i--) {
        if (p.hand[i].typeIdx === typeIdxNum) {
          p.hand.splice(i, 1);
        }
      }

      // 记录暗杠 meld（fromIdx 设为玩家自己）
      p.melds.push({
        kind: "gang",
        tileTypeIdx: typeIdxNum,
        fromIdx: playerIdx,
        size: 4,
      });
      sortHand(p.hand);

      result.kongs.push(typeIdxNum);
      //   触发一次渲染，让暗杠马上出现在界面上
      // render();
      //   如果是玩家自己暗杠，立即加分
      if (playerIdx === 0) {
        // 暗杠3家各给10元
        adjustScore(30);
        setStatus(`你暗杠了 ${tileName(typeIdxNum)}，每家给10元`);
      } else {
        // 对手暗杠，你付钱
        adjustScore(-10);
        setStatus(
          `${game.players[playerIdx].name} 暗杠了 ${tileName(typeIdxNum)}，你付10元`,
        );
      }
      // 再摸一张加回手牌，循环检测
      t = drawOne(playerIdx);
      if (!t) break;
      result.tile = t;
    }

    return result;
  }

  /**
   * 结束游戏
   * @param {number} winnerIdx - 赢家索引（-1=流局）
   * @param {string} reason - 胡牌原因
   */
  function endGame(winnerIdx, reason) {
    game.winner = winnerIdx;
    const name = game.players[winnerIdx].name;

    // 分类描述：软/硬胡，以及油类情况
    let typeDesc = "";
    const winner = game.players[winnerIdx];
    const hasLaizi =
      game.laiziTypeIdx != null &&
      winner.hand.some((t) => t.typeIdx === game.laiziTypeIdx);
    if (game.justChengThenDraw) {
      // 自摸后立即胡
      if (hasLaizi) typeDesc = "软油";
      else typeDesc = "黑油";
    } else {
      typeDesc = hasLaizi ? "软胡" : "硬胡";
    }
    game.huTypeLabel = typeDesc;

    setStatus(`结束：${name} 胡了（${reason}，${typeDesc}）`);

    game.phase = "gameover";

    // 根据胡牌规则结算金额
    const delta = calculateHuScore(winnerIdx);
    if (delta !== 0) {
      adjustScore(delta);
      if (winnerIdx === 0) {
        setStatus(`你胡了 ${reason}（${typeDesc}），赢得${delta}元`);
      } else {
        setStatus(`你输了 ${-delta}元，${name}胡了 ${reason}（${typeDesc}）`);
      }
    }
    game.justChengThenDraw = false;
  }

  /**
   * 人类回合开始（摸牌→检查胡牌→等待操作）
   */
  async function humanTurnStart() {
    if (game.busy) return;
    if (game.winner !== null) return;
    if (game.current !== 0) return;

    game.busy = true;
    try {
      await sleep(Math.max(60, Math.round(speedMs() * 0.45)));
      maybeDrawForCurrent(); // 摸牌

      const p0 = game.players[0];
      const canCheng =
        game.laiziTypeIdx != null &&
        p0.hand.some((t) => t.typeIdx === game.laiziTypeIdx);
      game.canCheng = canCheng; // 更新是否可以逞癞子状态

      // 检查是否可胡
      const ok = updateYouWinBadge();

      if (ok) {
        setStatus("你可胡了");
        game.canHu = true; // 允许点击胡牌按钮
        game.phase = "react"; // 进入碰/杠/过阶段
        game.reaction = { canHu: true }; // 只有胡牌反应，没有碰杠
      }

      //   //   render();
      //   // 如果勾选自动出牌，自动执行
      //   if (ui.chkAuto.checked) {
      //     await sleep(Math.max(80, Math.round(speedMs() * 0.7)));
      //     autoDiscardForHuman();
      //   }
    } finally {
      game.busy = false;
    }
  }

  /**
   * 更新可胡牌徽章的显示状态
   * @returns {boolean} 是否可胡
   */
  function updateYouWinBadge() {
    const p0 = game.players[0];
    // const p0 = {
    //   name: "你",
    //   isHuman: true,
    //   // 手牌（14张，按牌型排序，无isLaizi字段）
    //   hand: [
    //     { id: 1, typeIdx: 1 }, // 二万
    //     { id: 2, typeIdx: 2 }, // 三万
    //     { id: 3, typeIdx: 2 }, // 三万
    //     { id: 4, typeIdx: 3 }, // 四万
    //     { id: 5, typeIdx: 4 }, // 五万
    //     { id: 6, typeIdx: 5 }, // 六万
    //     { id: 7, typeIdx: 5 }, // 六万
    //     { id: 8, typeIdx: 9 }, // 一筒
    //     { id: 9, typeIdx: 10 }, // 二筒
    //     { id: 10, typeIdx: 11 }, // 三筒
    //     { id: 11, typeIdx: 15 }, // 七筒
    //     { id: 12, typeIdx: 23 }, // 六条
    //     { id: 13, typeIdx: 24 }, // 七条
    //     { id: 14, typeIdx: 25 }, // 八条
    //   ],
    //   melds: [], // 无碰/杠牌
    //   discards: [], // 无弃牌
    // };

    // game.laiziTypeIdx = 15;
    // game.players[0] = p0;
    console.log("检查是否可胡", p0);
    console.log("game", game);
    console.log("癞子牌索引：", game.laiziTypeIdx);
    const ok =
      handTypeIdxs(0).length === 14 &&
      canHuByTypes(handTypeIdxs(0), game.laiziTypeIdx);
    console.log("结果：", ok);

    return ok;
  }

  //   /**
  //    * 获取玩家的所有牌型索引（手牌+碰/杠）
  //    * @param {number} playerIdx - 玩家索引
  //    * @returns {Array} 牌型索引数组
  //    */
  //   function handTypeIdxs(playerIdx) {
  //     const p = game.players[playerIdx];
  //     const arr = p.hand.map((x) => x.typeIdx);
  //     // 加入碰/杠的牌
  //     if (Array.isArray(p.melds)) {
  //       for (const m of p.melds) {
  //         const size = m.size ?? (m.kind === "gang" ? 4 : 3);
  //         for (let i = 0; i < size; i++) arr.push(m.tileTypeIdx);
  //       }
  //     }
  //     return arr;
  //   }
  /**
   * 获取玩家的所有牌型索引（手牌+碰/杠，杠牌仅算3张）
   * @param {number} playerIdx - 玩家索引
   * @returns {Array} 牌型索引数组（胡牌时有效长度为14）
   */
  function handTypeIdxs(playerIdx) {
    const p = game.players[playerIdx];
    const arr = p.hand.map((x) => x.typeIdx);

    // 处理碰/杠：碰牌算3张，杠牌只算3张（无论明杠/暗杠）
    if (Array.isArray(p.melds)) {
      for (const m of p.melds) {
        const size = m.kind === "gang" ? 3 : (m.size ?? 3); // 杠牌强制算3张
        for (let i = 0; i < size; i++) arr.push(m.tileTypeIdx);
      }
    }
    return arr;
  }

  /**
   * 玩家选择 碰
   * 仅支持玩家0（人类）响应当前的 game.reaction
   */
  function onPeng(playerIdx) {
    if (!game.reaction) return false;
    const { fromIdx, tile, canPeng } = game.reaction;
    if (!canPeng) return false;

    const p = game.players[playerIdx];
    const dg = game.dingGuoTypeIdx;
    const dingPairPeng =
      dg != null &&
      tile.typeIdx === dg &&
      p.hand.filter((t) => t.typeIdx === dg).length >= 2;
    // 从手牌中移除两张相同牌
    const removed = [];
    for (let i = p.hand.length - 1; i >= 0 && removed.length < 2; i--) {
      if (p.hand[i].typeIdx === tile.typeIdx) {
        removed.push(p.hand.splice(i, 1)[0]);
      }
    }
    if (removed.length < 2) return false;

    // 从出牌者的弃牌区移除最后一张
    const from = game.players[fromIdx];
    const last = from.discards.pop();

    // 添加碰牌到玩家的牌组（melds）
    p.melds.push({
      kind: "peng",
      tileTypeIdx: tile.typeIdx,
      fromIdx,
      size: 3,
    });

    if (dingPairPeng && playerIdx === 0 && fromIdx !== 0) {
      adjustScore(15);
      setStatus(
        `顶果碰：${game.players[fromIdx].name} 付你 15 元`,
      );
    }

    // 重置反应，轮到操作玩家出牌
    game.reaction = null;
    game.phase = "discard";
    game.current = playerIdx;
    return true;
  }

  /**
   * 玩家选择 杠（点杠）
   */
  async function onGang(playerIdx) {
    if (!game.reaction) return false;
    const { fromIdx, tile, canGang } = game.reaction;
    if (!canGang) return false;

    const p = game.players[playerIdx];
    // 从手牌中移除三张相同牌
    const removed = [];
    for (let i = p.hand.length - 1; i >= 0 && removed.length < 3; i--) {
      if (p.hand[i].typeIdx === tile.typeIdx) {
        removed.push(p.hand.splice(i, 1)[0]);
      }
    }
    if (removed.length < 3) return false;

    // 从出牌者的弃牌区移除最后一张
    const from = game.players[fromIdx];
    const last = from.discards.pop();

    // 添加杠牌到玩家的牌组（melds）
    p.melds.push({
      kind: "gang",
      tileTypeIdx: tile.typeIdx,
      fromIdx,
      size: 4,
    });

    // 直杠收钱：打给你的人付15
    if (fromIdx !== 0) {
      adjustScore(15);
      setStatus(`直杠成功，${game.players[fromIdx].name} 付你15元`);
    }

    // 重置反应，玩家补摸一张牌后继续出牌
    game.reaction = null;
    const drawn = drawOne(playerIdx);
    game.lastDrawTileId = drawn ? drawn.id : null;
    game.phase = "discard";
    game.current = playerIdx;

    await sleep(Math.max(80, Math.round(speedMs() * 0.6)));
    setStatus(`${game.players[game.current].name} 摸牌：${tileName(drawn.typeIdx)}`);
    return true;
  }

  /**
   * 玩家选择 过（放弃对当前弃牌的响应）
   * 如果是在摸牌之后点击过放弃胡牌，则放弃后继续出牌；如果是在别人打牌后点击过放弃，则放弃后轮到出牌者下一家摸牌
   * 仅支持玩家0（人类）响应当前的 game.reaction
   */
  function onPass(playerIdx) {
    if (!game.reaction) return false;
    // 如果当前反应状态包含 canHu，说明玩家是在摸牌后点击过放弃胡牌，此时放弃后继续出牌
    if (
      playerIdx === 0 &&
      game.lastDrawTileId !== null &&
      game.reaction.canHu
    ) {
      game.justChengThenDraw = false;
      game.reaction = null;
      game.phase = "discard";
      game.current = playerIdx;
      setStatus(`放弃胡牌，请继续出牌`);
      return true;
    }

    // 放弃后轮到出牌者逆时针下家摸牌（与 nextPlayer 一致：本地玩家索引 0 南 →1 东 →2 北 →3 西）
    const fromIdx = game.lastDiscard ? game.lastDiscard.fromIdx : 0;
    game.reaction = null;
    game.phase = "idle";
    game.current = (fromIdx + 1) % 4;
    // 继续游戏
    if (game.winner === null) {
      if (!game.players[game.current].isHuman) {
        void botTurnLoop();
      } else {
        void humanTurnStart();
      }
    }
    return true;
  }
  //   function onPass(playerIdx) {
  //     if (!game.reaction) return false;

  //     // 放弃后轮到出牌者下一家摸牌
  //     const fromIdx = game.lastDiscard ? game.lastDiscard.fromIdx : 0;
  //     game.reaction = null;
  //     game.phase = "idle";
  //     game.current = (fromIdx + 1) % 4;
  //     // 继续游戏
  //     if (game.winner === null) {
  //       if (!game.players[game.current].isHuman) {
  //         void botTurnLoop();
  //       } else {
  //         void humanTurnStart();
  //       }
  //     }
  //     return true;
  //   }

  /**
   * 逞癞子事件处理（打出癞子牌并补一张）
   */
  function onCheng() {
    if (game.winner !== null) return;
    if (game.current !== 0 || game.phase !== "discard") return;
    if (game.laiziTypeIdx == null) return;
    const you = game.players[0];
    const laiziTile = you.hand.find((t) => t.typeIdx === game.laiziTypeIdx);
    if (!laiziTile) return;
    const disc = discardById(0, laiziTile.id);
    if (!disc) return;
    game.chengTimes = (game.chengTimes || 0) + 1;
    game.justChengThenDraw = true;
    setStatus(`你逞癞子：${tileName(disc.typeIdx)}，立即补一张`);
    game.phase = "idle";
    maybeDrawForCurrent(); // 补牌
  }

  /**
   * 根据胡牌规则计算输赢金额（仅在游戏结束时调用）
   * @param {number} winnerIdx 胡牌者索引
   * @returns {number} 相对于玩家0的净变化（正=你赢，负=你输）
   */
  function calculateHuScore(winnerIdx) {
    const winner = game.players[winnerIdx];
    const hasLaizi =
      game.laiziTypeIdx != null &&
      winner.hand.some((t) => t.typeIdx === game.laiziTypeIdx);
    const base = hasLaizi ? 5 : 10;
    let amount = 0;

    if (winnerIdx === 0) {
      if (game.justChengThenDraw) {
        if (hasLaizi) {
          amount = 20 * 3;
        } else {
          amount = 40 * 3;
        }
      } else {
        const wMult = Math.max(1, game.chengTimes || 0);
        amount = base * wMult * 3;
      }
    } else {
      const pMult = Math.max(1, game.chengTimes || 0);
      amount = -base * pMult;
    }
    return amount;
  }

  /**
   * 调整玩家（主要指你）的积分并更新显示
   * @param {number} delta 正或负金额
   */
  function adjustScore(delta) {
    // if (logicAdjustScore) {
    //   logicAdjustScore(game, delta);
    // } else {
    game.score = (game.score || 0) + delta;
    // }
    // if (ui.txtScore) ui.txtScore.textContent = String(game.score);
  }

  return {
    game,
    newGame,
    humanDiscardByIndex,
    setStatus,
    handlePostDiscard,
    onPeng,
    onGang,
    onPass,
    onCheng,
    endGame,
    on,
    emit,
  };
}

// ========================== 模块导出 ==========================
module.exports = {
  TILE_KIND_COUNT,
  SUITS,
  tileName,
  tileGlyph,
  suitOf,
  numberOf,
  canHuByTypes,
  createMahjongGame,
  // scoring helpers for external usage
  //   adjustScore,
  //   calculateHuScore,
  //   chooseBotDiscardTileId,
};
