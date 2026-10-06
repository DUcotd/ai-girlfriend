/**
 * backup.js - 全量档案导出 / 导入 / 自动快照（B5-12，审计 INFRA-12）。
 *
 * 为什么这是数据安全里最值钱的一件：这个应用的全部人格与关系都只存在于
 * `data/` 下那 11 个 JSON 里，而在此之前**没有任何一条恢复路径**：
 *   - 「完全重置」是不可逆的（只有 60 秒内 Ctrl+C 抢救进程的机会）；
 *   - 一次误删、一次磁盘故障、一次写坏的文件，就抹掉几个月甚至几年的关系；
 *   - 换机器要手动拷 `data/`，还得知道该拷哪几个文件（这份清单本身就常漏，
 *     `jsonStore` 的 LEGACY_FILES 就长期落后于实际文件过）。
 *
 * 三条设计约束：
 * 1. **导出前先 flush**：所有去抖写盘的引擎（memory / narrative / userEmotion / trigger）
 *    在内存里都有未落盘的数据，不 flush 就导出会少掉最近几轮 —— 那正是用户最在意的部分。
 * 2. **导入前自动快照当前状态**：导入是破坏性操作，出错时必须能退回导入前，
 *    而不是「导坏了，原数据也没了」。
 * 3. **导入后立即热加载到各引擎**：只写文件不 reload 的话，运行中的引擎会在几十秒内
 *    用内存里的旧状态把刚导入的文件盖回去，表现成「导入没生效 / 只生效了一半」。
 *
 * 纯函数（校验、校验和）与副作用（读写盘、reload）分开，便于单测。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { dataDir, dataPath, readJson, writeJson } from '../utils/jsonStore.js';

/** 档案格式标识与版本：导入时先认这个，避免把别的 JSON 当档案导进来 */
export const ARCHIVE_KIND = 'ai-girlfriend-archive';
export const ARCHIVE_VERSION = 1;

/**
 * 数据文件清单 —— 全项目唯一事实源。
 * 每项都写明「谁拥有它」，导入时要逐个热加载；新增数据文件必须在这里登记，
 * 否则它不会进档案（`test-audit-b5b.mjs` 会拿 data/ 目录与这张表对账，防漏登记）。
 */
export const ARCHIVE_FILES = Object.freeze([
    { file: 'state.json', owner: 'aiGirlfriend', reload: (s) => s.aiGirlfriend.reloadState(), label: '对话历史 / 人设 / 运行时开关' },
    { file: 'affinity_state.json', owner: 'affinity', reload: (s) => s.aiGirlfriend.affinityEngine.reload(), label: '好感度与变更账本' },
    { file: 'emotion_state.json', owner: 'emotion', reload: (s) => s.aiGirlfriend.emotionEngine.reload(), label: '她当前的情绪与情绪历史' },
    { file: 'personality_state.json', owner: 'personality', reload: (s) => s.aiGirlfriend.personalityDrift.reload(), label: '性格七维与漂移账本' },
    { file: 'memory.json', owner: 'memory', reload: (s) => s.aiGirlfriend.memory?.store?.reload(), label: '情节记忆与事实' },
    { file: 'narrative.json', owner: 'narrative', reload: (s) => s.aiGirlfriend.narrativeStore?.reload(), label: '我们的故事' },
    { file: 'user_emotion_state.json', owner: 'userEmotion', reload: (s) => s.aiGirlfriend.userEmotionEngine?.reload(), label: '你的情绪时间线' },
    { file: 'proactive_state.json', owner: 'proactive', reload: (s) => s.proactiveEngine.reload(), label: '主动消息配置与队列' },
    { file: 'life_log.json', owner: 'life', reload: (s) => s.proactiveEngine.lifeSimulator.reload(), label: '她这几小时在做什么' },
    { file: 'trigger_state.json', owner: 'trigger', reload: (s) => s.triggerRegistry.reload(), label: '事件队列与冷却/去重标记' },
    { file: 'tasks.json', owner: 'tasks', reload: (s) => s.taskManager.reload(), label: '待办任务' },
]);

export const ARCHIVE_FILE_NAMES = ARCHIVE_FILES.map((f) => f.file);

