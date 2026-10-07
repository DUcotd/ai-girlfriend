import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import type { AtRule, ChildNode, Container } from "postcss";
import { describe, expect, it } from "vitest";

/**
 * 主题 / 装饰 CSS 的层叠契约（FE-14 顺序依赖 + FE-10 对比度）。
 *
 * 这里刻意不断言「文件里有没有出现某串字符」，而是把两个 CSS 真的解析成规则表，
 * 用 jsdom 做选择器匹配 + 一套最小层叠算法算出「浏览器最终采用哪条声明」，
 * 然后把文件顺序、文件内规则顺序都调乱，要求结果一字不变——
 * 「换个 import 顺序就变色」这种缺陷，只有把顺序当变量跑一遍才测得出来。
 * 同一张解析出来的 token 表顺带算 WCAG 对比度，配色回退时这里先红。
 */

const CSS_DIR = resolve(process.cwd(), "src/styles");
const readCss = (name: string) => readFileSync(resolve(CSS_DIR, name), "utf8");

interface Declaration {
    prop: string;
    value: string;
    /** 在同一条规则内的位置（同规则内后写的赢，`height:100vh; height:100dvh` 就靠这个） */
    index: number;
}

interface ParsedRule {
    selectors: string[];
    declarations: Declaration[];
    /** 所属 cascade layer；null = 裸规则（不属于任何层） */
    layer: string | null;
    /** 包裹本规则的 at-rule 链（media / layer …），用于区分「装饰类」与「reduced-motion 补丁」 */
    atChain: string[];
    /** 规则在文件内的序号 */
    index: number;
}

interface ParsedCss {
    name: string;
    rules: ParsedRule[];
    /** `@layer a, b;` 这种没有规则体的层序声明 */
    declaredLayerOrder: string[];
}

function atChainOf(node: ChildNode): string[] {
    const chain: string[] = [];
    let parent = node.parent as Container | undefined;
    while (parent && parent.type !== "root") {
        if (parent.type === "atrule") {
            const at = parent as AtRule;
            chain.unshift(`${at.name} ${at.params}`.trim());
        }
        parent = parent.parent as Container | undefined;
    }
    return chain;
}

function layerOf(node: ChildNode): string | null {
    let parent = node.parent as Container | undefined;
    while (parent && parent.type !== "root") {
        if (parent.type === "atrule" && (parent as AtRule).name === "layer") {
            return (parent as AtRule).params.trim();
        }
        parent = parent.parent as Container | undefined;
    }
    return null;
}

function parseCss(name: string, css: string): ParsedCss {
    const root = postcss.parse(css);
    const rules: ParsedRule[] = [];
    const declaredLayerOrder: string[] = [];

    root.walkAtRules("layer", (atRule) => {
        if (atRule.nodes) return; // 带规则体的是「层本身」，不是层序声明
        atRule.params
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .forEach((layer) => declaredLayerOrder.push(layer));
    });

    root.walkRules((rule) => {
        const declarations: Declaration[] = [];
        rule.walkDecls((decl) => {
            declarations.push({ prop: decl.prop, value: decl.value, index: declarations.length });
        });
        if (declarations.length === 0) return;
        rules.push({
            selectors: rule.selectors,
            declarations,
            layer: layerOf(rule),
            atChain: atChainOf(rule),
            index: rules.length,
        });
    });

    return { name, rules, declaredLayerOrder };
}

/**
 * (a, b, c) 特异性：id / 类·属性·伪类 / 类型·伪元素。
 * 只覆盖本项目 CSS 里出现的写法（:root、:root[data-x]、.a.a、*、::-webkit-*）。
 */
