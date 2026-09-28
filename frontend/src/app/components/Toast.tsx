"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, AlertCircle, CheckCircle, Info } from "lucide-react";
import { useEffect, useState, useCallback } from "react";

interface ToastProps {
    message: string;
    type: "success" | "error" | "info";
    onClose: () => void;
    duration?: number;
}

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

// Toast Manager Hook
interface ToastState {
    message: string;
    type: "success" | "error" | "info";
    id: number;
}

let toastId = 0;

export function useToast() {
    const [toasts, setToasts] = useState<ToastState[]>([]);

    const showToast = useCallback((message: string, type: "success" | "error" | "info" = "info") => {
        const id = ++toastId;
        setToasts((prev) => [...prev, { message, type, id }]);
    }, []);

    const removeToast = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    // 直接返回 JSX 元素（而非在 useMemo 里新建组件）：
    // 避免每次 toasts 变化产生新的组件类型导致整棵子树 remount
    const ToastContainer = (
        <AnimatePresence>
            {toasts.map((toast, idx) => (
                <div key={toast.id} style={{ top: `${1 + idx * 4.5}rem` }} className="fixed right-4 z-[100]">
                    <Toast
                        message={toast.message}
                        type={toast.type}
                        onClose={() => removeToast(toast.id)}
                    />
                </div>
            ))}
        </AnimatePresence>
    );

    return { showToast, ToastContainer };
}
