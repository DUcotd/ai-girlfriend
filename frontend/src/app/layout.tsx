import type { Metadata } from "next";
import ToastViewport from "./components/ui/ToastViewport";
import "./globals.css";
import "../styles/tokens.css";
import "../styles/themes.css";
import "../styles/utilities.css";

export const metadata: Metadata = {
  title: "AI 女友 - 小爱",
  description: "情感陪伴型 AI 智能体",
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
        {children}
        <ToastViewport />
      </body>
    </html>
  );
}
