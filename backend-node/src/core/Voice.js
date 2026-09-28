import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { BACKEND_ROOT } from '../config.js';

dotenv.config();

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
    }

    async textToSpeech(text) {
        if (!this.openai) throw new Error("OpenAI API Key not configured");

        const speechFile = path.join(BACKEND_ROOT, 'static', 'audio', `${uuidv4()}.mp3`);

        // Ensure static/audio exists
        const dir = path.dirname(speechFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        try {
            const mp3 = await this.openai.audio.speech.create({
                model: "tts-1",
                voice: "nova", // Options: alloy, echo, fable, onyx, nova, shimmer
                input: text,
            });

            const buffer = Buffer.from(await mp3.arrayBuffer());
            await fs.promises.writeFile(speechFile, buffer);

            return path.basename(speechFile);
        } catch (e) {
            // 捕获 OpenAI 特定错误并剥离敏感信息
            if (e.status === 401) {
                throw new Error("Invalid OpenAI API Key. Please check your settings.");
            }
            throw e;
        }
    }

    async speechToText(filePath) {
        if (!this.openai) throw new Error("OpenAI API Key not configured");

        const transcription = await this.openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-1",
            language: "zh" // Optimization for Chinese
        });

        return transcription.text;
    }
}

export default VoiceEngine;
