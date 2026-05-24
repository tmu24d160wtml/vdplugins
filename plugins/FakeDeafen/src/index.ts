let originalSend: typeof WebSocket.prototype.send | null = null;
let installed = false;
let unregisterCommand: (() => void) | null = null;

type FakeDeafenState = {
  installed: boolean;
  enabled: boolean;
  originalSend: typeof WebSocket.prototype.send;
  activeWebSocket: WebSocket | null;
  lastVoiceState: any;
};

declare global {
  var __fakeDeafenVendetta: FakeDeafenState | undefined;
  var bunny: any;
  var vendetta: any;
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

function getEnabled() {
  return globalThis.__fakeDeafenVendetta?.enabled ?? false;
}

function setEnabled(value: boolean) {
  const state = globalThis.__fakeDeafenVendetta;

  if (state) {
    state.enabled = value;
    log(`Realtime toggle: ${value ? "ON" : "OFF"}`);
  }
}

function toggleEnabled() {
  const next = !getEnabled();
  setEnabled(next);
  return next;
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
    enabled: true,
    originalSend,
    activeWebSocket: null,
    lastVoiceState: null
  };

  globalThis.__fakeDeafenVendetta = state;

  proto.send = function patchedSend(
    this: WebSocket,
    data: string | ArrayBufferLike | Blob | ArrayBufferView
  ) {
    try {
      if (typeof data === "string" && data.includes('"op":4')) {
        const payload = JSON.parse(data);

        if (payload?.op === 4 && payload?.d) {
          state.activeWebSocket = this;
          state.lastVoiceState = { ...payload.d };

          if (state.enabled) {
            payload.d.self_deaf = true;
            payload.d.self_mute = true;

            data = JSON.stringify(payload);

            log("Forced voice state: self_deaf=true, self_mute=true");
          } else {
            log("Bypassed voice state because toggle is OFF.");
          }
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

function tryRegisterCommand() {
  const registerCommand =
    globalThis.bunny?.api?.commands?.registerCommand ??
    globalThis.vendetta?.commands?.registerCommand;

  if (typeof registerCommand !== "function") {
    error("registerCommand not found. Slash command /fd will not be available.");
    return;
  }

  unregisterCommand = registerCommand({
    name: "fd",
    displayName: "fd",
    description: "Toggle Fake Deafen ON/OFF",
    displayDescription: "Toggle Fake Deafen ON/OFF",
    options: [],

    execute: () => {
      const enabled = toggleEnabled();

      return {
        content: `Fake Deafen: ${enabled ? "ON" : "OFF"}`
      };
    }
  });

  log("Registered /fd command.");
}

function unregisterFdCommand() {
  if (typeof unregisterCommand === "function") {
    unregisterCommand();
  }

  unregisterCommand = null;
}

export default {
  onLoad() {
    patchWebSocket();
    tryRegisterCommand();
  },

  onUnload() {
    unregisterFdCommand();
    unpatchWebSocket();
  }
};
