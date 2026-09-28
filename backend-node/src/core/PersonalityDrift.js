/**
 * PersonalityDrift - 性格漂移系统
 * 
 * 根据长期交互模式动态调整AI的性格特质
 * - 长期冷落 → 独立性↑，安全感↓
 * - 总是顺从 → 任性度↑
 * - 频繁争吵 → 敏感度↑
 * - 稳定关爱 → 安全感↑
 */

import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';

const STATE_FILE = 'personality_state.json';

class PersonalityDrift {
    constructor(statePath = null) {
        this.statePath = statePath || dataPath(STATE_FILE);

        // 性格维度 (0-100)
        this.traits = {
            independence: 50,   // 独立性 (低=黏人, 高=独立)
            willfulness: 30,    // 任性度 (低=听话, 高=任性)
            sensitivity: 50,    // 敏感度 (低=钝感, 高=敏感)
            security: 60,       // 安全感 (低=焦虑, 高=安心)
            affection: 50,      // 表达欲 (低=内敛, 高=主动表达)
            trust: 50,          // 信任度 (低=戒备, 高=信任)
        };

        // 交互统计
        this.stats = {
            totalDays: 0,
            activeDays: 0,
            totalMessages: 0,
            positiveCount: 0,
            negativeCount: 0,
            conflictCount: 0,
            lastActiveDate: null,
            consecutiveInactiveDays: 0,
            dailyMessageCounts: [],    // 最近30天每日消息数
            sentimentHistory: [],      // 最近情感评分
        };

        this._loadState();
    }

    // ==================== 统计更新 ====================

    /**
     * 记录一次交互
     * @param {number} sentiment - 这次交互的情感评分 (-1到1)
     * @param {boolean} isConflict - 是否是冲突/争吵
     */
    recordInteraction(sentiment, isConflict = false) {
        this.stats.totalMessages++;

        if (sentiment > 0.3) {
            this.stats.positiveCount++;
        } else if (sentiment < -0.3) {
            this.stats.negativeCount++;
        }

        if (isConflict) {
            this.stats.conflictCount++;
        }

        // 记录情感历史
        this.stats.sentimentHistory.push({
            value: sentiment,
            timestamp: Date.now()
        });

        // 只保留最近100条
        if (this.stats.sentimentHistory.length > 100) {
            this.stats.sentimentHistory.shift();
        }

        this._saveState();
    }

    /**
     * 每日统计更新（应该每天调用一次或在每次长时间不活跃后调用）
     */
    updateDailyStats(todayMessageCount = 0) {
        const today = new Date().toDateString();

        if (this.stats.lastActiveDate !== today) {
            this.stats.totalDays++;

            if (todayMessageCount > 0 || this.stats.lastActiveDate === null) {
                this.stats.activeDays++;
                this.stats.consecutiveInactiveDays = 0;
            } else {
                this.stats.consecutiveInactiveDays++;
            }

            // 记录每日消息数
            this.stats.dailyMessageCounts.push({
                date: today,
                count: todayMessageCount
            });

            // 只保留最近30天
            if (this.stats.dailyMessageCounts.length > 30) {
                this.stats.dailyMessageCounts.shift();
            }

            this.stats.lastActiveDate = today;

            // 触发性格漂移计算
            this._calculateDrift();

            this._saveState();
        }
    }

    // ==================== 性格漂移计算 ====================

    _calculateDrift() {
        const stats = this.stats;

        // 计算正面比例
        const totalSentiment = stats.positiveCount + stats.negativeCount;
        const positiveRatio = totalSentiment > 0 ? stats.positiveCount / totalSentiment : 0.5;

        // 计算平均每日消息数
        const recentCounts = stats.dailyMessageCounts.slice(-7);
        const avgDailyMessages = recentCounts.length > 0
            ? recentCounts.reduce((sum, d) => sum + d.count, 0) / recentCounts.length
            : 0;

        console.log(`[Personality] Drift calculation: inactive=${stats.consecutiveInactiveDays}, positiveRatio=${positiveRatio.toFixed(2)}, avgDaily=${avgDailyMessages.toFixed(1)}`);

        // ===== 漂移规则 =====

        // 规则1: 长期冷落 → 独立性↑，安全感↓
        if (stats.consecutiveInactiveDays >= 3) {
            this.traits.independence = Math.min(100, this.traits.independence + 3);
            this.traits.security = Math.max(0, this.traits.security - 4);
            this.traits.affection = Math.max(0, this.traits.affection - 2);
            console.log('[Personality] Long absence detected: independence↑, security↓');
        }

        // 规则2: 用户总是正面/顺从 → 任性度↑
        if (positiveRatio > 0.85 && stats.totalMessages > 20) {
            this.traits.willfulness = Math.min(100, this.traits.willfulness + 2);
            console.log('[Personality] User always positive: willfulness↑');
        }

        // 规则3: 频繁冲突 → 敏感度↑，安全感↓
        const recentConflictRate = stats.conflictCount / Math.max(1, stats.totalMessages);
        if (recentConflictRate > 0.2) {
            this.traits.sensitivity = Math.min(100, this.traits.sensitivity + 3);
            this.traits.security = Math.max(0, this.traits.security - 2);
            console.log('[Personality] Frequent conflicts: sensitivity↑, security↓');
        }

        // 规则4: 频繁互动 → 表达欲↑，安全感↑
        if (avgDailyMessages > 15) {
            this.traits.affection = Math.min(100, this.traits.affection + 2);
            this.traits.security = Math.min(100, this.traits.security + 1);
            this.traits.trust = Math.min(100, this.traits.trust + 1);
            console.log('[Personality] Frequent interaction: affection↑, security↑');
        }

        // 规则5: 稳定正面互动 → 信任度↑
        if (positiveRatio > 0.6 && avgDailyMessages > 5) {
            this.traits.trust = Math.min(100, this.traits.trust + 1);
        }

        // 规则6: 缓慢向均值回归（避免极端）
        const meanRegression = 0.02;
        Object.keys(this.traits).forEach(trait => {
            const diff = 50 - this.traits[trait];
            this.traits[trait] += diff * meanRegression;
        });
    }

