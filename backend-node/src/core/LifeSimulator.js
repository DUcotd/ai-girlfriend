import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';

const LOG_FILE = 'life_log.json';

/**
 * 生活模拟器 - 模拟AI女友的日常活动
 *
 * 功能特点：
 * - 基于时间段的活动调度
 * - 活动历史记录（最近24小时）
 * - 持久化保存
 * - 支持用户回来时的"欢迎"消息素材
 */
class LifeSimulator {
    constructor() {
        this.logPath = dataPath(LOG_FILE);

        // 当前活动状态
        this.currentActivity = null;
        this.activityStartTime = null;

        // 活动历史（最近24小时）
        this.activityHistory = [];

        // 活动持续时间范围（分钟）
        this.activityDuration = { min: 15, max: 60 };

        // 基于时间段的活动池
        this.activityPools = {
            // 早晨 6:00-9:00
            morning: [
                { activity: '刚睡醒在赖床', emoji: '😴', mood: 'sleepy' },
                { activity: '洗漱准备新的一天', emoji: '🪥', mood: 'default' },
                { activity: '做早餐', emoji: '🍳', mood: 'happy' },
                { activity: '吃早餐看新闻', emoji: '📺', mood: 'default' },
                { activity: '听晨间音乐', emoji: '🎵', mood: 'happy' },
                { activity: '在阳台晒太阳', emoji: '☀️', mood: 'happy' },
            ],
            // 上午 9:00-12:00
            forenoon: [
                { activity: '在看书', emoji: '📖', mood: 'thinking' },
                { activity: '做瑜伽', emoji: '🧘', mood: 'default' },
                { activity: '整理房间', emoji: '🧹', mood: 'default' },
                { activity: '学习新东西', emoji: '💻', mood: 'thinking' },
                { activity: '和猫咪玩', emoji: '🐱', mood: 'happy' },
                { activity: '在窗边发呆', emoji: '🌸', mood: 'default' },
            ],
            // 中午 12:00-14:00
            noon: [
                { activity: '做午饭', emoji: '🍜', mood: 'default' },
                { activity: '吃午饭', emoji: '🍱', mood: 'happy' },
                { activity: '午睡中', emoji: '😴', mood: 'sleepy' },
                { activity: '刷手机', emoji: '📱', mood: 'default' },
                { activity: '听播客', emoji: '🎧', mood: 'thinking' },
            ],
            // 下午 14:00-18:00
            afternoon: [
                { activity: '看电影', emoji: '🎬', mood: 'happy' },
                { activity: '在画画', emoji: '🎨', mood: 'thinking' },
                { activity: '喝下午茶', emoji: '☕', mood: 'happy' },
                { activity: '弹钢琴', emoji: '🎹', mood: 'default' },
                { activity: '在阳台看风景', emoji: '🌆', mood: 'default' },
                { activity: '写日记', emoji: '📝', mood: 'thinking' },
                { activity: '逛网店', emoji: '🛒', mood: 'happy' },
            ],
            // 傍晚 18:00-20:00
            evening: [
                { activity: '做晚饭', emoji: '🍲', mood: 'default' },
                { activity: '吃晚饭', emoji: '🍽️', mood: 'happy' },
                { activity: '看日落', emoji: '🌅', mood: 'default' },
                { activity: '出门散步', emoji: '🚶', mood: 'happy' },
                { activity: '浇花', emoji: '🌷', mood: 'default' },
            ],
            // 晚上 20:00-23:00
            night: [
                { activity: '追剧中', emoji: '📺', mood: 'happy' },
                { activity: '在看小说', emoji: '📚', mood: 'thinking' },
                { activity: '敷面膜', emoji: '💆', mood: 'happy' },
                { activity: '和朋友视频聊天', emoji: '📞', mood: 'happy' },
                { activity: '练习烘焙', emoji: '🧁', mood: 'happy' },
                { activity: '听轻音乐放松', emoji: '🎶', mood: 'default' },
            ],
            // 深夜 23:00-6:00
            lateNight: [
                { activity: '准备睡觉了', emoji: '🌙', mood: 'sleepy' },
                { activity: '在听助眠音乐', emoji: '🎵', mood: 'sleepy' },
                { activity: '在回忆今天的事', emoji: '💭', mood: 'thinking' },
                { activity: '已经睡着了~', emoji: '😴', mood: 'sleepy' },
                { activity: '做美梦中', emoji: '💤', mood: 'sleepy' },
            ],
        };

        // 检查间隔（毫秒）
        this.checkInterval = 60000; // 每分钟检查一次

        this.init();
    }

