const http = require("http");
const { URL } = require("url");
const { WebSocketServer } = require("ws");
const { createGateway } = require("./ws/gateway");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;

// 提供最小健康检查接口，方便部署后探活
const server = http.createServer((req, res) => {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const u = new URL(req.url || "/", baseUrl);

  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "chenglaizi-server" }));
    return;
  }
  if (u.pathname === "/room/qrcode") {
    const roomNo = String(u.searchParams.get("roomNo") || "").trim();
    if (!roomNo) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, message: "roomNo required" }));
      return;
    }
    // 配置为你的小游戏落地页（应支持 roomNo 参数并拉起小游戏）
    const entryBase = process.env.MINI_GAME_ENTRY_URL || "https://example.com/chenglaizi";
    const inviteUrl = `${entryBase}${entryBase.includes("?") ? "&" : "?"}roomNo=${encodeURIComponent(roomNo)}`;
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(inviteUrl)}`;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        roomNo,
        inviteUrl,
        qrImageUrl,
      }),
    );
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, message: "not found" }));
});

const wss = new WebSocketServer({ server });
createGateway(wss);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] ws listening on :${PORT}`);
});
