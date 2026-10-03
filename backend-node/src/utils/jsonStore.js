/**
 * jsonStore - 统一的 JSON 持久化工具
 *
 * 职责：
 * 1. 所有持久化数据统一存放于 backend-node/data/（不再依赖 process.cwd()，
 *    从任意目录启动服务端，数据位置都一致）
 * 2. 写入使用「临时文件 + rename」原子操作，避免写一半崩溃损坏状态文件
 * 3. 一次性迁移旧版散落在 <repo>/memory_db/ 的数据文件
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { BACKEND_ROOT } from '../config.js';

/**
 * 数据目录：默认 backend-node/data，可用 AI_GIRLFRIEND_DATA_DIR 重定向。
 *
 * 为什么要能重定向：此前数据根锚死在 BACKEND_ROOT，测试只能对真实用户数据做
 * 「备份/还原」，一次断言崩溃或漏删就会污染真实档案（历史上真发生过）。
 * 现在所有 test-*.mjs 一律指向临时目录，data/ 在跑测试后 mtime 零变化。
 */
const DATA_DIR = process.env.AI_GIRLFRIEND_DATA_DIR
    ? path.resolve(process.env.AI_GIRLFRIEND_DATA_DIR)
    : path.join(BACKEND_ROOT, 'data');
// 旧版数据目录：backend-node/../memory_db
const LEGACY_DIR = path.resolve(BACKEND_ROOT, '..', 'memory_db');
const LEGACY_FILES = [
    'state.json',
    'memory.json',
    'emotion_state.json',
    'personality_state.json',
    'life_log.json',
    // 2026-10 审计补齐：这份清单曾长期落后于实际数据文件，旧库里的这些文件不会被迁移
    'tasks.json',
    'affinity_state.json',
    'proactive_state.json',
    'user_emotion_state.json',
    'narrative.json',
    'trigger_state.json',
];

/** 当前生效的数据目录（供 /health 与测试断言使用） */
export function dataDir() {
    return DATA_DIR;
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * 将旧版 <repo>/memory_db/ 中的数据文件迁移到 backend-node/data/。
 * 仅当目标不存在而旧文件存在时复制，幂等且不覆盖新数据。
 */
export function migrateLegacyData() {
    ensureDataDir();
    // 显式指定数据目录（测试/多实例）时不做迁移：迁移会把真实旧数据复制进临时目录，
    // 让「测试隔离」变成假象。
    if (process.env.AI_GIRLFRIEND_DATA_DIR) return;
    if (!fs.existsSync(LEGACY_DIR)) return;
    let migrated = 0;
    for (const file of LEGACY_FILES) {
        const legacyPath = path.join(LEGACY_DIR, file);
        const newPath = path.join(DATA_DIR, file);
        if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
            try {
                fs.copyFileSync(legacyPath, newPath);
                migrated++;
                console.log(`[jsonStore] Migrated legacy data: ${file}`);
            } catch (e) {
                console.error(`[jsonStore] Failed to migrate ${file}:`, e.message);
            }
        }
    }
    if (migrated > 0) {
        console.log(`[jsonStore] Migrated ${migrated} legacy file(s) to ${DATA_DIR}`);
    }
}

/** 返回 data/ 目录下的绝对路径（同时确保目录存在） */
export function dataPath(filename) {
    ensureDataDir();
    return path.join(DATA_DIR, filename);
}

/**
 * 读取 JSON 文件，不存在或解析失败时返回 fallback。
 *
 * 解析失败时把损坏文件改名 quarantine（*.corrupt-<时间戳>）保留现场再回退：
 * 否则调用方会拿着 fallback（通常是空状态）继续运行，下次 writeJson 把
 * fallback 原子覆盖回去，真实数据就永久丢了。隔离后数据可人工抢救。
 */
export function readJson(filename, fallback = null) {
    const filePath = dataPath(filename);
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.error(`[jsonStore] Read error (${filename}):`, e.message);
        try {
            const quarantined = `${filePath}.corrupt-${Date.now()}`;
            fs.renameSync(filePath, quarantined);
            console.warn(`[jsonStore] Corrupted file quarantined: ${quarantined}`);
        } catch (renameErr) {
            console.error(`[jsonStore] Failed to quarantine corrupted file:`, renameErr.message);
        }
        return fallback;
    }
}

/**
 * 原子写入 JSON 文件：先写临时文件再 rename。
 *
 * 三处加固（2026-10 审计 B0-6）：
 *  1. rename 前 `fsync`：否则崩溃时可能留下「已 rename 但内容半截」的文件，
 *     读回来是损坏 JSON，被隔离后状态直接回滚。
 *  2. 临时文件名带随机后缀：固定 `.tmp` 名在多实例（如 PORT=8100 临时实例）下
 *     会互相 rename 覆盖，把对方的内容写进本方目标文件。
 *  3. Windows 上 rename 到已存在文件常因杀软/索引句柄抛 EPERM：此时退化为
 *     直接覆盖写目标文件，并保留临时文件供人工排查 —— 而不是静默丢这一次写盘。
 *
 * @returns {boolean} 是否真正落盘成功。调用方必须把它计入自己的失败面（见 resetAll）。
 */
export function writeJson(filename, data) {
    const filePath = dataPath(filename);
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    try {
        const fd = fs.openSync(tmpPath, 'w');
        try {
            fs.writeFileSync(fd, payload, 'utf-8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        try {
            fs.renameSync(tmpPath, filePath);
        } catch (renameErr) {
            // EPERM/EBUSY：Windows 文件被占用的典型表现，退化为覆盖写
            if (![ 'EPERM', 'EBUSY', 'EACCES' ].includes(renameErr.code)) throw renameErr;
            fs.writeFileSync(filePath, payload, 'utf-8');
            console.warn(`[jsonStore] rename(${filename}) failed with ${renameErr.code}, fell back to direct write`);
        }
        return true;
    } catch (e) {
        console.error(`[jsonStore] Write error (${filename}):`, e.message);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        return false;
    }
}
