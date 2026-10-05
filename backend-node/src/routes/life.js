/**
 * 生活模拟路由：/life/current、/life/history
 *
 * ⚠️ 两条都是**纯读**（审计 HTTP-13）：以前 GET /life/current 会在没有当前活动时
 * 现场生成一条并写盘，等于「看一眼她在干嘛」就把她的生活时间表推倒重来。
 */
import { Router } from 'express';
import { proactiveEngine } from '../services/container.js';

const router = Router();

/**
 * 取 LifeSimulator，未就绪时回 503 并返回 null（调用方据此 return）。
 * 名字里的状态码曾经是 404，与实际的 503 不符（审计 HTTP-19），改名对齐行为。
 */
function lifeSimulatorOrNull(res) {
    if (!proactiveEngine?.lifeSimulator) {
        res.status(503).json({ detail: "LifeSimulator 还没就绪，请稍后再试" });
        return null;
    }
    return proactiveEngine.lifeSimulator;
}

router.get('/life/current', (req, res) => {
    const sim = lifeSimulatorOrNull(res);
    if (!sim) return;
    res.json(sim.getCurrentActivity());
});

/** 历史窗口上限（小时）：再大就把 24h 日志之外的空档全吐给调用方了 */
const MAX_HISTORY_HOURS = 168;

router.get('/life/history', (req, res) => {
    const sim = lifeSimulatorOrNull(res);
    if (!sim) return;
    // ?hours 可以是数组/任意字符串：parseInt 的 NaN 已经被 || 兜住，
    // 但负数与天文数字要一起夹住，否则一次请求要遍历整条历史
    const raw = Array.isArray(req.query.hours) ? req.query.hours[0] : req.query.hours;
    const hours = Math.min(MAX_HISTORY_HOURS, Math.max(1, parseInt(raw, 10) || 6));
    res.json(sim.getActivityHistory(hours));
});

export default router;
