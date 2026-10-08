/** Mixed canonical and legacy IDs must never poison ordinary numeric allocation. */
import {describe,it,expect} from 'vitest';
import {nextId} from '@/lib/iegp/store';
describe('legacy allocation',()=>{
 it('ignores canonical, foreign, malformed and unsafe numeric IDs',()=>{
  const ids=['TAC-001','TAC-009','TAC_20261007T110500_0001_a3f9','COV-999','TAC-12x','TAC-9007199254740992'];
  const first=nextId('TAC',ids), second=nextId('TAC',[...ids,first]);
  expect(first).toBe('TAC-010'); expect(second).toBe('TAC-011');
 });
 it('finds an unused safe ID when the maximum safe suffix is occupied',()=>{
  const ids=['COV-001','COV-9007199254740991'];
  const first=nextId('COV',ids),second=nextId('COV',[...ids,first]);
  expect(first).toBe('COV-002');expect(second).toBe('COV-003');
 });
});
