/**
 * 主动消息提示音：WebAudio 即时合成两声上行「叮咚」，
 * 替代此前指向不存在的 /notification.mp3 的 404 请求（每次播放都白打一次网络）。
 *
 * - AudioContext 惰性创建、模块级复用（播完不 close，避免反复创建开销）；
 * - 浏览器 autoplay 政策可能禁止无交互页面发声，静默忽略；
 * - 音量刻意压低（0.25），不与 TTS 朗读抢听觉焦点。
 */
let sharedCtx: AudioContext | null = null;

export function playNotificationSound(): void {
  try {
    if (!sharedCtx || sharedCtx.state === "closed") {
      sharedCtx = new AudioContext();
    }
    const ctx = sharedCtx;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    const now = ctx.currentTime;
    // E6 → A6：清脆的上行两音
    const notes = [
      { freq: 1318.51, start: 0 },
      { freq: 1760.0, start: 0.12 },
    ];

    for (const { freq, start } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;

      const t = now + start;
      // exponentialRamp 不允许 0，用极小值代替
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    }
  } catch {
    // WebAudio 不可用或自动播放被禁止：忽略
  }
}
