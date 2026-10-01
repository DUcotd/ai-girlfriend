import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    applyTheme,
    applyThemeMode,
    cleanupLegacyEmbeddingDefaults,
    get,
    getAdvancedChatConfig,
    getChatConfig,
    getMemoryConfig,
    getStoredAffinity,
    getStoredTheme,
    getStoredThemeMode,
    isSetupComplete,
    isTtsConfigured,
    remove,
    set,
    setAdvancedChatConfig,
    setStoredAffinity,
    StorageKeys,
} from "../storage";
import { DEFAULT_PROVIDER } from "../providers";
import { CHAT_NUMBER_LIMITS, DEFAULT_ADVANCED_CONFIG, type AdvancedChatConfig } from "../chatParams";

// jsdom environment provides localStorage + document (see vitest.config.ts).
beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    localStorage.clear();
});

describe("isSetupComplete", () => {
    it("is false when nothing is stored", () => {
        expect(isSetupComplete()).toBe(false);
    });

    it("is false when only the API key is present", () => {
        localStorage.setItem(StorageKeys.apiKey, "sk-123");
        expect(isSetupComplete()).toBe(false);
    });

    it("is false when only the completion flag is present", () => {
        localStorage.setItem(StorageKeys.hasCompletedSetup, "true");
        expect(isSetupComplete()).toBe(false);
    });

    it("is true when both API key and completion flag are present", () => {
        localStorage.setItem(StorageKeys.apiKey, "sk-123");
        localStorage.setItem(StorageKeys.hasCompletedSetup, "true");
        expect(isSetupComplete()).toBe(true);
    });
});

describe("getMemoryConfig", () => {
    it("defaults to facts enabled and auto retrieval when nothing is stored", () => {
        expect(getMemoryConfig()).toEqual({ memoryFactsEnabled: true, memoryRetrievalMode: "auto" });
    });

    it("treats only the literal string 'false' as disabled", () => {
        localStorage.setItem(StorageKeys.memoryFactsEnabled, "false");
        expect(getMemoryConfig().memoryFactsEnabled).toBe(false);

        localStorage.setItem(StorageKeys.memoryFactsEnabled, "0");
        expect(getMemoryConfig().memoryFactsEnabled).toBe(true);
    });

    it("accepts valid retrieval modes", () => {
        localStorage.setItem(StorageKeys.memoryRetrievalMode, "embedding");
        expect(getMemoryConfig().memoryRetrievalMode).toBe("embedding");
        localStorage.setItem(StorageKeys.memoryRetrievalMode, "keyword");
        expect(getMemoryConfig().memoryRetrievalMode).toBe("keyword");
    });

    it("falls back to auto for an invalid retrieval mode", () => {
        localStorage.setItem(StorageKeys.memoryRetrievalMode, "garbage");
        expect(getMemoryConfig().memoryRetrievalMode).toBe("auto");
    });
});

describe("isTtsConfigured", () => {
    it("is false when no TTS key is stored", () => {
        expect(isTtsConfigured()).toBe(false);
    });

    it("is false for a whitespace-only key", () => {
        localStorage.setItem(StorageKeys.ttsApiKey, "   ");
        expect(isTtsConfigured()).toBe(false);
    });

    it("is true for a non-empty trimmed key", () => {
        localStorage.setItem(StorageKeys.ttsApiKey, " tts-key ");
        expect(isTtsConfigured()).toBe(true);
    });
});

describe("cleanupLegacyEmbeddingDefaults", () => {
    it("removes the legacy base URL default", () => {
        localStorage.setItem(StorageKeys.embBaseUrl, "https://api.siliconflow.cn/v1");
        cleanupLegacyEmbeddingDefaults();
        expect(localStorage.getItem(StorageKeys.embBaseUrl)).toBeNull();
    });

    it("removes the legacy model name default", () => {
        localStorage.setItem(StorageKeys.embModelName, "BAAI/bge-large-zh-v1.5");
        cleanupLegacyEmbeddingDefaults();
        expect(localStorage.getItem(StorageKeys.embModelName)).toBeNull();
    });

    it("keeps user-provided values that differ from the legacy defaults", () => {
        localStorage.setItem(StorageKeys.embBaseUrl, "https://custom.example/v1");
        localStorage.setItem(StorageKeys.embModelName, "custom-model");
        cleanupLegacyEmbeddingDefaults();
        expect(localStorage.getItem(StorageKeys.embBaseUrl)).toBe("https://custom.example/v1");
        expect(localStorage.getItem(StorageKeys.embModelName)).toBe("custom-model");
    });
});

