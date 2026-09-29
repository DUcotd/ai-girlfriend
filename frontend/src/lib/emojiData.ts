/**
 * 表情面板的数据单一事实源。
 * 面板组件只负责渲染，增删表情/分类一律改这里。
 */

/** 分类的网格形态：
 *  - grid：多列方形格，适合单个 emoji 字符
 *  - wide：少列宽格，适合颜文字这类多字符长文本 */
export type EmojiLayout = "grid" | "wide";

export interface EmojiCategory {
    /** 稳定 id（用作 key 与选中态，不用数组下标） */
    id: string;
    label: string;
    layout: EmojiLayout;
    emojis: readonly string[];
}

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
    {
        id: "love",
        label: "爱心",
        layout: "grid",
        emojis: ["❤️", "💕", "💖", "💗", "💓", "💞", "💝", "💘", "🥰", "😍", "😘", "😚"],
    },
    {
        id: "face",
        label: "表情",
        layout: "grid",
        emojis: ["😊", "😄", "😆", "🤭", "😳", "🥹", "😢", "😭", "😤", "😡", "🤗", "🤔"],
    },
    {
        id: "action",
        label: "动作",
        layout: "grid",
        emojis: ["👋", "👏", "🙌", "🤝", "👍", "👎", "✌️", "🤞", "🫶", "💪", "🙏", "🫡"],
    },
    {
        id: "kaomoji",
        label: "颜文字",
        layout: "wide",
        emojis: [
            "(๑•̀ㅂ•́)و✧", "(｡♥‿♥｡)", "(✿◠‿◠)", "(≧◡≦)", "(´・ω・`)", "╰(*°▽°*)╯",
            "(｡◕‿◕｡)", "(◕‿◕✿)", "(⁄ ⁄•⁄ω⁄•⁄ ⁄)", "( ´ ▽ ` )ﾉ", "(✧ω✧)", "٩(◕‿◕｡)۶",
        ],
    },
    {
        id: "misc",
        label: "其他",
        layout: "grid",
        emojis: ["✨", "💫", "⭐", "🌟", "🌸", "🌺", "🎀", "🎵", "🎶", "💭", "💬", "🎁"],
    },
];

/** 面板首次打开时的默认分类 */
export const DEFAULT_EMOJI_CATEGORY_ID = EMOJI_CATEGORIES[0].id;
