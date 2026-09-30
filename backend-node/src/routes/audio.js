/**
 * 语音路由：/audio/speak (TTS)、/audio/transcribe (ASR)
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { voiceEngine } from '../services/container.js';
import { config } from '../config.js';
import multer from 'multer';

const router = Router();

// 用 diskStorage 保留原始扩展名：multer 的 dest 写法会把上传文件存成无扩展名临时文件，
// 而 Whisper 靠扩展名识别音频格式，无扩展名的 recording 直接转写失败。
// 浏览器录音是 webm，前端未提供扩展名时按 webm 兜底。
fs.mkdirSync(config.upload.dir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({
        destination: config.upload.dir,
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname) || '.webm';
            cb(null, `upload-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
        },
    }),
    limits: { fileSize: config.upload.maxFileSize },
});

router.post('/audio/speak', asyncHandler(async (req, res) => {
    const { text } = req.body;
    if (fail(res, !text, 'Text is required')) return;
    const filename = await voiceEngine.current.textToSpeech(text);
    res.json({ audio_url: `/static/audio/${filename}` });
}));

router.post('/audio/transcribe', upload.single('file'), asyncHandler(async (req, res) => {
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
