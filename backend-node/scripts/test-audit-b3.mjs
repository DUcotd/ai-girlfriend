/**
 * B3 批次回归测试（接口契约与安全）。
 *
 * 覆盖 docs/full-audit/02-plan.md 的 B3 剩余项：
 *   B3-2  POST /config 全字段类型/长度校验、未知字段可见、空值语义有唯一文档
 *   B3-3  baseUrl 分级（云元数据一律拒 / 本机与内网合法但告警）+ status 回显
 *   B3-4  消费型 GET 改 POST（GET /chat/proactive 不再消耗队列）；GET /life/current 纯读
 *   B3-5  上游异常 → 稳定码 + 中文文案，细节只进日志
 *   B3-6  上传扩展名白名单 / 413 / TTS 入参类型 / 开机清扫 temp_uploads
 *   B3-7  自由文本入库前截断 + 注入端兜底
 *   B3-8  一致性：读时 roll 日界、context_count 口径统一、/chat 与 stream done 同源
 *   B3-9  对话原文不进默认日志、队列长度上限
 *
 * 运行：node scripts/test-audit-b3.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b3-'));
process.env.HOST = '127.0.0.1';

const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { aiGirlfriend, proactiveEngine, updateVoiceEngine, voiceEngine } =
    await import('../src/services/container.js');
const { classifyUpstreamError, UPSTREAM_ERROR_CODES, messageFor, classifiedByCode } =
    await import('../src/utils/upstreamError.js');
const { normalizeBaseUrl, classifyBaseUrlHost, validateConfigBody, configFieldRules } =
    await import('../src/utils/configValidation.js');
const { REASONING_EFFORTS } = await import('../src/config.js');
const { preview, debugText } = await import('../src/utils/log.js');
const TaskManager = (await import('../src/core/TaskManager.js')).default;
const { buildTaskContextText } = await import('../src/core/prompts/taskPrompt.js');
const { EMOTION_LABELS } = await import('../src/core/EmotionEngine.js');
const { pickAudioExtension, cleanupUploadDir } = await import('../src/routes/audio.js');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { failures.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log('  FAIL', name, detail); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const app = createApp();
const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function api(method, urlPath, body) {
    const init = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${base}${urlPath}`, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 保留原文给断言用 */ }
    return { status: res.status, json, text };
}

const REPLY = '<monologue>他看起来很难过，我要陪着他</monologue>我在呢。<metadata>{"emotion":"心疼","affinity_change":1}</metadata>';
const UPSTREAM_HOST = 'api.secret-upstream-host.example';

function fakeUpstream({ throwWith = null, delayMs = 0, chunks = 1 } = {}) {
    aiGirlfriend.apiKey = 'sk-test-key';
    aiGirlfriend.openai = {
        chat: {
            completions: {
                create: async (_p, opts = {}) => {
                    if (throwWith) throw throwWith;
                    if (delayMs) await sleep(delayMs);
                    if (chunks > 1) {
                        return {
                            [Symbol.asyncIterator]: async function* () {
                                for (let i = 0; i < chunks; i++) {
                                    if (opts.signal?.aborted) return;
                                    await sleep(delayMs);
                                    yield { choices: [{ delta: { content: `第${i}段。` } }] };
                                }
                                yield { choices: [{ delta: { content: REPLY.slice(30) } }] };
                            },
                        };
                    }
                    return {
                        choices: [{ message: { role: 'assistant', content: REPLY } }],
                        usage: { total_tokens: 10 },
                    };
                },
            },
        },
    };
}
aiGirlfriend.memory.embedding = { available: false, model: 'fake', embed: async () => null, update: () => {} };

