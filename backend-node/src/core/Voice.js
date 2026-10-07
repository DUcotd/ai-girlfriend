import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { BACKEND_ROOT, config } from '../config.js';
import { ERROR_CODES } from '../utils/errorCodes.js';

dotenv.config();

const AUDIO_DIR = path.join(BACKEND_ROOT, 'static', 'audio');
/** TTS 产物保留时长：超时即清（前端拿到 URL 后立即播放，正常远小于该值） */
const AUDIO_TTL_MS = 60 * 60 * 1000;
/** 清理扫描周期 */
const AUDIO_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
/**
 * OpenAI tts-1 的输入上限是 4096 字符，超出直接 400 —— 超长文本截断朗读而不是整体失败。
 * 数值本身在 config.js 的 tts.maxInputChars（项目约定：运行时数字集中在 config）。
 */

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
            // 带 status + errorCode 抛出：errorHandler 原样透传，前端才能给可操作提示。
            // detail 会被界面直接显示，所以必须是中文（B4-5 之后全站用户可见文案中文，
            // 英文原文只在日志里）
            const err = new Error("还没配置语音服务的 API Key，朗读和转写暂时用不了");
            err.status = 400;
            err.errorCode = ERROR_CODES.VOICE_NOT_CONFIGURED;
            throw err;
        }
        // 纵深防御：路由层已经拦过类型，这里再守一道 —— 旧写法 `text.slice(...)`
        // 收到数字/对象会抛 TypeError 并落成 500（审计 HTTP-16）
        if (typeof text !== 'string' || !text.trim()) {
            const err = new Error("text 必须是非空字符串");
            err.status = 400;
            err.errorCode = ERROR_CODES.INVALID_REQUEST;
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
                input: text.slice(0, config.tts.maxInputChars),
            });

            const buffer = Buffer.from(await mp3.arrayBuffer());
            await fs.promises.writeFile(speechFile, buffer);

            return path.basename(speechFile);
        } catch (e) {
            // 捕获 OpenAI 特定错误并剥离敏感信息
            if (e.status === 401) {
                // 中文 detail + 指明去哪一格改（设置 → 语音），界面不用再自己编一份文案
                const err = new Error("语音服务的 API Key 无效或额度不足，请在设置页「语音」里检查");
                err.status = 401;
                err.errorCode = ERROR_CODES.VOICE_AUTH_FAILED;
                throw err;
            }
            throw e;
        }
    }

    async speechToText(filePath) {
        if (!this.openai) {
            // detail 会被界面直接显示，所以必须是中文（B4-5 之后全站用户可见文案中文，
            // 英文原文只在日志里）；带 status + errorCode 抛出，errorHandler 原样透传
            const err = new Error("还没配置语音服务的 API Key，朗读和转写暂时用不了");
            err.status = 400;
            err.errorCode = ERROR_CODES.VOICE_NOT_CONFIGURED;
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
