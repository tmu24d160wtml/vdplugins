import { showToast } from "@vendetta/ui/toasts";

let originalSend: typeof WebSocket.prototype.send | null = null;
let installed = false;
let unregisterFd: (() => void) | null = null;
let unregisterFc: (() => void) | null = null;

// Định nghĩa trạng thái gộp cho cả Fake Deafen và Fast Camera
type SharedPluginState = {
  installed: boolean;
  fdEnabled: boolean;
  fcEnabled: boolean;
  originalSend: typeof WebSocket.prototype.send;
  activeWebSocket: WebSocket | null;
  lastVoiceState: any;
};

let fcInterval: NodeJS.Timeout | null = null;
const TOGGLE_SPEED = 700; // Tốc độ chớp tắt camera (100ms)

declare global {
  var __sharedVoicePluginVendetta: SharedPluginState | undefined;
  var bunny: any;
  var vendetta: any;
}

function log(...args: unknown[]) {
  console.log("[VoiceCombo]", ...args);
}

function error(...args: unknown[]) {
  console.error("[VoiceCombo]", ...args);
}

function getWebSocketPrototype() {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor || !WebSocketCtor.prototype || typeof WebSocketCtor.prototype.send !== "function") {
    return null;
  }
  return WebSocketCtor.prototype;
}

// --- QUẢN LÝ TRẠNG THÁI (GETTER / SETTER) ---
function getFdEnabled() { return globalThis.__sharedVoicePluginVendetta?.fdEnabled ?? false; }
function setFdEnabled(value: boolean) {
  const state = globalThis.__sharedVoicePluginVendetta;
  if (state) state.fdEnabled = value;
}

function getFcEnabled() { return globalThis.__sharedVoicePluginVendetta?.fcEnabled ?? false; }
function setFcEnabled(value: boolean) {
  const state = globalThis.__sharedVoicePluginVendetta;
  if (state) state.fcEnabled = value;
}

// --- VÒNG LẶP CHO FAST CAMERA (GỬI GATEWAY CHỚP TẮT) ---
let lastVideoState = false;
function runFcLoop() {
  const state = globalThis.__sharedVoicePluginVendetta;
  if (!state || !state.fcEnabled || !state.activeWebSocket || !state.lastVoiceState) return;

  try {
    // Đảo trạng thái video liên tục
    lastVideoState = !lastVideoState;
    
    // Sao chép trạng thái voice state mới nhất của phòng thoại hiện tại
    const payload = {
      op: 4,
      d: {
        ...state.lastVoiceState,
        self_video: lastVideoState
      }
    };

    // Gửi trực tiếp qua WebSocket đang hoạt động
    state.originalSend.call(state.activeWebSocket, JSON.stringify(payload));
  } catch (e) {
    error("FC Loop failed to send payload:", e);
  }

  fcInterval = setTimeout(runFcLoop, TOGGLE_SPEED);
}

function startFc() {
  setFcEnabled(true);
  runFcLoop();
}

function stopFc() {
  setFcEnabled(false);
  if (fcInterval) {
    clearTimeout(fcInterval);
    fcInterval = null;
  }
  
  // Trả camera về lại trạng thái bình thường (tắt hẳn) khi dừng lệnh
  const state = globalThis.__sharedVoicePluginVendetta;
  if (state && state.activeWebSocket && state.lastVoiceState) {
    try {
      const payload = {
        op: 4,
        d: { ...state.lastVoiceState, self_video: false }
      };
      state.originalSend.call(state.activeWebSocket, JSON.stringify(payload));
    } catch(e) {}
  }
}

