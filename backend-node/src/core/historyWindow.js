/**
 * historyWindow —— 对话历史的「成对裁剪」与 prompt 窗口选择（B8-6，审计 CORE-21）。
 *
 * 为什么单独一个纯函数模块：裁剪这件事原本散在三处、语义各不相同 ——
 *   ① `_trimHistory()`：`while (len > MAX) splice(1, 2)`（假设严格 user/assistant 交替）
 *   ② `_finalize` 里手抄的同一段 while
 *   ③ `recordProactiveMessage`：第三种写法（按非 system 条数取尾巴）
 * 而 `recordProactiveMessage` 会 push **孤立的 assistant**（她主动说话、用户还没回），
 * 于是「每次砍两条」从这一刻起就错位了：之后每轮裁剪都可能删掉一条 user、
 * 留下另一轮的回答 —— 用户看到的症状是「我说过的话凭空消失，她的答非所问」。
 * 三处共用这一份实现，形状就不会再漂移（本项目已经为「第二份真相」付过太多次学费）。
 *
 * 成对语义（本次的口径）：
 *   - 一个「单元」= 一条 user 消息 + 它后面跟着的所有 assistant 回复；
 *   - 主动消息这类**没有 user 打头**的孤立 assistant 自成单元；
 *   - 裁剪只按**整单元**丢弃（从最旧的开始），永不把 user 和它的回答拆开；
 *     末尾「有 user 还没回答」与开头「孤立 assistant」都容忍（那是真实对话的正常形状）。
 *
 * 纯函数：不读文件、不碰 config 之外的状态、不 new Date()，可被单测直接打。
 */

/** 是否是人设 system 条目（history[0] 的那一条） */
function isPersona(msg) {
    return !!msg && msg.role === 'system';
}

/**
 * 把非 system 的消息切成「单元」。
 * @param {Array<{role:string}>} messages
 * @returns {Array<Array<object>>} 每个单元是一组该一起删的消息（时间升序）
 */
export function groupIntoUnits(messages) {
    const units = [];
    let current = null;
    for (const msg of messages || []) {
        if (!msg) continue;
        if (msg.role === 'user') {
            if (current) units.push(current);
            current = [msg];
        } else if (current) {
            current.push(msg);
        } else {
            // 没有 user 打头（主动消息 / 恢复历史时的首条）：孤立 assistant 自成单元
            units.push([msg]);
        }
    }
    if (current) units.push(current);
    return units;
}

/**
 * 条数裁剪：整单元从最旧开始丢，保证剩下的条数 ≤ maxEntries。
 * 容忍开头/结尾的孤立消息（不做「必须成对」的假设，那正是旧 splice(1,2) 的失效点）。
 *
 * @param {Array} history 完整历史（history[0] 可能是人设 system）
 * @param {number} maxEntries 非 system 条目的上限
 * @returns {{ history: Array, dropped: number }}
 */
export function trimHistoryPairAware(history, maxEntries) {
    const list = Array.isArray(history) ? history : [];
    const persona = isPersona(list[0]) ? [list[0]] : [];
    const rest = list.slice(persona.length);
    const cap = Math.max(1, Number(maxEntries) || 1);
    if (rest.length <= cap) return { history: list, dropped: 0 };

    const units = groupIntoUnits(rest);
    // 从最旧的单元开始丢，直到条数达标；至少留最后一个单元
    let droppedUnits = 0;
    let remaining = rest.length;
    while (remaining > cap && droppedUnits < units.length - 1) {
        remaining -= units[droppedUnits].length;
        droppedUnits++;
    }
    const kept = units.slice(droppedUnits).flat();
    // 极端情况：最后一个单元本身就超上限（比如一次塞进来的超长一串）→ 保留它的尾巴
    const tail = kept.length > cap ? kept.slice(kept.length - cap) : kept;
    return { history: [...persona, ...tail], dropped: rest.length - tail.length };
}

/**
 * 选出发给 LLM 的对话窗口（不含人设与动态 system 块，由调用方拼接顺序）。
 *
 * @param {Array} history
 * @param {{maxEntries?:number, unlimited?:boolean, maxChars?:number, clipChars?:number}} opts
 *   maxEntries —— 条数上限（config.chat.maxPromptHistory；unlimited 时忽略条数）
 *   maxChars   —— 窗口总字符上限（config.prompt.budget.maxHistoryChars）：
 *                 unlimitedContext 也受它约束，否则「无限上下文」就是无界 prefill
 * @returns {{messages:Array<{role:string,content:string}>, droppedEntries:number, droppedChars:number, clipped:number}}
 */
