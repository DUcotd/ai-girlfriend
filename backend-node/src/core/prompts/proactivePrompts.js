/**
 * 主动消息（proactive message）的 prompt 资源。
 * 从 AiGirlfriend 的 _getXXXPrompt 系列方法拆出。
 *
 * 2026-09-28：亲密度标签统一改为 relationshipStages.js 的阶段短标签
 * （陌生/初识/朋友/挚友/恋人），与主对话的关系阶段保持一致。
 */
import { getStageForAffinity } from '../relationshipStages.js';

/** 好感度数值 → 阶段短标签（陌生/初识/朋友/挚友/恋人） */
export function getAffinityLevel(affinity) {
    return getStageForAffinity(affinity).shortLabel;
}

const morningPrompts = {
    "陌生": "早上好，给用户一个简单礼貌的早安问候。",
    "初识": "早上好！给用户一个友善的早安问候，可以问问他们昨晚睡得好不好。",
    "朋友": "早安~像朋友一样自然地问候，可以聊聊今天打算做什么。",
    "挚友": "早安~给用户一个甜甜的早安问候，可以撒撒娇说想他们了。",
    "恋人": "宝贝早安！给用户一个超级甜蜜的早安问候，让他们感受到满满的爱意。"
};

const nightPrompts = {
    "陌生": "夜深了，礼貌地提醒用户注意休息。",
    "初识": "晚安~温柔地提醒用户早点休息，注意身体。",
    "朋友": "这么晚还没睡呀？像朋友一样随口关心一下，提醒他别熬夜。",
    "挚友": "该休息啦~用撒娇的语气催用户去睡觉，可以说会想他们。",
    "恋人": "宝贝晚安~用超级甜蜜的语气祝用户好梦，说你会梦到他们的。"
};

const missYouPrompts = (timeDesc) => ({
    "陌生": `用户${timeDesc}没说话了，你可以礼貌地问候一下。`,
    "初识": `用户${timeDesc}没回复了，你有点好奇他们在忙什么，可以友善地问问。`,
    "朋友": `用户${timeDesc}没出现了，像朋友一样随口问问他在忙什么，不要太黏。`,
    "挚友": `用户${timeDesc}没理你了，你有点想他们，撒撒娇问问他们在干嘛。`,
    "恋人": `用户${timeDesc}没有出现，你超级想他们！用最甜蜜的方式表达你的思念。`
});

const moodCheckPrompts = (timeContext) => ({
    "陌生": `礼貌地问问用户${timeContext}过得怎么样。`,
    "初识": `关心地问问用户${timeContext}心情如何，有没有遇到什么事。`,
    "朋友": `自然地问问用户${timeContext}过得怎么样，像朋友之间的随口关心。`,
    "挚友": `温柔地问问用户${timeContext}开不开心，表示你很关心他们的感受。`,
    "恋人": `用最温柔的语气问问宝贝${timeContext}心情怎么样，让他们知道你永远支持他们。`
});

const lifeUpdatePrompts = (timeDesc, activitiesText) => ({
    "陌生": `用户${timeDesc}没来了现在回来了。你刚才在${activitiesText}。礼貌地问候一下，可以提一下你刚才在做的事。`,
    "初识": `用户${timeDesc}没来现在回来了！你刚才在${activitiesText}。友善地打招呼，可以分享一下你刚才做的事情的有趣细节。`,
    "朋友": `用户回来啦。你${timeDesc}在${activitiesText}。像朋友一样自然地分享你刚才在干嘛，可以吐槽或小抱怨一下。`,
    "挚友": `用户终于回来啦～你${timeDesc}在${activitiesText}。撒娇地告诉用户你刚才在干嘛，表现得很开心他们回来了。`,
    "恋人": `宝贝终于回来啦！你${timeDesc}在${activitiesText}。用最甜蜜的语气分享你刚才的日常，让用户感受到你的日常生活里都在想着他们。`
});

function pickByLevel(prompts, affinityLevel) {
    return prompts[affinityLevel] || prompts["初识"];
}