// --- HOOK WEBSOCKET ---
function patchWebSocket() {
  if (installed || globalThis.__sharedVoicePluginVendetta?.installed) {
    log("Already installed.");
    return;
  }

  const proto = getWebSocketPrototype();
  if (!proto) {
    error("WebSocket.prototype.send not found.");
    showToast("Voice Combo: WebSocket not found");
    return;
  }

  originalSend = proto.send;

  const state: SharedPluginState = {
    installed: true,
    fdEnabled: true,  // Mặc định bật Fake Deafen khi load
    fcEnabled: false, // Mặc định tắt Fast Camera khi load
    originalSend,
    activeWebSocket: null,
    lastVoiceState: null
  };

  globalThis.__sharedVoicePluginVendetta = state;

  proto.send = function patchedSend(
    this: WebSocket,
    data: string | ArrayBufferLike | Blob | ArrayBufferView
  ) {
    try {
      if (typeof data === "string" && data.includes('"op":4')) {
        const payload = JSON.parse(data);

        if (payload?.op === 4 && payload?.d) {
          state.activeWebSocket = this;
          
          // Lưu lại dữ liệu phòng thoại gốc (guild_id, channel_id...) để FC sử dụng cấu trúc này
          state.lastVoiceState = { ...payload.d };

          // Xử lý logic Fake Deafen (/fd)
          if (state.fdEnabled) {
            payload.d.self_deaf = true;
            payload.d.self_mute = true;
            data = JSON.stringify(payload);
            log("Forced voice state: self_deaf=true, self_mute=true");
          }
        }
      }
    } catch (e) {
      error("Failed to intercept Gateway payload:", e);
    }

    return state.originalSend.call(this, data);
  };

  installed = true;
  log("Hooked WebSocket successful.");
}

function unpatchWebSocket() {
  const proto = getWebSocketPrototype();
  const state = globalThis.__sharedVoicePluginVendetta;

  if (proto && state?.originalSend) {
    proto.send = state.originalSend;
  } else if (proto && originalSend) {
    proto.send = originalSend;
  }

  delete globalThis.__sharedVoicePluginVendetta;
  originalSend = null;
  installed = false;
  log("Restored WebSocket.");
}

// --- ĐĂNG KÝ CÁC LỆNH SLASH COMMANDS ---
function registerCommands() {
  const registerCommand =
    globalThis.bunny?.api?.commands?.registerCommand ??
    globalThis.vendetta?.commands?.registerCommand;

  if (typeof registerCommand !== "function") {
    error("registerCommand function not found.");
    showToast("Voice Combo: Commands unavailable");
    return;
  }

  // Lệnh 1: /fd (Fake Deafen)
  unregisterFd = registerCommand({
    name: "fd",
    displayName: "fd",
    description: "Toggle Fake Deafen ON/OFF",
    displayDescription: "Toggle Fake Deafen ON/OFF",
    options: [],
    execute: () => {
      const nextState = !getFdEnabled();
      setFdEnabled(nextState);
      showToast(`Fake Deafen: ${nextState ? "ON" : "OFF"}`);
      return undefined as any;
    }
  });

  // Lệnh 2: /fc (Fast Camera Spammer)
  unregisterFc = registerCommand({
    name: "fc",
    displayName: "fc",
    description: "Toggle Fast Camera Spammer ON/OFF",
    displayDescription: "Toggle Fast Camera Spammer ON/OFF",
    options: [],
    execute: () => {
      const isRunning = getFcEnabled();
      if (isRunning) {
        stopFc();
        showToast("🟢 Fast Camera: OFF");
      } else {
        startFc();
        showToast("⚡ Fast Camera: ON (100ms)");
      }
      return undefined as any;
    }
  });

  log("Registered /fd and /fc commands.");
}

function unregisterCommands() {
  if (typeof unregisterFd === "function") unregisterFd();
  if (typeof unregisterFc === "function") unregisterFc();
  unregisterFd = null;
  unregisterFc = null;
}

// --- EXPORT DEFAULT PLUGIN ---
export default {
  onLoad() {
    patchWebSocket();
    registerCommands();
  },

  onUnload() {
    stopFc();
    unregisterCommands();
    unpatchWebSocket();
  }
};
