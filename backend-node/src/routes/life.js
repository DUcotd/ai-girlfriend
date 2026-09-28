/**
 * 生活模拟路由：/life/current、/life/history
 */
import { Router } from 'express';
import { proactiveEngine } from '../services/container.js';

const router = Router();

function lifeSimulatorOr404(req, res) {
    if (!proactiveEngine?.lifeSimulator) {
        res.status(503).json({ detail: "LifeSimulator not ready" });
        return null;
    }
    return proactiveEngine.lifeSimulator;
}

router.get('/life/current', (req, res) => {
    const sim = lifeSimulatorOr404(req, res);
    if (!sim) return;
    res.json(sim.getCurrentActivity());
});

router.get('/life/history', (req, res) => {
    const sim = lifeSimulatorOr404(req, res);
    if (!sim) return;
    const hours = parseInt(req.query.hours) || 6;
    res.json(sim.getActivityHistory(hours));
});

export default router;
