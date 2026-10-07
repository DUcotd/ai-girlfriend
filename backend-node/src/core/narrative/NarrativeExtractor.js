/**
 * NarrativeExtractor - 关系叙事抽取层（REQ-03）。
 *
 * 定位（docs/companion-upgrade/02-architecture.md REQ-03 §2.3.3）：
 *   maybeExtract(userInput, replyText, ctx) -> { extracted, ops }
 *   复用 FactExtractor 的「主 LLM + JSON ops + 容错解析」范式（低温度、纯 JSON、剥栅栏），
 *   但语义不同（关系事件 vs 单方事实），故独立实现而不复用类本身。
 *
 * 三层节流（关键，防 LLM 成本失控，见 §2.3.1）——**三者全满足才调 LLM**：
 *   ① 轮次节流：每 config.narrative.extractEveryNTurns 轮尝试一次；
 *   ② 时间窗节流：距上次抽取 ≥ config.narrative.minIntervalMs；
 *   ③ 信号节流：本轮命中「关键信号」（第一次/约定/纪念日词、专属梗词、
 *      好感度跃迁或用户情绪强转折——后两者由调用方以结构化 ctx 传入）。
 *
 * ⚠️ 本层只做「判定 + 调 LLM + 解析」，不做状态写入；写入由 AiGirlfriend 走 store 完成，
 *    保证叙事层与记忆层一样，写操作集中、可审计。
 */
import { config } from '../../config.js';
import {
    EXTRACT_NARRATIVE_SYSTEM_PROMPT, normalizeNarrativeType, clampImportance,
    hasNarrativeSignal,
} from './narrativeTypes.js';
import { resolveNarrativeDate, DATE_SOURCE } from './narrativeDate.js';

/**
 * 联想线索标签的统一裁剪（add / update 两条路共用，避免一处放宽一处收紧）。
 * @param {unknown} raw
 * @returns {string[]}
 */
function clampTags(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => t.trim().slice(0, 20))
        .slice(0, 8);
}

/** 专属梗触发语裁剪；非字符串/空白 → null。 */
function clampJokeTrigger(raw) {
    return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 40) : null;
}

/**
 * 解析 LLM 输出的叙事操作（容错：剥代码栅栏、截取首尾大括号、字段校验）。
 * 契约与 FactExtractor.parseFactOps 同款，字段按叙事 schema 校验。
 * @param {string} raw
 * @returns {{add: Array, update: Array, delete: string[]}}
 */
export function parseNarrativeOps(raw) {
    const result = { add: [], update: [], delete: [] };
    if (!raw || typeof raw !== 'string') return result;

    let text = raw.trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) text = fenced[1].trim();

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return result;

    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
        return result;
    }

    if (Array.isArray(parsed.add)) {
        result.add = parsed.add.filter((item) =>
            item && typeof item === 'object'
            && (typeof item.summary === 'string' && item.summary.trim()
                || typeof item.title === 'string' && item.title.trim())
        );
    }
    if (Array.isArray(parsed.update)) {
        result.update = parsed.update.filter((item) =>
            item && typeof item.id === 'string' && item.id
            && typeof item.summary === 'string' && item.summary.trim()
        );
    }
    if (Array.isArray(parsed.delete)) {
        result.delete = parsed.delete.filter((id) => typeof id === 'string' && id);
    }
    return result;
}

export class NarrativeExtractor {
    /**
     * @param {object} opts
     * @param {() => ({client: object, model: string}|null)} opts.getClient 主 LLM 客户端供给
     * @param {import('./NarrativeStore.js').NarrativeStore} opts.store 用于读现有叙事与节流统计
     */
    constructor({ getClient, store }) {
        this.getClient = getClient;
        this.store = store;
    }

