/**
 * FactExtractor - 事实记忆提取层。
 *
 * 每轮对话结束后（后台、串行队列）把最新一轮交给主 LLM，让它对照现有事实库
 * 输出 add/update/delete 操作，只沉淀持久性信息（身份/偏好/人际/约定/重要事件）。
 *
 * 该层走主对话客户端，与嵌入模型无关：事实注入按重要度常驻 prompt，
 * 嵌入只用于事实的语义去重（无嵌入时退化为文本包含判断），
 * 因此「不使用嵌入模型」的方案 B 下事实记忆同样完整可用。
 */
import { config } from '../../config.js';
import { EmbeddingClient } from './EmbeddingClient.js';
import { normalizeText } from './textSim.js';

export const EXTRACT_SYSTEM_PROMPT = `你是虚拟角色的记忆管理器，负责维护「关于用户」的长期事实库。

**只提取持久性信息**（这些值得长期记住）：
- 身份：称呼、姓名、职业、生日、所在地
- 喜好与厌恶：明确表达的 likes/dislikes
- 人际关系：家人、朋友、宠物及其情况
- 生活习惯：作息、爱好、日常安排
- 约定与承诺：答应过用户的事、用户答应的事
- 重要事件：对用户情绪或关系有实质影响的事
- 稳定观点：用户明确表达的立场

**不要提取**：寒暄闲聊、一次性情绪反应、对话的措辞细节、你（角色）自己的回复内容。

**规则**：
1. 每条事实一句话、第三人称、具体明确（"用户喜欢玩原神"，而不是"用户玩游戏"）
2. 与现有事实矛盾 → 用 update 覆盖对应 id（信息变了就算矛盾，如"不喜欢香菜"→"能接受香菜"）
3. 与现有事实语义重复 → 不要重复 add
4. importance 1-5：5=核心身份/重大承诺，4=明确喜好/重要事件，3=一般偏好/日常事实，2=弱信号，1=不确定的传闻
5. category 取值：identity | preference | relationship | habit | promise | event | opinion | other
6. 本轮没有任何值得记的信息时，输出空操作
7. 只输出 JSON，不要输出任何其他文字：{"add": [{"content": "...", "category": "...", "importance": 3}], "update": [{"id": "...", "content": "...", "category": "...", "importance": 3}], "delete": ["id"]}`;

/**
 * 解析 LLM 输出的事实操作（容错：剥代码栅栏、截取首尾大括号、字段校验）。
 * @returns {{add: Array, update: Array, delete: string[]}}
 */
export function parseFactOps(raw) {
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
        result.add = parsed.add.filter((f) => f && typeof f.content === 'string' && f.content.trim());
    }
    if (Array.isArray(parsed.update)) {
        result.update = parsed.update.filter(
            (f) => f && typeof f.id === 'string' && f.id && typeof f.content === 'string' && f.content.trim()
        );
    }
    if (Array.isArray(parsed.delete)) {
        result.delete = parsed.delete.filter((id) => typeof id === 'string' && id);
    }
    return result;
}

const CATEGORY_VALUES = new Set(['identity', 'preference', 'relationship', 'habit', 'promise', 'event', 'opinion', 'other']);

export function normalizeCategory(category) {
    return CATEGORY_VALUES.has(category) ? category : 'other';
}

export function clampImportance(importance) {
    const n = Number(importance);
    if (!Number.isFinite(n)) return 3;
    return Math.min(5, Math.max(1, Math.round(n)));
}

export class FactExtractor {
    /**
     * @param {object} opts
     * @param {() => ({client: object, model: string}|null)} opts.getClient 主 LLM 客户端供给
     */
    constructor({ getClient }) {
        this.getClient = getClient;
    }

    /**
     * 提取一轮对话的事实操作。网络/解析失败向上抛（由调用队列记日志，下轮自然重试）。
     *
     * @returns {{add: Array, update: Array, delete: string[]}}
     */
    async extractOps(userInput, replyText, facts) {
        const provider = this.getClient ? this.getClient() : null;
        if (!provider || !provider.client) {
            return { add: [], update: [], delete: [] };
        }

        const existingFacts = (facts || [])
            .map((f) => `- [${f.id}] ${f.content}`)
            .join('\n');

        const messages = [
            { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
            {
                role: 'user',
                content:
                    `现有事实：\n${existingFacts || '（暂无）'}\n\n` +
                    `最新对话：\nUser: ${userInput}\nXiao Ai: ${replyText}\n\n` +
                    `请输出 JSON 操作。`,
            },
        ];

        const completion = await provider.client.chat.completions.create({
            model: config.memory.facts.extractModel || provider.model,
            messages,
            temperature: config.memory.facts.extractTemperature,
            max_tokens: 800,
        });

        return parseFactOps(completion.choices[0]?.message?.content);
    }

    /**
     * 事实语义去重：与任一既有事实余弦超阈值，或归一化后互为包含，视为重复。
     * 嵌入不可用时只用文本判断（方案 B 路径）。
     */
    static isDuplicateFact(newContent, newEmbedding, facts) {
        const normalized = normalizeText(newContent);
        const threshold = config.memory.dedupWriteSimilarity;
        return (facts || []).some((f) => {
            const nf = normalizeText(f.content);
            if (nf && (nf === normalized || nf.includes(normalized) || normalized.includes(nf))) {
                return true;
            }
            if (newEmbedding && f.embedding) {
                return EmbeddingClient.cosineSimilarity(newEmbedding, f.embedding) > threshold;
            }
            return false;
        });
    }
}
