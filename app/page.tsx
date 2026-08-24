"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { OWNER_NAME, SITE_NAME, SITE_TAGLINE } from "../lib/branding.ts";
import { DEFAULT_MODEL, MODELS, isKnownModel } from "../lib/models.ts";
import { STORAGE_KEYS, STORAGE_VERSION } from "../lib/storage.ts";
import { localResponse } from "../lib/search/conversation.ts";
import type { HistoryItem } from "../lib/search/intent.ts";

type SearchSource = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  time: string;
  attachment?: string;
  sources?: SearchSource[];
  searchMode?: "news" | "knowledge" | "conversation" | "error";
  searchedAt?: string;
};

type SpeechRecognitionHandle = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionHandle;
    webkitSpeechRecognition?: new () => SpeechRecognitionHandle;
  }
}

/** Keeps the persisted transcript well under the ~5 MB localStorage budget. */
const MAX_PERSISTED_MESSAGES = 60;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const HISTORY_TURNS_SENT = 10;
/** Minimum time the splash stays up, so a fast restore isn't a one-frame flash. */
const SPLASH_HOLD_MS = 550;
/** Must match the .app-splash.is-leaving transition duration in globals.css. */
const SPLASH_FADE_MS = 420;

const sampleChats: Record<string, Message[]> = {
  "Learning plan ideas": [
    { id: "sample-101", role: "user", content: "Help me build a learning plan for coding on Android.", time: "Yesterday" },
    { id: "sample-102", role: "assistant", content: "Start with Python fundamentals in short daily sessions, then build small projects directly in Termux. A good first month would cover syntax, functions, files, APIs, and one finished project you can share.", time: "Yesterday" },
  ],
  "Weekly goals": [
    { id: "sample-201", role: "user", content: "Can you help me set three realistic goals for this week?", time: "Monday" },
    { id: "sample-202", role: "assistant", content: "Yes. Let’s choose one goal for progress, one for your health, and one for your personal life. Each should be small enough to finish and specific enough to track.", time: "Monday" },
  ],
};

const suggestions = [
  {
    icon: "globe",
    title: "Today’s news",
    detail: "Search live coverage",
    prompt: "Look into today’s top news.",
  },
  {
    icon: "book",
    title: "Explain a concept",
    detail: "Make something click",
    prompt: "Explain a difficult concept to me in a simple way.",
  },
  {
    icon: "spark",
    title: "Plan my day",
    detail: "Build a focused schedule",
    prompt: "Help me plan a productive day with clear priorities.",
  },
  {
    icon: "bulb",
    title: "Brainstorm ideas",
    detail: "Find a fresh direction",
    prompt: "Help me brainstorm a few strong ideas for a new project.",
  },
];

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  const paths: Record<string, React.ReactNode> = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    plus: <path d="M12 5v14M5 12h14" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.82 2.82-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.82-2.82.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3v-4h.04A1.7 1.7 0 0 0 4.6 8.92a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.82-2.82.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.82 2.82-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 21 9.96V14a1.7 1.7 0 0 0-1.6 1Z" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.8 9.4a2.4 2.4 0 1 1 3.5 2.14c-.82.4-1.3.9-1.3 1.96M12 17h.01" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    send: <><path d="m21 3-8.3 18-2.2-7.5L3 10.7 21 3Z" /><path d="m10.5 13.5 4-4" /></>,
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>,
    paperclip: <path d="m20.5 11.5-8.9 8.9a5 5 0 0 1-7.1-7.1l9.6-9.6a3.5 3.5 0 0 1 5 5l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" /></>,
    moon: <path d="M20.5 15.1A8.5 8.5 0 0 1 8.9 3.5 8.5 8.5 0 1 0 20.5 15.1Z" />,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
    spark: <><path d="m12 3 1.25 4.1L17 9l-3.75 1.9L12 15l-1.25-4.1L7 9l3.75-1.9L12 3Z" /><path d="m5 14 .7 2.3L8 17.5l-2.3 1.2L5 21l-.7-2.3L2 17.5l2.3-1.2L5 14ZM19 13l.45 1.55L21 15l-1.55.45L19 17l-.45-1.55L17 15l1.55-.45L19 13Z" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z" /></>,
    document: <><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
    bulb: <><path d="M9 18h6M10 22h4M8.2 14.5a6 6 0 1 1 7.6 0c-.9.67-1.3 1.55-1.3 2.5h-5c0-.95-.4-1.83-1.3-2.5Z" /></>,
    chat: <path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2.24V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v8Z" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  };

  return <svg {...common}>{paths[name]}</svg>;
}

