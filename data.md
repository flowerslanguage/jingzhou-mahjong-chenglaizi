开局就2个癞子
const p0 = {
name: "你",
isHuman: true,
// 手牌（10张，含癞子）
hand: [
{ id: 1, typeIdx: 4 }, // 五万（癞子）
{ id: 2, typeIdx: 4 }, // 五万（普通）
{ id: 3, typeIdx: 5 }, // 六万
{ id: 4, typeIdx: 6 }, // 七万
{ id: 5, typeIdx: 7 }, // 八万
{ id: 6, typeIdx: 9 }, // 一筒
{ id: 7, typeIdx: 10 }, // 二筒
{ id: 8, typeIdx: 12 }, // 四筒
{ id: 9, typeIdx: 12 }, // 四筒
{ id: 10, typeIdx: 19 }, // 二条
{ id: 11, typeIdx: 19 }, // 二条
],
// 碰牌（1组，一条刻子）
melds: [
{
kind: "peng", // 碰牌类型
tileTypeIdx: 18, // 一条的typeIdx
fromIdx: 1, // 从玩家1处碰的（可自定义）
size: 3, // 碰牌数量
},
],
discards: [], // 弃牌区（空）
};
game.players[0] = p0;
game.laiziTypeIdx = 4;

// const p0 = {
// name: "你",
// isHuman: true,
// hand: [
// { id: 15, typeIdx: 3 },
// { id: 17, typeIdx: 4 },
// { id: 21, typeIdx: 5 },
// { id: 56, typeIdx: 14 },
// { id: 57, typeIdx: 14 },
// { id: 59, typeIdx: 14 },
// { id: 102, typeIdx: 25 },
// { id: 103, typeIdx: 25 },
// ],
// melds: [
// { kind: "peng", tileTypeIdx: 26, fromIdx: 2, size: 3 },
// { kind: "gang", tileTypeIdx: 7, fromIdx: 1, size: 4 },
// ],
// discards: [
// { id: 32, typeIdx: 8 },
// { id: 80, typeIdx: 20 },
// { id: 45, typeIdx: 11 },
// { id: 6, typeIdx: 1 },
// { id: 66, typeIdx: 16 },
// { id: 92, typeIdx: 23 },
// { id: 82, typeIdx: 20 },
// { id: 33, typeIdx: 8 },
// { id: 52, typeIdx: 13 },
// { id: 81, typeIdx: 20 },
// ],
// };
// game.laiziTypeIdx = 0;