/** 单个文件读成解析后的对象；不存在返回 null（档案里允许缺项，新装机器就是这样） */
function readArchiveFile(name) {
    const p = dataPath(name);
    if (!fs.existsSync(p)) return null;
    try {
        return { raw: fs.readFileSync(p, 'utf-8'), parsed: JSON.parse(fs.readFileSync(p, 'utf-8')) };
    } catch (e) {
        console.error(`[Backup] 读取 ${name} 失败：${e.message}`);
        return null;
    }
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * 导出前把所有去抖中的待写数据落到磁盘。
 * 返回失败项 —— 有失败说明磁盘状态已经不完整，这时导出的档案不能当真，
 * 调用方（路由）必须把 warnings 带到响应里，而不是静默给一份「看起来成功」的档案。
 * @returns {Promise<{failed: string[]}>}
 */
export async function flushAll(services) {
    const failed = [];
    const run = (name, fn) => {
        try {
            const r = fn();
            // 引擎的 flush 返回 boolean（B0-6 后半）：false 就是没写进去
            if (r === false) failed.push(name);
        } catch (e) {
            console.error(`[Backup] flush ${name} failed: ${e.message}`);
            failed.push(name);
        }
    };
    const ag = services.aiGirlfriend;
    run('state', () => ag._saveState());
    run('affinity', () => ag.affinityEngine._saveState());
    run('emotion', () => ag.emotionEngine._saveState());
    run('personality', () => ag.personalityDrift._saveState());
    run('memory', () => { ag.memory?.flush?.(); });
    run('narrative', () => { ag.flushNarratives?.(); });
    run('userEmotion', () => { ag.flushUserEmotion?.(); });
    run('proactive', () => services.proactiveEngine._saveState());
    run('life', () => services.proactiveEngine.lifeSimulator?.saveState());
    run('trigger', () => services.triggerRegistry.flush());
    run('tasks', () => services.taskManager.saveTasks());
    return { failed };
}

/** 保证 flush 之后各引擎真的把内存态写下去了（给去抖一点时间） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 构造一份完整档案（内存对象，尚未序列化）。
 * @param {object} services 容器单例
 * @param {{now?: Date, app?: object}} [opts]
 */
export async function buildArchive(services, { now = new Date(), app = {} } = {}) {
    const { failed } = await flushAll(services);
    // 去抖写的 flush 已经同步执行；这里再等一小会儿是为了兜住
    // 个别「写完还要 fsync」的链路抖动，避免导出读到半个文件。
    await sleep(30);

    const files = {};
    const checksums = {};
    const missing = [];
    for (const name of ARCHIVE_FILE_NAMES) {
        const got = readArchiveFile(name);
        if (!got) { missing.push(name); continue; }
        files[name] = got.parsed;
        checksums[name] = sha256(got.raw);
    }
    return {
        kind: ARCHIVE_KIND,
        version: ARCHIVE_VERSION,
        exportedAt: now.toISOString(),
        app: {
            backendVersion: app.backendVersion ?? null,
            node: process.version,
            // 只记主机名，绝不在档案里留下 Key（档案会被下载、转发、备份到云盘）
            model: services.aiGirlfriend.modelName || null,
            baseUrlHost: (() => {
                try { return new URL(services.aiGirlfriend.baseUrl).host; } catch { return null; }
            })(),
        },
        // 每个文件是什么，写给「人」看的（也便于以后手工抢救）
        manifest: ARCHIVE_FILES.map(({ file, label }) => ({ file, label })),
        files,
        checksums,
        warnings: [
            ...failed.map((f) => `导出前写盘失败：${f}（这份档案里该项可能是旧数据）`),
            ...missing.map((f) => `数据目录里没有 ${f}（新装或该功能从未用到，属正常）`),
        ],
    };
}

/**
 * 校验一份待导入的档案（纯函数，不碰磁盘）。
 * @returns {{errors: string[], warnings: string[], files: Record<string, object>}}
 */
export function validateArchive(archive) {
    const errors = [];
    const warnings = [];
    if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
        return { errors: ['档案必须是一个 JSON 对象'], warnings, files: {} };
    }
    if (archive.kind !== ARCHIVE_KIND) {
        errors.push(`不认识的档案格式（kind=${JSON.stringify(archive.kind)}），只接受 ${ARCHIVE_KIND}`);
    }
    if (archive.version !== ARCHIVE_VERSION) {
        errors.push(`档案版本不支持（档案 ${archive.version}，本程序 ${ARCHIVE_VERSION}）`);
    }
    const files = archive.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
        errors.push('档案里没有 files 段');
        return { errors, warnings, files: {} };
    }
    const unknown = Object.keys(files).filter((k) => !ARCHIVE_FILE_NAMES.includes(k));
    if (unknown.length) warnings.push(`档案里有本程序不认识的项，将跳过：${unknown.join(', ')}`);

    for (const [name, content] of Object.entries(files)) {
        if (!ARCHIVE_FILE_NAMES.includes(name)) continue;
        // 每个文件都必须是对象或数组：readJson 对损坏文件会隔离并回退空状态，
        // 若这里放过一个字符串/数字，导入后就是「文件存在但内容清空」的数据丢失。
        if (content === undefined || content === null) { warnings.push(`档案里的 ${name} 为空，将跳过`); continue; }
        if (typeof content !== 'object') {
            errors.push(`${name} 的内容不是 JSON 对象/数组，拒绝导入`);
            continue;
        }
        const sum = archive.checksums?.[name];
        if (typeof sum === 'string' && sum.length === 64) {
            // 校验和只能证明「导出后没被改过」；导入时对象已被 JSON 解析过一遍，
            // 重新序列化与原文可能只差空格，因此**不作为拒绝条件**，只在明显不符时告警。
            const recomputed = sha256(JSON.stringify(content, null, 2));
            if (recomputed !== sum) warnings.push(`${name} 的校验和与内容不完全对应（多半是序列化空白差异），仍可导入`);
        } else {
            warnings.push(`${name} 没有校验和，无法确认导出后未被改动`);
        }
    }
    if (!Object.keys(files).some((k) => ARCHIVE_FILE_NAMES.includes(k))) {
        errors.push('档案里没有任何可导入的数据文件');
    }
    return { errors, warnings, files };
}

