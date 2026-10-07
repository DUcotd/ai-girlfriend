/**
 * 后端统一鉴权中间件（P0 安全加固）。
 *
 * 背景：原先后端所有业务路由（/chat、/config、/reset、/tasks、/audio、/state、
 * /life、/personality…）**零鉴权**。任何能访问该端口的进程都能：
 *   - POST /config 覆写 API Key 配置
 *   - POST /reset 清空用户的全部数据（历史 / 记忆 / 好感度 / 性格 / 情绪）
 *   - 读取全部对话历史与记忆
 * CORS 只放行 localhost:3000，但 CORS **只约束浏览器**，防不住本机其它程序
 * 或局域网内的直接 HTTP 调用。因此在应用层补一道真正的鉴权。
 *
 * 防护策略（两档，开箱可用且纵深防御）：
 *   1) 已配置 token（环境变量 AI_GIRLFRIEND_TOKEN）：校验 Authorization: Bearer <token>，
 *      不匹配一律 401。用 crypto.timingSafeEqual 做常量时间比较，抵御时序攻击。
 *   2) 未配置 token：**不放行**，退回「本机守卫」——仅允许来自 127.0.0.1 / ::1
 *      （含 IPv4-mapped ::ffff:127.0.0.1）/ localhost 的请求通过，其余一律 401。
 *      这样本地单机用户不配 token 也能直接自用，而局域网 / 外部访问被彻底阻断。
 *      启动时由 warnIfTokenMissing() 打印一次醒目中文警告，提示如何配置 token。
 *
 * ⚠️ token 直接从 process.env 读取，**不经过 config.js**——config.js 正被其它
 * 并行任务占用，避免文件冲突；同时也让鉴权开关与业务配置解耦。
 *
 * ⚠️ 挂载位置必须在 express.json() 之后、业务路由之前（见 app.js），
 * 否则 req.ip / req.socket 尚未就绪、且预检 OPTIONS 会被误拦。
 */
import crypto from 'crypto';
import { failWith } from './validate.js';
import { ERROR_CODES } from '../utils/errorCodes.js';

/** 环境变量名：鉴权 token 的唯一来源。 */
export const TOKEN_ENV = 'AI_GIRLFRIEND_TOKEN';

/**
 * 健康检查路径：豁免鉴权，供前端 / 探活工具 / CI 的 boot smoke 判断后端是否真的活着。
 * `/` 只回一句「活着」；`/health` 回可判断的状态字段（数据目录可写、Key 是否已下发…），
 * 两者都不含任何对话内容与凭证，因此免鉴权不构成信息泄漏（主机名除外，那是自己的配置）。
 */
export const HEALTH_PATHS = new Set(['/', '/health']);

/** 静态资源前缀：TTS 音频等由 <audio> 标签直取，带不了 Authorization 头，
 *  故在「未配 token 的本机守卫模式」下免检；配了 token 则要求 ?token= 通过。 */
export const STATIC_PREFIX = '/static';

/**
 * 本机地址白名单。覆盖：
 *   - '127.0.0.1'            IPv4 回环
 *   - '::1'                  IPv6 回环
 *   - '::ffff:127.0.0.1'     Node 在双栈监听下把 IPv4 回环表示为 IPv4-mapped IPv6
 *   - 'localhost'            某些反代 / 自测场景会以主机名形式出现
 */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

