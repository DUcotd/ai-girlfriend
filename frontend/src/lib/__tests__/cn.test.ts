import { describe, expect, it } from "vitest";
import { cn } from "../cn";

describe("cn", () => {
    it("joins plain class names", () => {
        expect(cn("a", "b", "c")).toBe("a b c");
    });

    it("drops falsy conditional values", () => {
        expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
    });

    it("supports object and array inputs (clsx semantics)", () => {
        expect(cn({ a: true, b: false }, ["c", { d: true }])).toBe("a c d");
    });

    it("resolves conflicting tailwind utilities to the last one", () => {
        expect(cn("p-2", "p-4")).toBe("p-4");
        expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
    });

    it("keeps non-conflicting utilities intact", () => {
        expect(cn("px-2", "py-4")).toBe("px-2 py-4");
    });

    it("returns an empty string when given no truthy input", () => {
        expect(cn()).toBe("");
        expect(cn(false, null, undefined)).toBe("");
    });
});