/**
 * 备份根目录。默认「当前数据目录的旁边」而不是写死 backend-node/backups：
 * 测试与多实例都用 AI_GIRLFRIEND_DATA_DIR 隔离，跟着走才能让自动快照也落进沙盒。
 */
export function backupRoot() {
    return config.backup.dir
        ? path.resolve(config.backup.dir)
        : path.resolve(dataDir(), '..', 'backups');
}

/** 快照目录与命名：时间戳前缀保证排序，reason 让目录名自己说明为什么存在 */
export function snapshotDir(reason, now = new Date()) {
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const safe = String(reason || 'manual').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'manual';
    return path.join(backupRoot(), `${ts}-${safe}`);
}

/**
 * 把当前 data/ 里的档案文件复制到快照目录（原样复制，保留可人工抢救的能力）。
 * @returns {{dir: string, files: string[]}}
 */
export function createSnapshot(reason = 'manual', now = new Date()) {
    const dir = snapshotDir(reason, now);
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (const name of ARCHIVE_FILE_NAMES) {
        const src = dataPath(name);
        if (!fs.existsSync(src)) continue;
        try {
            fs.copyFileSync(src, path.join(dir, name));
            files.push(name);
        } catch (e) {
            console.error(`[Backup] 快照 ${name} 失败: ${e.message}`);
        }
    }
    fs.writeFileSync(path.join(dir, 'SNAPSHOT_INFO.json'), JSON.stringify({
        reason, createdAt: now.toISOString(), files,
        note: '这是 data/ 的原样副本，删掉本目录不影响运行；要恢复就把 files 里的文件复制回 data/ 后重启后端。',
    }, null, 2), 'utf-8');
    // protect 本次：时钟回拨或用未来时间戳批量建快照时，「按名字取最新 N 份」
    // 会把刚写的这份当成最旧的立刻删掉 —— 实测过：restoreSnapshot 生成的
    // pre-restore 快照会被自己那一次 prune 抹掉，等于「备份失败但没人知道」。
    pruneSnapshots({ protect: dir });
    return { dir, files };
}

/** 只保留最近 config.backup.keep 份快照（按目录名字典序 = 时间序） */
export function pruneSnapshots({ protect = null } = {}) {
    const dirs = listSnapshots();
    const victims = dirs.slice(config.backup.keep)
        .filter((d) => !protect || path.resolve(d.dir) !== path.resolve(protect));
    let removed = 0;
    for (const d of victims) {
        try {
            fs.rmSync(d.dir, { recursive: true, force: true });
            removed++;
        } catch (e) {
            console.error(`[Backup] 清理旧快照 ${d.dir} 失败: ${e.message}`);
        }
    }
    if (removed) console.log(`[Backup] 清理旧快照 ${removed} 份（保留最近 ${config.backup.keep} 份）`);
    return removed;
}

