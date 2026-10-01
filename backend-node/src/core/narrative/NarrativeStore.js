/**
 * NarrativeStore - 关系叙事持久化存储层（REQ-03，schema v1）。
 *
 * 定位（docs/companion-upgrade/02-architecture.md REQ-03 §2.3.3）：
 *   持有 narratives[]（关系事件），读写 data/narrative.json，去抖异步落盘。
 *   对标 MemoryStore，但**独立存储、独立生命周期**：叙事是从 episodes 派生的下游产物，
 *   单独落 narrative.json 避免「派生数据污染事实源」；二者互不写入。
 *
 * 落盘策略：走去抖异步写盘（参照 MemoryStore.flushDebounceMs），
 *   禁止每轮同步全量重写 JSON；flush() 兜底，reset() 立即落盘。
 *
 * cap 裁剪：超出 config.narrative.maxNarratives 时，先丢重要度最低、再丢最旧
 *   （与 MemoryStore.capFacts 同口径：重要度升序在前、同分按 occurredAt 旧在前，从头丢）。
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { dataPath, readJson, writeJson } from '../../utils/jsonStore.js';
import { config } from '../../config.js';
import {
    normalizeNarrativeType, clampImportance, normalizeAnniversaryCycle,
    getTypeMeta,
} from './narrativeTypes.js';

const DB_FILE = 'narrative.json';
const SCHEMA_VERSION = 1;
const V1_BACKUP_FILE = 'narrative.json.bad.bak';

/**
 * 叙事容量裁剪（纯函数，测试友好）：超出上限时先丢重要度最低、再丢最旧。
 * @param {Array} narratives
 * @param {number} max
 * @returns {Array}
 */
export function capNarratives(narratives, max) {
    if (!Array.isArray(narratives) || narratives.length <= max) return narratives;
    // 重要度升序在前、同分按 occurredAt 旧在前；从头部开始丢
    const sorted = [...narratives].sort((a, b) =>
        (a.importance - b.importance) || ((a.occurredAt || 0) - (b.occurredAt || 0))
    );
    return sorted.slice(sorted.length - max);
}

/**
 * 归一化一条叙事记录（加载与写入共用），保证字段齐全、类型安全。
 * 非法/缺字段一律回退默认，绝不抛错——叙事层是「锦上添花」，不能因脏数据拖垮主链路。
 * @param {object} raw
 * @returns {object|null} 归一化后的叙事；无有效内容时返回 null
 */
export function normalizeNarrative(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const title = typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim().slice(0, 20)
        : '';
    if (!summary && !title) return null;

    const type = normalizeNarrativeType(raw.type);
    const now = Date.now();
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : uuidv4(),
        type,
        title: title || `我们的${getTypeMeta(type).labelZh}`,
        summary,
        occurredAt: Number.isFinite(raw.occurredAt) ? raw.occurredAt : now,
        sourceEpisodeId: typeof raw.sourceEpisodeId === 'string' ? raw.sourceEpisodeId : null,
        participants: Array.isArray(raw.participants) && raw.participants.length
            ? raw.participants.filter((p) => typeof p === 'string')
            : ['user', 'xiaoi'],
        importance: clampImportance(raw.importance, 3),
        recurring: normalizeRecurring(raw.recurring),
        jokeTrigger: typeof raw.jokeTrigger === 'string' ? raw.jokeTrigger : null,
        tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
        embedding: Array.isArray(raw.embedding) ? raw.embedding : null,
        embeddingModel: typeof raw.embeddingModel === 'string' ? raw.embeddingModel : null,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
        recallCount: Number.isFinite(raw.recallCount) ? raw.recallCount : 0,
        lastRecalledAt: Number.isFinite(raw.lastRecalledAt) ? raw.lastRecalledAt : null,
    };
}

