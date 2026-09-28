import TaskManager from './TaskManager.js';
import LifeSimulator from './LifeSimulator.js';

class ProactiveEngine {
    constructor(aiGirlfriend) {
        this.aiGirlfriend = aiGirlfriend;

        this.config = {
            enabled: true,
            frequencyLevel: 'medium',
            customDailyLimit: null,
            enabledTypes: [
                'morning_greeting', 'night_greeting', 'task_reminder',
                'random_chat', 'miss_you', 'mood_check', 'memory_share', 'life_update'
            ]
        };

        this.frequencyMultipliers = {
            low: { cooldown: 2.0, dailyLimit: 0.5 },
            medium: { cooldown: 1.0, dailyLimit: 1.0 },
            high: { cooldown: 0.7, dailyLimit: 1.5 }
        };

        this.messageQueue = [];
        this.maxQueueSize = 5;
        this.lastTriggerTime = Date.now();
        this.lastUserActiveTime = Date.now();
        this.checkInterval = 60000;

        this.baseTriggerCooldowns = {
            morning_greeting: 24 * 60 * 60 * 1000,
            night_greeting: 24 * 60 * 60 * 1000,
            task_reminder: 30 * 60 * 1000,
            random_chat: 2 * 60 * 60 * 1000,
            miss_you: 3 * 60 * 60 * 1000,
            mood_check: 4 * 60 * 60 * 1000,
            memory_share: 6 * 60 * 60 * 1000,
            life_update: 30 * 60 * 1000,
        };

        this.lastTriggerByType = {};
        this.dailyMessageCount = 0;
        this.lastDayReset = new Date().toDateString();
        this.lifeSimulator = new LifeSimulator();

        this.start();
    }

    updateConfig(newConfig) {
        if (typeof newConfig.enabled === 'boolean') this.config.enabled = newConfig.enabled;
        if (newConfig.frequencyLevel && ['low', 'medium', 'high'].includes(newConfig.frequencyLevel))
            this.config.frequencyLevel = newConfig.frequencyLevel;
        if (typeof newConfig.customDailyLimit === 'number' && newConfig.customDailyLimit >= 0)
            this.config.customDailyLimit = newConfig.customDailyLimit;
        else if (newConfig.customDailyLimit === null) this.config.customDailyLimit = null;
        if (Array.isArray(newConfig.enabledTypes))
            this.config.enabledTypes = newConfig.enabledTypes.filter(t =>
                Object.keys(this.baseTriggerCooldowns).includes(t));
        return this.config;
    }

    getConfig() { return { ...this.config }; }

    get triggerCooldowns() {
        const multiplier = this.frequencyMultipliers[this.config.frequencyLevel]?.cooldown || 1.0;
        const adjusted = {};
        for (const [type, baseCooldown] of Object.entries(this.baseTriggerCooldowns)) {
            if (type === 'morning_greeting' || type === 'night_greeting')
                adjusted[type] = baseCooldown;
            else
                adjusted[type] = Math.round(baseCooldown * multiplier);
        }
        return adjusted;
    }

