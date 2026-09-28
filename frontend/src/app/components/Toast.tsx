"use client";

import { motion } from "framer-motion";
import { X, AlertCircle, CheckCircle, Info } from "lucide-react";
import { useEffect } from "react";
import { useUiStore } from "@/stores/uiStore";
import type { ToastType } from "@/stores/uiStore";

interface ToastProps {
    message: string;
    type: ToastType;
    onClose: () => void;
    duration?: number;
}

/** 单条 toast（纯展示）。渲染容器是 layout 里的 ToastViewport（全局唯一）。 */
export default function Toast({ message, type, onClose, duration = 3000 }: ToastProps) {
    useEffect(() => {
        const timer = setTimeout(onClose, duration);
        return () => clearTimeout(timer);
    }, [duration, onClose]);

    const icons = {
        success: <CheckCircle className="w-5 h-5 text-green-500" />,
        error: <AlertCircle className="w-5 h-5 text-red-500" />,
        info: <Info className="w-5 h-5 text-blue-500" />,
    };

    const colors = {
        success: "bg-green-50 border-green-200",
        error: "bg-red-50 border-red-200",
        info: "bg-blue-50 border-blue-200",
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className={`fixed top-4 right-4 z-[100] flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-lg backdrop-blur-sm ${colors[type]}`}
        >
            {icons[type]}
            <span className="text-sm text-gray-700">{message}</span>
            <button
                onClick={onClose}
                className="p-1 hover:bg-white/50 rounded-full transition-colors"
            >
                <X size={16} className="text-gray-400" />
            </button>
        </motion.div>
    );
}

/**
 * 全局 toast 入口：返回 pushToast（uiStore action，引用稳定）。
 * 组件不再各自渲染 ToastContainer——统一由 ToastViewport 渲染，
 * 弹窗内的 toast 也不会再被 Modal 遮罩盖住。
 */
export function useToast() {
    return useUiStore((s) => s.pushToast);
}