describe("advanced chat config round-trip", () => {
    it("reads defaults when nothing is stored", () => {
        expect(getAdvancedChatConfig()).toEqual(DEFAULT_ADVANCED_CONFIG);
    });

    it("persists and re-reads a full config", () => {
        const cfg: AdvancedChatConfig = {
            maxPromptHistory: 42,
            unlimitedContext: true,
            temperature: 1.25,
            maxTokens: 2048,
            reasoningEffort: "high",
        };
        setAdvancedChatConfig(cfg);
        expect(getAdvancedChatConfig()).toEqual(cfg);
    });

    it("writes empty strings for undefined maxTokens and empty reasoningEffort", () => {
        setAdvancedChatConfig({ ...DEFAULT_ADVANCED_CONFIG, maxTokens: undefined, reasoningEffort: "" });
        expect(localStorage.getItem(StorageKeys.maxTokens)).toBe("");
        expect(localStorage.getItem(StorageKeys.reasoningEffort)).toBe("");
        // 读回时仍是 undefined / ""（不会凭空变成 0）
        const readBack = getAdvancedChatConfig();
        expect(readBack.maxTokens).toBeUndefined();
        expect(readBack.reasoningEffort).toBe("");
    });

    it("clamps dirty stored values on read", () => {
        localStorage.setItem(StorageKeys.maxPromptHistory, "9999");
        localStorage.setItem(StorageKeys.temperature, "-5");
        localStorage.setItem(StorageKeys.unlimitedContext, "true");
        const cfg = getAdvancedChatConfig();
        expect(cfg.maxPromptHistory).toBe(CHAT_NUMBER_LIMITS.maxPromptHistory.max);
        expect(cfg.temperature).toBe(CHAT_NUMBER_LIMITS.temperature.min);
        expect(cfg.unlimitedContext).toBe(true);
    });
});

describe("getChatConfig", () => {
    it("falls back to the default provider for baseUrl and modelName", () => {
        const cfg = getChatConfig();
        expect(cfg.apiKey).toBe("");
        expect(cfg.baseUrl).toBe(DEFAULT_PROVIDER.baseUrl);
        expect(cfg.modelName).toBe(DEFAULT_PROVIDER.modelName);
    });

    it("returns stored values when present", () => {
        localStorage.setItem(StorageKeys.baseUrl, "https://custom.example/v1");
        localStorage.setItem(StorageKeys.modelName, "my-model");
        const cfg = getChatConfig();
        expect(cfg.baseUrl).toBe("https://custom.example/v1");
        expect(cfg.modelName).toBe("my-model");
    });

    it("merges advanced + memory config into the payload", () => {
        localStorage.setItem(StorageKeys.temperature, "0.5");
        localStorage.setItem(StorageKeys.memoryRetrievalMode, "keyword");
        const cfg = getChatConfig();
        expect(cfg.temperature).toBe(0.5);
        expect(cfg.memoryRetrievalMode).toBe("keyword");
    });
});

describe("theme helpers", () => {
    it("applies and reads back the theme via data-theme", () => {
        applyTheme("starry");
        expect(document.documentElement.getAttribute("data-theme")).toBe("starry");
        expect(getStoredTheme()).toBe("starry");
    });

    it("applies and reads back the theme mode via data-mode", () => {
        applyThemeMode("dark");
        expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
        expect(getStoredThemeMode()).toBe("dark");
    });

    it("returns null for an unset theme", () => {
        expect(getStoredTheme()).toBeNull();
        expect(getStoredThemeMode()).toBeNull();
    });
});

describe("affinity helpers", () => {
    it("returns null when nothing is stored", () => {
        expect(getStoredAffinity()).toBeNull();
    });

    it("returns null for a non-numeric stored value", () => {
        localStorage.setItem(StorageKeys.affinity, "abc");
        expect(getStoredAffinity()).toBeNull();
    });

    it("round-trips a valid integer", () => {
        setStoredAffinity(37);
        expect(getStoredAffinity()).toBe(37);
    });

    it("parses a leading integer out of a mixed string", () => {
        localStorage.setItem(StorageKeys.affinity, "42abc");
        expect(getStoredAffinity()).toBe(42);
    });
});

describe("generic get/set/remove", () => {
    it("sets and gets a value by key name", () => {
        set("apiKey", "sk-xyz");
        expect(get("apiKey")).toBe("sk-xyz");
    });

    it("removes a value by key name", () => {
        set("apiKey", "sk-xyz");
        remove("apiKey");
        expect(get("apiKey")).toBeNull();
    });

    it("returns null for a key that was never set", () => {
        expect(get("theme")).toBeNull();
    });
});