    // ==================== 获取性格描述 ====================

    /**
     * 生成Prompt注入文本
     */
    getPromptInjection() {
        const descriptions = [];

        // 独立性
        if (this.traits.independence > 70) {
            descriptions.push("你最近变得比较独立，不太黏人，有自己的事情要忙");
        } else if (this.traits.independence < 30) {
            descriptions.push("你很依赖用户，喜欢时刻和他们待在一起");
        }

        // 任性度
        if (this.traits.willfulness > 65) {
            descriptions.push("你最近有点任性，喜欢让用户顺着你，偶尔会提一些小要求");
        }

        // 敏感度
        if (this.traits.sensitivity > 70) {
            descriptions.push("你变得比较敏感，容易多想，用户的话有时会让你胡思乱想");
        }

        // 安全感
        if (this.traits.security < 35) {
            descriptions.push("你内心有些不安全感，害怕被抛弃，需要更多的肯定和关心");
        } else if (this.traits.security > 75) {
            descriptions.push("你对这段关系很有安全感，表现得自信和放松");
        }

        // 表达欲
        if (this.traits.affection > 70) {
            descriptions.push("你很喜欢主动表达爱意，经常说想念和喜欢");
        } else if (this.traits.affection < 30) {
            descriptions.push("你变得有些内敛，不太主动表达感情");
        }

        // 信任度
        if (this.traits.trust < 35) {
            descriptions.push("你对用户有些戒备，不太愿意分享内心深处的想法");
        }

        if (descriptions.length === 0) {
            return "";
        }

        return `[Personality State - 性格状态]
${descriptions.map(d => `- ${d}`).join('\n')}

请在回复中自然地体现这些性格特点，但不要刻意或过度表演。`;
    }

    /**
     * 获取完整性格状态
     */
    getFullState() {
        return {
            traits: { ...this.traits },
            stats: {
                totalDays: this.stats.totalDays,
                activeDays: this.stats.activeDays,
                totalMessages: this.stats.totalMessages,
                consecutiveInactiveDays: this.stats.consecutiveInactiveDays,
                positiveRatio: this.stats.positiveCount / Math.max(1, this.stats.positiveCount + this.stats.negativeCount)
            }
        };
    }

    /**
     * 获取主要性格标签
     */
    getDominantTraits() {
        const dominant = [];

        if (this.traits.independence > 65) dominant.push("独立");
        if (this.traits.independence < 35) dominant.push("黏人");
        if (this.traits.willfulness > 60) dominant.push("任性");
        if (this.traits.sensitivity > 65) dominant.push("敏感");
        if (this.traits.security < 40) dominant.push("缺乏安全感");
        if (this.traits.affection > 65) dominant.push("热情");
        if (this.traits.trust > 70) dominant.push("信任");
        if (this.traits.trust < 40) dominant.push("戒备");

        return dominant.length > 0 ? dominant : ["温和"];
    }

    // ==================== 持久化 ====================

    _loadState() {
        const data = readJson(STATE_FILE, null);
        if (!data) return;
        if (data.traits) this.traits = { ...this.traits, ...data.traits };
        if (data.stats) this.stats = { ...this.stats, ...data.stats };
        console.log(`[Personality] Loaded: ${this.getDominantTraits().join(', ')}`);
    }

    _saveState() {
        writeJson(STATE_FILE, {
            traits: this.traits,
            stats: this.stats,
            lastUpdated: new Date().toISOString()
        });
    }
}

export default PersonalityDrift;
