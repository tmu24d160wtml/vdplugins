// plugins/Translate/src/index.ts
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { after, instead } from "@vendetta/patcher";
import { registerCommand } from "@vendetta/commands";
import { findByName, findByProps } from "@vendetta/metro";
import { React, ReactNative as RN } from "@vendetta/metro/common";
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
  showToast(error instanceof Error ? error.message : "Translation failed");
}
function getMessageText(message) {
  return message?.content || message?.messageSnapshots?.[0]?.message?.content || "";
}
function TranslatedLine({ message }) {
  const [result, setResult] = React.useState(
    translatedMessages.get(message?.id) ?? null
  );
  const text = getMessageText(message);
  React.useEffect(() => {
    if (!text?.trim() || !message?.id)
      return;
    let mounted = true;
    const cached = translatedMessages.get(message.id);
    const pending = translationPromises.get(message.id) ?? translate("incoming", text);
    translationPromises.set(message.id, pending);
    pending.then((value) => {
      translatedMessages.set(message.id, value);
      if (mounted)
        setResult(value);
    }).catch(() => void 0);
    return () => {
      mounted = false;
    };
  }, [message?.id, text]);
  if (!result?.text || result.text.trim() === text.trim())
    return null;
  return React.createElement(RN.Text, {
    style: { color: "#8a8f98", fontSize: 12, marginTop: 3, marginLeft: 2 }
  }, result.text);
}
function patchMessageRenderer() {
  const modules = [
    findByName("MessageContent", false),
    findByName("Message", false)
  ].filter(Boolean);
  const module = modules[0];
  if (!module) {
    setTimeout(patchMessageRenderer, 1500);
    return;
  }
  if (patchedModules.has(module))
    return;
  patchedModules.add(module);
  after("default", module, (args, result) => {
    const message = args?.[0]?.message ?? args?.[0]?.props?.message;
    if (!message || !result?.props)
      return result;
    const accessory = React.createElement(TranslatedLine, { message, key: `translation-${message.id}` });
    const children = result.props.children;
    if (Array.isArray(children))
      result.props.children = [...children, accessory];
    else
      result.props.children = [children, accessory];
    return result;
  });
}
function addTranslateAction(value, message) {
  if (!value || typeof value !== "object")
    return false;
  const children = value.props?.children;
  if (Array.isArray(children)) {
    const already = children.some((child) => child?.props?.id === "translate-message");
    if (!already && children.some((child) => child?.props?.id === "copy-text" || child?.props?.label === "Copy Text")) {
      children.push({
        type: "action",
        props: {
          id: "translate-message",
          label: "Translate",
          icon: "ic_language_24px",
          onPress: async () => {
            try {
              const result = await translate("incoming", getMessageText(message));
              translatedMessages.set(message.id, result);
              showToast(`${result.text}\\n(${result.sourceLanguage} \u2192 ${languageName(settings.incomingTo)})`);
            } catch (error) {
              notifyError(error);
            }
          }
        }
      });
      return true;
    }
    return children.some((child) => addTranslateAction(child, message));
  }
  return false;
}
function findMessageIn(value, depth = 0) {
  if (!value || depth > 5 || typeof value !== "object")
    return null;
  if (typeof value.id === "string" && typeof value.content === "string")
    return value;
  for (const child of Object.values(value)) {
    const found = findMessageIn(child, depth + 1);
    if (found)
      return found;
  }
  return null;
}
function patchSimpleActionSheet() {
  const module = findByProps("showSimpleActionSheet");
  if (!module?.showSimpleActionSheet) {
    setTimeout(patchSimpleActionSheet, 1500);
    return;
  }
  if (patchedModules.has(module))
    return;
  patchedModules.add(module);
  after("showSimpleActionSheet", module, (args) => {
    const config = args?.[0];
    const options = config?.options;
    const message = findMessageIn(config);
    if (!Array.isArray(options) || !message || options.some((item) => item?.id === "translate-message"))
      return;
    options.push({
      id: "translate-message",
      label: "Translate",
      onPress: async () => {
        try {
          const result = await translate("incoming", getMessageText(message));
          translatedMessages.set(message.id, result);
          showToast(result.text);
        } catch (error) {
          notifyError(error);
        }
      }
    });
  });
}
function patchMessageLongPress() {
  const module = findByName("MessageLongPressActionSheet", false);
  if (!module) {
    setTimeout(patchMessageLongPress, 1500);
    return;
  }
  if (patchedModules.has(module))
    return;
  patchedModules.add(module);
  messageMenuUnpatch = after("default", module, (_args, result) => {
    const message = _args?.[0]?.message ?? _args?.[0]?.props?.message;
    if (message)
      addTranslateAction(result, message);
    return result;
  });
}
function patchOutgoingMessages() {
  const actions = findByProps("sendMessage");
  if (!actions?.sendMessage)
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
      showToast(`Auto translate: ${settings.autoTranslate ? "ON" : "OFF"}`);
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
    settings = { ...defaults, ...storage };
    registerSlashCommand();
    patchSimpleActionSheet();
    patchMessageLongPress();
    patchOutgoingMessages();
    patchMessageRenderer();
  },
  onUnload() {
    unregisterCommand?.();
    unregisterCommand = void 0;
    messageMenuUnpatch?.();
    sendUnpatch?.();
    translatedMessages.clear();
    translationPromises.clear();
  },
  settings: SettingsPanel
};
export {
  src_default as default
};
