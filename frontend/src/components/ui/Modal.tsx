"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { dialogCanClose } from "@/lib/dialogGuard";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 关联标题元素 id（无障碍名称）；不传则退回 aria-label="对话框" */
  ariaLabelledBy?: string;
}

/** 焦点陷阱：Tab 只在弹窗内部循环，不会跑到后面的聊天界面上 */
function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * 通用弹窗容器 —— 原先每个弹窗各自复制了一份遮罩 + 居中布局代码。
 * 点击遮罩关闭，点击内容区不关闭；Esc 键关闭。
 *
 * a11y（FE-10）：`role=dialog` + `aria-modal` 让读屏知道「背景已失效」；
 * 打开时把焦点移进弹窗、关闭时**归还**给打开它的那个按钮（否则键盘用户会掉回页首）；
 * Tab 被圈在弹窗里；背景滚动上锁，免得滚动条位置被弹窗改掉。
 * 关闭前经过 `dialogCanClose()`：设置页有未保存改动时这次关闭会被拦下并提示。
 */
export default function Modal({ isOpen, onClose, children, ariaLabelledBy }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const prevOverflow = useRef<string>("");

  // 打开：记下唤起点 → 聚焦弹窗 → 锁背景滚动；关闭/卸载：归还焦点 → 解锁
  useEffect(() => {
    if (!isOpen) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    prevOverflow.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 面板本身拿焦点（tabIndex=-1）：不自动聚焦第一个控件，免得 Enter 误触「保存」
    const panel = panelRef.current;
    panel?.focus();

    return () => {
      document.body.style.overflow = prevOverflow.current;
      const opener = openerRef.current;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) {
        opener.focus();
      }
    };
  }, [isOpen]);

  // Esc 关闭 + Tab 陷阱
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dialogCanClose()) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableWithin(panelRef.current);
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm"
          onClick={() => {
            if (dialogCanClose()) onClose();
          }}
        >
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={ariaLabelledBy}
            aria-label={ariaLabelledBy ? undefined : "对话框"}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            className="outline-none"
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
