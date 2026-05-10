# server 使用说明

## 已实现内容（最小联调版）

- WebSocket 网关
- 登录占位：`auth.login`（用 code 生成 uid/token）
- 房间：`room.create`、`room.join`、`room.ready`
- 房间广播：`room.state`
- 心跳：`sys.ping` / `sys.pong`

## 启动

在 `server/` 目录执行：

```bash
npm install
npm start
```

默认端口：`3100`

健康检查：

```bash
GET http://127.0.0.1:3100/health
```

## 联调顺序建议

1. 客户端发送 `auth.login`
2. 登录成功后发送 `room.create`，拿到 `roomNo`
3. 第二个客户端登录后发送 `room.join`
4. 双方监听 `room.state`，确认座位和在线状态同步
5. 客户端发送 `room.ready`，验证准备状态广播

## 注意

- 当前房间数据是内存存储，服务重启会丢失。
- 当前登录是占位实现，后续需替换为微信 `code2Session`。
