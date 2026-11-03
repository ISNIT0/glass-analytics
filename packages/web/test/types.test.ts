import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { WireEvent as CoreWireEvent } from '@glass/core/events';
import type { WireEvent as SdkWireEvent } from '../src/types.ts';

// Compile-time check (run by `pnpm typecheck`): the SDK's public copy of the
// wire format must stay identical to the one the Worker accepts.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<CoreWireEvent, SdkWireEvent> = true;

it('the SDK wire format matches @glass/core', () => {
  assert.equal(same, true);
});
