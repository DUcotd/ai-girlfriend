import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind 类名：clsx 处理条件类，tailwind-merge 去重冲突。
 * 所有组件拼接类名统一走这里，不要手写模板字符串拼类。
 */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
