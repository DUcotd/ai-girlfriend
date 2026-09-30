import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';
import { config } from '../config.js';

dotenv.config();

const DB_FILE = 'memory.json';

class Memory {
    constructor(persistDirectory = "memory_db", config = {}) {
        // persistDirectory 仅为兼容保留；实际存储统一在 backend-node/data/memory.json
        this.dbPath = dataPath(DB_FILE);

        this.apiKey = config.embeddingApiKey || config.apiKey || null;
        this.baseUrl = config.embeddingBaseUrl || config.baseUrl || "https://api.openai.com/v1";
        this.embeddingModel = config.embeddingModelName || "text-embedding-3-small";

        if (this.baseUrl.includes("siliconflow") && this.embeddingModel === "text-embedding-3-small") {
            this.embeddingModel = "BAAI/bge-large-zh-v1.5";
        }

        this.openai = null;

        if (this.apiKey) {
            this.initOpenAI();
        }

        this.memories = this._load();
    }

    initOpenAI() {
        let cleanBaseUrl = this.baseUrl.replace(/\/embeddings\/?$/, "");
        // embedding 只用来做「锦上添花」的语义检索：
        // 超时短、不重试，慢/挂了就立刻回退关键词检索，绝不拖慢对话主链路。
        this.openai = new OpenAI({
            apiKey: this.apiKey,
            baseURL: cleanBaseUrl,
            timeout: config.embedding.timeoutMs,
            maxRetries: config.embedding.maxRetries,
        });
    }

    updateConfig(config) {
        if (config.embeddingApiKey) this.apiKey = config.embeddingApiKey;
        else if (config.apiKey) this.apiKey = config.apiKey;

        if (config.embeddingBaseUrl) this.baseUrl = config.embeddingBaseUrl;
        else if (config.baseUrl) this.baseUrl = config.baseUrl;

        if (config.embeddingModelName) this.embeddingModel = config.embeddingModelName;

        if (this.apiKey) {
            this.initOpenAI();
        }
    }

    _load() {
        return readJson(DB_FILE, []);
    }

    _save() {
        writeJson(DB_FILE, this.memories);
    }

    async getEmbedding(text) {
        if (!this.openai) return null;
        try {
            const response = await this.openai.embeddings.create({
                model: this.embeddingModel,
                input: text,
            });
            return response.data[0].embedding;
        } catch (e) {
            // 静默退化是有意设计，但至少要留一条日志，否则 key/模型配错永远无人知晓
            console.warn(`[Memory] getEmbedding failed (${e.status || 'no-status'}), falling back to keyword search: ${e.message || e}`);
            return null;
        }
    }

    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    async addMemory(text, metadata = null) {
        if (!text || !text.trim()) return;
        const embedding = await this.getEmbedding(text);
        const entry = {
            id: uuidv4(),
            text,
            embedding,
            // 记录生成向量用的模型：换模型后旧向量维度不匹配，靠这个字段才能发现并提示
            embeddingModel: embedding ? this.embeddingModel : null,
            metadata: metadata || { type: "conversation" },
            emotionSnapshot: metadata?.emotionSnapshot || null,
            timestamp: Date.now() / 1000
        };
        this.memories.push(entry);
        if (this.memories.length > 500) {
            this.memories = this.memories.slice(-500);
        }
        this._save();
    }

    async getRelevantContext(query, currentEmotion = null, nResults = 3) {
        if (!this.memories || this.memories.length === 0) return "";

        // 没有任何向量化的记忆时，语义检索无从谈起，
        // 直接走关键词检索，省掉一次 embedding 网络往返。
        const hasVectors = this.memories.some(m => m.embedding);
        if (!hasVectors) return this._keywordSearch(query, nResults);

        const queryEmbedding = await this.getEmbedding(query);
        if (queryEmbedding) {
            // 换过嵌入模型后，旧模型生成的向量维度不匹配、相似度恒为 0，
            // 这些记忆会静默退出语义检索——至少要给出一条可发现的警告
            const staleModels = new Set(
                this.memories
                    .filter(m => m.embedding && m.embeddingModel && m.embeddingModel !== this.embeddingModel)
                    .map(m => m.embeddingModel)
            );
            if (staleModels.size > 0 && !this._warnedStaleEmbedding) {
                this._warnedStaleEmbedding = true;
                console.warn(
                    `[Memory] ${staleModels.size} 个旧嵌入模型（${[...staleModels].join(', ')}）生成的历史记忆与当前模型` +
                    `（${this.embeddingModel}）不兼容，已无法参与语义检索；可清空记忆或换回原模型。`
                );
            }
            const scoredMemories = [];
            for (const mem of this.memories) {
                if (mem.embedding) {
                    const semanticScore = this.cosineSimilarity(queryEmbedding, mem.embedding);
                    let emotionScore = 0;
                    if (currentEmotion && mem.emotionSnapshot) {
                        emotionScore = this._emotionSimilarity(currentEmotion, mem.emotionSnapshot);
                    }
                    const emotionWeight = currentEmotion && currentEmotion.P < 0 ? 0.4 : 0.2;
                    const combinedScore = semanticScore + emotionScore * emotionWeight;
                    scoredMemories.push({ score: combinedScore, semanticScore, emotionScore, text: mem.text });
                }
            }
            if (scoredMemories.length > 0) {
                scoredMemories.sort((a, b) => b.score - a.score);
                const relevantMemories = scoredMemories.filter(m => m.semanticScore > 0.3).slice(0, nResults);
                if (relevantMemories.length > 0) {
                    return relevantMemories.map(m => m.text).join("\n");
                }
            }
        }
        return this._keywordSearch(query, nResults);
    }

    _emotionSimilarity(e1, e2) {
        if (!e1 || !e2) return 0;
        const pDiff = Math.abs((e1.P || 0) - (e2.P || 0));
        const aDiff = Math.abs((e1.A || 0) - (e2.A || 0));
        const dDiff = Math.abs((e1.D || 0) - (e2.D || 0));
        return 1 - (pDiff + aDiff + dDiff) / 6;
    }

    /**
     * 检索词切分。英文/数字按空白与词边界切；无空白的中日韩文本按字符二元组（bigram）切——
     * 否则整句只产生一个「词」，等价于全文精确子串匹配，中文记忆检索基本恒空。
     */
    _queryTerms(query) {
        const lower = query.toLowerCase().trim();
        if (!lower) return [];
        const terms = new Set();
        // 中英混排：连续 ASCII 片段整词保留，其余片段按 bigram 切
        const segments = lower.split(/([a-z0-9]+)/).filter(Boolean);
        for (const seg of segments) {
            if (/^[a-z0-9]+$/.test(seg)) {
                terms.add(seg);
                continue;
            }
            for (let i = 0; i < seg.length - 1; i++) {
                terms.add(seg.slice(i, i + 2));
            }
        }
        return [...terms];
    }

    _keywordSearch(query, nResults = 3) {
        const queryTerms = this._queryTerms(query);
        if (queryTerms.length === 0) return "";
        const scoredMemories = [];
        for (const mem of this.memories) {
            let score = 0;
            const textLower = mem.text.toLowerCase();
            queryTerms.forEach(term => { if (textLower.includes(term)) score++; });
            if (score > 0) scoredMemories.push({ score, text: mem.text });
        }
        scoredMemories.sort((a, b) => b.score - a.score);
        return scoredMemories.slice(0, nResults).map(m => m.text).join("\n");
    }

    getAllMemories() { return this.memories; }

    clearMemory() {
        this.memories = [];
        this._save();
    }
}

export default Memory;
