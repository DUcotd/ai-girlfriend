/**
 * configValidation.js - `POST /config` 与 `POST /config/proactive` 的入参守卫（HTTP-11 / HTTP-12）。
 *
 * 为什么必须在这一层挡住：这些字段会被写进进程内的运行时配置并**持久化到 state.json**，
 * 一个错误会长期影响之后每一轮对话。审计实测过的三条静默失效路径：
 *   1. 类型不校验：`{"api_key":{}}` 会被当成「有 Key」，`{"temperature":"false"}`
 *      会让每轮 temperature 变成 NaN —— 界面全程显示 updated，没人知道配置已经坏掉；
 *   2. 字段名写错（camelCase 误当 snake_case）静默忽略 —— 用户点了保存、界面上没生效；
 *   3. `base_url` 可以是任意字符串：指向 `http://169.254.169.254/`（云元数据地址）或
 *      内网服务时，本机持有的 API Key 会被主动送到那个地址（SSRF 式的凭据外泄）。
 *
 * 空值语义（这里定死并写进 README，别再各写一套）：
 *   - `undefined`（没带这个字段）= 不动；
 *   - 主连接三件套里 `api_key` 的**空串 = 不动**：前端 useBootstrap 每次挂载都会把
 *     localStorage 里的空值序列化成 ''，把它当「清空」会在用户没配 Key 的浏览器里
 *     抹掉服务端 `AI_GIRLFRIEND_API_KEY` 兜底的 Key；要显式清空请传 `null`；
 *   - 嵌入/TTS 的 Key：空串 **= 清空**（设置页「清除嵌入配置」就是发 ''，这是既有契约），
 *     `null` 同样表示清空。
 */

/** 各字段长度上限：防一条 100KB 的「模型名」永久抬高每一轮请求的体积 */
export const CONFIG_LIMITS = Object.freeze({
    apiKey: 512,
    modelName: 200,
    baseUrl: 2048,
});

const STRING = 'string';
// ⚠️ 命名不能用 URL / NUMBER / BOOLEAN：`const URL = 'url'` 会把全局的 URL 构造器
// 遮蔽掉，同文件里的 `new URL(...)` 立刻变成 "URL is not a constructor"。
// （这条曾经让每一个合法 baseUrl 都被判成非法，报错信息还特别像「地址不合规」。）
const URL_KIND = 'url';
const NUMBER = 'number';
const BOOLEAN = 'boolean';
const ENUM = 'enum';

/**
 * `POST /config` 的字段表（唯一事实源：路由与测试都读这里）。
 * reasoning_effort 的档位由调用方注入（真源在 config.js 的 REASONING_EFFORTS），
 * 这样本文件保持零依赖、纯函数，可以被任何测试直接引用。
 * clearMeansNull：该字段只有 null 表示清空，空串视为「未提供」
 */
export function configFieldRules(reasoningEfforts = []) {
    return Object.freeze({
        ...CONFIG_FIELD_RULES_BASE,
        reasoning_effort: { kind: ENUM, values: ['', ...reasoningEfforts], emptyIsNoop: true },
    });
}

const CONFIG_FIELD_RULES_BASE = Object.freeze({
    api_key: { kind: STRING, max: CONFIG_LIMITS.apiKey, clearMeansNull: true },
    base_url: { kind: URL_KIND, max: CONFIG_LIMITS.baseUrl },
    model_name: { kind: STRING, max: CONFIG_LIMITS.modelName },
    tts_api_key: { kind: STRING, max: CONFIG_LIMITS.apiKey },
    embedding_api_key: { kind: STRING, max: CONFIG_LIMITS.apiKey },
    embedding_base_url: { kind: URL_KIND, max: CONFIG_LIMITS.baseUrl },
    embedding_model_name: { kind: STRING, max: CONFIG_LIMITS.modelName },
    max_prompt_history: { kind: NUMBER, min: 1, max: 500 },
    temperature: { kind: NUMBER, min: 0, max: 2 },
    max_tokens: { kind: NUMBER, min: 0, max: 1_000_000 },
    reasoning_effort: { kind: ENUM, values: [''], emptyIsNoop: true },
    unlimited_context: { kind: BOOLEAN },
    memory_facts_enabled: { kind: BOOLEAN },
    memory_retrieval_mode: { kind: ENUM, values: ['auto', 'embedding', 'keyword'] },
    user_emotion_enabled: { kind: BOOLEAN },
    narrative_enabled: { kind: BOOLEAN },
    trigger_enabled: { kind: BOOLEAN },
});

/**
 * `POST /config/proactive` 的字段表。
 * frequencyLevel 的档位表由调用方注入（真源在 ProactiveEngine.FREQUENCY），
 * 这样本文件保持零依赖、纯函数，可以被任何测试直接引用。
 */
