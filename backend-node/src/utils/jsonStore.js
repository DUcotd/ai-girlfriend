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
import { BACKEND_ROOT } from '../config.js';

const DATA_DIR = path.join(BACKEND_ROOT, 'data');
// 旧版数据目录：backend-node/../memory_db
const LEGACY_DIR = path.resolve(BACKEND_ROOT, '..', 'memory_db');
const LEGACY_FILES = [
    'state.json',
    'memory.json',
    'emotion_state.json',
    'personality_state.json',
    'life_log.json',
];

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

/** 读取 JSON 文件，不存在或解析失败时返回 fallback */
export function readJson(filename, fallback = null) {
    const filePath = dataPath(filename);
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.error(`[jsonStore] Read error (${filename}):`, e.message);
        return fallback;
    }
}

/** 原子写入 JSON 文件：先写临时文件再 rename */
export function writeJson(filename, data) {
    const filePath = dataPath(filename);
    const tmpPath = `${filePath}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (e) {
        console.error(`[jsonStore] Write error (${filename}):`, e.message);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        return false;
    }
}
