import { Router } from 'express';
import { contentController } from './controller.js';
import { authenticateInternal } from '../../middleware/auth.js';

const router = Router();

// Internal API routes (used by orchestrator)
router.get('/prompts', authenticateInternal, contentController.getPrompt);
router.get('/daily-topic', authenticateInternal, contentController.getDailyTopic);

// Admin routes (for content management)
router.get('/prompts/all', contentController.getAllPrompts);
router.post('/prompts', contentController.createPrompt);
router.put('/prompts/:id', contentController.updatePrompt);
router.delete('/prompts/:id', contentController.deletePrompt);

export default router;