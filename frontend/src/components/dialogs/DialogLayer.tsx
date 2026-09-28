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
 * 弹窗注册表：按名称集中渲染，开关状态在 uiStore。
 * 各弹窗需要的状态自行从 store 订阅，不再由 page 透传。
 */
export default function DialogLayer() {
  const dialog = useUiStore((s) => s.dialog);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const messages = useChatStore((s) => s.messages);

  return (
    <>
      <Modal isOpen={dialog === "theme"} onClose={closeDialog}>
        <ThemeDialog onClose={closeDialog} />
      </Modal>

      <Modal isOpen={dialog === "export"} onClose={closeDialog}>
        <ExportDialog messages={messages} onClose={closeDialog} />
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
