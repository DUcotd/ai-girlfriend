/**
 * 语音合成（TTS）统一实现。
 * 原先 page.tsx 与 VoiceButton.tsx 各写了一份本地朗读逻辑，此处收敛为一份。
 */
/** 挑选中文女声（微软 TTS 常见音色），找不到则用系统默认 */
function pickChineseVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find(
      (v) =>
        (v.name.includes("Xiaoxiao") ||
          v.name.includes("Huihui") ||
          v.name.includes("Ting-Ting") ||
          v.name.includes("female")) &&
        v.lang.includes("zh")
    ) || null
  );
}

/** 浏览器本地朗读；onEnd 在朗读自然结束（或出错）时回调，供调用方复位 speaking 状态 */
export function speakLocal(text: string, onEnd?: () => void): void {
  if (!("speechSynthesis" in window)) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 1.1;
  utterance.pitch = 1.2;
  const voice = pickChineseVoice();
  if (voice) utterance.voice = voice;
  if (onEnd) {
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
  }
  window.speechSynthesis.speak(utterance);
}

/** 停止本地朗读 */
export function stopLocalSpeech(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
