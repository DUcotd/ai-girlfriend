/**
 * 立绘情绪映射表（从 CharacterPanel 拆出）。
 *
 * 立绘原图是 1024x1024 的 PNG，实际显示只有 192px 见方，
 * 已统一转成 512x512 的 WebP（单张 16~18KB）。
 * 7 种情绪（EmotionKey）现已全部配有立绘，emoji 仅作加载失败时的回退。
 */
export const emotionImages: Record<string, string> = {
    default: "/characters/default.webp",
    happy: "/characters/happy.webp",
    shy: "/characters/shy.webp",
    thinking: "/characters/thinking.webp",
    sleepy: "/characters/sleepy.webp",
    sad: "/characters/sad.webp",
    angry: "/characters/angry.webp",
};

export const emotionEmojis: Record<string, string> = {
    default: "😊",
    happy: "😆",
    shy: "😳",
    thinking: "🤔",
    sleepy: "😴",
    sad: "😢",
    angry: "😤",
};

/** 立绘支持的情绪种类（必须有对应图片与 emoji/label） */
export type EmotionKey = keyof typeof emotionImages;

export const EMOTION_ORDER: EmotionKey[] = ["default", "happy", "shy", "thinking", "sleepy", "sad", "angry"];

export const emotionLabels: Record<string, string> = {
    default: "开心",
    happy: "超开心",
    shy: "害羞",
    thinking: "思考中",
    sleepy: "困困的",
    sad: "难过",
    angry: "傲娇",
};

const emotionMap: Record<string, string> = {
    // 正面
    "开心": "happy", "狂喜": "happy", "兴奋": "happy", "亢奋": "happy",
    "满足": "default", "平静": "default",
    // 害羞/顺从
    "害羞": "shy", "羞涩": "shy", "撒娇": "shy", "依赖": "shy",
    // 思考/强势
    "思考": "thinking", "强势": "thinking", "焦虑": "thinking",
    // 困倦
    "困": "sleepy", "困倦": "sleepy",
    // 负面
    "难过": "sad", "伤心": "sad", "抑郁": "sad", "低落": "sad",
    // 愤怒/傲娇（立绘为傲娇式鼓脸，非真愤怒）
    "生气": "angry", "愤怒": "angry", "暴躁": "angry", "烦躁": "angry", "傲娇": "angry",
    // 兼容旧标签
    "default": "default", "happy": "happy", "shy": "shy",
    "thinking": "thinking", "sleepy": "sleepy", "sad": "sad", "angry": "angry",
    "pleasant": "default", "friendly": "default",
};

/** 把后端返回的情绪标签映射到立绘支持的情绪种类 */
export function normalizeEmotion(emotion: string): EmotionKey {
    return (emotionMap[emotion] || (emotionImages[emotion] ? emotion : "default")) as EmotionKey;
}
