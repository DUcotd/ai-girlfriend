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
            keyframes: {
                "spin-slow": {
                    to: { transform: "rotate(360deg)" },
                },
            },
            animation: {
                "spin-slow": "spin-slow 8s linear infinite",
            },
        },
    },
    plugins: [
        plugin(({ addVariant }) => {
            addVariant("dark", '[data-mode="dark"] &');
        }),
    ],
};

export default config;
