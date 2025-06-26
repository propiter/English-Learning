import { Router } from 'express';
import { userController } from './controller.js';
import { authenticateInternal } from '../../middleware/auth.js';

const router = Router();

// Public routes (for initial registration)
router.post('/register', userController.register);

// Internal API routes (between modules)
router.get('/platform/:platform/:platformId', authenticateInternal, userController.findByPlatformId);
router.put('/:id/progress', authenticateInternal, userController.updateProgress);

// Protected routes (for future web dashboard)
router.get('/:id', userController.getProfile);
router.put('/:id', userController.updateProfile);
router.get('/:id/progress', userController.getProgress);

export default router;