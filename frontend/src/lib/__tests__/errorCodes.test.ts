import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
    CLIENT_ONLY_ERROR_CODES,
    KNOWN_ERROR_CODES,
    LOCAL_ERROR_CODES,
    UPSTREAM_ERROR_CODES,
    actionFor,
    withActionHint,
} from "@/lib/errorCodes";

/**
 * 错误码契约的跨端守卫（B7-①）。
 *
 * 前端那份镜像**必须**与后端两张表逐值相等：
 *   - 后端加了码而前端没登记 → 界面只能走默认行动（不会崩，但提示不精准）；
 *   - 前端留了后端已删的码 → 那条分支永远不命中，等于写了一段死代码骗自己。
 * 所以这里直接 import 后端模块比对，而不是靠注释「记得同步」。
 */
interface BackendTables {
    ERROR_CODES: Record<string, string>;
    UPSTREAM_ERROR_CODES: Record<string, string>;
}

let backend: BackendTables;

beforeAll(async () => {
    const root = resolve(process.cwd(), "../backend-node/src/utils");
    const local = (await import(pathToFileURL(`${root}/errorCodes.js`).href)) as BackendTables;
    const upstream = (await import(pathToFileURL(`${root}/upstreamError.js`).href)) as Pick<
        BackendTables,
        "UPSTREAM_ERROR_CODES"
    >;
    backend = { ERROR_CODES: local.ERROR_CODES, UPSTREAM_ERROR_CODES: upstream.UPSTREAM_ERROR_CODES };
});

const backendValues = (table: Record<string, string>) => new Set(Object.values(table));

describe("错误码镜像与后端两张表逐值一致", () => {
    it("后端两张表能被前端测试导入（没改名、没挪位置）", () => {
        expect(typeof backend.ERROR_CODES).toBe("object");
        expect(typeof backend.UPSTREAM_ERROR_CODES).toBe("object");
    });

    it("上游类镜像与后端 UPSTREAM_ERROR_CODES 完全一致", () => {
        expect(new Set(Object.values(UPSTREAM_ERROR_CODES))).toEqual(
            backendValues(backend.UPSTREAM_ERROR_CODES)
        );
    });

    it("本机业务类镜像与后端 ERROR_CODES 完全一致", () => {
        expect(new Set(Object.values(LOCAL_ERROR_CODES))).toEqual(
            backendValues(backend.ERROR_CODES)
        );
    });

    it("前端独有的两个码确实不在后端表里（network_error / aborted）", () => {
        const all = new Set([
            ...backendValues(backend.ERROR_CODES),
            ...backendValues(backend.UPSTREAM_ERROR_CODES),
        ]);
        for (const value of Object.values(CLIENT_ONLY_ERROR_CODES)) {
            expect(all.has(value)).toBe(false);
        }
    });

    it("KNOWN_ERROR_CODES 覆盖两个来源（行动映射的查表口径）", () => {
        for (const value of Object.values(backend.ERROR_CODES)) {
            expect(KNOWN_ERROR_CODES.has(value)).toBe(true);
        }
        for (const value of Object.values(backend.UPSTREAM_ERROR_CODES)) {
            expect(KNOWN_ERROR_CODES.has(value)).toBe(true);
        }
    });

    it("两张后端表只共享 internal_error 这一个值（前端镜像同样只别名一次）", () => {
        const shared = Object.values(backend.ERROR_CODES).filter((v) =>
            Object.values(backend.UPSTREAM_ERROR_CODES).includes(v)
        );
        expect(shared).toEqual([backend.UPSTREAM_ERROR_CODES.UNKNOWN]);
        expect(LOCAL_ERROR_CODES.INTERNAL_ERROR).toBe(backend.UPSTREAM_ERROR_CODES.UNKNOWN);
    });
});

describe("码 → 行动（前端不复制文案，只决定用户下一步做什么）", () => {
    it("没配 Key / Key 无效 / 凭证问题 → 指向设置页", () => {
        for (const code of [
            UPSTREAM_ERROR_CODES.NOT_CONFIGURED,
            UPSTREAM_ERROR_CODES.AUTH,
            LOCAL_ERROR_CODES.UNAUTHORIZED_TOKEN,
            LOCAL_ERROR_CODES.VOICE_NOT_CONFIGURED,
        ]) {
            expect(actionFor(code).openSettings).toBe(true);
        }
    });

    it("限流 / 排队满 / 上游抖动 / 网络 → 可重试，不指挥人去改配置", () => {
        for (const code of [
            UPSTREAM_ERROR_CODES.RATE_LIMITED,
            UPSTREAM_ERROR_CODES.BUSY,
            UPSTREAM_ERROR_CODES.UNAVAILABLE,
            CLIENT_ONLY_ERROR_CODES.NETWORK,
        ]) {
            expect(actionFor(code).retry).toBe(true);
            expect(actionFor(code).openSettings).toBe(false);
        }
    });

    it("未知码与空码走默认行动，不抛异常（后端加码不该让旧前端崩）", () => {
        const fallback = actionFor("brand_new_code");
        expect(fallback).toEqual({ openSettings: false, retry: false, tone: "error" });
        expect(actionFor(null).openSettings).toBe(false);
        expect(actionFor(undefined).tone).toBe("error");
    });

    it("语气：阻断使用的用 error，「她这次没做到」的用 info", () => {
        expect(actionFor(UPSTREAM_ERROR_CODES.AUTH).tone).toBe("error");
        expect(actionFor(UPSTREAM_ERROR_CODES.BUSY).tone).toBe("info");
        expect(actionFor(LOCAL_ERROR_CODES.VOICE_NOT_CONFIGURED).tone).toBe("info");
    });
});

describe("行动指引的追加规则", () => {
    it("需要去设置页且后端文案没提设置时，补一句「（设置 → 通用）」", () => {
        expect(withActionHint("API Key 无效", UPSTREAM_ERROR_CODES.AUTH)).toBe(
            "API Key 无效（设置 → 通用）"
        );
    });

    it("后端文案已经写了去哪改，就不重复追加", () => {
        expect(withActionHint("请在设置页「语音」里检查", LOCAL_ERROR_CODES.VOICE_AUTH_FAILED)).toBe(
            "请在设置页「语音」里检查"
        );
    });

    it("文案以括号收尾（那种括号本身就是指引）→ 不追加", () => {
        expect(
            withActionHint(
                "请先配置 API Key 才能和小爱聊天哦~（在侧边栏输入或配置 .env 文件）",
                UPSTREAM_ERROR_CODES.NOT_CONFIGURED
            )
        ).toBe("请先配置 API Key 才能和小爱聊天哦~（在侧边栏输入或配置 .env 文件）");
    });

    it("不含指引关键词的短文案才追加", () => {
        expect(withActionHint("这个模型名找不到", UPSTREAM_ERROR_CODES.NOT_FOUND)).toBe(
            "这个模型名找不到（设置 → 通用）"
        );
    });

    it("不需要改配置的码原样返回", () => {
        expect(withActionHint("模型那边有点忙", UPSTREAM_ERROR_CODES.RATE_LIMITED)).toBe(
            "模型那边有点忙"
        );
    });
});