// =========================================================================
console.log('== B3-2 POST /config：类型与长度校验 ==');
{
    const r1 = await api('POST', '/config', { api_key: {} });
    check('api_key 传对象回 400（旧行为：当成「有 Key」并静默保存）',
        r1.status === 400 && Array.isArray(r1.json?.errors) && r1.json.errors.length > 0,
        `${r1.status} ${r1.text.slice(0, 80)}`);

    const r2 = await api('POST', '/config', { temperature: 'false' });
    check('temperature 传非数字字符串回 400（旧行为：NaN 进每轮请求）',
        r2.status === 400, `${r2.status} ${r2.text.slice(0, 80)}`);

    const r3 = await api('POST', '/config', { user_emotion_enabled: 'false' });
    check('布尔字段严格类型：\'false\' 字符串被拒（真值会把开关当开着）',
        r3.status === 400, `${r3.status}`);

    const r4 = await api('POST', '/config', { memory_retrieval_mode: 'magic' });
    check('枚举字段只接受合法档位', r4.status === 400, `${r4.status}`);

    const r5 = await api('POST', '/config', { reasoning_effort: 'ultra' });
    check('reasoning_effort 非档位被拒（旧行为：静默归一化成「不传」）',
        r5.status === 400, `${r5.status}`);

    const r6 = await api('POST', '/config', { model_name: 'x'.repeat(5000) });
    check('超长字符串被长度上限拦住（旧行为：无上限入库）',
        r6.status === 400, `${r6.status}`);

    const r7 = await api('POST', '/config', { apiKey: 'sk-camelcase' });
    check('camelCase 字段不再静默忽略：响应带 warnings 点名',
        r7.status === 200 && Array.isArray(r7.json?.warnings)
        && r7.json.warnings.some((w) => w.includes('apiKey')),
        JSON.stringify(r7.json));

    const r8 = await api('POST', '/config', { temperature: '0.5' });
    check('数字字符串（合法数值）仍然接受并生效',
        r8.status === 200 && config.chat.temperature === 0.5, `${r8.status} ${config.chat.temperature}`);

    // 空值语义：主 Key 的 '' = 不动，null = 清空（与 configValidation.js 的文件头一致）
    await api('POST', '/config', { api_key: 'sk-keep-me', base_url: 'https://example.com/v1' });
    await api('POST', '/config', { api_key: '' });
    check('主 api_key 的空串 = 不动（否则没配 Key 的浏览器会抹掉 env 兜底 Key）',
        aiGirlfriend.apiKey === 'sk-keep-me', String(aiGirlfriend.apiKey));
    const cleared = await api('POST', '/config', { api_key: null });
    check('null = 显式清空', aiGirlfriend.apiKey === null && cleared.status === 200,
        String(aiGirlfriend.apiKey));
    await api('POST', '/config', { api_key: 'sk-test-key', base_url: 'https://example.com/v1' });

    const status = await api('GET', '/config/status');
    check('/config/status 回显当前 baseUrl（设置页高亮与告警的数据源）',
        status.json?.baseUrl === 'https://example.com/v1' && status.json?.isConfigured === true,
        JSON.stringify(status.json?.baseUrl));
}