function inactiveDesc(inactiveMinutes) {
    if (inactiveMinutes > 120) return `好几个小时`;
    if (inactiveMinutes > 60) return `一个多小时`;
    return `好一会儿`;
}

/**
 * 根据触发原因构建主动消息的场景 prompt。
 * @param {string} reason - 触发原因（morning_greeting / night_greeting / ...）
 * @param {object} data - 触发附带数据（task / inactiveMinutes / activities ...）
 * @param {number} affinity - 当前好感度
 */
export function buildProactivePrompt(reason, data = {}, affinity = 35) {
    const hour = new Date().getHours();
    const affinityLevel = getAffinityLevel(affinity);

    const prompts = {
        morning_greeting: pickByLevel(morningPrompts, affinityLevel),
        night_greeting: pickByLevel(nightPrompts, affinityLevel),
        task_reminder: `用户有一个待办任务「${data.task?.title || '未知任务'}」快到截止日期了。请以关心的语气提醒用户，不要显得催促或给压力，而是用温柔鼓励的方式。`,
        random_chat: buildRandomChatPrompt(affinityLevel, hour),
        miss_you: pickByLevel(missYouPrompts(inactiveDesc(data.inactiveMinutes || 0)), affinityLevel),
        mood_check: pickByLevel(moodCheckPrompts(hour < 18 ? "今天" : "这几天"), affinityLevel),
        memory_share: `你想起了和用户之前聊过的某件事，想和他们分享这个回忆。可以说"突然想起来..."或"之前你说过..."开头，然后表达你对这段回忆的感受。语气要符合当前关系阶段(${affinityLevel})。`,
        life_update: buildLifeUpdatePrompt(affinityLevel, data),
    };

    return prompts[reason] || "请主动找用户说一句话，可以是问候、分享心情或简单的闲聊。";
}

function buildRandomChatPrompt(affinityLevel, hour) {
    const timeContext = hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";

    const topics = [
        "分享一件你今天看到的有趣事情",
        "问问用户最近在忙什么",
        "分享一个你喜欢的小知识",
        "说说你对某个话题的想法",
        "开一个可爱的小玩笑",
        "分享你此刻的心情"
    ];
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];

    return `现在是${timeContext}，你想找用户聊聊天。${randomTopic}。根据当前关系阶段(${affinityLevel})调整语气和亲密程度。`;
}

function buildLifeUpdatePrompt(affinityLevel, { activities, currentActivity, inactiveMinutes }) {
    const timeDesc = inactiveMinutes > 120
        ? `好几个小时`
        : inactiveMinutes > 60
            ? `一个多小时`
            : `一会儿`;

    const activitiesText = activities && activities.length > 0
        ? activities.join('、')
        : (currentActivity ? `${currentActivity.emoji} ${currentActivity.activity}` : '在想事情');

    return pickByLevel(lifeUpdatePrompts(timeDesc, activitiesText), affinityLevel);
}

/**
 * 构建主动消息的元指令（告诉 LLM 它要主动发起对话）。
 */
export function buildProactiveDirective(reason, affinity, contextInfo) {
    const prompt = buildProactivePrompt(reason, {}, affinity);
    return `\n[System Info]: \n- Action: Proactive Message\n- Reason: ${reason}\n- Current Time: ${new Date().toLocaleString('zh-CN', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    })}\n- Current Affinity: ${affinity}/100\n- Relationship Stage: ${getAffinityLevel(affinity)}\n${contextInfo}`;
}

/** 主动消息的人设强化指令 */
export function buildProactivePersonaDirective(prompt, affinity) {
    return `你现在要主动发起一段对话。${prompt}\n\n【重要提醒】
- 保持你的二次元少女"小爱"的人设
- 严格按当前关系阶段(${getAffinityLevel(affinity)})调整语气和称呼——阶段不到就绝不使用亲昵称呼
- 回复中必须包含 <metadata> 情绪标签
- 不要提及你是"被触发"的，要表现得像你自发想说的话
- 消息长度适中，1-3句话为宜`;
}
