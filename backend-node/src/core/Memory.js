import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';

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
        this.openai = new OpenAI({
            apiKey: this.apiKey,
            baseURL: cleanBaseUrl
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
            if (e.status === 404) return null;
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
        const queryEmbedding = await this.getEmbedding(query);
        if (queryEmbedding) {
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

    _keywordSearch(query, nResults = 3) {
        const queryWords = new Set(query.toLowerCase().split(/\s+/));
        const scoredMemories = [];
        for (const mem of this.memories) {
            let score = 0;
            const textLower = mem.text.toLowerCase();
            queryWords.forEach(word => { if (textLower.includes(word)) score++; });
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
