import { group } from '../command.js';
import { add } from './card/add.js';
import { criteria } from './card/criteria.js';
import { edit } from './card/edit.js';
import { note } from './card/note.js';

/** Everything done to one card: the calls the card's modal makes, from a terminal. */
export const card = group('card', { add, edit, criteria, note });