    /**
     * 三层节流判定：三者**全满足**才返回 true。
     *
     * @param {number} turnCount 当前累计轮次（由调用方维护）
     * @param {object} ctx { affinityDelta, userEmotionTurned, isCritical }
     * @returns {{ok:boolean, reason:string, signal:string}}
     */
    shouldExtract(turnCount, ctx = {}) {
        const n = config.narrative;
        if (!n.enabled) return { ok: false, reason: 'disabled', signal: '' };

        // ① 轮次节流
        if (!Number.isFinite(turnCount) || turnCount <= 0) {
            return { ok: false, reason: 'no-turn', signal: '' };
        }
        if (turnCount % n.extractEveryNTurns !== 0) {
            return { ok: false, reason: 'turn-gate', signal: '' };
        }

        // ② 时间窗节流
        const lastAt = this.store?.stats?.lastExtractAt || 0;
        const elapsed = Date.now() - lastAt;
        if (lastAt > 0 && elapsed < n.minIntervalMs) {
            return { ok: false, reason: 'interval-gate', signal: '' };
        }

        // ③ 信号节流
        const signal = this._detectSignal(ctx);
        if (!signal) {
            return { ok: false, reason: 'no-signal', signal: '' };
        }
        return { ok: true, reason: 'ok', signal };
    }

    /**
     * 检测关键信号：优先结构化信号（情绪强转折 / 好感度跃迁），否则查表的关键信号。
     * @param {object} ctx
     * @returns {string} 命中信号名；空串 = 无信号
     */
    _detectSignal(ctx = {}) {
        if (ctx.isCritical) return 'critical';
        if (ctx.userEmotionTurned) return 'user-emotion-turn';
        if (Number.isFinite(ctx.affinityDelta)
            && Math.abs(ctx.affinityDelta) >= config.narrative.affinityJumpThreshold) {
            return 'affinity-jump';
        }
        if (hasNarrativeSignal(ctx.text)) return 'keyword';
        return '';
    }

    /**
     * 执行抽取。节流未通过则**不调 LLM**，直接返回 { extracted:false, ops:空 }。
     * 网络/解析失败向上抛（由调用队列记日志，下轮自然重试）。
     *
     * @param {string} userInput
     * @param {string} replyText
     * @param {object} ctx { turnCount, affinityDelta, userEmotionTurned, isCritical }
     * @returns {Promise<{extracted:boolean, ops:{add:Array,update:Array,delete:string[]}, signal:string}>}
     */
    async maybeExtract(userInput, replyText, ctx = {}) {
        const empty = { add: [], update: [], delete: [] };
        const text = `${userInput || ''}\n${replyText || ''}`;
        const gate = this.shouldExtract(ctx.turnCount, { ...ctx, text });
        if (!gate.ok) {
            return { extracted: false, ops: empty, signal: gate.signal };
        }

        const provider = this.getClient ? this.getClient() : null;
        if (!provider || !provider.client) {
            return { extracted: false, ops: empty, signal: gate.signal };
        }

        const existing = (this.store?.narratives || [])
            .map((n) => `- [${n.id}] (${n.type}) ${n.title}：${n.summary}`)
            .join('\n');

        const messages = [
            { role: 'system', content: EXTRACT_NARRATIVE_SYSTEM_PROMPT },
            {
                role: 'user',
                content:
                    `现有故事：\n${existing || '（暂无）'}\n\n` +
                    `最新对话：\nUser: ${userInput}\nXiao Ai: ${replyText}\n\n` +
                    `请输出 JSON 操作。`,
            },
        ];

        const completion = await provider.client.chat.completions.create({
            model: config.narrative.extractModel || provider.model,
            messages,
            temperature: config.narrative.extractTemperature,
            max_tokens: config.narrative.extractMaxTokens,
        });

        const raw = completion.choices[0]?.message?.content;
        const ops = parseNarrativeOps(raw);
        return { extracted: true, ops, signal: gate.signal };
    }

