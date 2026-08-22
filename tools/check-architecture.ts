import { findArchitectureViolations } from './architecture.ts';

const violations = await findArchitectureViolations();

if (violations.length > 0) {
  console.error('Architecture check failed:');
  for (const violation of violations) {
    console.error(
      `  ${violation.source}:${violation.line} imports ${violation.specifier} -> ${violation.target} (${violation.reason})`
    );
  }
  process.exitCode = 1;
} else {
  console.log('Architecture check passed.');
}
