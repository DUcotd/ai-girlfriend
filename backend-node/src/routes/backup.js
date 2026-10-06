/**
 * 档案路由：/backup/* —— 全量导出 / 导入 / 快照（B5-12，审计 INFRA-12）。
 *
 * 语义上这是整个后端最危险的一组接口：导入会覆盖全部对话、记忆、好感度与性格。
 * 所以三条硬约束：
 *   1. 导入前一定先做快照（`pre-import`），失败还能 restore 回来；
 *   2. 校验不过就 400，绝不「先写进去再说」；
 *   3. 报告如实：哪些文件写了、哪些没写、哪些热加载失败，全部回给调用方。
 *      半成功被说成成功，是这类工具最伤人的失败方式（用户以为恢复好了）。
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { failWith } from '../middleware/validate.js';
import { config } from '../config.js';
import { dataDir } from '../utils/jsonStore.js';
import { backupServices } from '../services/container.js';
import {
    ARCHIVE_FILE_NAMES, buildArchive, validateArchive, applyArchive,
    createSnapshot, listSnapshots, restoreSnapshot, scanForSecrets, backupRoot,
} from '../core/backup.js';

const router = Router();

/** 读一份档案用的最大字节数（与 express.json 的 limit 同口径，超了直接拒） */
const MAX_ARCHIVE_BYTES = config.backup.maxExportMb * 1024 * 1024;

router.get('/backup/status', (req, res) => {
    res.json({
        dataDir: dataDir(),
        backupDir: backupRoot(),
        files: ARCHIVE_FILE_NAMES,
        keep: config.backup.keep,
        snapshots: listSnapshots(),
    });
});

/**
 * 导出一份完整档案（作为 .json 附件下载）。
 * 查询串 `?pretty=0` 关掉缩进，体积能小三成，给「先用脚本存下来」的人。
 */
router.get('/backup/export', asyncHandler(async (req, res) => {
    const pretty = req.query.pretty !== '0';
    const archive = await buildArchive(backupServices);

    // 自检：档案被下载后会转发、会上云盘，绝不能夹着 Key
    const leaks = scanForSecrets(archive);
    if (leaks.length) {
        // 宁可不出档案，也不能把凭据写进一个必然被到处复制的文件里
        return failWith(res, 500, `导出被中止：档案里检出疑似敏感信息（${leaks.join('；')}）`, 'backup_secret_leak');
    }

    const stamp = (archive.exportedAt || '').replace(/[:.]/g, '-');
    const body = pretty ? JSON.stringify(archive, null, 2) : JSON.stringify(archive);
    if (Buffer.byteLength(body, 'utf-8') > MAX_ARCHIVE_BYTES) {
        return failWith(res, 413, `档案体积超过 ${config.backup.maxExportMb}MB 上限，请先清理旧记忆再导出`, 'backup_too_large');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-girlfriend-archive-${stamp}.json"`);
    res.send(body);
}));

/** 手工快照（不导出，只在服务器本地留一份当前状态） */
router.post('/backup/snapshot', (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 40) : 'manual';
    const snap = createSnapshot(reason, new Date());
    res.json({ status: 'snapshot_created', dir: snap.dir, files: snap.files });
});

/** 导入一份档案（请求体就是导出的那个 JSON） */
router.post('/backup/import', asyncHandler(async (req, res) => {
    const { errors, warnings, files } = validateArchive(req.body);
    if (errors.length) {
        return failWith(res, 400, `档案校验未通过：${errors.join('；')}`, 'backup_invalid');
    }
    const report = applyArchive(files, backupServices, { reason: 'import' });
    const partial = report.writeFailed.length > 0;
    res.status(partial ? 500 : 200).json({
        status: partial ? 'partial' : 'imported',
        snapshot: report.snapshot.dir,
        written: report.written,
        writeFailed: report.writeFailed,
        reloaded: report.reloaded,
        // 热加载失败意味着「磁盘是新的、内存是旧的」，必须告诉用户要重启后端
        reloadFailed: report.reloadFailed,
        restartRecommended: report.reloadFailed.length > 0,
        warnings,
    });
}));

/** 从某份快照恢复（等价于把那份快照当档案导入，同样会先做 pre-restore 快照） */
router.post('/backup/restore', asyncHandler(async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    if (!id) return failWith(res, 400, '缺少快照 id（先用 GET /backup/status 看有哪些）', 'backup_bad_request');
    const known = listSnapshots().some((s) => s.id === id);
    if (!known) return failWith(res, 404, `找不到快照 ${id}`, 'backup_snapshot_not_found');
    const { applied, restoredFrom } = restoreSnapshot(id, backupServices);
    res.json({
        status: applied.writeFailed.length ? 'partial' : 'restored',
        restoredFrom,
        ...applied,
        snapshot: applied.snapshot.dir,
        restartRecommended: applied.reloadFailed.length > 0,
    });
}));

export default router;
