import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { BACKEND_ROOT } from '../config.js';

dotenv.config();

const AUDIO_DIR = path.join(BACKEND_ROOT, 'static', 'audio');
/** TTS 产物保留时长：超时即清（前端拿到 URL 后立即播放，正常远小于该值） */
const AUDIO_TTL_MS = 60 * 60 * 1000;
/** 清理扫描周期 */
const AUDIO_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
/** OpenAI tts-1 的输入上限是 4096 字符，超出直接 400——超长文本截断朗读而不是整体失败 */
const TTS_MAX_INPUT_CHARS = 4000;

class VoiceEngine {
    constructor(config = {}) {
        // TTS/ASR 始终使用 OpenAI 官方 API（第三方 API 通常不支持）
        // API Key 需通过前端设置页面配置
        this.apiKey = config.apiKey || null;
        // 强制使用 OpenAI 官方 API，即使 chat 用的是其他 provider
        this.baseUrl = "https://api.openai.com/v1";

        this.openai = null;
        if (this.apiKey) {
            this.openai = new OpenAI({
                apiKey: this.apiKey,
                baseURL: this.baseUrl
            });
        }

        this._cleanupTimer = setInterval(() => this._cleanupOldAudio(), AUDIO_CLEANUP_INTERVAL_MS);
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();
        this._cleanupOldAudio();
    }

    /** 清理历史的 TTS 产物：每次朗读都会新建一个 mp3，没有清理逻辑磁盘会无限增长 */
    _cleanupOldAudio() {
        try {
            if (!fs.existsSync(AUDIO_DIR)) return;
            const cutoff = Date.now() - AUDIO_TTL_MS;
            for (const name of fs.readdirSync(AUDIO_DIR)) {
                if (!name.endsWith('.mp3')) continue;
                const full = path.join(AUDIO_DIR, name);
                try {
                    if (fs.statSync(full).mtimeMs < cutoff) {
                        fs.unlinkSync(full);
                    }
                } catch {
                    // 单个文件删除失败不影响其余清理
                }
            }
        } catch (e) {
            console.warn(`[Voice] audio cleanup failed: ${e.message || e}`);
        }
    }

    stop() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }

    async textToSpeech(text) {
        if (!this.openai) {
            // 带 status 抛出：errorHandler 会透传 status + message，前端才能给出可操作提示
            const err = new Error("OpenAI API Key not configured");
            err.status = 400;
            throw err;
        }

        const speechFile = path.join(AUDIO_DIR, `${uuidv4()}.mp3`);

        // Ensure static/audio exists
        const dir = path.dirname(speechFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        try {
            const mp3 = await this.openai.audio.speech.create({
                model: "tts-1",
                voice: "nova", // Options: alloy, echo, fable, onyx, nova, shimmer
                input: text.slice(0, TTS_MAX_INPUT_CHARS),
            });

            const buffer = Buffer.from(await mp3.arrayBuffer());
            await fs.promises.writeFile(speechFile, buffer);

            return path.basename(speechFile);
        } catch (e) {
            // 捕获 OpenAI 特定错误并剥离敏感信息
            if (e.status === 401) {
                const err = new Error("Invalid OpenAI API Key. Please check your settings.");
                err.status = 401;
                throw err;
            }
            throw e;
        }
    }

    async speechToText(filePath) {
        if (!this.openai) {
            const err = new Error("OpenAI API Key not configured");
            err.status = 400;
            throw err;
        }

        const transcription = await this.openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-1",
            language: "zh" // Optimization for Chinese
        });

        return transcription.text;
    }
}

export default VoiceEngine;
