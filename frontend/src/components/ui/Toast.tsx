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
        success: <CheckCircle className="h-5 w-5 text-status-success" />,
        error: <AlertCircle className="h-5 w-5 text-status-danger" />,
        info: <Info className="h-5 w-5 text-status-info" />,
    };

    const borders = {
        success: "border-status-success/30",
        error: "border-status-danger/30",
        info: "border-status-info/30",
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            // 定位交给外层 ToastViewport（按 idx 堆叠）；这里再写 fixed top/right
            // 会自成包含块、让外层的堆叠偏移失效，多条 toast 全部叠在同一点
            className={`flex items-center gap-3 rounded-2xl border bg-surface-1/95 px-4 py-3 shadow-lg backdrop-blur-sm ${borders[type]}`}
        >
            {icons[type]}
            <span className="text-sm text-content-primary">{message}</span>
            <button
                onClick={onClose}
                className="rounded-full p-1 transition-colors hover:bg-surface-2"
            >
                <X size={16} className="text-content-muted" />
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
