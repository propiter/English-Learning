import { Router } from 'express';
import { learningController } from './controller.js';
import { authenticateInternal } from '../../middleware/auth.js';

const router = Router();

// Internal API routes (between modules)
router.post('/sessions', authenticateInternal, learningController.createSession);
router.post('/sessions/calculate-xp', authenticateInternal, learningController.calculateSessionXP);

// Protected routes (for future web dashboard)
router.get('/users/:userId/progress', learningController.getProgress);
router.get('/users/:userId/sessions', learningController.getSessionHistory);
router.get('/users/:userId/level-up-check', learningController.checkLevelUpEligibility);
router.get('/users/:userId/analytics', learningController.getAnalytics);
router.get('/sessions/:sessionId', learningController.getSession);

export default router;