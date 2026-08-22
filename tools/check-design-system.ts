import { findDesignSystemViolations } from './design-system.ts';

const violations = await findDesignSystemViolations();

if (violations.length > 0) {
  console.error('Design-system check failed:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Design-system check passed.');
}
