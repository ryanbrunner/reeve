import { jsonSchemaFor, planningOutput } from '@reeve/shared';
const s = jsonSchemaFor(planningOutput);
console.log('has $schema key :', '$schema' in s, '(must be false)');
console.log('top-level keys  :', Object.keys(s).join(', '));
console.log(JSON.stringify(s).slice(0, 120) + '…');