function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg className={`logo-mark ${className}`} viewBox="0 0 48 48" role="img" aria-label="GenuinesAI logo">
      <defs>
        <linearGradient id="genuines-gradient" x1="7" y1="4" x2="42" y2="45" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7183F4" />
          <stop offset="0.5" stopColor="#5368DF" />
          <stop offset="1" stopColor="#3347B8" />
        </linearGradient>
        <linearGradient id="genuines-shine" x1="14" y1="9" x2="32" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="#DDE3FF" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="46" height="46" rx="14" fill="url(#genuines-gradient)" />
      <path d="M35 19.2A13 13 0 1 0 35.4 30V24.2H24.7" stroke="url(#genuines-shine)" strokeWidth="4.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M36.5 8.2v6.6M33.2 11.5h6.6" stroke="white" strokeWidth="1.8" strokeLinecap="round" opacity=".9" />
      <circle cx="36.5" cy="11.5" r="1.35" fill="white" />
      <path d="M8 19C12 8 23 4 33 7" stroke="white" strokeOpacity=".16" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function formatSourceDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Monotonic, collision-free message ids. `Date.now()` repeated within a tick. */
let messageSequence = 0;
function createMessageId(): string {
  messageSequence += 1;
  return `m${Date.now().toString(36)}-${messageSequence}`;
}

function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Storage throws in private-mode Safari and when the quota is full. */
function writeStoredValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A failed write only costs persistence, so the session continues.
  }
}