/** 归一化 recurring 字段；非法/缺失返回 null（非纪念日类）。 */
function normalizeRecurring(recurring) {
    if (!recurring || typeof recurring !== 'object') return null;
    if (!recurring.isAnniversary) return null;
    const date = typeof recurring.anniversaryDate === 'string' ? recurring.anniversaryDate.trim() : '';
    // 必须是 MM-DD 格式，否则视为非法（避免日后按无效日期做纪念日匹配）
    if (!/^\d{2}-\d{2}$/.test(date)) return null;
    return {
        isAnniversary: true,
        anniversaryDate: date,
        anniversaryType: normalizeAnniversaryCycle(recurring.anniversaryType),
    };
}

export class NarrativeStore {
    constructor() {
        this.narratives = [];
        this.stats = { lastExtractTurn: 0, lastExtractAt: 0 };
        this._saveTimer = null;
        this._dirty = false;
        this._load();
    }

    // ==================== 读写 ====================

    /**
     * 追加一条叙事（内部已做归一化 + cap 裁剪）；不落盘（调用方 scheduleSave）。
     * @param {object} data 叙事字段（见 normalizeNarrative）
     * @returns {object} 实际写入的叙事对象
     */
    addNarrative(data) {
        const narrative = normalizeNarrative(data);
        if (!narrative) {
            // 无有效内容（title/summary 全空）——直接丢弃，不产生空占位记录
            return null;
        }
        this.narratives.push(narrative);
        this._capNarratives();
        return narrative;
    }

    /**
     * 更新一条叙事（按 id）；id 不存在返回 null。
     * 只覆盖传入的字段；embedding 由调用方在需要时另行处理。
     * @param {string} id
     * @param {object} updates
     * @returns {object|null}
     */
    updateNarrative(id, updates = {}) {
        const narrative = this.narratives.find((n) => n.id === id);
        if (!narrative) return null;

        if (updates.title !== undefined && typeof updates.title === 'string' && updates.title.trim()) {
            narrative.title = updates.title.trim().slice(0, 20);
        }
        if (updates.summary !== undefined && typeof updates.summary === 'string' && updates.summary.trim()) {
            narrative.summary = updates.summary.trim();
        }
        if (updates.type !== undefined) {
            narrative.type = normalizeNarrativeType(updates.type);
        }
        if (updates.importance !== undefined) {
            narrative.importance = clampImportance(updates.importance, narrative.importance);
        }
        if (updates.occurredAt !== undefined && Number.isFinite(updates.occurredAt)) {
            narrative.occurredAt = updates.occurredAt;
        }
        if (updates.recurring !== undefined) {
            narrative.recurring = normalizeRecurring(updates.recurring);
        }
        if (updates.jokeTrigger !== undefined && typeof updates.jokeTrigger === 'string') {
            narrative.jokeTrigger = updates.jokeTrigger;
        }
        if (Array.isArray(updates.tags)) {
            narrative.tags = updates.tags.filter((t) => typeof t === 'string');
        }
        if (updates.embedding !== undefined) {
            narrative.embedding = Array.isArray(updates.embedding) ? updates.embedding : null;
        }
        if (updates.embeddingModel !== undefined) {
            narrative.embeddingModel = typeof updates.embeddingModel === 'string'
                ? updates.embeddingModel : null;
        }
        narrative.updatedAt = Date.now();
        this._capNarratives();
        return narrative;
    }

    /**
     * 删除一条叙事（手动删除接口用，A7 默认不级联：删 episode 不自动删 narrative）。
     * @param {string} id
     * @returns {boolean} 是否命中删除
     */
    removeNarrative(id) {
        const idx = this.narratives.findIndex((n) => n.id === id);
        if (idx === -1) return false;
        this.narratives.splice(idx, 1);
        return true;
    }

    /** 按 id 查一条。 */
    getById(id) {
        return this.narratives.find((n) => n.id === id) || null;
    }

