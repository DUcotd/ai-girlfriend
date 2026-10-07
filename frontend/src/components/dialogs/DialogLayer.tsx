"use client";

import Modal from "../ui/Modal";
import ExportDialog from "./ExportDialog";
import MemoryDialog from "./MemoryDialog";
import SettingsDialog from "../settings/SettingsDialog";
import TaskDialog from "./TaskDialog";
import ThemeDialog from "../theme/ThemeDialog";
import { useChatStore } from "@/stores/chatStore";
import { useUiStore } from "@/stores/uiStore";

/**
 * 导出弹窗的数据订阅单独成组件：它只在「导出」真的开着时才挂载。
 *
 * 以前 DialogLayer 自己 `useChatStore(s => s.messages)`，
 * 而 Modal 的 children 是先求值再传给 Modal 的——也就是说流式回复每吐一个字符，
 * 整层弹窗（主题/设置/记忆/任务/导出 5 个 Modal + 各自子树）都会重渲染一遍，
 * 哪怕一个弹窗都没开。挪进这里之后：关闭状态下没人订阅 messages，
 * 打开状态下只有这一颗子树重渲染。
 */
function ExportDialogHost({ onClose }: { onClose: () => void }) {
  const messages = useChatStore((s) => s.messages);
  return <ExportDialog messages={messages} onClose={onClose} />;
}

/**
 * 弹窗注册表：按名称集中渲染，开关状态在 uiStore。
 * 各弹窗需要的状态自行从 store 订阅，不再由 page 透传。
 */
export default function DialogLayer() {
  const dialog = useUiStore((s) => s.dialog);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const exportOpen = dialog === "export";

  return (
    <>
      <Modal isOpen={dialog === "theme"} onClose={closeDialog}>
        <ThemeDialog onClose={closeDialog} />
      </Modal>

      <Modal isOpen={exportOpen} onClose={closeDialog}>
        {/* 关闭时给 null：不挂载就等于不订阅（AnimatePresence 会带着上一帧的内容淡出，不会闪掉） */}
        {exportOpen && <ExportDialogHost onClose={closeDialog} />}
      </Modal>

      <Modal isOpen={dialog === "settings"} onClose={closeDialog}>
        <SettingsDialog onClose={closeDialog} />
      </Modal>

      <Modal isOpen={dialog === "memory"} onClose={closeDialog}>
        <MemoryDialog onClose={closeDialog} />
      </Modal>

      <Modal isOpen={dialog === "task"} onClose={closeDialog}>
        <TaskDialog onClose={closeDialog} />
      </Modal>
    </>
  );
}
