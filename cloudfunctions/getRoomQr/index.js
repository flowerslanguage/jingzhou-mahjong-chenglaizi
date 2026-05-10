const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 入参:
 * - roomNo: 房号（必填）
 *
 * 可选环境变量:
 * - ENTRY_PAGE: 小游戏入口页面，默认 "game"
 */
exports.main = async (event) => {
  const roomNo = String(event?.roomNo || "").trim();
  if (!roomNo) {
    return { ok: false, message: "roomNo required" };
  }

  const page = process.env.ENTRY_PAGE || "game";
  const scene = `roomNo=${roomNo}`;

  try {
    const resp = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page,
      checkPath: false,
      envVersion: "release",
    });

    const buffer = resp?.buffer;
    if (!buffer) {
      return { ok: false, message: "qrcode buffer empty" };
    }

    const cloudPath = `room-qrcode/${roomNo}-${Date.now()}.png`;
    const uploadRet = await cloud.uploadFile({
      cloudPath,
      fileContent: buffer,
    });

    const fileID = uploadRet?.fileID || "";
    if (!fileID) {
      return { ok: false, message: "upload failed" };
    }

    const tempRes = await cloud.getTempFileURL({
      fileList: [fileID],
    });
    const tempFileURL =
      tempRes?.fileList?.[0]?.tempFileURL || "";

    return {
      ok: true,
      mode: "cloud",
      roomNo,
      page,
      scene,
      fileID,
      tempFileURL,
      qrImageUrl: tempFileURL,
    };
  } catch (err) {
    return {
      ok: false,
      message: err?.message || "cloud openapi failed",
    };
  }
};