export function proactiveFieldRules(frequencyLevels) {
    return Object.freeze({
        ...PROACTIVE_FIELD_RULES_BASE,
        frequencyLevel: { kind: ENUM, values: frequencyLevels },
    });
}

const PROACTIVE_FIELD_RULES_BASE = Object.freeze({
    enabled: { kind: BOOLEAN },
    frequencyLevel: { kind: ENUM, values: [] },
    customDailyLimit: { kind: NUMBER, min: 0, max: 200, allowNull: true, integerOnly: true },
    enabledTypes: { kind: 'stringArray', maxItems: 64 },
});

/**
 * 允许的内网/回环 baseUrl —— 默认拒绝。
 * 本机单人应用最常见的合法场景确实是局域网自建推理服务，所以留两个显式开关：
 *   - `AI_GIRLFRIEND_ALLOW_PRIVATE_BASE_URLS=true` 整体放行
 *   - `AI_GIRLFRIEND_BASE_URL_ALLOWLIST=host1,host2` 精确放行（优先级高于拒绝规则）
 */
function privateBaseUrlPolicy() {
    const raw = process.env.AI_GIRLFRIEND_BASE_URL_ALLOWLIST || '';
    const allowlist = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    const allowAll = process.env.AI_GIRLFRIEND_ALLOW_PRIVATE_BASE_URLS === 'true';
    return { allowlist, allowAll };
}

/**
 * baseUrl 分级（B3-3）。**只拦真正危险的，其余给告警**：
 * 这是一个本地优先的应用，把 Key 交给局域网里的 Ollama / LM Studio 是合理用法，
 * 一刀切禁止内网会直接砍掉这类用户；而云元数据地址则是纯粹的凭据陷阱。
 *
 * @returns {'block'|'warn'|'ok'}
 */
export function classifyBaseUrlHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return 'block';

    // —— 一律拒绝：链路本地 / 未指定地址 / 云厂商元数据服务 ——
    // 169.254.0.0/16 覆盖 AWS/Azure/GCP/OpenStack 的元数据端点；
    // 100.100.100.200（阿里云元数据）落在 100.64.0.0/10 里，一并拒。
    if (host === 'metadata' || host.startsWith('metadata.')) return 'block';
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 169 && b === 254) return 'block';
        if (a === 0) return 'block';                              // 0.0.0.0 = 本机路由到自身/元数据
        if (a === 100 && b >= 64 && b <= 127) return 'block';     // CGNAT（含阿里云元数据段）
        if (a === 127) return 'warn';                             // 回环：本地推理服务，合法但要提示
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'warn';
        return 'ok';
    }
    if (host.includes(':')) {                                     // IPv6
        if (host === '::' || host === '::1') return host === '::' ? 'block' : 'warn';
        if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'warn';       // 唯一本地地址
        if (/^fe80:/.test(host)) return 'block';                  // 链路本地
        if (host.startsWith('::ffff:')) return classifyBaseUrlHost(host.slice(7));
        return 'ok';
    }
    if (host === 'localhost' || host.endsWith('.localhost')) return 'warn';
    if (host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
        // 裸主机名/内网域名解析：多半是局域网设备或内部服务，值得提示但不构成凭据外泄目标
        return 'warn';
    }
    return 'ok';
}

/** 这条地址是否为「不该把 API Key 送过去」的地址（云元数据 / 链路本地 / 未指定） */
export function isBlockedBaseUrlHost(hostname) {
    return classifyBaseUrlHost(hostname) === 'block';
}

/**
 * 校验一个 baseUrl / embedding baseUrl。
 * @returns {{url:string, warning:string|null}|null} 合法返回归一化结果；被拒返回 null
 */
export function normalizeBaseUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > CONFIG_LIMITS.baseUrl) return null;
    let url;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;         // 凭据塞在 URL 里：既不合规也容易被日志带出去

    const host = url.hostname.toLowerCase();
    const { allowlist, allowAll } = privateBaseUrlPolicy();
    if (!allowAll && !allowlist.has(host) && !allowlist.has(url.host)
        && classifyBaseUrlHost(url.hostname) === 'block') {
        return null;
    }
    const normalized = url.toString().replace(/\/$/, '');   // 归一化掉尾部斜杠，避免 UI 上显示成另一个地址
    const warning = classifyBaseUrlHost(url.hostname) === 'warn'
        ? `Base URL 指向本机或局域网地址（${host}）：合法的本机推理服务可以这样用，但你的 API Key 会随请求发到它那里。`
        : null;
    return { url: normalized, warning };
}

