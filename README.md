# AI Girlfriend

情感陪伴型 AI 智能体，支持多轮对话、语音交互、向量记忆。

## 启动

```bash
# 终端 1 - 后端 (端口 8000)
cd backend-node
npm install
npm run dev

# 终端 2 - 前端 (端口 3000)
cd frontend
npm install
npm run dev
```

打开 http://localhost:3000，点击右上角设置图标配置 API Key 即可使用。

## 技术栈

- **前端**: Next.js 16 + TailwindCSS + Framer Motion
- **后端**: Node.js + Express
- **AI**: 兼容 OpenAI API（支持 OpenAI / DeepSeek / Claude 等）

## API 密钥

| 服务商 | Base URL | 模型 |
|--------|----------|------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |

## 许可证

MIT
