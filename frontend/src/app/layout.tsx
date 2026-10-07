import type { Metadata, Viewport } from "next";
import SakuraEffect from "@/components/effects/SakuraEffect";
import MotionProvider from "@/components/ui/MotionProvider";
import ToastViewport from "@/components/ui/ToastViewport";
import "./globals.css";
import "../styles/tokens.css";
import "../styles/themes.css";
import "../styles/utilities.css";

export const metadata: Metadata = {
  title: "AI 女友 - 小爱",
  description: "情感陪伴型 AI 智能体",
};

/**
 * 视口：viewport-fit="cover" 让内容延伸到刘海/圆角区，
 * 配合 utilities.css 的 .pt-safe/.pb-safe/.ph-safe 把内容再收回安全区内
 * ——不 cover 的话 env(safe-area-inset-*) 恒为 0，输入框底部会被 Home 指示条压住。
 * 其余字段就是 Next 未导出 viewport 时的默认值，显式写出是为了能加 viewportFit。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * 防 FOUC：首帧绘制前同步设置 data-theme / data-mode。
 * 旧版没有独立模式时星空紫即暗色，此处做一次性迁移：
 * 已存 theme=starry 而无 themeMode 的用户按 dark 呈现。
 */
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme')||'sakura';if(['sakura','starry','ocean','forest'].indexOf(t)<0)t='sakura';var m=localStorage.getItem('themeMode');if(m!=='light'&&m!=='dark'){m=(t==='starry')?'dark':'light';}var d=document.documentElement;d.setAttribute('data-theme',t);d.setAttribute('data-mode',m);}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <MotionProvider>{children}</MotionProvider>
        <SakuraEffect />
        <ToastViewport />
      </body>
    </html>
  );
}
