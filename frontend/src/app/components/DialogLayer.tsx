"use client";

import Modal from "./ui/Modal";
import ExportDialog from "./ExportDialog";
import MemoryDialog from "./MemoryDialog";
import SettingsDialog from "./SettingsDialog";
import TaskDialog from "./TaskDialog";
import ThemeSwitcher from "./ThemeSwitcher";
import type { DialogName } from "@/app/dialogs";
import type { Message, TtsEngine } from "@/types";

interface DialogLayerProps {
  dialog: DialogName | null;
  onClose: () => void;
  messages: Message[];
  onAffinityChange: (affinity: number) => void;
  onTtsEngineChange: (engine: TtsEngine) => void;
}

/**
 * 弹窗注册表：原先 page.tsx 里堆了 5 个 <Modal>，各自绑一遍开关状态。
 * 这里按名称集中渲染，page 只需要维护一个 dialog 状态。
 */
export default function DialogLayer({
  dialog,
  onClose,
  messages,
  onAffinityChange,
  onTtsEngineChange,
}: DialogLayerProps) {
  return (
    <>
      <Modal isOpen={dialog === "theme"} onClose={onClose}>
        <ThemeSwitcher onClose={onClose} />
      </Modal>

      <Modal isOpen={dialog === "export"} onClose={onClose}>
        <ExportDialog messages={messages} onClose={onClose} />
      </Modal>

      <Modal isOpen={dialog === "settings"} onClose={onClose}>
        <SettingsDialog
          onClose={onClose}
          onConfigChange={(c) => onTtsEngineChange(c.ttsEngine)}
        />
      </Modal>

      <Modal isOpen={dialog === "memory"} onClose={onClose}>
        <MemoryDialog onClose={onClose} onStateChange={(state) => onAffinityChange(state.affinity)} />
      </Modal>

      <Modal isOpen={dialog === "task"} onClose={onClose}>
        <TaskDialog onClose={onClose} />
      </Modal>
    </>
  );
}
