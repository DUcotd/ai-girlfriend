"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * 麦克风录音 + 语音转文字。
 * 录音结束后将文本交给 onTranscribed，是否自动发送由调用方决定。
 */
export function useVoiceRecorder(onTranscribed: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTranscribedRef = useRef(onTranscribed);

  useEffect(() => {
    onTranscribedRef.current = onTranscribed;
  }, [onTranscribed]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMediaStream(stream);
      audioChunksRef.current = [];
      setRecordingTime(0);

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        setMediaStream(null);
        clearTimer();
        stream.getTracks().forEach((track) => track.stop());

        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const text = await api.transcribe(audioBlob);
        if (text) onTranscribedRef.current(text);
      };

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);

      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      alert("麦克风权限被拒绝");
    }
  }, [clearTimer]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
      setIsRecording(false);
      setRecordingTime(0);
      setMediaStream(null);
      clearTimer();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording, clearTimer]);

  // 卸载时清理定时器与音频轨道
  useEffect(() => {
    return () => {
      clearTimer();
      mediaRecorderRef.current?.stream
        .getTracks()
        .forEach((track) => track.stop());
    };
  }, [clearTimer]);

  return { isRecording, recordingTime, mediaStream, toggleRecording };
}