/** 数字字段：只接受真数字与「看起来是数字」的字符串；NaN/Infinity/布尔一律拒 */
function checkNumber(name, value, rule) {
    if (typeof value === 'boolean') return `${name} 不能是布尔值`;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) return `${name} 必须是有限数字，收到 ${JSON.stringify(value)}`;
    if (rule.integerOnly && !Number.isInteger(n)) return `${name} 必须是整数`;
    if (n < rule.min || n > rule.max) return `${name} 必须在 ${rule.min}~${rule.max} 之间，收到 ${n}`;
    return null;
}

/**
 * 按字段表校验一个请求体。
 * @param {object} body
 * @param {object} rules 字段表（CONFIG_FIELD_RULES / PROACTIVE_FIELD_RULES）
 * @param {object} [opts]
 * @param {string[]} [opts.extraAllowed] 允许出现但不校验的字段名（如任务路由的 title）
 * @returns {{errors: string[], warnings: string[], values: object}}
 *          errors 非空即应回 400；values 是归一化后的值（URL 归一化、trim）
 */
export function validateConfigBody(body, rules, { extraAllowed = [] } = {}) {
    const errors = [];
    const warnings = [];
    const values = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { errors: ['请求体必须是一个 JSON 对象'], warnings, values };
    }

    for (const [name, raw] of Object.entries(body)) {
        const rule = rules[name];
        if (!rule) {
            if (extraAllowed.includes(name)) continue;
            // 未知字段：不阻断（前后端版本不完全同步时不该整条保存失败），
            // 但必须说出来 —— 「字段名写错被静默忽略」正是最难查的一类失效。
            warnings.push(`未知字段已忽略：${name}`);
            continue;
        }
        if (raw === undefined) continue;                    // 没带这个字段 = 不动

        if (raw === null) {
            if (rule.allowNull) { values[name] = null; continue; }
            if (rule.kind === STRING) { values[name] = null; continue; }   // null = 显式清空
            errors.push(`${name} 不能为 null`);
            continue;
        }

        switch (rule.kind) {
            case STRING: {
                if (typeof raw !== 'string') { errors.push(`${name} 必须是字符串，收到 ${typeName(raw)}`); break; }
                const s = raw.trim();
                if (!s) {
                    // 空串语义按字段区分（见文件头注释）
                    values[name] = rule.clearMeansNull ? undefined : '';
                    break;
                }
                if (s.length > rule.max) {
                    errors.push(`${name} 最长 ${rule.max} 个字符，收到 ${s.length}`);
                    break;
                }
                values[name] = s;
                break;
            }
            case URL_KIND: {
                if (typeof raw !== 'string') { errors.push(`${name} 必须是字符串，收到 ${typeName(raw)}`); break; }
                const s = raw.trim();
                if (!s) { values[name] = ''; break; }                       // 空串 = 清除/回退默认
                const ok = normalizeBaseUrl(s);
                if (!ok) {
                    errors.push(`${name} 必须是合法的 http(s) 地址，且不能指向云元数据/链路本地地址` +
                        `（本机会带着你的 API Key 访问它）：${s.slice(0, 120)}`);
                    break;
                }
                values[name] = ok.url;
                if (ok.warning) warnings.push(ok.warning);
                break;
            }
            case NUMBER: {
                const err = checkNumber(name, raw, rule);
                if (err) errors.push(err);
                else values[name] = Number(raw);
                break;
            }
            case BOOLEAN: {
                if (typeof raw !== 'boolean') {
                    errors.push(`${name} 必须是 true/false，收到 ${JSON.stringify(raw)}`);
                } else values[name] = raw;
                break;
            }
            case ENUM: {
                if (typeof raw !== 'string') { errors.push(`${name} 必须是字符串，收到 ${typeName(raw)}`); break; }
                if (raw === '' && rule.emptyIsNoop) { values[name] = ''; break; }
                if (!rule.values.includes(raw)) {
                    errors.push(`${name} 只能是 ${rule.values.map((v) => v || '(空)').join('/')} 之一，收到 ${JSON.stringify(raw)}`);
                    break;
                }
                values[name] = raw;
                break;
            }
            case 'stringArray': {
                if (!Array.isArray(raw)) { errors.push(`${name} 必须是字符串数组`); break; }
                if (raw.length > rule.maxItems) { errors.push(`${name} 最多 ${rule.maxItems} 项`); break; }
                const bad = raw.find((x) => typeof x !== 'string');
                if (bad !== undefined) { errors.push(`${name} 的每一项必须是字符串`); break; }
                values[name] = raw;
                break;
            }
            default:
                errors.push(`${name} 的校验规则未实现（请补 configValidation.js）`);
        }
    }
    return { errors, warnings, values };
}

function typeName(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return '数组';
    return typeof v;
}
