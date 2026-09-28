import type { Config } from "tailwindcss";

/**
 * 设计 token 的 Tailwind 注册表。
 * 颜色变量单一定义在 src/styles/themes.css（主题×模式正交），
 * 这里只做映射，组件里写 bg-surface-1 / text-content-primary / border-line-subtle 等。
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
    plugins: [],
};

export default config;