/** 读取当前生效的 token；空串 / 纯空白视为「未配置」。 */
export function getConfiguredToken() {
    const raw = process.env[TOKEN_ENV];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * 用 Node 的 req.ip / req.socket 判定来源是否为本机回环。
 * 注意：express 的 req.ip 在未启用 trust proxy 时等于 socket 远端地址；
 * 我们**不信任** X-Forwarded-For（否则伪造该头即可绕过本机守卫），
 * 只认 socket 层的真实对端地址。
 */
export function isLoopbackRequest(req) {
    const candidates = [];
    const socketAddr = req?.socket?.remoteAddress;
    if (typeof socketAddr === 'string') candidates.push(socketAddr);
    const ip = req?.ip;
    if (typeof ip === 'string') candidates.push(ip);

    return candidates.some((addr) => {
        if (!addr) return false;
        // 去掉 IPv6 的 zone id（如 fe80::1%eth0 这种写法）后比较
        const normalized = addr.includes('%') ? addr.split('%')[0] : addr;
        if (LOOPBACK_IPS.has(normalized)) return true;
        // 兼容 '::ffff:127.0.0.1' 的不同大小写书写形式
        return normalized.toLowerCase() === '::ffff:127.0.0.1';
    });
}

/**
 * 常量时间字符串比较，避免通过响应耗时泄漏 token 前缀。
 *
 * ⚠️ crypto.timingSafeEqual 要求两个 Buffer 长度完全一致，长度不等会**抛异常**，
 * 长度本身就足以区分，因此长度不等时先对**等长的假 buffer** 做一次比较（消耗掉
 * 常量时间），再直接返回 false——既不抛异常、也不提前暴露「长度不对」。
 */
export function safeTokenEquals(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) {
        // 用等长的零 buffer 走一遍 timingSafeEqual，保证路径耗时平滑
        const filler = Buffer.alloc(b.length);
        crypto.timingSafeEqual(filler, b);
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

/** 从 `Authorization: Bearer <token>` 中解析 token；格式不符返回 null。 */
export function extractBearerToken(req) {
    const header = req?.headers?.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;
    const token = match[1].trim();
    return token.length > 0 ? token : null;
}

/** 请求路径是否命中豁免规则（健康检查 / CORS 预检）。 */
export function isExemptPath(req) {
    // CORS 预检必须放行：预检请求本来就不带业务凭证，拦掉会让所有跨域请求直接失败
    if (req.method === 'OPTIONS') return true;
    const path = req.path || '';
    if (HEALTH_PATHS.has(path)) return true;
    // ⚠️ /static 不再无条件豁免（审计 B0-10）：TTS 音频就是「对话内容的语音版」。
    // 旧规则下即使配了 token，这些文件仍对局域网完全敞开 —— 只有「未配 token 的
    // 本机守卫模式」下才免检（见 createAuthMiddleware 里的静态分支）。
    return false;
}

/** 从查询串取 token：<audio src="…"> 这类标签带不了 Authorization 头。 */
function extractQueryToken(req) {
    const raw = req?.query?.token;
    if (typeof raw !== 'string') return null;
    const token = raw.trim();
    return token.length > 0 ? token : null;
}

/** 是否静态资源路径（允许用查询串 token 通过；业务接口仍要求请求头） */
function isStaticPath(req) {
    const path = req.path || '';
    return path === STATIC_PREFIX || path.startsWith(`${STATIC_PREFIX}/`);
}

/**
 * 鉴权中间件工厂。
 * @param {{token?: string|null}} [options] 可显式注入 token（测试用）；缺省从 process.env 读。
 * @returns {import('express').RequestHandler}
 */
export function createAuthMiddleware(options = {}) {
    const resolvedToken = options.token !== undefined ? options.token : getConfiguredToken();

    return function authMiddleware(req, res, next) {
        // 1) 豁免：预检 / 健康检查 / 静态资源
        if (isExemptPath(req)) return next();

        // 2) 未配置 token → 本机守卫：仅回环地址放行（静态资源在此模式下同样只对本机开放）
        if (!resolvedToken) {
            if (isLoopbackRequest(req)) return next();
            return failWith(res, 401,
                'Unauthorized: 后端未配置访问令牌，且请求来自非本机地址。'
                + `请在环境变量 ${TOKEN_ENV} 中配置访问令牌。`,
                ERROR_CODES.UNAUTHORIZED_OPEN);
        }

        // 3) 已配置 token → 校验 Bearer token；静态资源额外允许 ?token= 查询串
        //    （浏览器渲染 <audio src> 无法附加请求头，而 TTS 音频属于对话内容）
        const provided = extractBearerToken(req)
            ?? (isStaticPath(req) ? extractQueryToken(req) : null);
        if (provided === null) {
            // 码分三档给前端：没配 token / 没带 token / 带了但不对。
            // 后两者界面能直接给出「去设置页填凭证」的可操作提示（B7-①）
            return failWith(res, 401,
                'Unauthorized: 缺少 Authorization: Bearer <token> 头。',
                ERROR_CODES.UNAUTHORIZED_MISSING);
        }
        if (!safeTokenEquals(provided, resolvedToken)) {
            return failWith(res, 401, 'Unauthorized: 访问令牌无效。', ERROR_CODES.UNAUTHORIZED_TOKEN);
        }
        return next();
    };
}

/** 默认单例中间件：从 process.env 读取 token（进程启动时快照）。 */
export const authMiddleware = createAuthMiddleware();

let warned = false;

/**
 * 启动时打印一次醒目中文警告：未配置 token 时说明当前的「本机守卫」行为与配置方法。
 * 幂等——同进程内重复调用只打印一次。
 */
export function warnIfTokenMissing() {
    if (warned) return;
    if (getConfiguredToken()) return;
    warned = true;
    const line = '='.repeat(64);
    console.warn(
        `\n${line}\n`
        + '⚠️  安全提示：未检测到后端访问令牌（AI_GIRLFRIEND_TOKEN）。\n'
        + '    当前处于「本机守卫」模式：仅允许来自 127.0.0.1 / ::1 的请求，\n'
        + '    局域网与外部地址的请求将一律返回 401。\n'
        + '    如需从其它设备访问，请先配置令牌（任选其一）：\n'
        + '      · 临时：AI_GIRLFRIEND_TOKEN=你的密钥 npm start\n'
        + '      · 持久：在 backend-node/.env 中写入 AI_GIRLFRIEND_TOKEN=你的密钥\n'
        + '    并在前端 localStorage 写入同名密钥（key: ai-girlfriend-token）。\n'
        + `${line}\n`,
    );
}
