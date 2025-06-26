import { Router } from 'express';
import { orchestratorController } from './controller.js';
import { authenticateInternal } from '../../middleware/auth.js';

const router = Router();

// Internal API routes
router.post('/process-message', authenticateInternal, orchestratorController.processMessage);
router.get('/health', orchestratorController.healthCheck);

export default router;