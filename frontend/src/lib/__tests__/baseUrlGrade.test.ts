import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
    assessBaseUrl,
    classifyBaseUrlHost,
    warnBaseUrlMessage,
} from "@/lib/baseUrlGrade";
import type { BaseUrlGrade } from "@/lib/baseUrlGrade";

/**
 * baseUrl 分级的跨端一致性守卫（B3 剩余项 / B7「把警告说给人看」的前半）。
 *
 * 真源是后端的 `classifyBaseUrlHost()` / `normalizeBaseUrl()`：它们决定 `POST /config`
 * 是「拒绝 / 警告 / 放行」。前端为了在用户点保存之前就显示分级，抄了一份镜像 ——
 * 抄写清单正是历史上最容易漂移的东西（主动消息默认勾选那次是「界面显示已保存、
 * 后端一个字都没收」），所以这里直接 import 后端模块逐样本比对，而不是靠注释提醒。
 */
interface BackendValidation {
    classifyBaseUrlHost: (hostname: string) => BaseUrlGrade;
    normalizeBaseUrl: (value: string) => { url: string; warning: string | null } | null;
}

let backend: BackendValidation;

beforeAll(async () => {
    const modulePath = resolve(
        process.cwd(),
        "../backend-node/src/utils/configValidation.js"
    );
    backend = (await import(pathToFileURL(modulePath).href)) as BackendValidation;
});

/** 覆盖后端 classifyBaseUrlHost 的每一条分支 */
const HOST_SAMPLES: { host: string; grade: BaseUrlGrade }[] = [
    { host: "api.openai.com", grade: "ok" },
    { host: "token.sensenova.cn", grade: "ok" },
    { host: "169.254.169.254", grade: "block" },   // 云厂商元数据端点
    { host: "0.0.0.0", grade: "block" },
    { host: "100.100.100.200", grade: "block" },   // 阿里云元数据（CGNAT 段）
    { host: "metadata", grade: "block" },
    { host: "metadata.google.internal", grade: "block" },
    { host: "127.0.0.1", grade: "warn" },
    { host: "10.0.0.5", grade: "warn" },
    { host: "172.16.0.1", grade: "warn" },
    { host: "192.168.1.10", grade: "warn" },
    { host: "localhost", grade: "warn" },
    { host: "ollama.local", grade: "warn" },
    { host: "my-nas", grade: "warn" },             // 裸主机名
    { host: "::1", grade: "warn" },
    { host: "::", grade: "block" },
    { host: "fe80::1", grade: "block" },
    { host: "fd00::1234", grade: "warn" },
    { host: "[::ffff:127.0.0.1]", grade: "warn" },
    { host: "", grade: "block" },
];

describe("baseUrl 分级与后端同一把尺子", () => {
    it("后端模块能被前端测试导入（真源没改名挪位）", () => {
        expect(typeof backend.classifyBaseUrlHost).toBe("function");
        expect(typeof backend.normalizeBaseUrl).toBe("function");
    });

    it.each(HOST_SAMPLES)(
        "主机名 $host —— 两侧分级都是 $grade",
        ({ host, grade }) => {
            expect(classifyBaseUrlHost(host)).toBe(grade);
            expect(backend.classifyBaseUrlHost(host)).toBe(grade);
        }
    );

    it("本机/局域网地址的告警文案与后端逐字一致", () => {
        const sample = "http://192.168.1.10:11434/v1";
        expect(assessBaseUrl(sample).message).toBe(
            backend.normalizeBaseUrl(sample)?.warning
        );
        expect(warnBaseUrlMessage("192.168.1.10")).toBe(
            backend.normalizeBaseUrl(sample)?.warning
        );
    });

    // 注意样本里**没有空串**：后端 `validateConfigBody` 对 `base_url: ''` 是短路处理
    // （空串 = 清除/回退服务商预设），根本不会走到 `normalizeBaseUrl`。
    // 前端同样把空串当「不评级」，所以这条一致性只在「用户真的填了东西」时成立。
    const URL_SAMPLES: string[] = [
        "https://token.sensenova.cn/v1",
        "https://api.openai.com/v1/",
        "http://127.0.0.1:11434/v1",
        "http://localhost:1234/v1",
        "http://169.254.169.254/latest/meta-data/",
        "http://0.0.0.0/v1",
        "http://[fe80::1]:11434/v1",
        "http://user:pass@api.openai.com/v1",
        "ftp://api.openai.com/v1",
        "not-a-url",
    ];

    it.each(URL_SAMPLES)("地址 %s 的「放行 / 拒绝」结论两侧一致", (value) => {
        const rejectedByBackend = backend.normalizeBaseUrl(value) === null;
        const blockedInFrontend = assessBaseUrl(value).grade === "block";
        expect(blockedInFrontend).toBe(rejectedByBackend);
    });

    it("空串不评级（留空表示沿用服务商预设，不是错误）", () => {
        expect(assessBaseUrl("")).toEqual({ grade: "ok", host: null, message: null });
        expect(assessBaseUrl("   ")).toEqual({ grade: "ok", host: null, message: null });
    });

    it("公网 https 地址不产生任何要显示的文案", () => {
        expect(assessBaseUrl("https://token.sensenova.cn/v1")).toEqual({
            grade: "ok",
            host: "token.sensenova.cn",
            message: null,
        });
    });

    it("尾部斜杠与前后空格不影响分级结论", () => {
        expect(assessBaseUrl("  https://api.openai.com/v1/ ").grade).toBe("ok");
        expect(assessBaseUrl("  http://127.0.0.1:11434/v1/ ").grade).toBe("warn");
    });

    it("被拒的地址给出的文案里写明了「保存会被后端拒绝」", () => {
        const blocked = assessBaseUrl("http://169.254.169.254/latest/meta-data/");
        expect(blocked.grade).toBe("block");
        expect(blocked.message).toContain("拒绝");
    });
});