/** 列出快照目录（新的在前） */
export function listSnapshots() {
    if (!fs.existsSync(backupRoot())) return [];
    return fs.readdirSync(backupRoot(), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
            const dir = path.join(backupRoot(), e.name);
            let info = null;
            try {
                info = JSON.parse(fs.readFileSync(path.join(dir, 'SNAPSHOT_INFO.json'), 'utf-8'));
            } catch { /* 手工建的目录没有 info，也算一份快照 */ }
            return { id: e.name, dir, reason: info?.reason ?? null, createdAt: info?.createdAt ?? null, files: info?.files ?? null };
        })
        .sort((a, b) => (a.id < b.id ? 1 : -1));
}

/**
 * 写一个档案文件到 data/：走 jsonStore.writeJson（原子 + fsync），
 * 但写的是**档案里的那份原始结构**，不经过任何引擎的归一化。
 */
export function writeArchiveFile(name, content) {
    return writeJson(name, content);
}

/**
 * 导入一份档案：快照 → 写文件 → 逐个热加载。
 *
 * 任一文件写失败就停下并把已写的部分如实报告（不假装成功）。
 * reload 失败（例如某个引擎缺方法）不回滚 —— 文件已经是新的，
 * 回滚反而更容易出现「文件一份、内存另一份」的分裂；这里如实报告并建议重启。
 *
 * @param {Record<string, object>} files
 * @param {object} services 容器单例
 * @param {{reason?: string}} [opts]
 */
export function applyArchive(files, services, { reason = 'import' } = {}) {
    const snapshot = createSnapshot(`pre-${reason}`, new Date());
    const written = [];
    const writeFailed = [];
    const reloaded = [];
    const reloadFailed = [];

    for (const entry of ARCHIVE_FILES) {
        const content = files[entry.file];
        if (content === undefined || content === null) continue;
        if (!writeArchiveFile(entry.file, content)) {
            writeFailed.push(entry.file);
            continue;
        }
        written.push(entry.file);
        try {
            const r = entry.reload(services);
            if (r === undefined && !entry.reload) reloadFailed.push(entry.file);
            else reloaded.push(entry.file);
        } catch (e) {
            console.error(`[Backup] 热加载 ${entry.file} 失败: ${e.message}`);
            reloadFailed.push(entry.file);
        }
    }
    return { snapshot, written, writeFailed, reloaded, reloadFailed };
}

/** 从某个快照恢复（等于把那份快照当成档案导入） */
export function restoreSnapshot(id, services) {
    const dir = path.join(backupRoot(), String(id));
    const real = path.resolve(dir);
    if (!real.startsWith(path.resolve(backupRoot()))) {
        throw Object.assign(new Error('快照 id 不合法'), { status: 400 });
    }
    if (!fs.existsSync(real)) throw Object.assign(new Error('快照不存在'), { status: 404 });
    const files = {};
    for (const entry of ARCHIVE_FILES) {
        const p = path.join(real, entry.file);
        if (!fs.existsSync(p)) continue;
        try { files[entry.file] = JSON.parse(fs.readFileSync(p, 'utf-8')); }
        catch (e) { throw Object.assign(new Error(`快照里的 ${entry.file} 已损坏：${e.message}`), { status: 400 }); }
    }
    if (!Object.keys(files).length) throw Object.assign(new Error('这份快照里没有任何数据文件'), { status: 400 });
    return { applied: applyArchive(files, services, { reason: `restore-${id}` }), restoredFrom: id };
}

/** 档案里是否含 Key 材料（导出后自检：这是最不该发生的泄漏） */
export function scanForSecrets(archive) {
    const text = JSON.stringify(archive);
    const hits = [];
    if (/(sk-[A-Za-z0-9_-]{12,})/.test(text)) hits.push('疑似 API Key 字符串');
    if (/"api_?key"\s*:\s*"sk-/i.test(text)) hits.push('api_key 字段带真实 Key');
    if (/Bearer\s+[A-Za-z0-9._-]{16,}/.test(text)) hits.push('Authorization Bearer 值');
    if (dataDir() && text.includes(path.basename(dataDir()) + path.sep)) hits.push('疑似绝对数据目录路径');
    return hits;
}