function removeStoredValue(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore: see writeStoredValue.
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function systemTheme(): "light" | "dark" {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function truncateLabel(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…` : collapsed;
}

function toHistoryItems(messages: Message[]): HistoryItem[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * The API can be unreachable for reasons that have nothing to do with this app
 * — a gateway rejecting the POST, an expired hosting session, an outage. Say
 * what still works instead of showing a bare status code.
 */
function searchUnavailableMessage(status: number): string {
  const reason = status === 401 || status === 403
    ? `Live search is turning me away right now (${status}), which usually means the hosting layer is blocking the request rather than anything you did.`
    : status === 429
      ? "I’m being rate limited at the moment."
      : `Live search isn’t responding right now (${status}).`;
  return `${reason} I can still help directly: ask me to explain something, plan your day, brainstorm, draft text, or work through a coding problem.`;
}

function currentTime(): string {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  /**
   * Whether the pending request will actually reach the network. The indicator
   * used to claim "Searching live sources" unconditionally, including for
   * replies served entirely from the local rule-based layer — a bad claim to
   * make in a product whose pitch is that it shows you its sources.
   */
  const [isSearching, setIsSearching] = useState(false);

  /** Newest assistant reply, announced by the live region below. */
  const latestAssistantText = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index].content;
    }
    return "";
  }, [messages]);
  const [isListening, setIsListening] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL.name);
  const [modelOpen, setModelOpen] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [activeModal, setActiveModal] = useState<"settings" | "help" | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toast, setToast] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  /**
   * Splash lifecycle. It covers real work rather than stalling for effect: the
   * first paint happens before saved messages, model, and theme are read back
   * from localStorage, so without it the welcome state appears and is then
   * replaced by a restored conversation. `holding` keeps it up for a floor of
   * SPLASH_HOLD_MS so a fast restore doesn't produce a single-frame flicker,
   * and `leaving` runs the fade before it unmounts.
   */
  const [splashLeaving, setSplashLeaving] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelControlRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionHandle | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const storageVersion = readStoredValue(STORAGE_KEYS.version);
    const savedMessages = readStoredValue(STORAGE_KEYS.messages);
    const savedModel = readStoredValue(STORAGE_KEYS.model);
    const savedTheme = readStoredValue(STORAGE_KEYS.theme);

    if (storageVersion === STORAGE_VERSION && savedMessages) {
      try {
        const parsed = JSON.parse(savedMessages) as unknown;
        // A hand-edited or half-written entry must not take the whole app down.
        if (Array.isArray(parsed)) setMessages(parsed as Message[]);
        else removeStoredValue(STORAGE_KEYS.messages);
      } catch {
        removeStoredValue(STORAGE_KEYS.messages);
      }
    } else {
      removeStoredValue(STORAGE_KEYS.messages);
      writeStoredValue(STORAGE_KEYS.version, STORAGE_VERSION);
    }

    if (savedModel && isKnownModel(savedModel)) setSelectedModel(savedModel);
    // First visit follows the operating-system preference instead of forcing light.
    setTheme(savedTheme === "dark" || savedTheme === "light" ? savedTheme : systemTheme());
    setHydrated(true);
  }, []);

  // Dismiss the splash once hydration is done, holding a minimum duration so a
  // cached instant load doesn't flash it for one frame.
  useEffect(() => {
    if (!hydrated) return;
    const fade = window.setTimeout(() => setSplashLeaving(true), SPLASH_HOLD_MS);
    return () => window.clearTimeout(fade);
  }, [hydrated]);

  // Unmount only after the fade finishes, so it isn't cut off mid-transition.
  useEffect(() => {
    if (!splashLeaving) return;
    const remove = window.setTimeout(() => setSplashDone(true), SPLASH_FADE_MS);
    return () => window.clearTimeout(remove);
  }, [splashLeaving]);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredValue(STORAGE_KEYS.messages, JSON.stringify(messages.slice(-MAX_PERSISTED_MESSAGES)));
    writeStoredValue(STORAGE_KEYS.version, STORAGE_VERSION);
    writeStoredValue(STORAGE_KEYS.model, selectedModel);
    writeStoredValue(STORAGE_KEYS.theme, theme);
    document.documentElement.dataset.theme = theme;
  }, [messages, selectedModel, theme, hydrated]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [messages, isTyping]);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
    recognitionRef.current?.stop();
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  // Escape closes whatever is on top; the model menu also closes on outside click.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeModal) setActiveModal(null);
      else if (modelOpen) setModelOpen(false);
      else if (sidebarOpen) setSidebarOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!modelOpen) return;
      if (!modelControlRef.current?.contains(event.target as Node)) setModelOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [activeModal, modelOpen, sidebarOpen]);

  // Move focus into the dialog when it opens and hand it back when it closes.
  useEffect(() => {
    if (activeModal) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      dialogRef.current?.focus();
      return;
    }
    returnFocusRef.current?.focus?.();
    returnFocusRef.current = null;
  }, [activeModal]);

  // Grow the composer with its content instead of clipping to a single row.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    // Without clearing the previous timer, an earlier toast dismisses a later one.
    toastTimerRef.current = window.setTimeout(() => {
      setToast("");
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  const stopGenerating = () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setIsTyping(false);
  };

  const startNewChat = () => {
    stopGenerating();
    removeStoredValue(STORAGE_KEYS.messages);
    setMessages([]);
    setInput("");
    setAttachedFile(null);
    setSidebarOpen(false);
  };

  const loadConversation = (name: keyof typeof sampleChats) => {
    stopGenerating();
    setMessages(sampleChats[name]);
    setSidebarOpen(false);
  };

  const requestAssistant = async (prompt: string, history: Message[], attachmentName?: string) => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setIsTyping(true);

    try {
      let data: {
        answer?: string;
        error?: string;
        sources?: SearchSource[];
        mode?: Message["searchMode"];
        searchedAt?: string;
      };

      const offlineAnswer = attachmentName ? null : localResponse(prompt, toHistoryItems(history));
      setIsSearching(!attachmentName && !offlineAnswer);

      if (attachmentName) {
        data = {
          answer: `${attachmentName} is attached to this conversation. File-content analysis is not connected yet, but you can paste the relevant text and I’ll help with it immediately.`,
          sources: [],
          mode: "conversation",
        };
      } else if (offlineAnswer) {
        // The rule-based layer is pure and needs no server, so answer from it
        // here. This is the same module the route runs, so the reply is
        // identical — it just arrives instantly and keeps working when the API
        // is unreachable.
        data = { answer: offlineAnswer, sources: [], mode: "conversation" };
      } else {
        const response = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: prompt,
            model: selectedModel,
            history: history.slice(-HISTORY_TURNS_SENT).map((message) => ({
              role: message.role,
              content: message.content,
              sourceTitles: message.sources?.map((source) => source.title).slice(0, 3),
            })),
          }),
          signal: controller.signal,
        });
        // A gateway error can answer with HTML, so a failed parse must not mask the status.
        data = await response.json().catch(() => ({})) as typeof data;
        if (!response.ok) {
          // 400 and 413 are this app rejecting the input and carry a usable
          // message; anything else is the search path being unavailable.
          if (data.error && (response.status === 400 || response.status === 413)) {
            throw new Error(data.error);
          }
          data = { answer: searchUnavailableMessage(response.status), sources: [], mode: "error" };
        }
      }

      if (controller.signal.aborted) return;
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: "assistant",
          content: data.answer || "I couldn’t form a response. Please try that once more.",
          time: currentTime(),
          sources: data.sources,
          searchMode: data.mode,
          searchedAt: data.searchedAt,
        },
      ]);
    } catch (error) {
      // An aborted request is a deliberate stop, not a failure to report.
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: "assistant",
          content: error instanceof Error && error.message
            ? `I hit a connection problem: ${error.message}. Please try again in a moment.`
            : "I hit a connection problem. Please try again in a moment.",
          time: currentTime(),
          searchMode: "error",
        },
      ]);
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        setIsTyping(false);
      }
    }
  };

  const sendMessage = (value = input) => {
    const cleaned = value.trim() || (attachedFile ? "Please help me with this file." : "");
    if (!cleaned || isTyping) return;

    const attachmentName = attachedFile?.name;
    const history = messages;
    setMessages((current) => [
      ...current,
      { id: createMessageId(), role: "user", content: cleaned, time: currentTime(), attachment: attachmentName },
    ]);
    setInput("");
    setAttachedFile(null);
    void requestAssistant(cleaned, history, attachmentName);
  };

  const copyMessage = async (message: Message) => {
    if (!navigator.clipboard?.writeText) {
      showToast("Copy is unavailable in this browser");
      return;
    }
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      showToast("Response copied");
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedId(null);
        copiedTimerRef.current = null;
      }, 1600);
    } catch {
      showToast("Copy is unavailable in this browser");
    }
  };

  /**
   * Replaces the answers that followed the last prompt instead of appending a
   * second answer below the first, which left both versions in the transcript.
   */
  const regenerateResponse = () => {
    if (isTyping) return;
    const lastPromptIndex = messages.map((message) => message.role).lastIndexOf("user");
    if (lastPromptIndex === -1) return;

    const lastPrompt = messages[lastPromptIndex];
    const history = messages.slice(0, lastPromptIndex);
    setMessages(messages.slice(0, lastPromptIndex + 1));
    void requestAssistant(lastPrompt.content, history, lastPrompt.attachment);
  };

  const toggleVoiceInput = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      showToast("Voice input is not supported in this browser");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setInput((current) => `${current} ${transcript}`.trim());
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => {
      setIsListening(false);
      showToast("I couldn’t hear that. Try again.");
    };
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  };

  return (
    <main className="app-shell">
      {!splashDone && (
        <div
          className={`app-splash ${splashLeaving ? "is-leaving" : ""}`}
          role="status"
          aria-label={`${SITE_NAME} is starting`}
          // Once fading it is decorative and must not trap assistive tech on
          // content that is about to disappear.
          aria-hidden={splashLeaving ? "true" : undefined}
        >
          <div className="app-splash-inner">
            <LogoMark className="splash-mark" />
            <p className="splash-name">{SITE_NAME}</p>
            <p className="splash-tagline">{SITE_TAGLINE}</p>
            <div className="splash-bar"><span /></div>
          </div>
        </div>
      )}

      <div
        className={`sidebar-scrim ${sidebarOpen ? "is-open" : ""}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Conversation navigation">
        <div className="sidebar-brand">
          <LogoMark className="brand-mark-small" />
          <span>GenuinesAI</span>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        <button className="new-chat-button" onClick={startNewChat}>
          <Icon name="plus" size={19} />
          <span>New conversation</span>
        </button>

        <nav className="conversation-nav">
          <p className="nav-label">Recent</p>
          <button className="conversation-link is-active" onClick={() => setSidebarOpen(false)}>
            <Icon name="chat" size={17} />
            <span>{messages[0] ? truncateLabel(messages[0].content, 26) : `Getting started with ${SITE_NAME}`}</span>
          </button>
          <button className="conversation-link" onClick={() => loadConversation("Learning plan ideas")}><Icon name="chat" size={17} /><span>Learning plan ideas</span></button>
          <button className="conversation-link" onClick={() => loadConversation("Weekly goals")}><Icon name="chat" size={17} /><span>Weekly goals</span></button>
        </nav>

        <div className="sidebar-footer">
          <button className="sidebar-action" onClick={() => { setActiveModal("help"); setSidebarOpen(false); }}><Icon name="help" size={18} /><span>Help & shortcuts</span></button>
          <button className="sidebar-action" onClick={() => { setActiveModal("settings"); setSidebarOpen(false); }}><Icon name="settings" size={18} /><span>Settings</span></button>
          <div className="profile-row">
            <span className="profile-avatar">J</span>
            <span className="profile-copy"><strong>{OWNER_NAME}</strong><small>Personal workspace</small></span>
            <Icon name="chevron" size={17} />
          </div>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open conversations">
            <Icon name="menu" size={22} />
          </button>
          <div className="mobile-brand">
            <LogoMark className="brand-mark-tiny" />
            <strong>GenuinesAI</strong>
          </div>
          <div className="model-control" ref={modelControlRef}>
            <button
              className="model-selector"
              onClick={() => setModelOpen((open) => !open)}
              aria-label={`Selected model: ${selectedModel}`}
              aria-haspopup="menu"
              aria-expanded={modelOpen}
            >
              <span className="status-dot" /><span className="model-name-full">{selectedModel}</span><span className="model-name-short">{selectedModel.replace(`${SITE_NAME} `, "")}</span>
              <svg className={modelOpen ? "is-open" : ""} width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {modelOpen && (
              <div className="model-menu" role="menu">
                <p>Choose a model</p>
                {MODELS.map((model) => (
                  <button
                    key={model.name}
                    className={selectedModel === model.name ? "is-selected" : ""}
                    onClick={() => {
                      setSelectedModel(model.name);
                      setModelOpen(false);
                      showToast(`${model.name} selected`);
                    }}
                    role="menuitem"
                  >
                    <span><strong>{model.name}</strong><small>{model.detail}</small></span>
                    {selectedModel === model.name && <Icon name="check" size={17} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-button new-mobile-chat" onClick={startNewChat} aria-label="Start a new conversation">
            <Icon name="plus" size={22} />
          </button>
        </header>

        {/*
          aria-live previously sat on this container, so every change anywhere
          in the conversation subtree re-announced the whole thread. The live
          region is now a dedicated status node below that holds only the newest
          assistant reply.
        */}
        <div className={`conversation ${messages.length ? "has-messages" : ""}`}>
          {messages.length === 0 ? (
            <section className="welcome-state">
              <LogoMark className="hero-mark" />
              <p className="eyebrow">Your thinking partner</p>
              <h1>Ready when you are, {OWNER_NAME}.</h1>
              <p className="welcome-copy">Ask a question, search current news, or turn an idea into a clear plan.</p>

              <div className="suggestion-grid">
                {suggestions.map((suggestion) => (
                  <button key={suggestion.title} className="suggestion-card" onClick={() => sendMessage(suggestion.prompt)}>
                    <span className={`suggestion-icon ${suggestion.icon}`}><Icon name={suggestion.icon} size={20} /></span>
                    <span className="suggestion-text"><strong>{suggestion.title}</strong><small>{suggestion.detail}</small></span>
                    <Icon name="chevron" size={17} />
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className="message-list">
              <div className="date-divider"><span>Today</span></div>
              {messages.map((message) => (
                <article key={message.id} className={`message-row ${message.role}`}>
                  {message.role === "assistant" && <div className="assistant-avatar"><LogoMark className="brand-mark-tiny" /></div>}
                  <div className="message-wrap">
                    <div className="message-bubble">
                      {message.attachment && <span className="attachment-chip"><Icon name="document" size={15} />{message.attachment}</span>}
                      <span>{message.content}</span>
                    </div>
                    {message.role === "assistant" && message.searchMode && message.searchMode !== "conversation" && (
                      <div className={`search-activity ${message.searchMode === "error" ? "has-error" : ""}`}>
                        <Icon name="globe" size={14} />
                        <span>{message.searchMode === "news" ? "Searched live news" : message.searchMode === "knowledge" ? "Searched live references" : "Search unavailable"}</span>
                        {message.searchedAt && <time>{formatSourceDate(message.searchedAt)}</time>}
                      </div>
                    )}
                    {message.role === "assistant" && message.sources && message.sources.length > 0 && (
                      <div className="source-list" aria-label="Sources">
                        {message.sources.map((source, index) => (
                          <a key={`${source.url}-${index}`} className="source-card" href={source.url} target="_blank" rel="noreferrer">
                            <span className="source-number">{index + 1}</span>
                            <span className="source-copy">
                              <strong>{source.title}</strong>
                              <small><span>{source.source}</span>{source.publishedAt && <span>{formatSourceDate(source.publishedAt)}</span>}</small>
                              {source.snippet && <em>{source.snippet}</em>}
                            </span>
                            <Icon name="external" size={15} />
                          </a>
                        ))}
                      </div>
                    )}
                    {message.role === "assistant" && (
                      <div className="message-actions">
                        <button onClick={() => copyMessage(message)} aria-label="Copy response">
                          <Icon name={copiedId === message.id ? "check" : "copy"} size={15} />
                          <span>{copiedId === message.id ? "Copied" : "Copy"}</span>
                        </button>
                        <button onClick={regenerateResponse} disabled={isTyping} aria-label="Generate another response">
                          <Icon name="refresh" size={15} /><span>Try again</span>
                        </button>
                      </div>
                    )}
                    <time>{message.time}</time>
                  </div>
                </article>
              ))}
              {isTyping && (
                <article className="message-row assistant">
                  <div className="assistant-avatar"><LogoMark className="brand-mark-tiny" /></div>
                  <div
                    className="typing-state"
                    aria-label={isSearching ? "GenuinesAI is searching live sources" : "GenuinesAI is responding"}
                  >
                    <div className="typing-bubble"><span /><span /><span /></div>
                    <small>
                      <Icon name={isSearching ? "globe" : "spark"} size={12} />
                      {isSearching ? "Searching live sources" : "Thinking"}
                    </small>
                  </div>
                </article>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/*
          The single live region for the thread. It holds only the latest
          assistant message, so a screen reader announces each new reply once
          instead of re-reading the conversation on every render.
        */}
        <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {isTyping
            ? (isSearching ? "Searching live sources" : "Thinking")
            : latestAssistantText}
        </div>

        <footer className="composer-area">
          {attachedFile && (
            <div className="pending-attachment">
              <Icon name="document" size={15} />
              <span>{attachedFile.name}</span>
              <button onClick={() => setAttachedFile(null)} aria-label="Remove attachment"><Icon name="close" size={14} /></button>
            </div>
          )}
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > MAX_ATTACHMENT_BYTES) {
                showToast(`Choose a file smaller than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
                event.target.value = "";
                return;
              }
              setAttachedFile(file);
              showToast(`${file.name} attached`);
              event.target.value = "";
            }}
          />
          <div className={`composer ${input.trim() || attachedFile ? "has-value" : ""}`}>
            <button className="composer-button attach-button" onClick={() => fileInputRef.current?.click()} aria-label="Attach a file">
              <Icon name="paperclip" size={20} />
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              rows={1}
              placeholder={isListening ? "Listening…" : "Message GenuinesAI"}
              aria-label="Message GenuinesAI"
            />
            <button
              className={`composer-button mic-button ${isListening ? "is-listening" : ""}`}
              onClick={toggleVoiceInput}
              aria-label={isListening ? "Stop listening" : "Use voice input"}
            >
              <Icon name="mic" size={20} />
            </button>
            {isTyping ? (
              <button className="send-button is-stopping" onClick={stopGenerating} aria-label="Stop generating">
                <Icon name="stop" size={19} />
              </button>
            ) : (
              <button className="send-button" onClick={() => sendMessage()} disabled={!input.trim() && !attachedFile} aria-label="Send message">
                <Icon name="send" size={19} />
              </button>
            )}
          </div>
          <p className="disclaimer">GenuinesAI can make mistakes. Check important information.</p>
        </footer>
      </section>

      {activeModal && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setActiveModal(null)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            ref={dialogRef}
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p>{activeModal === "settings" ? "Preferences" : "Quick guide"}</p>
                <h2 id="modal-title">{activeModal === "settings" ? "Settings" : "Help & shortcuts"}</h2>
              </div>
              <button className="icon-button" onClick={() => setActiveModal(null)} aria-label="Close dialog"><Icon name="close" size={20} /></button>
            </div>

            {activeModal === "settings" ? (
              <div className="modal-content">
                <div className="setting-block">
                  <span><strong>Appearance</strong><small>Choose how GenuinesAI looks on this device.</small></span>
                  <div className="theme-options">
                    <button className={theme === "light" ? "is-selected" : ""} onClick={() => setTheme("light")}><Icon name="sun" size={18} />Light{theme === "light" && <Icon name="check" size={16} />}</button>
                    <button className={theme === "dark" ? "is-selected" : ""} onClick={() => setTheme("dark")}><Icon name="moon" size={18} />Dark{theme === "dark" && <Icon name="check" size={16} />}</button>
                  </div>
                </div>
                <div className="setting-row">
                  <span><strong>Current model</strong><small>Your selection is saved automatically.</small></span>
                  <span className="setting-value">{selectedModel.replace(`${SITE_NAME} `, "")}</span>
                </div>
                <div className="setting-row live-search-setting">
                  <span><strong>Live search</strong><small>Current news and reference sources.</small></span>
                  <span className="setting-value"><i />Connected</span>
                </div>
                <button className="clear-chat-button" onClick={() => { startNewChat(); setActiveModal(null); showToast("Conversation cleared"); }}>Clear current conversation</button>
              </div>
            ) : (
              <div className="modal-content help-content">
                <p>GenuinesAI is designed to turn rough thoughts into useful next steps. Start with a quick prompt or write your own message.</p>
                <div className="shortcut-row"><span>Send a message</span><kbd>Enter</kbd></div>
                <div className="shortcut-row"><span>Add a new line</span><kbd>Shift</kbd><span className="key-plus">+</span><kbd>Enter</kbd></div>
                <div className="shortcut-row"><span>Start over</span><button onClick={() => { startNewChat(); setActiveModal(null); }}>New conversation</button></div>
                <p className="help-note">For current information, say “search,” “latest,” “today,” or “news.” GenuinesAI will show the sources it consulted. Voice input depends on browser support.</p>
              </div>
            )}
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status"><Icon name="check" size={16} />{toast}</div>}
    </main>
  );
}
