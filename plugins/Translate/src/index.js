// plugins/Translate/src/index.ts
import { storage } from "@vendetta/plugin";
import { after, before, instead } from "@vendetta/patcher";
import { findByProps } from "@vendetta/metro";
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
  outgoingTo: "en"
};
var settings = { ...defaults };
var translatedMessages = /* @__PURE__ */ new Map();
var patchedModules = /* @__PURE__ */ new WeakSet();
var lazyActionSheetUnpatch;
var sendUnpatch;
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
async function translate(text, direction = "incoming") {
  const from = direction === "incoming" ? settings.incomingFrom : settings.outgoingFrom;
  const to = direction === "incoming" ? settings.incomingTo : settings.outgoingTo;
  if (!text.trim())
    return { text, sourceLanguage: from };
  return settings.provider === "gemini" ? geminiTranslate(text, from, to) : googleTranslate(text, from, to);
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
    const content = args?.[1]?.content;
    if (typeof content !== "string" || !content.trim())
      return original(...args);
    try {
      const result = await translate(content, "outgoing");
      args[1] = { ...args[1], content: result.text };
    } catch (error) {
      notifyError(error);
    }
    return original(...args);
  });
}
function notifyError(error) {
  console.error("[Translate Messages] translation failed", error);
}
function getMessageText(message) {
  const content = message?.content || message?.messageSnapshots?.[0]?.message?.content || "";
  const marker = content.indexOf("\n\n-# ");
  return marker >= 0 ? content.slice(0, marker) : content;
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
              const result = await translate(content);
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
    React.createElement(RN.Text, { style: { color: isDark ? "white" : "#202124", fontSize: 18, fontWeight: "bold", marginBottom: 12 } }, "Translate Messages"),
    React.createElement(RN.Text, { style: { color: isDark ? "#bbb" : "#555" } }, "Provider: google or gemini"),
    input("provider", "google or gemini"),
    React.createElement(RN.Text, { style: { color: isDark ? "#bbb" : "#555" } }, "Gemini API key (only for Gemini)"),
    input("geminiApiKey", "API key"),
    React.createElement(RN.Text, { style: { color: isDark ? "#bbb" : "#555" } }, "Gemini model"),
    input("geminiModel", "gemini-2.0-flash"),
    React.createElement(RN.Text, { style: { color: isDark ? "#bbb" : "#555" } }, "Incoming message: source language and target language"),
    input("incomingFrom", "auto"),
    input("incomingTo", "vi"),
    React.createElement(RN.Text, { style: { color: isDark ? "#bbb" : "#555", marginTop: 12 } }, "Your messages: source language and target language"),
    input("outgoingFrom", "auto"),
    input("outgoingTo", "en")
  );
}
var src_default = {
  onLoad() {
    console.log("[Translate Messages] loaded");
    settings = { ...defaults, ...storage };
    patchLazyMessageActionSheet();
    patchOutgoingMessages();
  },
  onUnload() {
    lazyActionSheetUnpatch?.();
    lazyActionSheetUnpatch = void 0;
    sendUnpatch?.();
    sendUnpatch = void 0;
    sheetUnpatches.forEach((unpatch) => unpatch());
    sheetUnpatches.clear();
    translatedMessages.clear();
  },
  settings: SettingsPanel
};
export {
  src_default as default
};