    init() {
        // 加载历史记录
        this.loadState();

        // 如果没有当前活动，开始一个新的
        if (!this.currentActivity) {
            this.startNewActivity();
        }

        // 启动定时检查
        this.startSimulation();

        console.log('[LifeSimulator] Initialized with activity:', this.currentActivity?.activity);
    }

    loadState() {
        const data = readJson(LOG_FILE, null);
        if (!data) {
            this.activityHistory = [];
            return;
        }

        this.activityHistory = data.history || [];

        // 恢复当前活动（如果还在有效期内）
        // currentStart 也要一并校验：缺失/非法时 new Date() 会得到 Invalid Date，
        // 后续 toISOString() 抛 RangeError 且在定时器回调里变成进程崩溃
        if (data.current && data.currentEnd && data.currentStart) {
            const startTime = new Date(data.currentStart);
            const endTime = new Date(data.currentEnd);
            if (!Number.isNaN(startTime.getTime()) && !Number.isNaN(endTime.getTime()) && Date.now() < endTime.getTime()) {
                this.currentActivity = data.current;
                this.activityStartTime = startTime;
                this.activityEndTime = endTime;
            }
        }

        // 清理超过24小时的历史
        this.cleanOldHistory();
    }

    saveState() {
        return writeJson(LOG_FILE, {
            current: this.currentActivity,
            currentStart: this.activityStartTime?.toISOString(),
            currentEnd: this.activityEndTime?.toISOString(),
            history: this.activityHistory,
            lastUpdated: new Date().toISOString()
        });
    }

    /**
     * 清生活日志（「完全重置」的一步，审计 B0-5）。
     * 当前活动会由定时器在下一个周期重新抽取，因此不需要额外处理。
     * @returns {boolean} 是否落盘成功
     */
    resetLog() {
        this.activityHistory = [];
        this.currentActivity = null;
        this.activityStartTime = null;
        this.activityEndTime = null;
        return this.saveState();
    }

    cleanOldHistory() {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        this.activityHistory = this.activityHistory.filter(h =>
            new Date(h.endTime || h.startTime).getTime() > oneDayAgo
        );
    }

    getTimePeriod() {
        const hour = new Date().getHours();
        if (hour >= 6 && hour < 9) return 'morning';
        if (hour >= 9 && hour < 12) return 'forenoon';
        if (hour >= 12 && hour < 14) return 'noon';
        if (hour >= 14 && hour < 18) return 'afternoon';
        if (hour >= 18 && hour < 20) return 'evening';
        if (hour >= 20 && hour < 23) return 'night';
        return 'lateNight';
    }

    startNewActivity() {
        // 记录上一个活动到历史
        if (this.currentActivity) {
            this.activityHistory.push({
                ...this.currentActivity,
                startTime: this.activityStartTime?.toISOString(),
                endTime: new Date().toISOString()
            });
        }

        // 选择新活动
        const period = this.getTimePeriod();
        const pool = this.activityPools[period];

        // 避免连续重复同一活动
        let newActivity;
        let attempts = 0;
        do {
            newActivity = pool[Math.floor(Math.random() * pool.length)];
            attempts++;
        } while (
            this.currentActivity?.activity === newActivity.activity &&
            attempts < 5 &&
            pool.length > 1
        );

        this.currentActivity = newActivity;
        this.activityStartTime = new Date();

        // 随机持续时间
        const duration = this.activityDuration.min +
            Math.random() * (this.activityDuration.max - this.activityDuration.min);
        this.activityEndTime = new Date(Date.now() + duration * 60 * 1000);

        this.cleanOldHistory();
        this.saveState();

        console.log(`[LifeSimulator] New activity: ${newActivity.emoji} ${newActivity.activity} (until ${this.activityEndTime.toLocaleTimeString()})`);
    }

