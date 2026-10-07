import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/**
 * 设计 token 的 Tailwind 注册表。
 * 颜色变量单一定义在 src/styles/themes.css（主题×模式正交），
 * 这里只做映射，组件里写 bg-surface-1 / text-content-primary / border-line-subtle 等。
 *
 * dark 变体映射到 [data-mode="dark"] 属性选择器（不用默认的媒体查询），
 * 组件里写 dark:text-accent-1 即可按我们的模式开关生效。
 */
const config: Config = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                surface: {
                    1: "hsl(var(--surface-1) / <alpha-value>)",
                    2: "hsl(var(--surface-2) / <alpha-value>)",
                },
                content: {
                    primary: "hsl(var(--text-primary) / <alpha-value>)",
                    secondary: "hsl(var(--text-secondary) / <alpha-value>)",
                    muted: "hsl(var(--text-muted) / <alpha-value>)",
                },
                accent: {
                    1: "hsl(var(--accent-1) / <alpha-value>)",
                    2: "hsl(var(--accent-2) / <alpha-value>)",
                    strong: "hsl(var(--accent-strong) / <alpha-value>)",
                    pop: "hsl(var(--accent-pop) / <alpha-value>)",
                },
                line: {
                    subtle: "hsl(var(--border-subtle) / <alpha-value>)",
                },
                status: {
                    success: "hsl(var(--status-success) / <alpha-value>)",
                    danger: "hsl(var(--status-danger) / <alpha-value>)",
                    info: "hsl(var(--status-info) / <alpha-value>)",
                    warning: "hsl(var(--status-warning) / <alpha-value>)",
                },
            },
            boxShadow: {
                card: "var(--shadow-card)",
                modal: "var(--shadow-modal)",
                accent: "var(--shadow-accent)",
                "accent-hover": "var(--shadow-accent-hover)",
            },
            /* 动效规范（token 真源在 tokens.css）：微交互 duration-fast(120ms)、
               功能过渡 duration-normal(200ms)、弹窗/主题 duration-slow(300ms) */
            transitionDuration: {
                fast: "var(--duration-fast)",
                normal: "var(--duration-normal)",
                slow: "var(--duration-slow)",
            },
            transitionTimingFunction: {
                "out-expo": "var(--ease-out)",
            },
            keyframes: {
                "spin-slow": {
                    to: { transform: "rotate(360deg)" },
                },
                /* 立绘呼吸：与外层 hover scale 分层使用（内层元素），避免 transform 冲突 */
                breathe: {
                    "0%, 100%": { transform: "scale(1)" },
                    "50%": { transform: "scale(1.035)" },
                },
                /* 情绪切换 crossfade：旧立绘作为覆盖层渐隐，露出底层新立绘 */
                "avatar-fade-out": {
                    from: { opacity: "1" },
                    to: { opacity: "0" },
                },
            },
            animation: {
                "spin-slow": "spin-slow 8s linear infinite",
                breathe: "breathe 4s ease-in-out infinite",
                "avatar-fade-out": "avatar-fade-out var(--duration-slow) var(--ease-out) forwards",
            },
        },
    },
    plugins: [
        plugin(({ addVariant }) => {
            addVariant("dark", '[data-mode="dark"] &');
            /* 触屏档：设备「没有 hover 能力」时（手机/平板）用得到。
               触屏没有鼠标悬停，`hover:`/`group-hover:` 独占的可见性（opacity-0 → 100 之类）
               在那儿永远不触发，操作就消失了。写法：`coarse:opacity-100`。
               与 focus-visible 配对使用，键盘与触屏都能看到同一份本该只有鼠标能唤起的界面。 */
            addVariant("coarse", "@media (hover: none)");
        }),
    ],
};

export default config;
