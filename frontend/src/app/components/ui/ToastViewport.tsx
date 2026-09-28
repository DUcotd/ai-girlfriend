"use client";

import { AnimatePresence } from "framer-motion";
import Toast from "../Toast";
import { useUiStore } from "@/stores/uiStore";

/**
 * 全局唯一 toast 容器，挂在根布局。
 * 取代原来各组件 useToast 各自挂容器的模式（toast 无法跨组件复用、
 * 且弹窗内 toast 会被 Modal 遮罩盖住）。
 */
export default function ToastViewport() {
    const toasts = useUiStore((s) => s.toasts);
    const dismissToast = useUiStore((s) => s.dismissToast);

    return (
        <AnimatePresence>
            {toasts.map((toast, idx) => (
                <div
                    key={toast.id}
                    style={{ top: `${1 + idx * 4.5}rem` }}
                    className="fixed right-4 z-[100]"
                >
                    <Toast
                        message={toast.message}
                        type={toast.type}
                        onClose={() => dismissToast(toast.id)}
                    />
                </div>
            ))}
        </AnimatePresence>
    );
}
