/**
 * MemoryStore - 记忆持久化存储层（schema v2）。
 *
 * 职责：
 * 1. memory.json 的读写与 v1 → v2 迁移（v1 是裸数组，每条为一轮对话原文）
 * 2. 两类数据的内存持有：episodes（情节=原始对话轮）+ facts（事实=提取的持久信息）
 * 3. 去抖异步落盘：对话每轮都会写情节，逐轮同步全量重写大 JSON 不可取；
 *    flushDebounceMs 内的多次写入合并成一次，进程退出由 facade.flush() 兜底
 *
 * 写入沿用 jsonStore 的「临时文件 + rename」原子写；文件损坏由 readJson 的
 * quarantine 机制隔离（改名保留现场），不会出现「损坏 → 读成空 → 写回覆盖」的静默清空。
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { dataPath, readJson, writeJson } from '../../utils/jsonStore.js';
import { config } from '../../config.js';

const DB_FILE = 'memory.json';
const V1_BACKUP_FILE = 'memory.json.v1.bak';

/**
 * v1 裸数组 → v2 episodes。
 * v1 每条：{ id, text, embedding, embeddingModel, metadata:{emotionSnapshot}, emotionSnapshot, timestamp }
 * v2 顶层只保留一份 emotionSnapshot（旧版 metadata 里是冗余双写，迁移时清除）。
 */
export function migrateV1ToV2(raw) {
    return raw
        .filter((e) => e && typeof e.text === 'string' && e.text.trim())
        .map((e) => ({
            id: e.id || uuidv4(),
            text: e.text,
            embedding: Array.isArray(e.embedding) ? e.embedding : null,
            embeddingModel: e.embeddingModel || null,
            emotionSnapshot: e.emotionSnapshot || e.metadata?.emotionSnapshot || null,
            timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now() / 1000,
        }));
}

/**
 * 事实库容量裁剪（纯函数，测试友好）：超出上限时先丢重要度最低、再丢最旧。
 */
export function capFacts(facts, max) {
    if (facts.length <= max) return facts;
    // 重要度升序在前、同分按 createdAt 旧在前；从头部开始丢
    const sorted = [...facts].sort((a, b) =>
        (a.importance - b.importance) || (a.createdAt - b.createdAt)
    );
    return sorted.slice(sorted.length - max);
}

export class MemoryStore {
    constructor() {
        this.episodes = [];
        this.facts = [];
        this._saveTimer = null;
        this._dirty = false;
        this._load();
    }

    _load() {
        const raw = readJson(DB_FILE, null);
        if (raw === null || raw === undefined) return;

        if (Array.isArray(raw)) {
            this.episodes = migrateV1ToV2(raw);
            this._backupV1();
            // 迁移结果立即落盘为 v2；失败也只在下次写入时重试，不阻塞启动
            this._dirty = true;
            this.flush();
            console.log(`[Memory] Migrated v1 memory.json → v2: ${this.episodes.length} episodes`);
            return;
        }

        if (raw.version === 2) {
            this.episodes = Array.isArray(raw.episodes) ? raw.episodes : [];
            this.facts = Array.isArray(raw.facts) ? raw.facts : [];
            console.log(`[Memory] Loaded ${this.episodes.length} episodes, ${this.facts.length} facts`);
            return;
        }

        console.warn(`[Memory] Unknown memory.json schema (version=${raw?.version}), starting fresh`);
    }

    /** v1 迁移前把原始文件备份一份，迁移逻辑若有缺陷可人工回滚 */
    _backupV1() {
        try {
            const src = dataPath(DB_FILE);
            const dest = dataPath(V1_BACKUP_FILE);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
            }
        } catch (e) {
            console.warn(`[Memory] v1 backup failed (continuing): ${e.message}`);
        }
    }

    /** 追加一条情节，超出上限丢最旧；不落盘（调用方 scheduleSave） */
    addEpisode({ text, embedding = null, embeddingModel = null, emotionSnapshot = null }) {
        this.episodes.push({
            id: uuidv4(),
            text,
            embedding,
            embeddingModel,
            emotionSnapshot: emotionSnapshot || null,
            timestamp: Date.now() / 1000,
        });
        if (this.episodes.length > config.memory.maxEpisodes) {
            this.episodes = this.episodes.slice(-config.memory.maxEpisodes);
        }
    }

    /** 追加事实；超出上限先丢重要度最低、再丢最旧 */
    addFact({ content, category = 'other', importance = 3, source = 'extracted', embedding = null, embeddingModel = null }) {
        this.facts.push({
            id: uuidv4(),
            content,
            category,
            importance,
            source,
            embedding,
            embeddingModel,
            createdAt: Date.now() / 1000,
            updatedAt: Date.now() / 1000,
        });
        this._capFacts();
    }

    _capFacts() {
        this.facts = capFacts(this.facts, config.memory.facts.maxFacts);
    }

    scheduleSave() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.flush();
        }, config.memory.flushDebounceMs);
    }

    /** 立即落盘（幂等；无待写数据时为空操作）。进程退出前必须调用 */
    flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        if (!this._dirty) return;
        this._dirty = false;
        writeJson(DB_FILE, {
            version: 2,
            episodes: this.episodes,
            facts: this.facts,
        });
    }
}
