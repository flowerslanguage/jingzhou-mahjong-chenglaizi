/**
 * 微信登录占位实现：
 * - 当前版本不直接请求微信接口
 * - 用 code 生成稳定 uid，并签发简易 token
 * 后续可替换为 code2Session 真正实现。
 */

function makeUidFromCode(code) {
  return `wx_${String(code || "").trim()}`;
}

function signToken(uid) {
  const raw = `${uid}|${Date.now()}`;
  return Buffer.from(raw).toString("base64url");
}

function parseToken(token) {
  try {
    const text = Buffer.from(token, "base64url").toString("utf8");
    const [uid] = text.split("|");
    if (!uid) return null;
    return { uid };
  } catch (err) {
    return null;
  }
}

async function loginByCode(code, nickname) {
  if (!code || typeof code !== "string") {
    return null;
  }
  const uid = makeUidFromCode(code);
  const token = signToken(uid);
  const safeNickname =
    typeof nickname === "string" && nickname.trim()
      ? nickname.trim().slice(0, 24)
      : uid;
  return {
    uid,
    token,
    profile: {
      nickname: safeNickname,
      avatar: "",
    },
  };
}

module.exports = {
  loginByCode,
  parseToken,
};
