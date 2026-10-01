import { describe, expect, it } from "vitest";
import {
    CHAT_NUMBER_LIMITS,
    DEFAULT_ADVANCED_CONFIG,
    clampChatNumber,
    normalizeAdvancedConfig,
    normalizeReasoningEffort,
    parseOptionalChatNumber,
    REASONING_EFFORT_OPTIONS,
    type AdvancedChatConfig,
} from "../chatParams";

describe("clampChatNumber", () => {
    it("returns the numeric value unchanged when already in range", () => {
        expect(clampChatNumber(50, "maxPromptHistory")).toBe(50);
        expect(clampChatNumber("1.5", "temperature")).toBe(1.5);
    });

    it("clamps values below min up to min", () => {
        expect(clampChatNumber(-100, "temperature")).toBe(CHAT_NUMBER_LIMITS.temperature.min);
        expect(clampChatNumber(1, "maxPromptHistory")).toBe(CHAT_NUMBER_LIMITS.maxPromptHistory.min);
    });

    it("clamps values above max down to max", () => {
        expect(clampChatNumber(999, "temperature")).toBe(CHAT_NUMBER_LIMITS.temperature.max);
        expect(clampChatNumber("999999", "maxTokens")).toBe(CHAT_NUMBER_LIMITS.maxTokens.max);
    });

    it("falls back for null, undefined, and empty string", () => {
        expect(clampChatNumber(null, "temperature")).toBe(CHAT_NUMBER_LIMITS.temperature.fallback);
        expect(clampChatNumber(undefined, "temperature")).toBe(CHAT_NUMBER_LIMITS.temperature.fallback);
        expect(clampChatNumber("", "temperature")).toBe(CHAT_NUMBER_LIMITS.temperature.fallback);
    });

    it("falls back for non-numeric / non-finite input", () => {
        expect(clampChatNumber("abc", "maxPromptHistory")).toBe(CHAT_NUMBER_LIMITS.maxPromptHistory.fallback);
        expect(clampChatNumber(NaN, "temperature")).toBe(CHAT_NUMBER_LIMITS.temperature.fallback);
        expect(clampChatNumber(Infinity, "maxTokens")).toBe(CHAT_NUMBER_LIMITS.maxTokens.fallback);
        expect(clampChatNumber(-Infinity, "temperature")).toBe(CHAT_NUMBER_LIMITS.temperature.fallback);
    });

    it("treats a whitespace-only string as 0 (Number('  ') === 0), clamped to min", () => {
        // 只有「空串」走 fallback；纯空白串会被 Number() 转成 0，
        // 再按 min 钳制 —— 记录该边界，避免误以为它等同空串。
        expect(clampChatNumber("  ", "temperature")).toBe(CHAT_NUMBER_LIMITS.temperature.min);
    });

    it("preserves the boundary values exactly (min and max are inclusive)", () => {
        const { min, max } = CHAT_NUMBER_LIMITS.maxPromptHistory;
        expect(clampChatNumber(min, "maxPromptHistory")).toBe(min);
        expect(clampChatNumber(max, "maxPromptHistory")).toBe(max);
    });
});

describe("parseOptionalChatNumber", () => {
    it("returns undefined for empty / null / undefined (means 'do not send the param')", () => {
        expect(parseOptionalChatNumber(null, "maxTokens")).toBeUndefined();
        expect(parseOptionalChatNumber(undefined, "maxTokens")).toBeUndefined();
        expect(parseOptionalChatNumber("", "maxTokens")).toBeUndefined();
    });

    it("delegates to clamping when a value is present", () => {
        expect(parseOptionalChatNumber(0, "maxTokens")).toBe(CHAT_NUMBER_LIMITS.maxTokens.min);
        expect(parseOptionalChatNumber("4096", "maxTokens")).toBe(4096);
    });
});

describe("normalizeReasoningEffort", () => {
    it("keeps each supported effort level", () => {
        for (const level of ["none", "minimal", "low", "medium", "high"] as const) {
            expect(normalizeReasoningEffort(level)).toBe(level);
        }
    });

    it("falls back to empty string for unsupported / empty / nullish values", () => {
        expect(normalizeReasoningEffort("ultra")).toBe("");
        expect(normalizeReasoningEffort("")).toBe("");
        expect(normalizeReasoningEffort(null)).toBe("");
        expect(normalizeReasoningEffort(undefined)).toBe("");
        expect(normalizeReasoningEffort("HIGH")).toBe("");
    });

    it("every declared option value round-trips through the normalizer", () => {
        for (const option of REASONING_EFFORT_OPTIONS) {
            expect(normalizeReasoningEffort(option.value)).toBe(option.value);
        }
    });
});

describe("normalizeAdvancedConfig", () => {
    it("returns a defensive copy of the defaults when config is nullish", () => {
        const fromNull = normalizeAdvancedConfig(null);
        const fromUndefined = normalizeAdvancedConfig(undefined);
        expect(fromNull).toEqual(DEFAULT_ADVANCED_CONFIG);
        expect(fromUndefined).toEqual(DEFAULT_ADVANCED_CONFIG);
        // 必须是新对象，避免调用方污染默认常量
        expect(fromNull).not.toBe(DEFAULT_ADVANCED_CONFIG);
    });

    it("clamps out-of-range numbers and normalizes reasoning effort", () => {
        const result = normalizeAdvancedConfig({
            maxPromptHistory: 1,
            temperature: 9,
            reasoningEffort: "bogus" as AdvancedChatConfig["reasoningEffort"],
        });
        expect(result.maxPromptHistory).toBe(CHAT_NUMBER_LIMITS.maxPromptHistory.min);
        expect(result.temperature).toBe(CHAT_NUMBER_LIMITS.temperature.max);
        expect(result.reasoningEffort).toBe("");
    });

    it("keeps maxTokens undefined when empty (not coerced to 0)", () => {
        const result = normalizeAdvancedConfig({ maxTokens: undefined });
        expect(result.maxTokens).toBeUndefined();
    });

    it("coerces unlimitedContext to a real boolean", () => {
        expect(normalizeAdvancedConfig({ unlimitedContext: true }).unlimitedContext).toBe(true);
        expect(normalizeAdvancedConfig({ unlimitedContext: false }).unlimitedContext).toBe(false);
        // 脏值（如从字符串来）应被转成布尔
        expect(
            normalizeAdvancedConfig({ unlimitedContext: "yes" as unknown as boolean }).unlimitedContext
        ).toBe(true);
    });

    it("fills missing fields from defaults while preserving provided ones", () => {
        const result = normalizeAdvancedConfig({ temperature: 1.2 });
        expect(result.temperature).toBe(1.2);
        expect(result.maxPromptHistory).toBe(DEFAULT_ADVANCED_CONFIG.maxPromptHistory);
        expect(result.reasoningEffort).toBe(DEFAULT_ADVANCED_CONFIG.reasoningEffort);
    });
});