    /** 记录一次「被主动回顾」（防复读）并落盘调度。 */
    markRecalled(id, ts = Date.now()) {
        const narrative = this.narratives.find((n) => n.id === id);
        if (!narrative) return null;
        narrative.recallCount = (narrative.recallCount || 0) + 1;
        narrative.lastRecalledAt = ts;
        return narrative;
    }

    /** 更新抽取统计（供三层节流读取 lastExtractTurn / lastExtractAt）。 */
    setStats({ lastExtractTurn, lastExtractAt } = {}) {
        if (Number.isFinite(lastExtractTurn)) this.stats.lastExtractTurn = lastExtractTurn;
        if (Number.isFinite(lastExtractAt)) this.stats.lastExtractAt = lastExtractAt;
    }

    /** 全量清空（「完全重置」语义）；不落盘（调用方 flush/reset）。 */
    clear() {
        this.narratives = [];
        this.stats = { lastExtractTurn: 0, lastExtractAt: 0 };
    }

    _capNarratives() {
        this.narratives = capNarratives(this.narratives, config.narrative.maxNarratives);
    }

    // ==================== 持久化 ====================

    _load() {
        const raw = readJson(DB_FILE, null);
        if (raw === null || raw === undefined) return;

        if (raw.version === SCHEMA_VERSION || raw.version === undefined) {
            const list = Array.isArray(raw.narratives) ? raw.narratives : [];
            this.narratives = list.map(normalizeNarrative).filter(Boolean);
            if (raw.stats && typeof raw.stats === 'object') {
                this.setStats({
                    lastExtractTurn: Number.isFinite(raw.stats.lastExtractTurn) ? raw.stats.lastExtractTurn : 0,
                    lastExtractAt: Number.isFinite(raw.stats.lastExtractAt) ? raw.stats.lastExtractAt : 0,
                });
            }
            this._capNarratives();
            console.log(`[Narrative] Loaded ${this.narratives.length} narratives`);
            return;
        }

        console.warn(`[Narrative] Unknown narrative.json schema (version=${raw?.version}), starting fresh`);
        // 未知 schema：备份现场后从空开始，避免「读成空 → 写回覆盖」的静默清空
        this._backupBadSchema();
    }

    /** 未知 schema 前把原始文件备份一份，便于人工抢救。 */
    _backupBadSchema() {
        try {
            const src = dataPath(DB_FILE);
            const dest = dataPath(V1_BACKUP_FILE);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
            }
        } catch (e) {
            console.warn(`[Narrative] bad-schema backup failed (continuing): ${e.message}`);
        }
    }

    /** 去抖落盘：合并短时间内的多次写入（参照 MemoryStore）。 */
    scheduleSave() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.flush();
        }, config.narrative.flushDebounceMs);
    }

    /** 立即落盘（幂等；无待写数据时空操作）。进程退出前必须调用 */
    flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        if (!this._dirty) return;
        this._dirty = false;
        this._saveNow();
    }

    /** 无条件写盘（reset / 测试用）。 */
    _saveNow() {
        writeJson(DB_FILE, {
            version: SCHEMA_VERSION,
            narratives: this.narratives,
            stats: this.stats,
            lastUpdated: new Date().toISOString(),
        });
    }

    /** 全量导出（API 用）：剥离 embedding 大字段，按重要度→新近排序。 */
    getAll() {
        return {
            narratives: [...this.narratives]
                .sort((a, b) => (b.importance - a.importance) || (b.occurredAt - a.occurredAt))
                .map((n) => this.publicNarrative(n)),
            stats: { ...this.stats, total: this.narratives.length },
        };
    }

    /** 单条公开视图（剥离 embedding）。 */
    publicNarrative(n) {
        return {
            id: n.id,
            type: n.type,
            title: n.title,
            summary: n.summary,
            occurredAt: n.occurredAt,
            importance: n.importance,
            recurring: n.recurring,
            jokeTrigger: n.jokeTrigger,
            tags: n.tags,
            recallCount: n.recallCount,
            lastRecalledAt: n.lastRecalledAt,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
        };
    }
}

export default NarrativeStore;
