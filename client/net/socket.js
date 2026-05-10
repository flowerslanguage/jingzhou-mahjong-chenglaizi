/**
 * 微信小游戏 Socket 封装：
 * - 统一连接、发送、重连
 * - 对外暴露事件订阅接口
 */

function createSocketClient(options) {
  const url = options.url;
  const reconnectDelayMs = options.reconnectDelayMs || 2000;

  let socketTask = null;
  let manualClose = false;
  let connected = false;

  const listeners = {
    open: [],
    close: [],
    error: [],
    message: [],
  };

  function emit(event, data) {
    const arr = listeners[event] || [];
    for (const fn of arr) {
      try {
        fn(data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("socket listener error", err);
      }
    }
  }

  function connect() {
    manualClose = false;
    try {
      socketTask = wx.connectSocket({ url });
    } catch (err) {
      emit("error", err || new Error("connectSocket 调用失败"));
      return false;
    }

    socketTask.onOpen(() => {
      connected = true;
      emit("open");
    });

    socketTask.onClose((evt) => {
      connected = false;
      emit("close", evt);
      if (!manualClose) {
        setTimeout(() => {
          connect();
        }, reconnectDelayMs);
      }
    });

    socketTask.onError((err) => {
      emit("error", err);
    });

    socketTask.onMessage((evt) => {
      let data = null;
      try {
        data = JSON.parse(evt.data);
      } catch (err) {
        emit("error", new Error("消息解析失败"));
        return;
      }
      emit("message", data);
    });
    return true;
  }

  function close() {
    manualClose = true;
    if (socketTask) socketTask.close();
    socketTask = null;
    connected = false;
  }

  function send(packet) {
    if (!connected || !socketTask) return false;
    socketTask.send({
      data: JSON.stringify(packet),
    });
    return true;
  }

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function isConnected() {
    return connected;
  }

  return {
    connect,
    close,
    send,
    on,
    isConnected,
  };
}

module.exports = {
  createSocketClient,
};
