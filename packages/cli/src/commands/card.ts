import { group } from '../command.js';
import { add } from './card/add.js';
import { edit } from './card/edit.js';

/** Everything done to one card: the calls the card's modal makes, from a terminal. */
export const card = group('card', { add, edit });
