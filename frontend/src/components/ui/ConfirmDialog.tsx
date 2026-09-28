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
            icon: "text-red-500",
            iconBg: "bg-red-100",
            button: "bg-red-500 hover:bg-red-600 text-white",
        },
        warning: {
            icon: "text-orange-500",
            iconBg: "bg-orange-100",
            button: "bg-orange-500 hover:bg-orange-600 text-white",
        },
        normal: {
            icon: "text-pink-500",
            iconBg: "bg-pink-100",
            button: "btn-cute",
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
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200]"
                    />

                    {/* Dialog */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        transition={{ type: "spring", damping: 25, stiffness: 300 }}
                        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[201] w-[90%] max-w-[360px]"
                    >
                        <div className="modal-glass p-5 space-y-4">
                            {/* Header */}
                            <div className="flex items-start gap-3">
                                <div className={`p-2 rounded-xl ${style.iconBg}`}>
                                    <AlertTriangle className={`w-5 h-5 ${style.icon}`} />
                                </div>
                                <div className="flex-1">
                                    <h3 className="font-bold text-gray-800">{title}</h3>
                                    <p className="text-sm text-gray-500 mt-1 whitespace-pre-line">{message}</p>
                                </div>
                                <button
                                    onClick={onCancel}
                                    className="p-1 hover:bg-gray-100 rounded-full transition-colors"
                                >
                                    <X size={18} className="text-gray-400" />
                                </button>
                            </div>

                            {/* Actions */}
                            <div className="flex gap-2 justify-end pt-2">
                                <button
                                    onClick={onCancel}
                                    className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded-xl transition-colors"
                                >
                                    {cancelText}
                                </button>
                                <button
                                    onClick={onConfirm}
                                    className={`px-4 py-2 text-sm rounded-xl transition-all ${style.button}`}
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
