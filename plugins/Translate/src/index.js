// plugins/Translate/src/index.ts
import { storage } from "@vendetta/plugin";
import { after, before, instead } from "@vendetta/patcher";
import { registerCommand } from "@vendetta/commands";
import { findByName, findByProps, findByStoreName } from "@vendetta/metro";
import { React, ReactNative as RN, FluxDispatcher } from "@vendetta/metro/common";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";
var defaults = {
  provider: "google",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
  incomingFrom: "auto",
  incomingTo: "vi",
  outgoingFrom: "auto",
  outgoingTo: "en",
  autoTranslate: true
};
var settings = { ...defaults };
var unregisterCommand;
var messageMenuUnpatch;
var sendUnpatch;
var translatedMessages = /* @__PURE__ */ new Map();
var translationPromises = /* @__PURE__ */ new Map();
var patchedModules = /* @__PURE__ */ new WeakSet();
var autoProcessed = /* @__PURE__ */ new Set();
var originalContents = /* @__PURE__ */ new Map();
var messageEventSubscribed = false;
var scanInterval;
var messageEventUnsubscribers = [];
var runtimeUnpatches = /* @__PURE__ */ new Set();
var lazyActionSheetUnpatch;
var sheetUnpatches = /* @__PURE__ */ new Set();
var languages = {
  auto: "Detect language",
  en: "English",
  vi: "Vietnamese",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  ru: "Russian",
  th: "Thai",
  id: "Indonesian",
  it: "Italian",
  nl: "Dutch"
};
function languageName(code) {
  return languages[code] ?? code;
}
async function googleTranslate(text, from, to) {
  const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
    "params.client": "gtx",
    dataTypes: "TRANSLATION",
    // Public client key used by Google Translate's web client.
    key: "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA",
    "query.sourceLanguage": from,
    "query.targetLanguage": to,
    "query.text": text
  });
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Google Translate failed (${response.status})`);
  const data = await response.json();
  return { text: data.translation, sourceLanguage: data.sourceLanguage || from };
}
async function geminiTranslate(text, from, to) {
  if (!settings.geminiApiKey.trim())
    throw new Error("Gemini API key is not configured");
  const model = encodeURIComponent(settings.geminiModel || defaults.geminiModel);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(settings.geminiApiKey)}`;
  const source = from === "auto" ? "the detected source language" : languageName(from);
  const target = languageName(to);
  const prompt = `Translate the following Discord message from ${source} to ${target}. Preserve markdown, mentions, emoji and line breaks. Return only the translation.

${text}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!response.ok)
    throw new Error(`Gemini failed (${response.status})`);
  const data = await response.json();
  const translated = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
  if (!translated)
    throw new Error("Gemini returned an empty translation");
  return { text: translated, sourceLanguage: from === "auto" ? "detected language" : from };
}
async function translate(direction, text) {
  const from = direction === "incoming" ? settings.incomingFrom : settings.outgoingFrom;
  const to = direction === "incoming" ? settings.incomingTo : settings.outgoingTo;
  if (!text.trim())
    return { text, sourceLanguage: from };
  return settings.provider === "gemini" ? geminiTranslate(text, from, to) : googleTranslate(text, from, to);
}
function notifyError(error) {
  console.error("[Translate Messages] translation failed", error);
}
function getMessageText(message) {
  const content = message?.content || message?.messageSnapshots?.[0]?.message?.content || "";
  const marker = content.indexOf("\n\n-# ");
  return marker >= 0 ? content.slice(0, marker) : content;
}
function scheduleAutoTranslation(message) {
  if (!settings.autoTranslate || !message?.id || !getMessageText(message)?.trim() || autoProcessed.has(message.id))
    return;
  autoProcessed.add(message.id);
  const original = getMessageText(message);
  originalContents.set(message.id, original);
  translate("incoming", original).then((result) => {
    if (!result?.text || result.text.trim() === original.trim())
      return;
    translatedMessages.set(message.id, result);
    const updated = { ...message, content: `${original}