// =========================================================================
console.log('== B3-3 baseUrl：云元数据拒绝 / 本机合法但告警 ==');
{
    check('169.254.169.254（云元数据）被拒',
        normalizeBaseUrl('http://169.254.169.254/latest/meta-data/') === null);
    check('metadata.google.internal 被拒',
        normalizeBaseUrl('http://metadata.google.internal/computeMetadata/v1') === null);
    check('0.0.0.0 被拒', normalizeBaseUrl('http://0.0.0.0:8080/v1') === null);
    check('IPv6 链路本地 fe80:: 被拒',
        classifyBaseUrlHost('fe80::1') === 'block');
    check('阿里云元数据 100.100.100.200 被拒（CGNAT 段）',
        normalizeBaseUrl('http://100.100.100.200/latest/meta-data/') === null);
    check('非 http(s) 协议被拒',
        normalizeBaseUrl('ftp://models.example.com/v1') === null
        && normalizeBaseUrl('not a url') === null
        && normalizeBaseUrl('javascript:alert(1)') === null);
    check('URL 里塞凭据被拒（容易顺日志外泄）',
        normalizeBaseUrl('https://user:pass@api.example.com/v1') === null);

    const local = normalizeBaseUrl('http://127.0.0.1:11434/v1');
    check('本机 Ollama 这类地址合法放行，但给出告警（本地推理是这个应用的正常用法）',
        local?.url === 'http://127.0.0.1:11434/v1' && typeof local.warning === 'string'
        && local.warning.includes('API Key'),
        JSON.stringify(local));
    const lan = normalizeBaseUrl('http://192.168.1.20:8000/v1');
    check('局域网地址同样是 warn 而不是 block', !!lan?.warning, JSON.stringify(lan));
    const pub = normalizeBaseUrl('https://api.openai.com/v1');
    check('公网 https 地址无告警', pub?.url === 'https://api.openai.com/v1' && pub.warning === null,
        JSON.stringify(pub));
    const slashed = normalizeBaseUrl('https://token.sensenova.cn/v1/');
    check('尾部斜杠归一化（界面显示与实际存储同一个地址）',
        slashed?.url === 'https://token.sensenova.cn/v1', JSON.stringify(slashed));

    // 显式放行开关
    process.env.AI_GIRLFRIEND_BASE_URL_ALLOWLIST = '169.254.169.254';
    check('allowlist 精确放行优先于拒绝规则',
        !!normalizeBaseUrl('http://169.254.169.254/x')?.url);
    delete process.env.AI_GIRLFRIEND_BASE_URL_ALLOWLIST;
    process.env.AI_GIRLFRIEND_ALLOW_PRIVATE_BASE_URLS = 'true';
    check('一键放行开关（离线跑分/特殊环境）',
        !!normalizeBaseUrl('http://169.254.169.254/x')?.url);
    delete process.env.AI_GIRLFRIEND_ALLOW_PRIVATE_BASE_URLS;

    const r = await api('POST', '/config', { base_url: 'http://169.254.169.254/latest/meta-data/' });
    check('HTTP 层同样拦住元数据地址并给出原因',
        r.status === 400 && /API Key/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
    const rl = await api('POST', '/config', { base_url: 'http://127.0.0.1:11434/v1' });
    check('HTTP 层对本机地址放行但响应里带 warning',
        rl.status === 200 && (rl.json?.warnings || []).some((w) => w.includes('局域网') || w.includes('本机')),
        JSON.stringify(rl.json));
    await api('POST', '/config', { base_url: 'https://example.com/v1' });

    const rules = configFieldRules(REASONING_EFFORTS);
    check('reasoning_effort 档位与 config.REASONING_EFFORTS 同源（不抄第二份表）',
        REASONING_EFFORTS.every((v) => rules.reasoning_effort.values.includes(v)),
        JSON.stringify(rules.reasoning_effort.values));
}

// =========================================================================
console.log('== B3-5 上游异常 → 稳定码 + 中文文案 ==');
{
    const cases = [
        [{ status: 401, message: 'Incorrect API key provided' }, UPSTREAM_ERROR_CODES.AUTH],
        [{ status: 403, message: 'Forbidden' }, UPSTREAM_ERROR_CODES.AUTH],
        [{ status: 429, message: 'Rate limit reached' }, UPSTREAM_ERROR_CODES.RATE_LIMITED],
        [{ status: 404, message: 'The model `gpt-x` does not exist' }, UPSTREAM_ERROR_CODES.NOT_FOUND],
        [{ status: 500, message: 'Internal Server Error' }, UPSTREAM_ERROR_CODES.UNAVAILABLE],
        [{ status: 503, message: 'overloaded' }, UPSTREAM_ERROR_CODES.UNAVAILABLE],
        [{ code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${UPSTREAM_HOST}` }, UPSTREAM_ERROR_CODES.NETWORK],
        [{ name: 'APIConnectionTimeoutError', message: 'Request timed out after 60000ms' }, UPSTREAM_ERROR_CODES.TIMEOUT],
        [{ status: 400, message: 'This model\'s maximum context length is 8192 tokens' }, UPSTREAM_ERROR_CODES.CONTEXT_LENGTH],
        [{ message: 'fetch failed' }, UPSTREAM_ERROR_CODES.NETWORK],
        [null, UPSTREAM_ERROR_CODES.UNKNOWN],
        ['not even an error', UPSTREAM_ERROR_CODES.UNKNOWN],
    ];
    for (const [err, code] of cases) {
        const c = classifyUpstreamError(err);
        check(`classify(${code})`, c.code === code, `${c.code} / ${c.status}`);
    }
    const auth = classifyUpstreamError({ status: 401, message: 'bad key' });
    check('文案是中文且可操作（提到设置页/Key），不含上游细节',
        /设置页|Key|模型/.test(auth.message) && !auth.message.includes('bad key'),
        auth.message);
    check('每个稳定码都有一份文案与一个状态码',
        Object.values(UPSTREAM_ERROR_CODES).every((code) => {
            const m = messageFor(code);
            const c = classifiedByCode(code);
            return typeof m === 'string' && m.length > 4 && typeof c.status === 'number';
        }));
    check('未知码回落到通用文案而不是 undefined',
        messageFor('no_such_code').length > 4);

    // HTTP 层：429 的上游异常不得把主机名带进气泡
    fakeUpstream({ throwWith: Object.assign(new Error(`Connection error to ${UPSTREAM_HOST}`), { status: 429 }) });
    const r = await api('POST', '/chat', { message: '在吗' });
    check('/chat 的上游错误回分级文案而不是 SDK 原文',
        r.status === 200 && r.json.reply === messageFor(UPSTREAM_ERROR_CODES.RATE_LIMITED),
        `${r.status} ${r.json?.reply}`);
    check('响应里不再出现上游主机名',
        !r.text.includes(UPSTREAM_HOST), r.text.slice(0, 160));
    check('error_code 随响应下发（前端按它分支，不再匹配文案）',
        r.json.error_code === UPSTREAM_ERROR_CODES.RATE_LIMITED, JSON.stringify(r.json?.error_code));
}

// =========================================================================
console.log('== B3-4 消费型 GET 改 POST ==');
{
    const g = await api('GET', '/chat/proactive');
    check('GET /chat/proactive 不再消耗队列（回 405 并指明新端点）',
        g.status === 405 && /consume/.test(g.text), `${g.status} ${g.text.slice(0, 80)}`);

    proactiveEngine.messageQueue = [
        { id: 'q1', reason: 'miss_you', content: '想你了', priority: 50, timestamp: new Date().toISOString(), expiresAt: Date.now() + 3600_000 },
    ];
    const peek = await api('GET', '/chat/proactive/peek');
    check('peek 只读不取（队首仍在）',
        peek.status === 200 && peek.json?.id === 'q1' && proactiveEngine.messageQueue.length === 1,
        JSON.stringify(peek.json));
    const c1 = await api('POST', '/chat/proactive/consume');
    check('POST /chat/proactive/consume 取到消息',
        c1.status === 200 && c1.json?.id === 'q1', `${c1.status}`);
    const c2 = await api('POST', '/chat/proactive/consume');
    check('队列空时仍回 204（与旧契约一致）', c2.status === 204 && c2.text === '', `${c2.status}`);

    // GET /life/current 必须是纯读
    const sim = proactiveEngine.lifeSimulator;
    sim.currentActivity = { activity: '看书', emoji: '📖', mood: '平静' };
    sim.activityStartTime = new Date(Date.now() - 60_000);
    sim.activityEndTime = new Date(Date.now() + 30 * 60_000);
    const logFile = path.join(process.env.AI_GIRLFRIEND_DATA_DIR, 'life_log.json');
    if (fs.existsSync(logFile)) fs.rmSync(logFile);
    const before = { ...sim.currentActivity, start: sim.activityStartTime?.toISOString() };
    let saved = 0;
    const origSave = sim.saveState.bind(sim);
    sim.saveState = (...a) => { saved++; return origSave(...a); };
    const l1 = await api('GET', '/life/current');
    const l2 = await api('GET', '/life/current');
    sim.saveState = origSave;
    check('GET /life/current 是纯读（不再生成活动、不再写盘）',
        l1.status === 200 && saved === 0 && !fs.existsSync(logFile) && l2.json?.activity === '看书',
        `saveState 调用 ${saved} 次`);
    check('活动没有被 GET 推倒重来',
        sim.currentActivity.activity === before.activity && sim.activityStartTime.toISOString() === before.start);

    sim.currentActivity = null;
    const empty = await api('GET', '/life/current');
    check('还没抽出活动时如实回「在想事情」，而不是现场生成一条',
        empty.status === 200 && empty.json?.activity === '在想事情' && empty.json?.since === null,
        JSON.stringify(empty.json));
    sim.currentActivity = { activity: '看书', emoji: '📖', mood: '平静' };

    const h1 = await api('GET', '/life/history?hours=99999');
    check('?hours 天文数字被夹到上限（不再一次遍历整条历史）', h1.status === 200);
    const h2 = await api('GET', '/life/history?hours=-5');
    check('负数 hours 也被夹住', h2.status === 200);
    const h3 = await api('GET', '/life/history?hours=a&hours=b');
    check('hours 传数组不炸（取第一个）', h3.status === 200);
}

// =========================================================================
console.log('== B3-6 上传与 TTS 入参 ==');
{
    const r = await api('POST', '/audio/speak', { text: 123 });
    check('speak 传数字回 400（旧行为：text.slice 抛 TypeError 落成 500）',
        r.status === 400, `${r.status} ${r.text.slice(0, 60)}`);
    const r2 = await api('POST', '/audio/speak', { text: {} });
    check('speak 传对象回 400', r2.status === 400, `${r2.status}`);
    const r3 = await api('POST', '/audio/speak', { text: '   ' });
    check('speak 传空白串回 400', r3.status === 400, `${r3.status}`);
    const r4 = await api('POST', '/audio/speak', { text: '啊'.repeat(config.tts.maxRequestChars + 10) });
    check('超长文本回 400 而不是走完整个朗读链路',
        r4.status === 400 && /最长/.test(r4.text), `${r4.status}`);

    check('扩展名白名单判定', pickAudioExtension('recording.webm') === '.webm'
        && pickAudioExtension('A.MP3') === '.mp3'
        && pickAudioExtension('payload.exe') === null
        && pickAudioExtension('noext') === null
        && pickAudioExtension('a.tar.gz') === null
        && pickAudioExtension('x'.repeat(300) + '.webm') === null,
        String(pickAudioExtension('payload.exe')));

    async function uploadWith(name, bytes) {
        const fd = new FormData();
        fd.append('file', new Blob([bytes]), name);
        const res = await fetch(`${base}/audio/transcribe`, { method: 'POST', body: fd });
        const text = await res.text();
        return { status: res.status, text };
    }
    const exe = await uploadWith('evil.exe', Buffer.from('MZ\x90\x00 fake binary'));
    check('上传 .exe 被拒（415，落盘之前就被 fileFilter 拦下）',
        exe.status === 415, `${exe.status} ${exe.text.slice(0, 80)}`);
    const hugeExt = await uploadWith(`${'a'.repeat(300)}.webm`, Buffer.from('x'));
    check('超长文件名回 415 而不是 500（旧行为：ENAMETOOLONG）',
        hugeExt.status === 415, `${hugeExt.status} ${hugeExt.text.slice(0, 60)}`);
    const big = await uploadWith('long.webm', Buffer.alloc(config.upload.maxFileSize + 1024, 1));
    check('超过 maxFileSize 回 413（旧行为：multer 原始错误压成 500）',
        big.status === 413 && /上限/.test(big.text), `${big.status} ${big.text.slice(0, 80)}`);
    const two = new FormData();
    two.append('file', new Blob([Buffer.from('a')], ), 'a.webm');
    two.append('extra', new Blob([Buffer.from('b')]), 'b.webm');
    const multi = await fetch(`${base}/audio/transcribe`, { method: 'POST', body: two });
    check('多部件请求被拒（旧行为：第二个部件的临时文件留在磁盘上）',
        multi.status === 400, `${multi.status}`);

    // 合法音频：走到引擎层（未配 Key 应回 400 而不是 415/500）
    const noKey = await uploadWith('rec.webm', Buffer.from('fake webm bytes'));
    check('合法音频通过校验层，错误来自引擎而不是入参',
        noKey.status === 400 && /Key/.test(noKey.text) && !/只接受音频/.test(noKey.text),
        `${noKey.status} ${noKey.text.slice(0, 80)}`);
    let cleaned = null;
    const realPath = path.join(config.upload.dir, 'upload-should-be-deleted.webm');
    fs.writeFileSync(realPath, 'leftover');
    voiceEngine.current.speechToText = async (p) => { cleaned = p; return '转写结果'; };
    // 直接放一个能匹配 name 的文件，验证 finally 会删除它
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('audio')]), 'ok.webm');
    const okRes = await fetch(`${base}/audio/transcribe`, { method: 'POST', body: fd });
    check('转写成功后临时文件被清掉',
        okRes.status === 200 && cleaned && !fs.existsSync(cleaned), JSON.stringify(cleaned));

    fs.writeFileSync(path.join(config.upload.dir, 'upload-stale-1.webm'), 'x');
    fs.writeFileSync(path.join(config.upload.dir, 'keepme.txt'), 'x');
    const removed = cleanupUploadDir();
    check('开机清扫只删自己生成的 upload-* 残留（不碰别的文件）',
        removed >= 1 && !fs.existsSync(path.join(config.upload.dir, 'upload-stale-1.webm'))
        && fs.existsSync(path.join(config.upload.dir, 'keepme.txt')),
        `删除 ${removed} 个`);
    fs.rmSync(path.join(config.upload.dir, 'keepme.txt'), { force: true });
    fs.rmSync(realPath, { force: true });
}

// =========================================================================
console.log('== B3-7 自由文本入库前截断 ==');
{
    const long = '相'.repeat(config.textLimits.taskTitle + 50);
    const r = await api('POST', '/tasks', { title: long });
    check('超长任务标题回 400 并给出上限',
        r.status === 400 && /最长/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
    const okTitle = '相'.repeat(config.textLimits.taskTitle);
    const r2 = await api('POST', '/tasks', { title: okTitle });
    check('刚好到上限的标题可以存', r2.status === 200 && r2.json?.title?.length === config.textLimits.taskTitle,
        `${r2.status} ${r2.json?.title?.length}`);
    const r3 = await api('POST', '/tasks', { title: '正常标题', description: 'd'.repeat(config.textLimits.taskDescription + 1) });
    check('超长描述回 400', r3.status === 400, `${r3.status}`);

    const t = TaskManager.addTask({ title: long, source: 'ai' });
    check('AI 建单（不走 HTTP）也照样截断',
        t.title.length === config.textLimits.taskTitle, String(t.title.length));
    TaskManager.deleteTask(t.id);

    const legacy = { id: 'legacy-1', title: '旧'.repeat(5000), dueTime: null, completed: false };
    const text = buildTaskContextText([legacy], new Date());
    check('修复前就存在的超长标题，注入端也兜住（每轮 prompt 不再被它撑爆）',
        text.length < 2000 && text.includes('…'), `注入文本 ${text.length} 字`);

    const fact = '事'.repeat(config.textLimits.factContent + 200);
    const rf = await api('POST', '/memories/facts', { content: fact });
    check('超长事实回 400', rf.status === 400 && /最长/.test(rf.text), `${rf.status}`);
    const rf2 = await api('POST', '/memories/facts', { content: '我住在成都' });
    check('正常事实仍然能存', rf2.status === 200, `${rf2.status} ${rf2.text.slice(0, 80)}`);
    const direct = await aiGirlfriend.addFact('事'.repeat(config.textLimits.factContent + 300), { importance: 4 });
    check('直接调用引擎（LLM 提取路径）也截断而不是照单存下',
        direct === null || direct.content.length <= config.textLimits.factContent,
        String(direct?.content?.length));

    const rp = await api('POST', '/state', { nickname: 'x'.repeat(200) });
    check('超长昵称回 400（上限来自 config.textLimits，不再是路由里手写的 50）',
        rp.status === 400 && /最长/.test(rp.text), `${rp.status}`);
    const rp2 = await api('POST', '/state', { affinity: '42' });
    check('affinity 传字符串仍回 400（既有约定未回退）', rp2.status === 400, `${rp2.status}`);
    const rp3 = await api('POST', '/state', { affinity: Infinity });
    check('affinity=Infinity 被有限性判定拦住（旧写法 typeof number 放行后 clamp 出 NaN）',
        rp3.status === 400, `${rp3.status}`);

    const rc = await api('POST', '/chat', { message: '   ' });
    check('空白消息回 400 而不是让模型空转一轮', rc.status === 400, `${rc.status}`);
}

// =========================================================================
console.log('== B3-8 一致性小修 ==');
{
    aiGirlfriend.affinityEngine.daily = { dayKey: '1970-01-01', gained: 99 };
    const meta = aiGirlfriend.affinityEngine.getMeta();
    check('跨了自然日之后读 meta 会 roll 日界（昨天的「额度已满」不该今天还显示）',
        meta.dailyCapReached === false && aiGirlfriend.affinityEngine.daily.gained === 0,
        JSON.stringify(aiGirlfriend.affinityEngine.daily));

    fakeUpstream({ throwWith: null });
    const before = (await api('GET', '/state')).json?.historyCount;
    const chat = await api('POST', '/chat', { message: '今天月亮不错' });
    await sleep(250);
    const after = (await api('GET', '/state')).json?.historyCount;
    check('/chat 的 context_count 与 /state 的 historyCount 同口径（都不含 system 消息）',
        chat.json?.context_count === after, `${chat.json?.context_count} vs ${after}`);
    check('一轮对话确实进了两条历史', after === before + 2, `${before} → ${after}`);

    // done 与 /chat 响应体同源
    const streamKeys = await new Promise((resolve) => {
        fetch(`${base}/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '同源检查' }),
        }).then(async (res) => {
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            const timer = setTimeout(() => reader.cancel().catch(() => { }), 6000);
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const line = buf.split('\n').find((l) => l.startsWith('data:') && l.includes('"done"'));
                if (line) { clearTimeout(timer); reader.cancel().catch(() => { }); resolve(Object.keys(JSON.parse(line.slice(5))).sort()); return; }
            }
            clearTimeout(timer);
            resolve([]);
        });
    });
    const chatKeys = Object.keys(chat.json || {}).sort();
    // done 事件多一个 SSE 判别字段 type，以及仅流式存在的 aborted（本轮没中断所以不出现）
    const streamKeysSansType = streamKeys.filter((k) => k !== 'type').sort();
    check('流式 done 与非流式响应是同一份字段集合（B3-8 合成一个 builder）',
        streamKeysSansType.length > 0 && JSON.stringify(streamKeysSansType) === JSON.stringify(chatKeys),
        `stream=${streamKeysSansType.join(',')} chat=${chatKeys.join(',')}`);

    const noKey = (() => {
        const saved = aiGirlfriend.apiKey;
        const savedClient = aiGirlfriend.openai;
        aiGirlfriend.apiKey = null;
        aiGirlfriend.openai = null;
        const g = aiGirlfriend._preChatGuard('在吗');
        aiGirlfriend.apiKey = saved;
        aiGirlfriend.openai = savedClient;
        return g;
    })();
    check('未配 Key 的兜底回的是真实情绪标签而不是 "default"',
        EMOTION_LABELS.includes(noKey.emotion), String(noKey.emotion));
    check('兜底带稳定码 not_configured（前端能给「去设置页」提示）',
        noKey.errorCode === UPSTREAM_ERROR_CODES.NOT_CONFIGURED, String(noKey.errorCode));

    // PORT 非法值：envNumber 应裁剪回默认，而不是把 NaN 交给 listen
    const configUrl = new URL('../src/config.js', import.meta.url).href;
    const portProbe = spawnSync(process.execPath, ['-e',
        `process.env.PORT="abc";import(${JSON.stringify(configUrl)}).then(m=>console.log("PORT="+m.config.port))`],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    check('PORT 非法值走 envNumber 回落默认（而不是 NaN 传给 listen）',
        /PORT=8000/.test(portProbe.stdout || ''), (portProbe.stdout || '') + (portProbe.stderr || '').slice(0, 200));
}

