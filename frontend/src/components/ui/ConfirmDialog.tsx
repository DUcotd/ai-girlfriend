"use client";

import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, X } from "lucide-react";

interface ConfirmDialogProps {
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: "danger" | "warning" | "normal";
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ConfirmDialog({
    isOpen,
    title,
    message,
    confirmText = "确认",
    cancelText = "取消",
    type = "normal",
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const colors = {
        danger: {
            icon: "text-status-danger",
            iconBg: "bg-status-danger/15",
            button: "bg-status-danger text-white hover:bg-status-danger/85",
        },
        warning: {
            icon: "text-status-warning",
            iconBg: "bg-status-warning/15",
            button: "bg-status-warning text-white hover:bg-status-warning/85",
        },
        normal: {
            icon: "text-accent-1",
            iconBg: "bg-accent-1/15",
            button: "bg-gradient-to-br from-accent-1 to-accent-2 text-white shadow-accent",
        },
    };

    const style = colors[type];

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onCancel}
                        className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm"
                    />

                    {/* Dialog */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        transition={{ type: "spring", damping: 25, stiffness: 300 }}
                        className="fixed left-1/2 top-1/2 z-[201] w-[90%] max-w-[360px] -translate-x-1/2 -translate-y-1/2"
                    >
                        <div className="space-y-4 rounded-[28px] border border-accent-1/20 bg-surface-1/95 p-5 text-content-primary shadow-modal backdrop-blur-[30px]">
                            {/* Header */}
                            <div className="flex items-start gap-3">
                                <div className={`rounded-xl p-2 ${style.iconBg}`}>
                                    <AlertTriangle className={`h-5 w-5 ${style.icon}`} />
                                </div>
                                <div className="flex-1">
                                    <h3 className="font-bold text-content-primary">{title}</h3>
                                    <p className="mt-1 whitespace-pre-line text-sm text-content-secondary">{message}</p>
                                </div>
                                <button
                                    onClick={onCancel}
                                    className="rounded-full p-1 transition-colors hover:bg-surface-2"
                                >
                                    <X size={18} className="text-content-muted" />
                                </button>
                            </div>

                            {/* Actions */}
                            <div className="flex justify-end gap-2 pt-2">
                                <button
                                    onClick={onCancel}
                                    className="rounded-xl px-4 py-2 text-sm text-content-secondary transition-colors hover:bg-surface-2"
                                >
                                    {cancelText}
                                </button>
                                <button
                                    onClick={onConfirm}
                                    className={`rounded-xl px-4 py-2 text-sm transition-all ${style.button}`}
                                >
                                    {confirmText}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
