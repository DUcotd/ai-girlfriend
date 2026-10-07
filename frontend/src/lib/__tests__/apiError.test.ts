import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiErrorFrom, networkError, toApiError } from "@/lib/apiError";
import { CLIENT_ONLY_ERROR_CODES, LOCAL_ERROR_CODES, UPSTREAM_ERROR_CODES } from "@/lib/errorCodes";
import { api } from "@/lib/api";

/**
 * ApiError 的形状与兼容性（B7-①）。
 *
 * 两条硬要求：
 *  1. `message` 仍然等于后端 detail —— 历史调用方（`e.message`）不能因为这次改造哑掉；
 *  2. 结构化字段（status/code/errors/action）必须在，界面才不用再匹配中文文案。
 */
describe("ApiError 形状", () => {
    it("带 detail 与 error_code 的错误体：字段齐全", () => {
        const err = apiErrorFrom(409, {
            detail: "已经记着类似的事了",
            error_code: LOCAL_ERROR_CODES.DUPLICATE_FACT,
        });
        expect(err).toBeInstanceOf(ApiError);
        expect(err.message).toBe("已经记着类似的事了");
        expect(err.detail).toBe("已经记着类似的事了");
        expect(err.status).toBe(409);
        expect(err.code).toBe(LOCAL_ERROR_CODES.DUPLICATE_FACT);
        expect(err.isNetworkError).toBe(false);
        expect(err.errors).toEqual([]);
    });

    it("POST /config 的 errors[] 逐条保留", () => {
        const err = apiErrorFrom(400, {
            detail: "temperature 必须是有限数字",
            error_code: LOCAL_ERROR_CODES.INVALID_CONFIG,
            errors: ["temperature 必须是有限数字", "base_url 必须是合法的 http(s) 地址", 42],
        });
        expect(err.errors).toEqual([
            "temperature 必须是有限数字",
            "base_url 必须是合法的 http(s) 地址",
        ]);
    });

    it("响应体缺失或不是约定形状时退化成状态码描述，不抛第二次错", () => {
        const err = apiErrorFrom(502, null);
        expect(err.code).toBeNull();
        expect(err.detail).toBe("");
        expect(err.userMessage).toBe("请求失败（HTTP 502）");
    });

    it("网络层失败：没有状态码，文案由前端负责（后端已经不在了）", () => {
        const err = networkError(new TypeError("fetch failed"));
        expect(err.isNetworkError).toBe(true);
        expect(err.code).toBe(CLIENT_ONLY_ERROR_CODES.NETWORK);
        expect(err.status).toBeNull();
        expect(err.userMessage).toContain("连不上后端");
        expect(err.action.retry).toBe(true);
    });

    it("需要去设置页的码，userMessage 会补一句指引", () => {
        const err = apiErrorFrom(400, {
            detail: "模型服务拒绝了这次请求（API Key 无效或过期）。",
            error_code: UPSTREAM_ERROR_CODES.AUTH,
        });
        expect(err.userMessage).toBe(
            "模型服务拒绝了这次请求（API Key 无效或过期）。（设置 → 通用）"
        );
    });

    it("AbortError 保持自己的码，不被当成网络故障", () => {
        const abort = new Error("The user aborted a request.");
        abort.name = "AbortError";
        const err = toApiError(abort);
        expect(err.code).toBe(CLIENT_ONLY_ERROR_CODES.ABORTED);
        expect(toApiError(err)).toBe(err);   // 幂等：已规整过的不再包一层
    });

    it("未知异常也能规整成 ApiError（调用方永远不用判类型）", () => {
        expect(toApiError("字符串错误").code).toBe(CLIENT_ONLY_ERROR_CODES.NETWORK);
        expect(toApiError(undefined).detail).toBe("");
    });
});

describe("request() 抛的就是 ApiError", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("后端回 400 + 稳定码 → 界面拿得到码", async () => {
        vi.stubGlobal("fetch", vi.fn(async () =>
            new Response(
                JSON.stringify({
                    status: "invalid_config",
                    detail: "base_url 必须是合法的 http(s) 地址",
                    error_code: LOCAL_ERROR_CODES.INVALID_CONFIG,
                    errors: ["base_url 必须是合法的 http(s) 地址"],
                }),
                { status: 400, headers: { "Content-Type": "application/json" } }
            )
        ));

        const error = await api.syncConfig({ baseUrl: "http://169.254.169.254/v1" }).catch((e) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.code).toBe(LOCAL_ERROR_CODES.INVALID_CONFIG);
        expect(error.action.openSettings).toBe(true);
        expect(error.userMessage).toContain("合法的 http(s) 地址");
    });

    it("连不上后端 → network_error，而不是「请求失败：undefined」", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
        const error = await api.getState().catch((e) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.isNetworkError).toBe(true);
        expect(error.userMessage).toContain("连不上后端");
    });
});