    start() {
        if (this.interval) clearInterval(this.interval);
        this.interval = setInterval(() => this.check(), this.checkInterval);
        console.log("[ProactiveEngine] Started with enhanced triggers");
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.lifeSimulator) {
            this.lifeSimulator.stop();
        }
        console.log("[ProactiveEngine] Stopped");
    }

    notifyUserActive() {
        const inactiveTime = Date.now() - this.lastUserActiveTime;
        const wasInactive = inactiveTime > 30 * 60 * 1000;
        const inactiveMinutes = Math.floor(inactiveTime / (1000 * 60));
        this.lastUserActiveTime = Date.now();
        if (wasInactive && this.canTrigger('life_update')) {
            const lifeSummary = this.lifeSimulator.getWelcomeBackSummary(inactiveMinutes);
            this.trigger('life_update', {
                inactiveMinutes,
                activities: lifeSummary.activities,
                currentActivity: lifeSummary.currentActivity
            });
        }
    }

    canTrigger(type) {
        if (!this.config.enabledTypes.includes(type)) return false;
        const cooldown = this.triggerCooldowns[type] || 60 * 60 * 1000;
        const lastTrigger = this.lastTriggerByType[type] || 0;
        return (Date.now() - lastTrigger) >= cooldown;
    }

    // 分档阈值与 relationshipStages.js 的阶段边界一致（15/34/59/84）
    getAffinityBonus() {
        const affinity = this.aiGirlfriend.affinity || 35;
        if (affinity <= 15) return 0.5;
        if (affinity <= 34) return 0.8;
        if (affinity <= 59) return 1.0;
        if (affinity <= 84) return 1.3;
        return 1.6;
    }

    getDailyLimit() {
        if (this.config.customDailyLimit !== null) return this.config.customDailyLimit;
        const affinity = this.aiGirlfriend.affinity || 35;
        let baseLimit;
        if (affinity <= 15) baseLimit = 3;
        else if (affinity <= 34) baseLimit = 5;
        else if (affinity <= 59) baseLimit = 8;
        else if (affinity <= 84) baseLimit = 12;
        else baseLimit = 15;
        const multiplier = this.frequencyMultipliers[this.config.frequencyLevel]?.dailyLimit || 1.0;
        return Math.round(baseLimit * multiplier);
    }

    resetDailyCountIfNeeded() {
        const today = new Date().toDateString();
        if (today !== this.lastDayReset) {
            this.dailyMessageCount = 0;
            this.lastDayReset = today;
        }
    }

    async check() {
        if (!this.config.enabled) return;
        this.resetDailyCountIfNeeded();
        if (this.dailyMessageCount >= this.getDailyLimit()) return;

        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();

        if (minute >= 0 && minute <= 5) {
            if (hour === 8 && this.canTrigger('morning_greeting')) return this.trigger("morning_greeting");
            if (hour === 22 && this.canTrigger('night_greeting')) return this.trigger("night_greeting");
        }

        if (this.canTrigger('task_reminder')) {
            const dueSoon = TaskManager.getDueSoonTasks(15);
            if (dueSoon.length > 0) return this.trigger("task_reminder", { task: dueSoon[0] });
        }

        if ((hour === 15 || hour === 20) && minute >= 0 && minute <= 5) {
            if (this.canTrigger('mood_check')) return this.trigger("mood_check");
        }

        const inactiveTime = Date.now() - this.lastUserActiveTime;
        if (inactiveTime > 2 * 60 * 60 * 1000 && this.canTrigger('miss_you')) {
            const probability = 0.3 * this.getAffinityBonus();
            if (Math.random() < probability)
                return this.trigger("miss_you", { inactiveMinutes: Math.floor(inactiveTime / (1000 * 60)) });
        }

        if (this.aiGirlfriend.affinity >= 50 && this.canTrigger('memory_share')) {
            const probability = 0.15 * this.getAffinityBonus();
            if (Math.random() < probability) return this.trigger("memory_share");
        }

        if (minute === 0 || minute === 30) {
            const timeSinceLast = (Date.now() - this.lastTriggerTime) / (1000 * 60 * 60);
            if (timeSinceLast >= 1 && this.canTrigger('random_chat')) {
                const baseP = (this.aiGirlfriend.affinity / 200) + (timeSinceLast / 24);
                const p = baseP * this.getAffinityBonus();
                if (Math.random() < Math.min(p, 0.4)) return this.trigger("random_chat");
            }
        }
    }

    async trigger(reason, data = {}) {
        if (this.messageQueue.length >= this.maxQueueSize) return;
        try {
            const message = await this.aiGirlfriend.generateProactiveMessage(reason, data);
            if (message) {
                this.messageQueue.push({
                    id: Date.now().toString(),
                    content: message.reply,
                    emotion: message.emotion,
                    timestamp: new Date().toISOString(),
                    reason,
                    priority: this.getMessagePriority(reason)
                });
                this.messageQueue.sort((a, b) => b.priority - a.priority);
                this.lastTriggerTime = Date.now();
                this.lastTriggerByType[reason] = Date.now();
                this.dailyMessageCount++;
            }
        } catch (e) {
            console.error("[ProactiveEngine] Trigger failed:", e.message || e);
        }
    }

    getMessagePriority(reason) {
        const priorities = { task_reminder: 100, morning_greeting: 80, night_greeting: 80,
            mood_check: 60, miss_you: 50, memory_share: 40, random_chat: 30 };
        return priorities[reason] || 20;
    }

    consumeMessage() { return this.messageQueue.length > 0 ? this.messageQueue.shift() : null; }

    peekQueue() {
        return { size: this.messageQueue.length, messages: this.messageQueue.map(m => ({
            id: m.id, reason: m.reason, timestamp: m.timestamp })) };
    }

    getStatus() {
        return {
            config: this.getConfig(), queueSize: this.messageQueue.length,
            dailyMessagesSent: this.dailyMessageCount, dailyLimit: this.getDailyLimit(),
            lastTriggerTime: this.lastTriggerTime, lastUserActiveTime: this.lastUserActiveTime,
            affinityBonus: this.getAffinityBonus(), currentCooldowns: this.triggerCooldowns
        };
    }
}

export default ProactiveEngine;
