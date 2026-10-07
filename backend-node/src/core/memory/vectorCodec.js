/**
 * vectorCodec —— 向量的**唯一读写口径**（B8-2，审计 CORE-08）。
 *
 * 背景：`memory.json` 里 1024 维的向量原本是一串浮点数组，配上
 * `JSON.stringify(data, null, 2)` 的缩进写盘，每个浮点各占一行 ——
 * 实测 500 条 episode（默认上限）= **14.6 MB**，每 2 秒去抖到期就同步全量重写一次，
 * 开机 readJson 还要把它整个解析回来（1-2 秒、几十 MB 瞬时堆）。
 *
 * 现在磁盘上的形状是 **base64(Float32LE)**：1024 × 4 字节 = 4096 B → base64 5462 字符，
 * 一条 episode 的向量部分从 ~18 KB 降到 ~5.5 KB，整库 ≤3 MB。
 *
 * 为什么是 Float32 而不是保留 float64：嵌入模型给出的数值本来就只在 float32 精度上稳定
 * （各家 API 的实现普遍是 fp32），而余弦相似度是**归一化的比值**，
 * 第 7 位小数的差异对排序完全不可见（test-audit-b8 里有断言：legacy 纯数组与
 * base64 读回来的库，检索结果逐条一致）。
 *
 * ⚠️ 兼容是双向的：
 *   - 读：`toVector()` 同时接受 旧的 `number[]` / `Float32Array` / 新的 base64 字符串，
 *     所以老用户磁盘上的 memory.json 不改写也能正常检索（写回时才顺带压缩）。
 *   - 写：所有写入点统一走 `encodeVector()`，它已经是字符串的原样返回（幂等，
 *     避免「二次编码」把 base64 又编一遍）。
 * 新增读取点**必须**经过 toVector()，不要再写 `Array.isArray(e.embedding)` ——
 * 那正是这次审计里 8 处各自为政的判定向导火索。
 */

/**
 * 归一化后的向量类型（JSDoc 声明，不是 TS 语法：本项目是纯 Node ESM）。
 * @typedef {number[]|Float32Array} VectorLike
 */

/** 是不是本模块写出的 base64 编码向量（字符串且长度是 4 的倍数、可 base64 解码） */
export function isEncodedVector(value) {
    return typeof value === 'string' && value.length > 0 && value.length % 4 === 0
        && /^[A-Za-z0-9+/]+=*$/.test(value);
}

/**
 * 任意存量形状 → 可索引向量。
 * @param {number[]|Float32Array|string|null|undefined} stored
 * @returns {Float32Array|number[]|null} 空/非法一律 null（调用方据此走关键词或文本判重）
 */
export function toVector(stored) {
    if (!stored) return null;
    if (Array.isArray(stored)) return stored.length > 0 ? stored : null;
    if (stored instanceof Float32Array) return stored.length > 0 ? stored : null;
    if (stored instanceof ArrayBuffer) {
        const f32 = new Float32Array(stored);
        return f32.length > 0 ? f32 : null;
    }
    if (typeof stored === 'string') {
        if (!isEncodedVector(stored)) return null;
        try {
            const bytes = Buffer.from(stored, 'base64');
            // base64 解出来的长度必须是 4 字节（一个 float32）的整数倍
            if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
            return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        } catch {
            // 非法 base64（手改过的档案、半截写入）：当成没有向量，检索退化为关键词路径
            return null;
        }
    }
    return null;
}

/**
 * 向量 → 磁盘形状（base64 Float32LE）。
 * @param {number[]|Float32Array|string|null|undefined} value
 * @returns {string|null} null = 没有向量；已经是字符串则原样返回（幂等，防二次编码）
 */
export function encodeVector(value) {
    if (!value) return null;
    if (typeof value === 'string') return isEncodedVector(value) ? value : null;
    const vec = toVector(value);
    if (!vec || vec.length === 0) return null;
    const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

/**
 * 解码成**普通数组**（只给测试与调试用；运行路径请直接用 toVector 拿 Float32Array，
 * 免得每次比较都拷一份 1024 元素的数组）。
 */
export function decodeVector(stored) {
    const vec = toVector(stored);
    return vec ? Array.from(vec) : null;
}
