  geminiApiKey: string;
  geminiModel: string;
  incomingFrom: string;
  incomingTo: string;
  outgoingFrom: string;
  outgoingTo: string;
  autoTranslate: boolean;
};

const defaults: Settings = {
  provider: "google",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
  incomingFrom: "auto",
  incomingTo: "vi",
  outgoingFrom: "auto",
  outgoingTo: "en",
  autoTranslate: false,
};


let settings: Settings = { ...defaults };
let unregisterCommand: (() => void) | undefined;
let messageMenuUnpatch: (() => void) | undefined;
let sendUnpatch: (() => void) | undefined;
const translatedMessages = new Map<string, Translation>();
const translationPromises = new Map<string, Promise<Translation>>();

const languages: Record<string, string> = {
  auto: "Detect language", en: "English", vi: "Vietnamese", zh: "Chinese", ja: "Japanese",
  ko: "Korean", fr: "French", de: "German", es: "Spanish", pt: "Portuguese",
  ru: "Russian", th: "Thai", id: "Indonesian", it: "Italian", nl: "Dutch",
};

function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return settings[key];
}

function languageName(code: string) {
  return languages[code] ?? code;
}

async function googleTranslate(text: string, from: string, to: string): Promise<Translation> {
  const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
    "params.client": "gtx",
    dataTypes: "TRANSLATION",
    // Public client key used by Google Translate's web client.
    key: "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA",
    "query.sourceLanguage": from,
    "query.targetLanguage": to,
    "query.text": text,
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Translate failed (${response.status})`);
  const data = await response.json();
  return { text: data.translation, sourceLanguage: data.sourceLanguage || from };
}