    startSimulation() {
        if (this.interval) clearInterval(this.interval);

        this.interval = setInterval(() => {
            // 检查是否需要切换活动
            if (Date.now() >= this.activityEndTime?.getTime()) {
                this.startNewActivity();
            }

            // 检查时间段是否变化（如从上午变成中午）
            const currentPeriod = this.getTimePeriod();
            const activityPool = this.activityPools[currentPeriod];
            const isActivityInCurrentPeriod = activityPool.some(
                a => a.activity === this.currentActivity?.activity
            );

            // 如果当前活动不属于当前时间段，强制切换
            if (!isActivityInCurrentPeriod) {
                console.log('[LifeSimulator] Time period changed, switching activity');
                this.startNewActivity();
            }
        }, this.checkInterval);

        console.log('[LifeSimulator] Simulation started');
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            console.log('[LifeSimulator] Simulation stopped');
        }
    }

    /**
     * 获取当前活动状态 —— **纯读**（审计 HTTP-13）。
     *
     * 旧实现在这里懒生成：`GET /life/current` 会调 startNewActivity() 并 saveState() 写盘，
     * 于是「看一眼她现在在干嘛」变成一次有副作用的请求（预取/重播/脚本都能触发，
     * 并且会把活动计时器悄悄重置）。活动的生成归定时器（startSimulation）独家负责，
     * 还没抽出第一条活动时如实回「在想事情」。
     */
    getCurrentActivity() {
        if (!this.currentActivity) {
            return {
                activity: '在想事情',
                emoji: '🌙',
                mood: null,
                since: null,
                duration: 0,
                period: this.getTimePeriod(),
            };
        }

        const now = Date.now();
        const duration = Math.floor((now - (this.activityStartTime?.getTime() ?? now)) / 60000);

        return {
            activity: this.currentActivity.activity,
            emoji: this.currentActivity.emoji,
            mood: this.currentActivity.mood,
            since: this.activityStartTime?.toISOString(),
            duration: duration, // 分钟
            period: this.getTimePeriod()
        };
    }

    /**
     * 获取活动历史
     * @param {number} hours - 获取最近几小时的历史
     */
    getActivityHistory(hours = 6) {
        const cutoff = Date.now() - hours * 60 * 60 * 1000;
        return this.activityHistory
            .filter(h => new Date(h.startTime).getTime() > cutoff)
            .map(h => ({
                activity: h.activity,
                emoji: h.emoji,
                startTime: h.startTime,
                endTime: h.endTime
            }));
    }

    /**
     * 获取欢迎回来消息的素材
     * @param {number} inactiveMinutes - 用户不活跃的分钟数
     */
    getWelcomeBackSummary(inactiveMinutes = 30) {
        const activities = [];

        // 获取不活跃期间的活动
        const cutoff = Date.now() - inactiveMinutes * 60 * 1000;
        const recentHistory = this.activityHistory.filter(h =>
            new Date(h.startTime).getTime() > cutoff
        );

        // 添加历史活动
        recentHistory.forEach(h => {
            activities.push(`${h.emoji} ${h.activity}`);
        });

        // 添加当前活动
        if (this.currentActivity) {
            activities.push(`${this.currentActivity.emoji} ${this.currentActivity.activity}`);
        }

        // 去重并限制数量
        const uniqueActivities = [...new Set(activities)].slice(-3);

        return {
            activities: uniqueActivities,
            currentActivity: this.currentActivity,
            inactiveMinutes,
            inactiveHours: Math.floor(inactiveMinutes / 60)
        };
    }
}

export default LifeSimulator;
