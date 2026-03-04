/**
 * AI-900 Exam Configuration
 * Centralized constants for trainer-server.mjs and related tools.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const EXAM_ID = 'ai900';
export const EXAM_NAME = 'AI-900 Azure AI Fundamentals';
export const PACK_SCHEMA = 'ai900-pack-v1';
export const ROOT = join(__dirname, '..');
export const PORT = 3900;
export const APP_URL = 'https://ai900-pwa.pages.dev';
export const LOG_DIR = join(ROOT, 'logs');
export const SESSION_SIZE = 50;
export const POOL_MAX_SIZE = 600;
export const DOMAINS = ['Workloads', 'ML', 'CV', 'NLP', 'GenAI'];
export const TYPES = ['single', 'multi', 'dropdown', 'match', 'order', 'hotarea', 'casestudy'];
export const QUALITY_FILE = join(ROOT, 'public', 'meta', 'quality.json');
export const TAXONOMY_FILE = join(ROOT, 'public', 'meta', 'taxonomy.json');
export const TRAINER_STATE_FILE = join(LOG_DIR, 'trainer-state.json');
export const QUALITY_LOG_FILE = join(LOG_DIR, 'quality-eval.log');
