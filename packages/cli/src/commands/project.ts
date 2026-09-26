import { group } from '../command.js';
import { add } from './project/add.js';

/**
 * Projects are cards to the server, so only making one needs a verb of its
 * own: editing a brief, a note, archiving are the `card` commands.
 */
export const project = group('project', { add });
