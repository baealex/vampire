import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packagePath = process.argv[2];
const expectedVersion = process.argv[3];

if (!packagePath || !expectedVersion) {
	console.error('Usage: node scripts/publish-package.mjs <package.tgz> <expected-version>');
	process.exit(1);
}

const resolvedPackagePath = resolve(packagePath);
const registryIntegrity = await publishedIntegrity(expectedVersion);

if (registryIntegrity) {
	console.log(`vampire@${expectedVersion} is already published; registry verification will run separately.`);
} else {
	const { stdout, stderr } = await execFileAsync(npmCommand(), ['publish', resolvedPackagePath, '--access', 'public'], {
		timeout: 120_000
	});
	process.stdout.write(stdout);
	process.stderr.write(stderr);
}

async function publishedIntegrity(version) {
	try {
		const { stdout } = await execFileAsync(npmCommand(), [
			'view',
			`vampire@${version}`,
			'dist.integrity',
			'--json',
			'--registry=https://registry.npmjs.org'
		], { timeout: 30_000 });
		return JSON.parse(stdout);
	} catch (error) {
		const details = `${error.stdout || ''}\n${error.stderr || ''}`;
		if (/E404|ETARGET|No match found|No matching version/i.test(details)) return undefined;
		throw error;
	}
}

function npmCommand() {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
