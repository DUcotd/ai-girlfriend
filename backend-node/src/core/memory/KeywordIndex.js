/**
 * KeywordIndex —— 关键词检索的**增量索引**（B8-1，审计 CORE-07）。
 *
 * 旧形状（改造前）：每次查询都从 episodes 现造一份 docs 数组、对**每一篇**重新分词，
 * df 再按「每词 × 每篇」扫一遍全库，idf 甚至写在文档循环**里面**。
 * 实测 500 条库 + 91 词查询 = 2 888 ms，而且它挂在请求路径上 await ——
 * 一条合法的长消息（chat.maxMessageLength=8000）就能把整个进程按住几十秒，
 * 主动消息轮询、在途流式全部停摆（无需并发的自我 DoS）。
 *
 * 现在的形状：
 *   - 每篇文档的分词结果（词频表 + 长度 + 词项集）按**文档 key** 存在索引里，
 *     文档没变就**永远不再重新分词**（请求路径上只做 Map 查找）。
 *   - df（词项 → 出现在多少篇文档里）在文档增删时增量维护，
 *     avgdl 用累计长度直接算，不再每轮扫全库。
 *   - idf 提到查询层：每个查询词项只算一次，而不是每篇文档各算一次。
 *   - 查询词项数有上限（config.memory.retrieval.maxQueryTerms），
 *     **只截查询、绝不截文档**（截查询丢的是最后一个词项，文档索引始终完整）。
 *
 * 记忆层（episodes）与叙事层（narratives）**共用这一份实现**：
 * 叙事层以前自己写了 `_keywordHits` / `_keywordScore` 两套小循环，每次候选都重新
 * 分词一遍 query、再 normalizeText 一遍候选文本，而且 `_keywordScore` 内部又调一次
 * `_keywordHits`（同一件事做两遍）。两处各写必然漂移，所以收敛到同一个索引 + 同一套打分。
 */
import { tokenize, tokenizeToMap } from './textSim.js';

/** 单篇文档的索引条目 */
function buildEntry(key, text) {
    const counts = tokenizeToMap(text);
    let length = 0;
    for (const n of counts.values()) length += n;
    return { key, text, counts, length, terms: [...counts.keys()] };
}

export class KeywordIndex {
    /**
     * @param {string} [label] 日志用名字
     */
    constructor(label = 'keyword') {
        this.label = label;
        /** key → 文档条目（Map 保持插入顺序，遍历时与库顺序一致） */
        this.entries = new Map();
        /** term → 出现在多少篇文档中 */
        this.df = new Map();
        this.docCount = 0;
        this.totalLen = 0;
        /** 观测计数：断言「第二次同样的查询不会重新分词」用的就是这两个数 */
        this.tokenizeCalls = 0;
        this.entryHits = 0;
        this.syncs = 0;
        this._version = null;
    }

    /**
     * 与文档列表对齐。
     *
     * @param {Array<{id?:string, text:string}>} docs 文档（记忆=episode，叙事=narrative）
     * @param {{keyOf?:(d:object)=>string, textOf?:(d:object)=>string, version?:number}} [opts]
     *   version = 调用方（store）在**任何增删改**时自增的世代号。
     *   给了它就能走 O(1) 的「没变化」快路径；不给也没关系 —— 逐条按 key+text 比对，
     *   代价是 O(文档数) 次 Map 查找，**仍然不会重新分词未变化的文档**。
     */
    sync(docs, opts = {}) {
        this.syncs++;
        const list = Array.isArray(docs) ? docs : [];
        const keyOf = opts.keyOf || ((d) => String(d?.id ?? d?.text ?? ''));
        const textOf = opts.textOf || ((d) => String(d?.text ?? ''));
        const version = typeof opts.version === 'number' ? opts.version : null;

        // 快路径：世代号没变且条数一致 → 一个字节都不用碰
        if (version !== null && this._version === version && list.length === this.docCount) {
            return this;
        }
        this._version = version;

        const seen = new Set();
        for (const doc of list) {
            const key = keyOf(doc);
            const text = textOf(doc);
            const existing = this.entries.get(key);
            if (existing && existing.text === text) {
                this.entryHits++;
                seen.add(key);
                continue;
            }
            if (existing) this._remove(existing);
            this.tokenizeCalls++;
            const entry = buildEntry(key, text);
            this.entries.set(key, entry);
            this._add(entry);
            seen.add(key);
        }
        // 消失的文档（被裁掉/被删）：把它的词项从 df 里退掉
        if (this.entries.size > seen.size) {
            for (const key of [...this.entries.keys()]) {
                if (!seen.has(key)) {
                    this._remove(this.entries.get(key));
                    this.entries.delete(key);
                }
            }
        }
        return this;
    }

    _add(entry) {
        this.docCount++;
        this.totalLen += entry.length;
        for (const term of entry.terms) {
            this.df.set(term, (this.df.get(term) || 0) + 1);
        }
    }

    _remove(entry) {
        this.docCount--;
        this.totalLen -= entry.length;
        for (const term of entry.terms) {
            const n = (this.df.get(term) || 0) - 1;
            if (n <= 0) this.df.delete(term);
            else this.df.set(term, n);
        }
    }

    /** 某篇文档的分词统计（请求路径上只有 Map 查找，没有分词） */
    statsOf(key) {
        return this.entries.get(key) || null;
    }

    dfOf(term) {
        return this.df.get(term) || 0;
    }

    get avgdl() {
        return this.docCount > 0 ? this.totalLen / this.docCount : 1;
    }

    /** 观测计数快照（测试断言用；业务路径不读） */
    counters() {
        return {
            tokenizeCalls: this.tokenizeCalls,
            entryHits: this.entryHits,
            syncs: this.syncs,
            docs: this.docCount,
            vocab: this.df.size,
        };
    }

    /**
     * 查询预处理：切词 → 截断到 maxQueryTerms → **每个词项只算一次 idf**。
     * @param {string} query
     * @param {number} maxQueryTerms
     * @param {number} k1 BM25 k1（归一化峰值要用，一并给出）
     * @returns {Array<{term:string, idf:number}>}
     */
    prepareQuery(query, maxQueryTerms, k1 = 1.2) {
        const all = tokenize(query);
        if (all.length === 0 || this.docCount === 0) return [];
        // ⚠️ 只截查询：文档侧的索引是完整的，截掉的只是最后一个（信息量最低的）词项
        const terms = all.slice(0, Math.max(1, maxQueryTerms));
        const denom = Math.max(1, this.docCount);
        return terms.map((term) => {
            const d = this.dfOf(term);
            return { term, idf: Math.log(1 + (denom - d + 0.5) / (d + 0.5)) };
        });
    }
}

export default KeywordIndex;