    /**
     * 把 LLM 的 add 操作归一化成交付 store 的字段（类型/重要度/标题兜底）。
     * 纯函数，便于单测。
     * @param {object} add
     * @param {number} [now] 基准时间（ms）；解析「今天/三天前」这类相对说法要用它
     * @returns {object|null}
     */
    static normalizeAdd(add, now = Date.now()) {
        if (!add || typeof add !== 'object') return null;
        const summary = typeof add.summary === 'string' ? add.summary.trim() : '';
        const title = typeof add.title === 'string' ? add.title.trim() : '';
        if (!summary && !title) return null;
        // F-1：以前这里写的是 `Number.isFinite(add.occurredAt) ? add.occurredAt : Date.now()`，
        // 而 prompt 要模型给的是 "YYYY-MM-DD" **字符串** —— 字符串永远不是有限数，于是模型每次
        // 认真回答的日期都被丢掉，每条故事的发生日期都变成「抽取当天」，纪念日跟着一起错。
        const date = resolveNarrativeDate(add.occurredAt, { now });
        return {
            type: normalizeNarrativeType(add.type),
            title: title.slice(0, 20),
            summary,
            importance: clampImportance(add.importance, 3),
            recurring: add.recurring && typeof add.recurring === 'object' ? add.recurring : null,
            occurredAt: date.occurredAt,
            // 「这个日期是她记得的，还是她猜的」——透出来源，界面与 prompt 才不用假装确定
            occurredAtSource: date.source,
            // B2-10：这三个字段以前在抽取层被**整段丢掉**，于是 store 的 normalizeNarrative
            // 永远收到空值 —— 「写了没接线」的典型形状。现在 tags 与 jokeTrigger 已经是
            // **召回信号**（AssociationRecall：用户说到线索词/那句暗号 → 这条故事排到注入段第一），
            // sourceEpisodeId 仍只是**写路径**（记着「这事来自哪段对话」，回溯展示是下一轮的事，
            // 现在没有任何消费者，别把它当成已经能用）。
            tags: clampTags(add.tags),
            jokeTrigger: clampJokeTrigger(add.jokeTrigger),
            sourceEpisodeId: typeof add.sourceEpisodeId === 'string' && add.sourceEpisodeId.trim()
                ? add.sourceEpisodeId.trim()
                : null,
        };
    }

    /** 把 LLM 的 update 操作归一化成 store.updateNarrative 可用的 updates。 */
    /**
     * 把 LLM 的 update 操作归一化成 store.updateNarrative 可用的 updates。
     *
     * F-2：prompt 的 JSON 示例里明写了 `"update": [{..., "tags": [...]}]`，
     * 但这里过去只透 summary/title/importance/type/recurring —— 等于对着模型说
     * 「你可以改标签」，然后把改的丢掉。更要紧的是 occurredAt：她后来才想清楚
     * 「原来是 3 月 8 日，不是 3 月」的时候，没有任何一条路能把正确日期写回去。
     * @param {object} upd
     * @param {number} [now]
     * @returns {object|null}
     */
    static normalizeUpdate(upd, now = Date.now()) {
        if (!upd || typeof upd !== 'object' || typeof upd.id !== 'string' || !upd.id) return null;
        const updates = { id: upd.id };
        if (typeof upd.summary === 'string' && upd.summary.trim()) updates.summary = upd.summary.trim();
        if (typeof upd.title === 'string' && upd.title.trim()) updates.title = upd.title.trim();
        if (upd.importance !== undefined) updates.importance = clampImportance(upd.importance, 3);
        if (upd.type !== undefined) updates.type = normalizeNarrativeType(upd.type);
        if (upd.recurring !== undefined) updates.recurring = upd.recurring;
        if (Array.isArray(upd.tags)) updates.tags = clampTags(upd.tags);
        if (upd.jokeTrigger !== undefined) updates.jokeTrigger = clampJokeTrigger(upd.jokeTrigger);
        if (upd.occurredAt !== undefined) {
            const date = resolveNarrativeDate(upd.occurredAt, { now });
            // 更新时解析失败 = 模型这次没说清 → **保持原日期**，不要用「今天」覆盖掉旧信息
            if (date.source !== DATE_SOURCE.fallback) {
                updates.occurredAt = date.occurredAt;
                updates.occurredAtSource = date.source;
            }
        }
        return updates;
    }
}

export default NarrativeExtractor;
