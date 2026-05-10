# shared 协议说明

本目录用于前后端共享常量与协议约定，避免联机开发时字符串和字段不一致。

## 文件

- `events.js`：事件名与动作常量
- `errors.js`：错误码与默认中文提示
- `protocol.js`：标准包结构构造函数与基础校验

## 标准消息结构

```js
{
  event: "game.discard",
  reqId: "uuid-1",
  seq: 12,
  ts: 1770000000,
  roomId: "R1001",
  tableId: "T2001",
  payload: {}
}
```

## 使用建议

1. 服务端收到包先调用 `isValidPacket` 做基础校验。
2. 每个事件再做“业务级 payload 校验”。
3. 回包统一带 `reqId`，便于客户端对齐请求与响应。
4. `seq` 仅在牌局事件中启用，房间事件可用 `0`。
5. 所有报错尽量返回 `errors.js` 中的错误码。
