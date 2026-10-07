"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { isTtsConfigured } from "@/lib/storage";
import { toast } from "@/stores/uiStore";

/**
 * 麦克风录音 + 语音转文字。
 * 录音结束后将文本交给 onTranscribed，是否自动发送由调用方决定。
 * 语音转文字与朗读共用独立的 TTS Key：未配置时不发起转写并明确提示。
 *
 * 两条纪律（FE-12 / FE-15）：
 * 1. **单实例**：`startingRef` 守住 getUserMedia 这个 await 窗口。旧写法在权限弹窗
 *    还没回来时 `isRecording` 仍是 false，连点两次会开两路麦克风和两个 MediaRecorder，
 *    第二个 onstop 覆盖第一个，录到的音频一半都不知去哪了。
 * 2. **秒数不进 React state**：计时改成「起始时间戳 + 按钮内部自绘」，
 *    录音时不再每秒把整棵 ChatPage（含消息列表）重渲染一遍。
 */
export function useVoiceRecorder(onTranscribed: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  /** 本次录音的开始时刻（ms）；未录音时为 null。计时由按钮自己画 */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  /** 申请麦克风到 recorder.start() 之间的闸门（防并发开第二路录音） */
  const startingRef = useRef(false);
  const onTranscribedRef = useRef(onTranscribed);

  useEffect(() => {
    onTranscribedRef.current = onTranscribed;
  }, [onTranscribed]);

  /** 放掉麦克风：轨道不 stop 就是「浏览器绿点常亮」，用户会以为一直在录 */
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setMediaStream(null);
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (startingRef.current || mediaRecorderRef.current) return;
    startingRef.current = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        toast("这个浏览器不支持录音，请改用 Chrome / Edge", "error");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMediaStream(stream);
      audioChunksRef.current = [];
      setStartedAt(Date.now());

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        mediaRecorderRef.current = null;
        setStartedAt(null);
        setIsRecording(false);
        releaseStream();

        // 未配置专属 TTS Key：云端转写不可用，直接提示而不是录完静默无结果
        if (!isTtsConfigured()) {
          toast("语音转文字需要 OpenAI TTS 密钥，请在 设置 → 语音 中配置", "info");
          return;
        }

        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        if (audioBlob.size === 0) {
          toast("没录到声音，再说长一点试试？", "info");
          return;
        }
        // transcribe 现在返回结果对象而不是 null：转写失败必须说得出是「后端没起来」
        // 还是「服务商拒了」，静默吞掉时用户只会反复重录（FE-15）
        const result = await api.transcribe(audioBlob);
        if (result.ok) {
          if (result.text.trim()) onTranscribedRef.current(result.text);
          else toast("没听清，再说一次？", "info");
          return;
        }
        const err = result.error;
        toast(
          err.isNetworkError
            ? "转写失败了：连不上后端，小爱听不到刚才的话"
            : `转写失败：${err.userMessage}`,
          "error"
        );
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (e) {
      // 失败分型（FE-15）：无设备 / 被拒绝 / 被占用是三件事，一句话糊在一起用户不知道该做什么
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        toast("没找到麦克风，检查一下设备是否插好", "error");
      } else if (name === "NotAllowedError" || name === "SecurityError") {
        toast("麦克风权限被拒绝，请在浏览器地址栏把权限改成「允许」", "error");
      } else if (name === "NotReadableError") {
        toast("麦克风被其他程序占用，关掉那个软件再试", "error");
      } else {
        console.error("[VoiceRecorder] start failed:", e);
        toast("录音启动失败，请重试", "error");
      }
      releaseStream();
      setIsRecording(false);
      setStartedAt(null);
    } finally {
      startingRef.current = false;
    }
  }, [releaseStream]);

  const toggleRecording = useCallback(() => {
    if (isRecording || mediaRecorderRef.current) {
      stopRecording();
    } else {
      void startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // 卸载时停掉录音并放掉音频轨道（组件被换掉也不能让麦克风绿点亮着）
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // 注意：这里**不返回 recordingTime**。秒数一旦进 state，ChatPage 每秒就要重渲染一次
  // （含整条消息列表）；改交 startedAt，计时由 RecordButton 自己画（FE-12）。
  return { isRecording, startedAt, mediaStream, toggleRecording };
}

/** 由开始时刻算已录秒数（纯函数，供 RecordButton 与测试使用） */
export const elapsedSeconds = (startedAt: number | null, now: number): number =>
  startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