export function selectPromptWindow(history, opts = {}) {
    const { maxEntries, unlimited = false, maxChars, clipChars } = opts;
    const list = Array.isArray(history) ? history : [];
    const persona = isPersona(list[0]) ? [list[0]] : [];
    const rest = list.slice(persona.length);
    // thought / 其它内部字段不该进模型请求（送 LLM 时只带 role+content）
    const toPromptMsg = (m) => ({ role: m.role, content: String(m.content ?? '') });

    let window = unlimited ? rest : (() => {
        const cap = Math.max(1, Number(maxEntries) || 1);
        if (rest.length <= cap) return rest;
        // 按单元对齐窗口起点：宁可多带一轮，也不把 user 和它的回答拆开
        const units = groupIntoUnits(rest);
        const picked = [];
        let count = 0;
        for (let i = units.length - 1; i >= 0 && count < cap; i--) {
            picked.unshift(...units[i]);
            count += units[i].length;
        }
        return picked;
    })();

    let droppedEntries = 0;
    let droppedChars = 0;

    // 字符预算：整单元从最旧开始丢（与条数裁剪同一口径）
    if (Number.isFinite(maxChars) && maxChars > 0) {
        let units = groupIntoUnits(window);
        let size = window.reduce((s, m) => s + String(m.content ?? '').length, 0);
        while (size > maxChars && units.length > 1) {
            const [oldest, ...keep] = units;
            const lost = oldest.reduce((s, m) => s + String(m.content ?? '').length, 0);
            size -= lost;
            droppedEntries += oldest.length;
            droppedChars += lost;
            units = keep;
        }
        window = units.flat();
    }

    // 单条仍然超预算（比如历史里留着改造前的超长回复）→ 逐条裁剪，丢内容不如留个开头
    let clipped = 0;
    let messages = window.map(toPromptMsg);
    if (Number.isFinite(clipChars) && clipChars > 0) {
        messages = messages.map((m) => {
            if (m.content.length <= clipChars) return m;
            clipped++;
            droppedChars += m.content.length - clipChars;
            return { role: m.role, content: `${m.content.slice(0, clipChars)}…` };
        });
    }

    return { messages: [...persona.map(toPromptMsg), ...messages], droppedEntries, droppedChars, clipped };
}

/**
 * 最后一道闸：整条请求的字符上限（B8-3）。
 * 只继续丢**对话窗口**里最旧的单元 —— 人设、动态 system 块、本轮提问永不丢
 * （从头部被静默截断时，最先掉的一直都是人设，那正是审计 CORE-09 的症状）。
 *
 * @param {Array} personaMessages 头部的人设 system（可为空）
 * @param {Array} windowMessages  对话窗口
 * @param {Array} tailMessages    动态 system 块 + 本轮用户消息
 * @param {number} maxRequestChars
 * @returns {{messages:Array, droppedEntries:number}}
 */
export function enforceRequestBudget(personaMessages, windowMessages, tailMessages, maxRequestChars) {
    const charsOf = (list) => list.reduce((s, m) => s + String(m.content ?? '').length, 0);
    const fixed = charsOf(personaMessages) + charsOf(tailMessages);
    let window = Array.isArray(windowMessages) ? [...windowMessages] : [];
    let droppedEntries = 0;
    if (!Number.isFinite(maxRequestChars) || maxRequestChars <= 0) {
        return { messages: [...personaMessages, ...window, ...tailMessages], droppedEntries: 0 };
    }
    let allowed = Math.max(0, maxRequestChars - fixed);
    while (window.length > 0 && charsOf(window) > allowed) {
        const units = groupIntoUnits(window);
        const oldest = units[0] || [window[0]];
        window = window.slice(oldest.length);
        droppedEntries += oldest.length;
    }
    // 只剩一个单元仍然超预算：与其让人设在服务端被从头部截掉，不如把窗口整段让路
    if (window.length > 0 && charsOf(window) > allowed) {
        droppedEntries += window.length;
        window = [];
    }
    return { messages: [...personaMessages, ...window, ...tailMessages], droppedEntries };
}
