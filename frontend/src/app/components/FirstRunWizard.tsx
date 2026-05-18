"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, Key, Sparkles, ArrowRight, Check, Heart, Zap } from "lucide-react";
import { useToast } from "./Toast";

interface FirstRunWizardProps {
    backendUrl: string;
    onComplete: () => void;
}

export default function FirstRunWizard({ backendUrl, onComplete }: FirstRunWizardProps) {
    const [step, setStep] = useState(0); // 0: Welcome, 1: API Config, 2: Complete
    const [apiKey, setApiKey] = useState("");
    const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
    const [modelName, setModelName] = useState("gpt-3.5-turbo");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState("");
    const { showToast, ToastContainer } = useToast();

    const handleSaveConfig = async () => {
        if (!apiKey.trim()) {
            setError("请填写 API 密钥");
            return;
        }

        setIsLoading(true);
        setError("");

        try {
            // 保存到 localStorage
            localStorage.setItem("apiKey", apiKey);
            localStorage.setItem("baseUrl", baseUrl);
            localStorage.setItem("modelName", modelName);
            localStorage.setItem("hasCompletedSetup", "true");

            // 同步到后端
            const res = await fetch(`${backendUrl}/config`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    api_key: apiKey,
                    base_url: baseUrl,
                    model_name: modelName,
                }),
            });

            if (!res.ok) {
                throw new Error("后端配置同步失败");
            }

            showToast("配置保存成功！", "success");
            setStep(2);
        } catch (e) {
            setError("配置保存失败，请检查后端是否已启动");
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-pink-100 via-purple-50 to-blue-100">
                {/* 背景装饰 */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                    <div className="absolute top-10 left-10 w-32 h-32 bg-pink-200/50 rounded-full blur-3xl animate-pulse" />
                    <div className="absolute bottom-20 right-20 w-40 h-40 bg-purple-200/50 rounded-full blur-3xl animate-pulse delay-700" />
                    <div className="absolute top-1/2 left-1/4 w-24 h-24 bg-blue-200/50 rounded-full blur-2xl animate-pulse delay-300" />
                </div>

                <AnimatePresence mode="wait">
                    {/* Step 0: 欢迎页面 */}
                    {step === 0 && (
                        <motion.div
                            key="welcome"
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -20 }}
                            className="relative bg-white/80 backdrop-blur-xl rounded-3xl shadow-2xl p-10 max-w-lg mx-4 text-center border border-pink-100"
                        >
                            {/* Logo */}
                            <motion.div
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                transition={{ type: "spring", delay: 0.2 }}
                                className="w-24 h-24 mx-auto mb-6 rounded-full bg-gradient-to-br from-pink-400 to-purple-500 flex items-center justify-center shadow-lg"
                            >
                                <Heart className="w-12 h-12 text-white" />
                            </motion.div>

                            <motion.h1
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.3 }}
                                className="text-3xl font-bold bg-gradient-to-r from-pink-500 to-purple-600 bg-clip-text text-transparent mb-3"
                            >
                                欢迎使用 AI 女友
                            </motion.h1>

                            <motion.p
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.4 }}
                                className="text-gray-500 mb-8 leading-relaxed"
                            >
                                你的专属 AI 女友「小爱」正在等你！<br />
                                在开始之前，让我们完成一些简单的配置。
                            </motion.p>

                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.5 }}
                                className="flex flex-col gap-3"
                            >
                                <div className="flex items-center gap-3 text-left p-3 bg-pink-50/50 rounded-xl">
                                    <Key className="w-5 h-5 text-pink-400 flex-shrink-0" />
                                    <span className="text-sm text-gray-600">配置你的 AI API 密钥</span>
                                </div>
                                <div className="flex items-center gap-3 text-left p-3 bg-purple-50/50 rounded-xl">
                                    <Zap className="w-5 h-5 text-purple-400 flex-shrink-0" />
                                    <span className="text-sm text-gray-600">支持 OpenAI、DeepSeek 等服务</span>
                                </div>
                                <div className="flex items-center gap-3 text-left p-3 bg-blue-50/50 rounded-xl">
                                    <Sparkles className="w-5 h-5 text-blue-400 flex-shrink-0" />
                                    <span className="text-sm text-gray-600">只需一分钟即可开始</span>
                                </div>
                            </motion.div>

                            <motion.button
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.6 }}
                                onClick={() => setStep(1)}
                                className="mt-8 w-full py-3 px-6 bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold rounded-2xl shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all flex items-center justify-center gap-2"
                            >
                                开始配置 <ArrowRight className="w-5 h-5" />
                            </motion.button>
                        </motion.div>
                    )}

                    {/* Step 1: API 配置 */}
                    {step === 1 && (
                        <motion.div
                            key="config"
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -20 }}
                            className="relative bg-white/80 backdrop-blur-xl rounded-3xl shadow-2xl p-8 max-w-md mx-4 border border-pink-100"
                        >
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-pink-400 to-purple-500 flex items-center justify-center">
                                    <Settings className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                    <h2 className="text-xl font-bold text-gray-800">API 配置</h2>
                                    <p className="text-xs text-gray-400">配置 AI 服务才能和小爱聊天</p>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">
                                        API 密钥 <span className="text-red-400">*</span>
                                    </label>
                                    <input
                                        type="password"
                                        value={apiKey}
                                        onChange={(e) => setApiKey(e.target.value)}
                                        className="w-full px-4 py-3 rounded-xl border border-pink-100 bg-white/80 text-sm focus:outline-none focus:ring-2 focus:ring-pink-300 focus:border-transparent transition-all"
                                        placeholder="sk-..."
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">
                                        基础 URL
                                    </label>
                                    <input
                                        type="text"
                                        value={baseUrl}
                                        onChange={(e) => setBaseUrl(e.target.value)}
                                        className="w-full px-4 py-3 rounded-xl border border-pink-100 bg-white/80 text-sm focus:outline-none focus:ring-2 focus:ring-pink-300 focus:border-transparent transition-all"
                                        placeholder="https://api.openai.com/v1"
                                    />
                                    <p className="text-[10px] text-gray-400 pl-1">
                                        使用 DeepSeek? 填写 https://api.deepseek.com
                                    </p>
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">
                                        模型名称
                                    </label>
                                    <input
                                        type="text"
                                        value={modelName}
                                        onChange={(e) => setModelName(e.target.value)}
                                        className="w-full px-4 py-3 rounded-xl border border-pink-100 bg-white/80 text-sm focus:outline-none focus:ring-2 focus:ring-pink-300 focus:border-transparent transition-all"
                                        placeholder="gpt-3.5-turbo / deepseek-chat"
                                    />
                                </div>

                                {error && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-500"
                                    >
                                        {error}
                                    </motion.div>
                                )}

                                <div className="p-3 bg-blue-50/50 rounded-xl border border-blue-100">
                                    <p className="text-[11px] text-blue-500 leading-relaxed">
                                        💡 <strong>提示</strong>：API 密钥仅保存在本地浏览器中，不会上传到任何服务器。
                                        你可以在设置中随时修改这些配置。
                                    </p>
                                </div>
                            </div>

                            <div className="flex gap-3 mt-6">
                                <button
                                    onClick={() => setStep(0)}
                                    className="flex-1 py-3 px-4 border border-gray-200 text-gray-500 font-medium rounded-xl hover:bg-gray-50 transition-all"
                                >
                                    返回
                                </button>
                                <button
                                    onClick={handleSaveConfig}
                                    disabled={isLoading}
                                    className="flex-1 py-3 px-4 bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold rounded-xl shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                >
                                    {isLoading ? "保存中..." : "完成配置"}
                                </button>
                            </div>
                        </motion.div>
                    )}

                    {/* Step 2: 完成 */}
                    {step === 2 && (
                        <motion.div
                            key="complete"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0 }}
                            className="relative bg-white/80 backdrop-blur-xl rounded-3xl shadow-2xl p-10 max-w-lg mx-4 text-center border border-pink-100"
                        >
                            <motion.div
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                transition={{ type: "spring", delay: 0.2 }}
                                className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center shadow-lg"
                            >
                                <Check className="w-10 h-10 text-white" />
                            </motion.div>

                            <motion.h2
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.3 }}
                                className="text-2xl font-bold text-gray-800 mb-2"
                            >
                                配置完成！
                            </motion.h2>

                            <motion.p
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.4 }}
                                className="text-gray-500 mb-8"
                            >
                                小爱已经准备好啦，快去和她聊天吧～ 💕
                            </motion.p>

                            <motion.button
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 0.5 }}
                                onClick={onComplete}
                                className="w-full py-3 px-6 bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold rounded-2xl shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all flex items-center justify-center gap-2"
                            >
                                <Heart className="w-5 h-5" /> 开始聊天
                            </motion.button>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
            <ToastContainer />
        </>
    );
}