// =========================================================================
console.log('== B3-9 日志隐私与队列上限 ==');
{
    const SECRET_MONOLOGUE = '其实我刚才那句话是违心的，我很委屈';
    const captured = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = (...a) => { captured.push(a.join(' ')); };
    console.warn = (...a) => { captured.push(a.join(' ')); };
    console.error = (...a) => { captured.push(a.join(' ')); };
    try {
        aiGirlfriend._parseReplyText(
            `<monologue>${SECRET_MONOLOGUE}</monologue>正文在这里。<metadata>{"emotion":"平静"}</metadata>`,
            '正文在这里'
        );
        debugText('Chat', '内心独白', SECRET_MONOLOGUE);
    } finally {
        console.log = origLog; console.warn = origWarn; console.error = origErr;
    }
    const joined = captured.join('\n');
    check('默认配置下日志不含独白原文（最私密的文本不该长期躺在 dev.log）',
        !joined.includes(SECRET_MONOLOGUE), joined.slice(0, 200));
    check('但仍然留下长度信息，排障时不是完全盲',
        /字/.test(joined), joined.slice(0, 120));

    config.logging.verbose = true;
    const cap2 = [];
    console.log = (...a) => { cap2.push(a.join(' ')); };
    try {
        debugText('Chat', '内心独白', SECRET_MONOLOGUE);
    } finally {
        console.log = origLog;
        config.logging.verbose = false;
    }
    check('显式开 AI_GIRLFRIEND_DEBUG 才打印原文（排障通道保留）',
        cap2.join('\n').includes(SECRET_MONOLOGUE), cap2.join('\n'));

    check('preview 折叠空白并截断', preview(`a\n  b ${'c'.repeat(300)}`).length <= config.logging.textPreviewChars + 20,
        preview('x'));

    // 队列上限：慢速上游 + 并发请求 → 超出的直接 429
    fakeUpstream({ delayMs: 120, chunks: 3 });
    const n = config.logging.maxChatQueue + 3;
    const results = await Promise.all(
        Array.from({ length: n }, (_, i) => fetch(`${base}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `压力测试 ${i}` }),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })))
    );
    const busy = results.filter((r) => r.status === 429);
    check(`并发 ${n} 轮（上限 ${config.logging.maxChatQueue}）时超额请求被拒`,
        busy.length >= 1, JSON.stringify(results.map((r) => r.status)));
    check('被拒的请求拿到的是 service_busy 稳定码与可读文案',
        busy.every((r) => r.body?.error_code === UPSTREAM_ERROR_CODES.BUSY && typeof r.body?.detail === 'string'),
        JSON.stringify(busy[0]?.body));
    check('队列深度在全部请求结束后归零（不泄漏计数）',
        aiGirlfriend._queueDepth === 0, String(aiGirlfriend._queueDepth));

    fakeUpstream();
    const after429 = await api('POST', '/chat', { message: '恢复了吗' });
    await sleep(250);
    check('拒掉超额请求后，正常请求照旧工作', after429.status === 200, `${after429.status}`);

    // 串行互斥没被重构破坏：某轮 reject 后，下一轮必须照常执行
    let calls = 0;
    aiGirlfriend.openai = {
        chat: { completions: { create: async () => {
            calls++;
            if (calls === 1) throw new Error('boom');
            return { choices: [{ message: { content: REPLY } }], usage: {} };
        } } },
    };
    aiGirlfriend._doChat = async function (msg) {
        if (calls === 0) throw new Error('第一轮直接炸在队列层');
        calls++;
        return { reply: 'ok', token_usage: {}, emotion: '平静', affinity: this.affinity };
    };
    const first = await aiGirlfriend.chat('a').catch((e) => ({ threw: true, e }));
    const second = await aiGirlfriend.chat('b');
    check('前一轮 reject 后，下一轮照常执行（catch 留在链内）',
        !first?.threw && second?.reply, JSON.stringify({ first: !!first, second: second?.reply }));
    delete aiGirlfriend._doChat;
    fakeUpstream();
}

console.log(`\n结果: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
    for (const f of failures) console.log('  ·', f);
}
// container 在导入时就起了轮询/生活模拟定时器，不收就会挂着不退出
proactiveEngine.stop();
aiGirlfriend.memory?.flush?.();
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
try { fs.rmSync(process.env.AI_GIRLFRIEND_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0);
