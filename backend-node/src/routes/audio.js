/**
 * 语音路由：/audio/speak (TTS)、/audio/transcribe (ASR)
 *
 * 入参边界（审计 HTTP-16）：这三条以前全都没有 ——
 *   1. 任何扩展名都能上传（含 .exe），文件名直接取自客户端的 originalname，
 *      超长扩展名会让磁盘写入抛 ENAMETOOLONG 并落成 500；
 *   2. 超过 maxFileSize 时 multer 抛原始错误，用户看到的是 500 而不是 413；
 *   3. /audio/speak 的 text 没做类型判定，传数字会在 Voice 里 .slice() 抛 TypeError。
 * 上传只接受音频扩展名白名单，且开机清扫上次崩溃留在 temp_uploads/ 的残file。
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { voiceEngine } from '../services/container.js';
import { config } from '../config.js';

const router = Router();

/**
 * 允许的音频扩展名（Whisper 支持的格式 + 浏览器 MediaRecorder 实际产出的 webm/ogg）。
 * 真源就这一份：multer 的 fileFilter 与错误文案都读它，避免两处不同步。
 */
export const ALLOWED_AUDIO_EXTENSIONS = Object.freeze([
    '.webm', '.ogg', '.oga', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.opus', '.mp4',
]);

/** originalname 的合法最大长度：文件名本身由服务端生成，但扩展名取自客户端，必须截 */
const ORIGINAL_NAME_MAX = 255;

/**
 * 从客户端文件名里取一个**白名单内**的扩展名。
 * @returns {string|null} 合法扩展名（含点，小写）；不在白名单内返回 null
 */
export function pickAudioExtension(originalname) {
    const raw = String(originalname ?? '');
    if (!raw || raw.length > ORIGINAL_NAME_MAX) return null;
    // path.extname 对 "a.tar.gz" 给 ".gz"、对 "noext" 给 ""，都按「不合法」处理
    const ext = path.extname(raw).toLowerCase();
    return ALLOWED_AUDIO_EXTENSIONS.includes(ext) ? ext : null;
}

/** 带 status 的上传错误：errorHandler 会把 4xx 的 message 透传给用户 */
function uploadError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// 用 diskStorage 保留原始扩展名：multer 的 dest 写法会把上传文件存成无扩展名临时文件，
// 而 Whisper 靠扩展名识别音频格式，无扩展名的 recording 直接转写失败。
fs.mkdirSync(config.upload.dir, { recursive: true });

/**
 * 开机清扫 temp_uploads/：上传文件在 transcribe 的 finally 里删除，
 * 但进程被强杀/崩溃时那些带着用户语音的临时文件会永远留在磁盘上。
 */
export function cleanupUploadDir(dir = config.upload.dir) {
    let removed = 0;
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!name.startsWith('upload-')) continue;      // 只清自己生成的文件
            try {
                fs.rmSync(path.join(dir, name), { force: true });
                removed++;
            } catch { /* 单个文件删不掉不影响其它 */ }
        }
    } catch (e) {
        console.error(`[Audio] 清扫上传目录失败: ${e.message}`);
    }
    if (removed) console.log(`[Audio] 开机清扫 temp_uploads：删除 ${removed} 个残留文件`);
    return removed;
}
cleanupUploadDir();

const upload = multer({
    storage: multer.diskStorage({
        destination: config.upload.dir,
        filename: (_req, file, cb) => {
            // 扩展名已在 fileFilter 里验过白名单，这里必然有值；兜底给 .webm
            const ext = pickAudioExtension(file.originalname) || '.webm';
            cb(null, `upload-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
        },
    }),
    // 非音频文件在**落盘之前**就被拒（fileFilter 早于 storage 写文件）
    fileFilter: (_req, file, cb) => {
        const ext = pickAudioExtension(file.originalname);
        if (!ext) {
            cb(uploadError(415,
                `只接受音频文件（${ALLOWED_AUDIO_EXTENSIONS.join('/')}），收到：` +
                String(file.originalname ?? '').slice(0, 60)));
            return;
        }
        cb(null, true);
    },
    limits: {
        fileSize: config.upload.maxFileSize,
        files: config.upload.maxFiles,
        // multipart 部件名/字段名也限长度：否则一个 100KB 的字段名会先进内存再报错
        fieldNameSize: 200,
        headerPairs: 2000,
    },
});

/** multer 的原始错误码翻成用户看得懂的中文 + 正确 HTTP 状态码 */
const uploadHandler = upload.single('file');
function receiveAudio(req, res, next) {
    uploadHandler(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return next(uploadError(413,
                `录音文件超过上限 ${(config.upload.maxFileSize / 1024 / 1024).toFixed(0)}MB，请缩短后再发送`));
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return next(uploadError(400, '只允许上传一个名为 file 的音频部件'));
        }
        if (typeof err.status === 'number') return next(err);   // fileFilter 抛的可操作提示原样透传
        console.error(`[Audio] 上传解析失败: ${err.message || err}`);
        return next(uploadError(400, '上传请求格式不正确'));
    });
}

router.post('/audio/speak', asyncHandler(async (req, res) => {
    const { text } = req.body;
    // 类型 + 长度都要拦：旧写法只判 !text，传 123 会一路走到 Voice 的 text.slice() 抛 TypeError
    if (fail(res, typeof text !== 'string' || !text.trim(), 'text 必须是非空字符串')) return;
    if (fail(res, text.length > config.tts.maxRequestChars,
        `text 最长 ${config.tts.maxRequestChars} 个字符（收到 ${text.length}）`)) return;
    const filename = await voiceEngine.current.textToSpeech(text);
    res.json({ audio_url: `/static/audio/${filename}` });
}));

router.post('/audio/transcribe', receiveAudio, asyncHandler(async (req, res) => {
    if (fail(res, !req.file, 'File is required')) return;
    const tempPath = req.file.path;
    try {
        const text = await voiceEngine.current.speechToText(tempPath);
        res.json({ text });
    } finally {
        // 无论成功失败都清理临时上传文件
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        }
    }
}));

export default router;
