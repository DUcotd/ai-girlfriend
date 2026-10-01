/**
 * 服务容器 - 集中创建并持有所有单例服务。
 * 路由层从这里取服务，不再各自实例化。
 */
import AiGirlfriend from '../core/AiGirlfriend.js';
import VoiceEngine from '../core/Voice.js';
import ProactiveEngine from '../core/ProactiveEngine.js';
import { migrateLegacyData } from '../utils/jsonStore.js';

// 先迁移旧版散落数据（<repo>/memory_db → backend-node/data），再初始化各服务
migrateLegacyData();

export const aiGirlfriend = new AiGirlfriend();
export const voiceEngine = { current: new VoiceEngine({}) };

export function updateVoiceEngine({ apiKey }) {
    voiceEngine.current.stop?.();
    voiceEngine.current = new VoiceEngine({ apiKey });
}

export const proactiveEngine = new ProactiveEngine(aiGirlfriend);

/** 优雅停机：清理所有后台定时器，并把记忆去抖中的待写数据立即落盘 */
export function shutdownServices() {
    proactiveEngine.stop();
    voiceEngine.current.stop?.();
    try {
        aiGirlfriend.memory?.flush();
    } catch (e) {
        console.error(`[Container] Memory flush on shutdown failed: ${e.message}`);
    }
}
