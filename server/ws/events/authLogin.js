const { loginByCode } = require("../../auth/wechatAuth");
const { EVENTS } = require("../../../shared/events");
const { ERRORS } = require("../../../shared/errors");

async function handleAuthLogin(ctx, packet) {
  const code = packet?.payload?.code;
  const nickname = packet?.payload?.nickname;
  const ret = await loginByCode(code, nickname);
  if (!ret) {
    ctx.reply(packet, EVENTS.ERROR, {
      code: ERRORS.E_AUTH_LOGIN_FAILED,
      message: "微信登录失败",
    });
    return;
  }

  ctx.bindUser(ret.uid, ret.profile?.nickname || ret.uid);
  ctx.reply(packet, EVENTS.AUTH_LOGIN_ACK, ret);
}

module.exports = {
  handleAuthLogin,
};
