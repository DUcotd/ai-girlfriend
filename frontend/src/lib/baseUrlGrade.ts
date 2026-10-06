/**
 * baseUrl 分级（前端侧的「同一把尺子」）。
 *
 * 真源在 `backend-node/src/utils/configValidation.js` 的 `classifyBaseUrlHost()`：
 * 后端 `POST /config` 收到地址后按它决定「拒绝 / 警告 / 放行」，warnings 随响应回传。
 * 这个文件是它的镜像，用途只有一个 —— **在用户点保存之前**就把分级显示在输入框下方，
 * 而不是等保存失败后弹一句「请检查后端连接」（那是本会话审计里 B3 剩下的最后一格）。
 *
 * ⚠️ 改这里必须同时改后端，`__tests__/baseUrlGrade.test.ts` 会逐样本比对两侧的
 * 分级、放行/拒绝结论与告警文案（跨端抄写清单一旦漂移就有静默失效的前科：
 * 参见主动消息默认勾选那次）。
 */

export type BaseUrlGrade = "ok" | "warn" | "block";

export interface BaseUrlAssessment {
    /** ok = 公网 https 服务；warn = 本机/局域网（合法，但 Key 会发过去）；block = 会被后端拒绝 */
    grade: BaseUrlGrade;
    /** 解析出的主机名；地址本身不合法时为 null */
    host: string | null;
    /** 要显示给用户的文案；ok 时为 null */
    message: string | null;
}

/**
 * 与后端 `normalizeBaseUrl()` 里那句告警**逐字一致**（测试钉住）。
 * 两边文案不同步的话，用户在输入框下看到的和保存响应里的会是两套话。
 */
export function warnBaseUrlMessage(host: string): string {
    return `Base URL 指向本机或局域网地址（${host}）：合法的本机推理服务可以这样用，但你的 API Key 会随请求发到它那里。`;
}

const BLOCK_UNPARSEABLE = "不是合法的 http(s) 地址，保存会被后端拒绝。";
const BLOCK_PROTOCOL = "只支持 http(s) 协议，保存会被后端拒绝。";
const BLOCK_CREDENTIALS = "地址里不要写账号密码（凭据容易被日志带出去），保存会被后端拒绝。";
const BLOCK_HOST =
    "这个地址是本机的元数据/保留地址，API Key 会直接送到它手里，后端会拒绝保存。";

/**
 * 主机名分级 —— 后端 `classifyBaseUrlHost()` 的逐行镜像。
 * 只拦真正危险的（云元数据 / 链路本地 / 未指定地址），其余给告警：
 * 本地优先的应用把 Key 交给局域网里的 Ollama / LM Studio 是合理用法。
 */
export function classifyBaseUrlHost(hostname: string): BaseUrlGrade {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return "block";

    if (host === "metadata" || host.startsWith("metadata.")) return "block";
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const a = Number(v4[1]);
        const b = Number(v4[2]);
        // 169.254.0.0/16 = AWS/Azure/GCP/OpenStack 元数据端点
        if (a === 169 && b === 254) return "block";
        // 0.0.0.0 = 本机路由到自身/元数据
        if (a === 0) return "block";
        // CGNAT 100.64.0.0/10（含阿里云元数据 100.100.100.200）
        if (a === 100 && b >= 64 && b <= 127) return "block";
        if (a === 127) return "warn";
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "warn";
        return "ok";
    }
    if (host.includes(":")) {
        // :: = 未指定地址；::1 = 回环
        if (host === "::" || host === "::1") return host === "::" ? "block" : "warn";
        // 唯一本地地址 fc00::/7
        if (/^f[cd][0-9a-f]{2}:/.test(host)) return "warn";
        // 链路本地
        if (/^fe80:/.test(host)) return "block";
        if (host.startsWith("::ffff:")) return classifyBaseUrlHost(host.slice(7));
        return "ok";
    }
    if (host === "localhost" || host.endsWith(".localhost")) return "warn";
    // 裸主机名 / .local / .internal：多半是局域网设备或内部服务，提示但不构成凭据外泄目标
    if (host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return "warn";
    return "ok";
}

/**
 * 对一个 baseUrl 输入值分级（空串不评级：留空表示沿用服务商预设）。
 * 结论与后端 `normalizeBaseUrl()` 的「放行 / 拒绝」保持一致。
 */
export function assessBaseUrl(value: string): BaseUrlAssessment {
    const raw = String(value || "").trim();
    if (!raw) return { grade: "ok", host: null, message: null };

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { grade: "block", host: null, message: BLOCK_UNPARSEABLE };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { grade: "block", host: url.hostname || null, message: BLOCK_PROTOCOL };
    }
    if (url.username || url.password) {
        return { grade: "block", host: url.hostname || null, message: BLOCK_CREDENTIALS };
    }

    const host = url.hostname.toLowerCase();
    const grade = classifyBaseUrlHost(host);
    if (grade === "warn") return { grade, host, message: warnBaseUrlMessage(host) };
    if (grade === "block") return { grade, host, message: BLOCK_HOST };
    return { grade, host, message: null };
}
