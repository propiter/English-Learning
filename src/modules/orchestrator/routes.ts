import { Router } from 'express';
import { orchestratorController } from './controller.js';
import { authenticateInternal } from '../../middleware/auth.js';

const router = Router();

// Internal API routes
router.post('/process-message', authenticateInternal, orchestratorController.processMessage);
router.get('/health', orchestratorController.healthCheck);

// Status endpoints para monitoreo
router.get('/llm-status', orchestratorController.getLLMStatus);
router.get('/stt-status', orchestratorController.getSTTStatus);
router.get('/tts-status', orchestratorController.getTTSStatus);

// Endpoint para refrescar proveedores (útil para cambios de configuración)
router.post('/refresh-providers', authenticateInternal, orchestratorController.refreshProviders);

export default router;