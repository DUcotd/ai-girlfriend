/**
 * EmbeddingClient - 嵌入向量客户端（仅语义检索模式使用）。
 *
 * 嵌入只用来做「锦上添花」的语义检索：超时短、不重试，
 * 慢/挂了就立刻退回关键词模式，绝不拖慢对话主链路。
 */
import OpenAI from 'openai';
import { config } from '../../config.js';

/**
 * 厂商默认模型映射：部分网关不托管 openai 默认嵌入模型，按 baseUrl 自动纠正。
 * 旧的 if-hardcode 收敛成配置表，新增厂商只加一行。
 */
const VENDOR_MODEL_OVERRIDES = [
    { test: /siliconflow/i, model: 'BAAI/bge-large-zh-v1.5' },
];

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export class EmbeddingClient {
    /**
     * @param {object} opts 已解析的嵌入配置 { apiKey, baseUrl, model }
     */
    constructor({ apiKey, baseUrl, model } = {}) {
        this.apiKey = apiKey || null;
        this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/embeddings\/?$/, '');
        this.model = model || DEFAULT_EMBEDDING_MODEL;

        for (const override of VENDOR_MODEL_OVERRIDES) {
            if (override.test.test(this.baseUrl) && this.model === DEFAULT_EMBEDDING_MODEL) {
                this.model = override.model;
                break;
            }
        }

        this.client = null;
        if (this.apiKey) {
            this.init();
        }
    }

    init() {
        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseUrl,
            timeout: config.embedding.timeoutMs,
            maxRetries: config.embedding.maxRetries,
        });
    }

    /** 是否具备调用条件（有 Key 即视为可用；单次调用失败由 embed() 静默处理） */
    get available() {
        return !!this.client;
    }

    /** 配置热更新（字段缺省保留原值） */
    update({ apiKey, baseUrl, model } = {}) {
        if (apiKey) this.apiKey = apiKey;
        if (baseUrl) this.baseUrl = baseUrl.replace(/\/embeddings\/?$/, '');
        if (model) this.model = model;
        for (const override of VENDOR_MODEL_OVERRIDES) {
            if (override.test.test(this.baseUrl) && this.model === DEFAULT_EMBEDDING_MODEL) {
                this.model = override.model;
                break;
            }
        }
        if (this.apiKey && !this.client) {
            this.init();
        }
    }

    /** 文本 → 向量；无客户端或调用失败返回 null（调用方自行走关键词路径） */
    async embed(text) {
        if (!this.client) return null;
        try {
            const response = await this.client.embeddings.create({
                model: this.model,
                input: text,
            });
            return response.data[0].embedding;
        } catch (e) {
            // 静默退化是有意设计，但至少要留一条日志，否则 key/模型配错永远无人知晓
            console.warn(`[Memory] embed failed (${e.status || 'no-status'}): ${e.message || e}`);
            return null;
        }
    }

    /** 余弦相似度；维度不匹配或零向量返回 0（换嵌入模型后旧向量即走这条路） */
    static cosineSimilarity(vecA, vecB) {
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
}
