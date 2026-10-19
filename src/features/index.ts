import { lite } from './lite/index.ts';

import type { Feature } from '../discord/types.ts';

// New product areas register here; their command definitions go in src/commands.ts
export const features: Feature[] = [lite];