-# ${result.text}` };
    try {
      FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message: updated, log_edit: false, otherPluginBypass: true });
    } catch {
      message.content = updated.content;
    }
  }).catch(() => autoProcessed.delete(message.id));
}
function collectMessages(value, output = [], depth = 0) {
  if (!value || depth > 4 || typeof value !== "object")
    return output;
  if (typeof value.id === "string" && typeof value.content === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectMessages(item, output, depth + 1));
    return output;
  }
  Object.values(value).forEach((item) => collectMessages(item, output, depth + 1));
  return output;
}
function scanCurrentChannelMessages() {
  try {
    const messageStore = findByStoreName("MessageStore");
    const selectedStore = findByStoreName("SelectedChannelStore") ?? findByProps("getChannelId", "getCurrentlySelectedChannelId") ?? findByProps("getChannelId");
    const channelId = selectedStore?.getChannelId?.() ?? selectedStore?.getCurrentlySelectedChannelId?.() ?? selectedStore?.getLastSelectedChannelId?.();
    if (!messageStore || !channelId)
      return;
    const messages = messageStore.getMessages?.(channelId);
    collectMessages(messages).forEach((message) => {
      if (!message?.channel_id || message.channel_id === channelId)
        scheduleAutoTranslation(message);
    });
  } catch (error) {
    console.log("[Translate Messages] existing message scan failed", error);
  }
}
function subscribeToMessageEvents() {
  const dispatcher = FluxDispatcher;
  if (!messageEventSubscribed && typeof dispatcher?.subscribe === "function") {
    const subscribe = (event, handler) => {
      const unsubscribe = dispatcher.subscribe(event, handler);
      if (typeof unsubscribe === "function")
        messageEventUnsubscribers.push(unsubscribe);
    };
    subscribe("MESSAGE_CREATE", (event) => scheduleAutoTranslation(event?.message ?? event));
    subscribe("MESSAGE_UPDATE", (event) => scheduleAutoTranslation(event?.message ?? event));
    subscribe("CHANNEL_SELECT", () => setTimeout(scanCurrentChannelMessages, 100));
    subscribe("LOAD_MESSAGES_SUCCESS", () => setTimeout(scanCurrentChannelMessages, 100));
    subscribe("LOAD_MESSAGES_SUCCESS", () => setTimeout(scanCurrentChannelMessages, 800));
    subscribe("MESSAGE_LIST_UPDATE", () => setTimeout(scanCurrentChannelMessages, 100));
    messageEventSubscribed = true;
  }
  setTimeout(scanCurrentChannelMessages, 500);
  setTimeout(scanCurrentChannelMessages, 2e3);
  setTimeout(scanCurrentChannelMessages, 5e3);
  scanInterval ??= setInterval(scanCurrentChannelMessages, 2e3);
}
function patchMessageStore() {
  const store = findByProps("getMessages");
  if (!store?.getMessages) {
    setTimeout(patchMessageStore, 1500);
    return;
  }
  if (patchedModules.has(store))
    return;
  patchedModules.add(store);
  const unpatch = after("getMessages", store, (_args, result) => {
    collectMessages(result).forEach((message) => scheduleAutoTranslation(message));
    return result;
  });
  runtimeUnpatches.add(unpatch);
}
function patchLazyMessageActionSheet() {
  const lazy = findByProps("openLazy", "hideActionSheet");
  if (!lazy?.openLazy) {
    setTimeout(patchLazyMessageActionSheet, 1500);
    return;
  }
  if (patchedModules.has(lazy))
    return;
  patchedModules.add(lazy);
  lazyActionSheetUnpatch = before("openLazy", lazy, ([component, key, props]) => {
    const message = props?.message;
    if (key !== "MessageLongPressActionSheet" || !message || !component?.then)
      return;
    component.then((sheet) => {
      if (!sheet)
        return;
      const unpatchSheet = after("default", sheet, (_args, tree) => {
        React.useEffect(() => () => {
          unpatchSheet();
          sheetUnpatches.delete(unpatchSheet);
        }, []);
        const groups = findInReactTree(
          tree,
          (node) => Array.isArray(node) && node[0]?.type?.name === "ActionSheetRowGroup"
        );
        const content = getMessageText(message);
        if (!content || !groups)
          return tree;
        const Row = Forms.FormRow;
        const row = React.createElement(Row, {
          label: "Translate",
          onPress: async () => {
            lazy.hideActionSheet?.();
            try {
              const result = await translate("incoming", content);
              translatedMessages.set(message.id, result);
              FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                message: {
                  id: message.id,
                  channel_id: message.channel_id,
                  guild_id: message.guild_id,
                  content: `${content}

-# ${result.text}`
                },
                log_edit: false,
                otherPluginBypass: true
              });
            } catch (error) {
              notifyError(error);
            }
          }
        });
        const target = findInReactTree(
          groups,
          (node) => Array.isArray(node) && node.some((child) => child?.type?.name === "ActionSheetRow")
        );
        if (target)
          target.unshift(row);
        return tree;
      });
      sheetUnpatches.add(unpatchSheet);
    }).catch(() => void 0);
  });
}
function patchOutgoingMessages() {
  const actions = findByProps("sendMessage");
  if (!actions?.sendMessage) {
    setTimeout(patchOutgoingMessages, 1500);
    return;
  }
  if (sendUnpatch)
    return;
  sendUnpatch = instead("sendMessage", actions, async (args, original) => {
    if (!settings.autoTranslate || !args?.[1]?.content)
      return original(...args);
    try {
      const result = await translate("outgoing", args[1].content);
      args[1] = { ...args[1], content: result.text };
    } catch (error) {
      notifyError(error);
    }
    return original(...args);
  });
}
function registerSlashCommand() {
  const register = registerCommand;
  unregisterCommand = register({
    name: "translate",
    displayName: "translate",
    description: "Toggle automatic translation of messages you send",
    displayDescription: "Toggle automatic translation of messages you send",
    options: [],
    execute: () => {
      settings.autoTranslate = !settings.autoTranslate;
      storage.autoTranslate = settings.autoTranslate;
      return void 0;
    }
  });
}
function SettingsPanel() {
  const [value, setValue] = React.useState({ ...settings });
  const isDark = RN.useColorScheme?.() === "dark";
  const inputTextColor = isDark ? "#ffffff" : "#202124";
  const update = (key, next) => {
    const merged = { ...value, [key]: next };
    setValue(merged);
    settings = merged;
    storage[key] = next;
  };
  const input = (key, label, placeholder = "") => React.createElement(RN.TextInput, {
    value: String(value[key] ?? ""),
    placeholder,
    placeholderTextColor: isDark ? "#9aa0a6" : "#8a8a8a",
    onChangeText: (v) => update(key, v),
    style: { color: inputTextColor, borderBottomWidth: 1, borderBottomColor: isDark ? "#777" : "#555", padding: 10, marginBottom: 10 }
  });
  return React.createElement(
    RN.ScrollView,
    { style: { padding: 16 } },
    React.createElement(RN.Text, { style: { color: "white", fontSize: 18, fontWeight: "bold", marginBottom: 12 } }, "Translate Messages"),
    React.createElement(RN.Text, { style: { color: "#bbb" } }, "Provider: google or gemini"),
    input("provider", "Provider"),
    React.createElement(RN.Text, { style: { color: isDark ? "#bbb" : "#555" } }, "Gemini API key (only for Gemini)"),
    input("geminiApiKey", "API key"),
    React.createElement(RN.Text, { style: { color: isDark ? "#bbb" : "#555" } }, "Gemini model"),
    input("geminiModel", "gemini-2.0-flash"),
    React.createElement(RN.Text, { style: { color: isDark ? "#bbb" : "#555" } }, "Incoming: from (default auto), to (default vi)"),
    input("incomingFrom", "auto"),
    input("incomingTo", "vi"),
    React.createElement(RN.Text, { style: { color: "#bbb" } }, "Your messages: from (default auto), to (default en)"),
    input("outgoingFrom", "auto"),
    input("outgoingTo", "en"),
    React.createElement(RN.Button, { title: `Auto translate: ${value.autoTranslate ? "ON" : "OFF"}`, onPress: () => update("autoTranslate", !value.autoTranslate) })
  );
}
var src_default = {
  onLoad() {
    console.log("[Translate Messages] loaded");
    settings = { ...defaults, ...storage };
    settings.autoTranslate = true;
    storage.autoTranslate = true;
    registerSlashCommand();
    patchLazyMessageActionSheet();
    patchOutgoingMessages();
    subscribeToMessageEvents();
    patchMessageStore();
  },
  onUnload() {
    unregisterCommand?.();
    unregisterCommand = void 0;
    messageMenuUnpatch?.();
    sendUnpatch?.();
    lazyActionSheetUnpatch?.();
    lazyActionSheetUnpatch = void 0;
    sheetUnpatches.forEach((unpatch) => unpatch());
    sheetUnpatches.clear();
    translatedMessages.clear();
    translationPromises.clear();
    autoProcessed.clear();
    originalContents.clear();
    messageEventUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    if (scanInterval)
      clearInterval(scanInterval);
    scanInterval = void 0;
    runtimeUnpatches.forEach((unpatch) => unpatch());
    runtimeUnpatches.clear();
    messageEventSubscribed = false;
  },
  settings: SettingsPanel
};
export {
  src_default as default
};
