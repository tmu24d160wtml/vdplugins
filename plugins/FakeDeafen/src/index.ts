let originalSend: typeof WebSocket.prototype.send | null = null;
let installed = false;

type FakeDeafenState = {
  installed: boolean;
  originalSend: typeof WebSocket.prototype.send;
  activeWebSocket: WebSocket | null;
  lastVoiceState: unknown;
};

declare global {
  var __fakeDeafenVendetta: FakeDeafenState | undefined;
}

function log(...args: unknown[]) {
  console.log("[FakeDeafen]", ...args);
}

function error(...args: unknown[]) {
  console.error("[FakeDeafen]", ...args);
}

function getWebSocketPrototype() {
  const WebSocketCtor = globalThis.WebSocket;

  if (
    !WebSocketCtor ||
    !WebSocketCtor.prototype ||
    typeof WebSocketCtor.prototype.send !== "function"
  ) {
    return null;
  }

  return WebSocketCtor.prototype;
}

function patchWebSocket() {
  if (installed || globalThis.__fakeDeafenVendetta?.installed) {
    log("Already installed.");
    return;
  }

  const proto = getWebSocketPrototype();

  if (!proto) {
    error("WebSocket.prototype.send not found.");
    return;
  }

  originalSend = proto.send;

  const state: FakeDeafenState = {
    installed: true,
    originalSend,
    activeWebSocket: null,
    lastVoiceState: null
  };

  globalThis.__fakeDeafenVendetta = state;

  proto.send = function patchedSend(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    try {
      if (typeof data === "string" && data.includes('"op":4')) {
        const payload = JSON.parse(data);

        if (payload?.op === 4 && payload?.d) {
          state.activeWebSocket = this;
          state.lastVoiceState = { ...payload.d };

          payload.d.self_deaf = true;
          payload.d.self_mute = true;

          data = JSON.stringify(payload);

          log("Forced voice state: self_deaf=true, self_mute=true");
        }
      }
    } catch (e) {
      error("Failed to intercept Gateway payload:", e);
    }

    return state.originalSend.call(this, data);
  };

  installed = true;
  log("Started.");
}

function unpatchWebSocket() {
  const proto = getWebSocketPrototype();
  const state = globalThis.__fakeDeafenVendetta;

  if (proto && state?.originalSend) {
    proto.send = state.originalSend;
  } else if (proto && originalSend) {
    proto.send = originalSend;
  }

  delete globalThis.__fakeDeafenVendetta;

  originalSend = null;
  installed = false;

  log("Stopped and restored WebSocket.prototype.send.");
}

export default {
  onLoad: patchWebSocket,
  onUnload: unpatchWebSocket
};
