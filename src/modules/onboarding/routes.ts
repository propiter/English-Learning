import { Router } from 'express';
import { onboardingController } from './controller.js';
import { authenticateInternal } from '../../middleware/auth.js';

const router = Router();

// Internal API routes
router.post('/process', authenticateInternal, onboardingController.processStep);
router.get('/status/:userId', authenticateInternal, onboardingController.getStatus);
router.post('/test-redis', authenticateInternal, onboardingController.testRedis);

export default router;