/**
 * 语音路由：/audio/speak (TTS)、/audio/transcribe (ASR)
 */
import { Router } from 'express';
import fs from 'fs';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { voiceEngine } from '../services/container.js';
import { config } from '../config.js';
import multer from 'multer';

const router = Router();
const upload = multer({ dest: config.upload.dir, limits: { fileSize: config.upload.maxFileSize } });

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
