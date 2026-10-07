/**
 * AssociationRecall —— 顺着线索想起（最后一轮打磨，F-3）。
 *
 * 拟人化的形状：人类回忆不是「按相似度检索」，而是**被线索勾起来的**——
 * 对方说到「熬夜」，她想起那晚你们在便利店门口分一碗关东煮；你们之间那句
 * 只有彼此懂的暗号一出现，她应该立刻知道你说的是哪件事。
 *
 * 而这两个字段（`narrative.tags` / `narrative.jokeTrigger`）在 B2-10 之前
 * 一直在抽取层被整段丢掉；B2-10 把它们存下来了，`tags` 进了检索文本，
 * `jokeTrigger` 却**没有任何消费者**——存进磁盘就再没人读过。这一格把最后半条线接上。
 *
 * 与语义检索的关系：这是**补充**，不是替代。语义/关键词检索负责「聊到这事儿了吗」，
 * 联想负责「这句话是她们的暗号 / 这是她记下的线索词」，命中的故事永远排在注入段最前面，
 * 并带上「她被哪个词勾起」的说明，让她能顺着说下去而不是凭空复述。
 *
 * 纯函数：不读文件、不调 LLM、不碰 config（阈值由调用方传入），时间从参数来。
 */

/** 联想命中类型（joke 永远优先于 tag：暗号比线索词更专属）。 */
export const ASSOCIATION_KINDS = { joke: 'joke', tag: 'tag' };

/**
 * 归一化匹配文本：去掉空白与常见中英标点、转小写。
 * 「月落乌啼~」和「月落 乌啼」应该算同一句话。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[\s，。、！？；：~～·…\-—_,.!?:;"'“”‘’()（）【】[\]{}<>《》/\\|]+/g, '');
}

/** 该条线索最短多长才有意义（单字标签「好」「哦」命中一切文本，只会带来噪音）。 */
const MIN_ASSOC_CHARS = 2;

/**
 * 对一批叙事做联想匹配。
 *
 * @param {string} userText 本轮用户原话
 * @param {Array<object>} narratives 叙事池（store.narratives 原对象）
 * @param {{maxHits?:number, minChars?:number}} [opts]
 * @returns {Array<{narrative: object, kind: string, matched: string, weight: number}>}
 *          按 weight 降序；同一叙事只保留最强的一条
 */
export function matchAssociations(userText, narratives, opts = {}) {
    const list = Array.isArray(narratives) ? narratives : [];
    const text = normalizeForMatch(userText);
    if (!text || list.length === 0) return [];
    const maxHits = Math.max(1, Number(opts.maxHits) || 2);
    const minChars = Math.max(1, Number(opts.minChars) || MIN_ASSOC_CHARS);

    const best = new Map();
    for (const n of list) {
        if (!n || !n.id) continue;
        let candidate = null;

        // ① 专属梗/暗号：整句互相包含都算命中（她记的那句可能是「月落乌啼」，
        //    用户可能说「月落乌啼呀」，也可能是复述全句「月落乌啼霜满天」）
        const joke = typeof n.jokeTrigger === 'string' ? normalizeForMatch(n.jokeTrigger) : '';
        if (joke.length >= minChars && (text.includes(joke) || (joke.includes(text) && text.length >= minChars))) {
            candidate = { narrative: n, kind: ASSOCIATION_KINDS.joke, matched: n.jokeTrigger, weight: 2 };
        }

        // ② 联想线索词：命中多个词时按「命中数 + 最长词」给分，但不会盖过暗号
        if (!candidate) {
            const tags = Array.isArray(n.tags) ? n.tags : [];
            let hits = 0;
            let longest = '';
            for (const rawTag of tags) {
                if (typeof rawTag !== 'string') continue;
                const tag = normalizeForMatch(rawTag);
                if (tag.length < minChars) continue;
                if (text.includes(tag)) {
                    hits++;
                    if (tag.length > longest.length) longest = rawTag.trim();
                }
            }
            if (hits > 0) {
                candidate = {
                    narrative: n,
                    kind: ASSOCIATION_KINDS.tag,
                    matched: longest,
                    // 重要度参与微调：同为命中一个词，里程碑故事比弱信号更该被想起
                    weight: 1 + Math.min(hits - 1, 3) * 0.1 + (Number(n.importance) || 3) / 50,
                };
            }
        }

        if (!candidate) continue;
        const prev = best.get(n.id);
        if (!prev || candidate.weight > prev.weight) best.set(n.id, candidate);
    }

    return [...best.values()]
        .sort((a, b) => (b.weight - a.weight) || (b.narrative.importance - a.narrative.importance))
        .slice(0, maxHits);
}

/**
 * 命中结果 → 注入段能用的 Map（id → 说明），并把叙事按命中强度排在检索结果前面。
 *
 * @param {Array} hits matchAssociations 的返回
 * @param {Array} retrieved 检索层已有的相关叙事（原始对象）
 * @param {number} limit 注入总条数上限
 * @returns {{narratives: Array, notes: Map<string, string>}}
 */
export function mergeWithRetrieved(hits, retrieved, limit = 4) {
    const notes = new Map();
    const ordered = [];
    const seen = new Set();
    for (const hit of Array.isArray(hits) ? hits : []) {
        const n = hit?.narrative;
        if (!n || !n.id || seen.has(n.id)) continue;
        seen.add(n.id);
        ordered.push(n);
        notes.set(n.id, hit.kind === ASSOCIATION_KINDS.joke
            ? `她刚听到那句只有你们俩懂的话（${clip(hit.matched, 20)}），想起了这件事`
            : `她顺着「${clip(hit.matched, 12)}」想起了这件事`);
    }
    for (const n of Array.isArray(retrieved) ? retrieved : []) {
        if (!n || !n.id || seen.has(n.id)) continue;
        seen.add(n.id);
        ordered.push(n);
    }
    const cap = Math.max(1, Number(limit) || 1);
    return { narratives: ordered.slice(0, cap), notes };
}

/** 截断展示文本（注入段的字符预算很紧，线索词只留个开头就够她认出来了）。 */
function clip(text, max) {
    const s = String(text ?? '').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}