function specificity(selector: string): [number, number, number] {
    let a = 0;
    let b = 0;
    let c = 0;
    // 伪元素记 c 级，并先从串里摘掉，免得 `::-webkit-scrollbar` 的词干被当成元素名
    const noPseudoElements = selector.replace(/::[\w-]+/g, () => {
        c += 1;
        return "";
    });
    const noAttrs = noPseudoElements.replace(/\[[^\]]*\]/g, () => {
        b += 1;
        return "";
    });
    a += (noAttrs.match(/#[\w-]+/g) ?? []).length;
    b += (noAttrs.match(/\.[\w-]+/g) ?? []).length;
    b += (noAttrs.match(/:(?!:)[\w-]+(\([^)]*\))?/g) ?? []).length;
    const onlyTypes = noAttrs.replace(/#[\w-]+|\.[\w-]+|:(?!:)[\w-]+(\([^)]*\))?/g, "");
    c += (onlyTypes.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
    return [a, b, c];
}

/** 层序：按「文档里第一次出现」定序，两个文件都写了同样的声明时结果与文件顺序无关 */
function layerOrderOf(files: ParsedCss[]): string[] {
    const layers: string[] = [];
    for (const file of files) {
        for (const layer of file.declaredLayerOrder) if (!layers.includes(layer)) layers.push(layer);
        for (const rule of file.rules) {
            if (rule.layer && !layers.includes(rule.layer)) layers.push(rule.layer);
        }
    }
    return layers;
}

/**
 * 最小层叠：裸规则 > 分层规则；层越靠后越优先；同层比特异性；
 * 再同则比文档顺序（文件序号 → 规则序号 → 声明序号）。
 */
function resolveCascade(files: ParsedCss[], element: Element): Map<string, string> {
    const layers = layerOrderOf(files);
    const winners = new Map<string, { value: string; rank: number[] }>();

    files.forEach((file, fileIndex) => {
        file.rules.forEach((rule, ruleIndex) => {
            const matched = rule.selectors.filter((selector) => {
                try {
                    return element.matches(selector);
                } catch {
                    // jsdom 认不了的浏览器私有选择器（::-webkit-*）不参与元素匹配
                    return false;
                }
            });
            if (matched.length === 0) return;
            const layerIndex = rule.layer === null ? Number.POSITIVE_INFINITY : layers.indexOf(rule.layer);
            const spec = matched.reduce(
                (best, selector) => {
                    const candidate = specificity(selector);
                    return compareRank(candidate, best) > 0 ? candidate : best;
                },
                [0, 0, 0] as [number, number, number]
            );
            rule.declarations.forEach((decl) => {
                const rank = [layerIndex, ...spec, fileIndex, ruleIndex, decl.index];
                const current = winners.get(decl.prop);
                if (!current || compareRank(rank, current.rank) > 0) {
                    winners.set(decl.prop, { value: decl.value, rank });
                }
            });
        });
    });

    const result = new Map<string, string>();
    winners.forEach((entry, prop) => result.set(prop, entry.value));
    return result;
}

function compareRank(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const left = a[i] ?? 0;
        const right = b[i] ?? 0;
        if (left !== right) return left - right;
    }
    return 0;
}

/** 展开 var() 链：主题层给色相饱和度、模式层给明度，最终值就是这条链拼出来的 */
function substituteVars(tokens: Map<string, string>, value: string): string {
    let current = value;
    for (let step = 0; step < 8; step++) {
        let changed = false;
        const next = current.replace(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g, (_all, name: string) => {
            const resolved = tokens.get(name);
            if (resolved === undefined) throw new Error(`${name} 未定义，无法解析 ${value}`);
            changed = true;
            return resolved;
        });
        current = next;
        if (!changed) return current;
    }
    return current;
}

function parseHslTriplet(value: string): [number, number, number] | null {
    const match = value.trim().match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const sat = s / 100;
    const light = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const amplitude = sat * Math.min(light, 1 - light);
    const f = (n: number) => light - amplitude * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
    const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
    const ca = parseHslTriplet(a);
    const cb = parseHslTriplet(b);
    if (!ca || !cb) throw new Error(`不是 HSL 三元组：${a} / ${b}`);
    const la = relativeLuminance(hslToRgb(...ca));
    const lb = relativeLuminance(hslToRgb(...cb));
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

const THEMES = ["sakura", "starry", "ocean", "forest"] as const;
const MODES = ["light", "dark"] as const;
const COMBOS = THEMES.flatMap((theme) => MODES.map((mode) => [theme, mode] as const));

const themesCss = parseCss("themes.css", readCss("themes.css"));
const utilitiesCss = parseCss("utilities.css", readCss("utilities.css"));

/** 模拟 layout.tsx 里调换两个 import 的先后 */
const inOrder = (swap: boolean) => (swap ? [utilitiesCss, themesCss] : [themesCss, utilitiesCss]);

/** 同内容、规则顺序倒过来（检验「层内谁写在后面」是否还左右结果） */
function reversed(parsed: ParsedCss): ParsedCss {
    const flip = parsed.rules.length;
    return {
        ...parsed,
        rules: parsed.rules.map((rule, index) => ({ ...rule, index: flip - index })),
    };
}

function htmlTokens(theme: string, mode: string, files: ParsedCss[]): Map<string, string> {
    const html = document.documentElement;
    html.setAttribute("data-theme", theme);
    html.setAttribute("data-mode", mode);
    const raw = resolveCascade(files, html);
    const resolved = new Map<string, string>();
    raw.forEach((value, prop) => resolved.set(prop, substituteVars(raw, value)));
    html.removeAttribute("data-theme");
    html.removeAttribute("data-mode");
    return resolved;
}

describe("主题变量不再依赖 import 顺序（FE-14）", () => {
    it("主题变量整份收进 cascade layer，且两个文件声明同一套层序", () => {
        expect(themesCss.rules.length).toBeGreaterThan(0);
        // 层内规则才是我们要的：全部主题变量都该属于 theme 层
        themesCss.rules.forEach((rule) => expect(rule.layer).toBe("theme"));
        expect(layerOrderOf(inOrder(false))).toEqual(layerOrderOf(inOrder(true)));
        expect(layerOrderOf(inOrder(false))).toEqual(["theme", "decor"]);
    });

    it.each(COMBOS)("%s + %s：调换 import 顺序后每个变量仍解析成同一个值", (theme, mode) => {
        const asIs = htmlTokens(theme, mode, inOrder(false));
        const swapped = htmlTokens(theme, mode, inOrder(true));
        const entries = [...asIs.entries()].filter(([prop]) => prop.startsWith("--"));
        expect(entries.length).toBeGreaterThan(12);
        entries.forEach(([prop, value]) => {
            expect(swapped.get(prop), `${theme}/${mode} 的 ${prop}`).toBe(value);
        });
    });

    it.each(COMBOS)("%s + %s：层内规则重排也不改结果（胜负交给特异性，不交给顺序）", (theme, mode) => {
        const shuffled = inOrder(true).map((file) =>
            file.name === "themes.css" ? reversed(file) : file
        );
        const normal = htmlTokens(theme, mode, inOrder(false));
        const reordered = htmlTokens(theme, mode, shuffled);
        ["--text-muted", "--surface-1", "--bg-start", "--gradient-text-1", "--accent-1"].forEach(
            (prop) => {
                expect(reordered.get(prop), `${theme}/${mode} 的 ${prop}`).toBe(normal.get(prop));
            }
        );
    });

    it("暗色模式用的是暗色表面：:root 的浅色回退没有反过来压住 data-mode=dark", () => {
        const light = htmlTokens("sakura", "light", inOrder(true));
        const dark = htmlTokens("sakura", "dark", inOrder(false));
        expect(parseHslTriplet(dark.get("--surface-1")!)![2]).toBeLessThan(
            parseHslTriplet(light.get("--surface-1")!)![2]
        );
    });

    it("色相由 data-theme 决定，与 utilities.css 谁先谁后无关", () => {
        COMBOS.forEach(([theme, mode]) => {
            const tokens = htmlTokens(theme, mode, inOrder(theme.length % 2 === 0));
            const hue = Number(tokens.get("--hue"));
            expect(Number.isNaN(hue)).toBe(false);
            expect(tokens.get("--hue")).toBe(
                htmlTokens(theme, mode, inOrder(false)).get("--hue")
            );
        });
    });

    it("装饰类不靠「写在 Tailwind 后面」取胜：单类原子规则无论先后都压不过它", () => {
        // 模拟 Tailwind 产物（裸规则、单类特异性）与 utilities.css 的两种先后顺序
        const tailwindLike = parseCss(
            "tailwind-like.css",
            ".gradient-text { background: #fff }.pb-safe { padding-bottom: 1rem }.app-shell-height { height: 0 }"
        );
        const div = document.createElement("div");
        div.className = "gradient-text pb-safe app-shell-height";

        [false, true].forEach((swap) => {
            const files = swap ? [tailwindLike, utilitiesCss] : [utilitiesCss, tailwindLike];
            const style = resolveCascade(files, div);
            expect(style.get("background"), `swap=${swap}`).toContain("linear-gradient");
            expect(style.get("padding-bottom"), `swap=${swap}`).toContain("safe-area-inset-bottom");
            // 100vh 兜底 + 100dvh 覆盖：同一条规则里后写的赢
            expect(style.get("height"), `swap=${swap}`).toBe("100dvh");
        });
    });
});

describe("主题 token 的对比度（FE-10 / FD）", () => {
    it.each(COMBOS)("%s + %s：muted 小字对表面 ≥ 4.5:1（AA 小字）", (theme, mode) => {
        const tokens = htmlTokens(theme, mode, inOrder(false));
        const muted = tokens.get("--text-muted")!;
        ["--surface-1", "--surface-2"].forEach((surface) => {
            expect(contrast(muted, tokens.get(surface)!), `${theme}/${mode} vs ${surface}`).toBeGreaterThanOrEqual(
                4.5
            );
        });
    });

    it.each(COMBOS)("%s + %s：muted 小字对页面渐变底 ≥ 4.0:1", (theme, mode) => {
        const tokens = htmlTokens(theme, mode, inOrder(false));
        const muted = tokens.get("--text-muted")!;
        ["--bg-start", "--bg-end"].forEach((bg) => {
            expect(contrast(muted, tokens.get(bg)!), `${theme}/${mode} vs ${bg}`).toBeGreaterThanOrEqual(4);
        });
    });

    it.each(COMBOS)("%s + %s：primary / secondary 不低于小字门槛", (theme, mode) => {
        const tokens = htmlTokens(theme, mode, inOrder(false));
        ["--text-primary", "--text-secondary"].forEach((prop) => {
            expect(contrast(tokens.get(prop)!, tokens.get("--surface-1")!)).toBeGreaterThanOrEqual(4.5);
        });
    });

    it.each(COMBOS)("%s + %s：.gradient-text 三个端点对所有底面 ≥ 3:1（大字号 AA）", (theme, mode) => {
        const tokens = htmlTokens(theme, mode, inOrder(false));
        ["--gradient-text-1", "--gradient-text-2", "--gradient-text-3"].forEach((stop) => {
            const value = tokens.get(stop)!;
            expect(parseHslTriplet(value), `${theme}/${mode} 的 ${stop} 要能解析成 HSL 三元组`).not.toBeNull();
            ["--surface-1", "--surface-2", "--bg-start", "--bg-end"].forEach((bg) => {
                expect(contrast(value, tokens.get(bg)!), `${theme}/${mode}: ${stop} vs ${bg}`).toBeGreaterThanOrEqual(
                    3
                );
            });
        });
    });

    it("muted / secondary / primary 三级文字仍分得开（提对比度时别压成两级）", () => {
        COMBOS.forEach(([theme, mode]) => {
            const tokens = htmlTokens(theme, mode, inOrder(false));
            const lightness = (prop: string) => parseHslTriplet(tokens.get(prop)!)![2];
            const muted = lightness("--text-muted");
            const secondary = lightness("--text-secondary");
            const primary = lightness("--text-primary");
            if (mode === "light") {
                expect(muted).toBeGreaterThan(secondary);
                expect(secondary).toBeGreaterThan(primary);
            } else {
                expect(muted).toBeLessThan(secondary);
                expect(secondary).toBeLessThan(primary);
            }
        });
    });
});

describe("utilities.css 的装饰类由特异性保护（FE-14）", () => {
    it("顶层装饰类都是 (0,2,0) 以上：原子类无法靠出现顺序翻掉它", () => {
        const plainClassRules = utilitiesCss.rules.filter(
            (rule) =>
                // reduced-motion 补丁走 !important，不需要提权，跳过
                !rule.atChain.some((at) => at.startsWith("media")) &&
                // 只看「纯类名」规则（含 .a.a 这种重复类名写法）
                rule.selectors.every((selector) => /^\.[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/.test(selector))
        );
        expect(plainClassRules.length).toBeGreaterThan(0);
        plainClassRules.forEach((rule) => {
            const [, classes] = specificity(rule.selectors[0]);
            expect(classes, rule.selectors[0]).toBeGreaterThanOrEqual(2);
        });
    });

    it(".gradient-text 只吃主题变量，不写死颜色", () => {
        const div = document.createElement("div");
        div.className = "gradient-text";
        const style = resolveCascade([utilitiesCss], div);
        expect(style.get("background")).toContain("var(--gradient-text-");
    });
});
