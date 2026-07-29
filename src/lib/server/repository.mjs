import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, stat, lstat, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/** @typedef {'conflict' | 'invalid-path' | 'not-found' | 'not-git' | 'too-large' | 'unsupported-file' | 'command-failed'} RepositoryReadErrorReason */
/** @typedef {{ path: string; status: string; previousPath?: string }} RepositoryChange */
/** @typedef {{ acceptedExitCodes?: number[]; maxBuffer?: number }} GitRunOptions */
/** @typedef {Error & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean }} GitCommandError */

const execFile = promisify(execFileCallback);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DIRECTORY_ENTRY_COUNT = 8_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 8_000;
const IGNORED_WORKSPACE_DIRECTORIES = new Set(['.git']);

export class RepositoryReadError extends Error {
	/** @type {RepositoryReadErrorReason} */
	reason;

	/**
	 * @param {RepositoryReadErrorReason} reason
	 * @param {string} message
	 */
	constructor(reason, message) {
		super(message);
		this.reason = reason;
	}
}

/**
 * @param {RepositoryReadErrorReason} reason
 * @param {string} message
 */
function repositoryError(reason, message) {
	return new RepositoryReadError(reason, message);
}

/** @param {string} value */
function normalizeRelativePath(value) {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || isAbsolute(value)) {
		throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
	}

	const normalized = normalize(value);
	if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
		throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
	}
	return normalized.split(sep).join('/');
}

/**
 * @param {string} root
 * @param {string} target
 */
function staysInside(root, target) {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

/** @param {string} cwd */
async function workspaceRoot(cwd) {
	try {
		return await realpath(cwd);
	} catch {
		throw repositoryError('not-found', 'Workspace directory is no longer available.');
	}
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitRunOptions} [options]
 */
async function runGit(cwd, args, options = {}) {
	const acceptedExitCodes = options.acceptedExitCodes ?? [0];
	try {
		return await execFile('git', ['-C', cwd, '-c', 'status.relativePaths=true', ...args], {
			encoding: 'utf8',
			maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT_BYTES,
			timeout: GIT_TIMEOUT_MS,
			env: {
				...process.env,
				GIT_EXTERNAL_DIFF: '',
				GIT_LITERAL_PATHSPECS: '1',
				GIT_OPTIONAL_LOCKS: '0',
				GIT_PAGER: 'cat',
				GIT_TERMINAL_PROMPT: '0',
				LC_ALL: 'C'
			}
		});
	} catch (error) {
		const commandError = /** @type {GitCommandError} */ (error);
		if (typeof commandError.code === 'number' && acceptedExitCodes.includes(commandError.code)) {
			return { stdout: commandError.stdout ?? '', stderr: commandError.stderr ?? '' };
		}
		if (commandError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
			throw repositoryError('too-large', 'Repository output is too large to display safely.');
		}
		if (commandError.killed) throw repositoryError('command-failed', 'Git took too long to respond.');
		throw repositoryError('command-failed', 'Git could not read this workspace.');
	}
}

/** @param {string} cwd */
async function isGitRepository(cwd) {
	try {
		const { stdout } = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { acceptedExitCodes: [0, 128] });
		return stdout.trim() === 'true';
	} catch (error) {
		if (error instanceof RepositoryReadError && error.reason === 'command-failed') return false;
		throw error;
	}
}

/** @param {string} output */
function countGitWorktrees(output) {
	return output.split('\n').filter((line) => line.startsWith('worktree ')).length;
}

/** @param {string} cwd */
async function readGitWorktreeCount(cwd) {
	const { stdout } = await runGit(cwd, ['worktree', 'list', '--porcelain']);
	return countGitWorktrees(stdout);
}

/** @param {string} output */
function parseGitChanges(output) {
	const records = output.split('\0');
	/** @type {RepositoryChange[]} */
	const changes = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record) continue;
		if (record.length < 4 || record[2] !== ' ') {
			throw repositoryError('command-failed', 'Git returned an unreadable status.');
		}

		const status = record.slice(0, 2);
		const path = record.slice(3);
		const renamed = status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C';
		const previousPath = renamed ? records[++index] : undefined;
		changes.push({
			path,
			status,
			...(previousPath ? { previousPath } : {})
		});
	}
	return changes.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

/** @param {string} cwd */
async function readGitChanges(cwd) {
	const { stdout } = await runGit(cwd, [
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=all',
		'--',
		'.'
	]);
	return parseGitChanges(stdout);
}

/**
 * @param {string} cwd
 * @param {string} path
 */
async function resolveReadableDirectory(cwd, path) {
	const root = await workspaceRoot(cwd);
	const normalizedPath = path === '' ? '' : normalizeRelativePath(path);
	const lexicalTarget = resolve(root, normalizedPath || '.');
	if (!staysInside(root, lexicalTarget)) {
		throw repositoryError('invalid-path', 'Directory path must stay inside the workspace.');
	}

	let target;
	try {
		target = await realpath(lexicalTarget);
	} catch {
		throw repositoryError('not-found', 'Directory is no longer available.');
	}
	if (!staysInside(root, target)) {
		throw repositoryError('invalid-path', 'Linked directories outside the workspace cannot be opened.');
	}

	let details;
	try {
		details = await stat(target);
	} catch {
		throw repositoryError('not-found', 'Directory is no longer available.');
	}
	if (!details.isDirectory()) throw repositoryError('unsupported-file', 'Only directories can be opened.');
	return { normalizedPath, target };
}

/**
 * Read only the immediate children of a workspace directory.
 * @param {string} cwd
 * @param {string} [path]
 */
export async function readWorkspaceDirectory(cwd, path = '') {
	const { normalizedPath, target } = await resolveReadableDirectory(cwd, path);
	let entries;
	try {
		entries = await readdir(target, { withFileTypes: true });
	} catch {
		throw repositoryError('command-failed', 'The directory could not be read.');
	}
	entries.sort((left, right) => {
		if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
		return left.name.localeCompare(right.name, 'en');
	});

	/** @type {string[]} */
	const files = [];
	/** @type {string[]} */
	const directories = [];
	let truncated = false;
	for (const entry of entries) {
		if (entry.isSymbolicLink() || IGNORED_WORKSPACE_DIRECTORIES.has(entry.name)) continue;
		if (files.length + directories.length >= MAX_DIRECTORY_ENTRY_COUNT) {
			truncated = true;
			break;
		}
		const entryPath = normalizedPath ? `${normalizedPath}/${entry.name}` : entry.name;
		if (entry.isDirectory()) directories.push(entryPath);
		else if (entry.isFile()) files.push(entryPath);
	}

	return { files, directories, truncated };
}

/** @param {string} cwd */
export async function readRepositorySnapshot(cwd) {
	const root = await workspaceRoot(cwd);
	const gitRepository = await isGitRepository(root);
	const directory = await readWorkspaceDirectory(root);
	if (!gitRepository) {
		return {
			isGitRepository: false,
			files: directory.files,
			directories: directory.directories,
			changes: [],
			truncated: directory.truncated
		};
	}

	const changes = await readGitChanges(root);
	return {
		isGitRepository: true,
		files: directory.files,
		directories: directory.directories,
		changes,
		truncated: directory.truncated
	};
}

/** @param {string} cwd */
export async function readRepositorySummary(cwd) {
	const root = await workspaceRoot(cwd);
	const gitRepository = await isGitRepository(root);
	if (!gitRepository) return { isGitRepository: false, changeCount: 0, worktreeCount: 0 };
	const [changes, worktreeCount] = await Promise.all([
		readGitChanges(root),
		readGitWorktreeCount(root)
	]);
	return { isGitRepository: true, changeCount: changes.length, worktreeCount };
}

/** @param {string} cwd */
export async function readRepositoryWatchPaths(cwd) {
	const root = await workspaceRoot(cwd);
	if (!await isGitRepository(root)) return { root, gitDirectory: undefined };
	const [{ stdout: gitDirectoryOutput }, { stdout: gitCommonDirectoryOutput }] = await Promise.all([
		runGit(root, ['rev-parse', '--absolute-git-dir']),
		runGit(root, ['rev-parse', '--git-common-dir'])
	]);
	const gitDirectory = gitDirectoryOutput.trim();
	const gitCommonDirectory = gitCommonDirectoryOutput.trim();
	return {
		root,
		gitDirectory: gitDirectory || undefined,
		worktreesDirectory: gitCommonDirectory ? join(resolve(root, gitCommonDirectory), 'worktrees') : undefined
	};
}

/**
 * @param {string} cwd
 * @param {string} path
 */
async function resolveReadableFile(cwd, path, maximumBytes = MAX_FILE_BYTES) {
	const root = await workspaceRoot(cwd);
	const normalizedPath = normalizeRelativePath(path);
	const lexicalTarget = resolve(root, normalizedPath);
	if (!staysInside(root, lexicalTarget)) {
		throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
	}

	let target;
	try {
		target = await realpath(lexicalTarget);
	} catch {
		throw repositoryError('not-found', 'File is no longer available.');
	}
	if (!staysInside(root, target)) {
		throw repositoryError('invalid-path', 'Linked files outside the workspace cannot be opened.');
	}

	let details;
	try {
		details = await stat(target);
	} catch {
		throw repositoryError('not-found', 'File is no longer available.');
	}
	if (!details.isFile()) throw repositoryError('unsupported-file', 'Only regular files can be opened.');
	if (details.size > maximumBytes) {
		throw repositoryError('too-large', maximumBytes === MAX_IMAGE_BYTES
			? 'Images larger than 10 MB are not shown.'
			: 'Files larger than 5 MB are not shown.');
	}
	return { normalizedPath, target, details };
}

/**
 * @param {string} cwd
 * @param {string} path
 */
async function resolveWritableFile(cwd, path) {
	const root = await workspaceRoot(cwd);
	const normalizedPath = normalizeRelativePath(path);
	const lexicalTarget = resolve(root, normalizedPath);
	if (!staysInside(root, lexicalTarget)) {
		throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
	}

	try {
		await mkdir(dirname(lexicalTarget), { recursive: true });
	} catch {
		throw repositoryError('command-failed', 'The file directory could not be created.');
	}

	let parent;
	try {
		parent = await realpath(dirname(lexicalTarget));
	} catch {
		throw repositoryError('not-found', 'The file directory is no longer available.');
	}
	if (!staysInside(root, parent)) {
		throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
	}

	let lexicalDetails;
	try {
		lexicalDetails = await lstat(lexicalTarget);
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
			return { normalizedPath, target: lexicalTarget, exists: false };
		}
		throw repositoryError('command-failed', 'The file could not be inspected.');
	}

	let target = lexicalTarget;
	if (lexicalDetails.isSymbolicLink()) {
		try {
			target = await realpath(lexicalTarget);
		} catch {
			throw repositoryError('invalid-path', 'Linked files outside the workspace cannot be edited.');
		}
		if (!staysInside(root, target)) {
			throw repositoryError('invalid-path', 'Linked files outside the workspace cannot be edited.');
		}
	}

	let details;
	try {
		details = await stat(target);
	} catch {
		throw repositoryError('not-found', 'File is no longer available.');
	}
	if (!details.isFile()) throw repositoryError('unsupported-file', 'Only regular files can be edited.');
	return { normalizedPath, target, exists: true, details };
}

/** @param {Uint8Array} bytes */
function detectImageMimeType(bytes) {
	const prefix = Buffer.from(bytes);
	if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return 'image/png';
	}
	if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
	if (prefix.length >= 6 && ['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString('ascii'))) return 'image/gif';
	if (prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP') {
		return 'image/webp';
	}
	if (prefix.length >= 12 && prefix.subarray(4, 8).toString('ascii') === 'ftyp') {
		for (let offset = 8; offset + 4 <= prefix.length; offset += 4) {
			if (['avif', 'avis'].includes(prefix.subarray(offset, offset + 4).toString('ascii'))) return 'image/avif';
		}
	}
	return undefined;
}

/** @param {import('node:fs').Stats} details */
function imageVersion(details) {
	return createHash('sha256')
		.update(`${details.size}:${details.mtimeMs}:${details.ctimeMs}:${details.ino}`)
		.digest('hex');
}

/**
 * @param {string} cwd
 * @param {string} path
 */
export async function readWorkspaceImageMetadata(cwd, path) {
	const { normalizedPath, target, details } = await resolveReadableFile(cwd, path, MAX_IMAGE_BYTES);
	const handle = await open(target, 'r');
	const prefix = Buffer.alloc(Math.min(64, details.size));
	try {
		await handle.read(prefix, 0, prefix.length, 0);
	} finally {
		await handle.close();
	}
	const mimeType = detectImageMimeType(prefix);
	if (!mimeType) throw repositoryError('unsupported-file', 'Only PNG, JPEG, GIF, WebP, and AVIF images are previewed.');
	return {
		path: normalizedPath,
		mimeType,
		size: details.size,
		modifiedAt: details.mtimeMs,
		version: imageVersion(details)
	};
}

/**
 * @param {string} cwd
 * @param {string} path
 */
export async function readWorkspaceImage(cwd, path) {
	const { normalizedPath, target, details } = await resolveReadableFile(cwd, path, MAX_IMAGE_BYTES);
	const bytes = await readFile(target);
	if (bytes.length > MAX_IMAGE_BYTES) throw repositoryError('too-large', 'Images larger than 10 MB are not shown.');
	const mimeType = detectImageMimeType(bytes.subarray(0, 64));
	if (!mimeType) throw repositoryError('unsupported-file', 'Only PNG, JPEG, GIF, WebP, and AVIF images are previewed.');
	return {
		path: normalizedPath,
		mimeType,
		bytes,
		size: bytes.length,
		version: imageVersion(details)
	};
}

/**
 * @param {string} cwd
 * @param {string} path
 */
export async function readWorkspaceFile(cwd, path) {
	const { normalizedPath, target, details } = await resolveReadableFile(cwd, path);
	const bytes = await readFile(target);
	if (bytes.length > MAX_FILE_BYTES) throw repositoryError('too-large', 'Files larger than 5 MB are not shown.');
	if (bytes.includes(0)) throw repositoryError('unsupported-file', 'Binary files are not shown.');

	let content;
	try {
		content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw repositoryError('unsupported-file', 'Only UTF-8 text files are shown.');
	}

	return {
		path: normalizedPath,
		content,
		size: bytes.length,
		modifiedAt: details.mtimeMs,
		version: createHash('sha256').update(bytes).digest('hex')
	};
}

/**
 * @param {string} cwd
 * @param {string} path
 * @param {string} content
 * @param {{ expectedVersion?: string; createOnly?: boolean }} [options]
 */
export async function writeWorkspaceFile(cwd, path, content, options = {}) {
	if (typeof content !== 'string') throw repositoryError('unsupported-file', 'Only UTF-8 text files can be saved.');
	const bytes = Buffer.from(content, 'utf8');
	if (bytes.length > MAX_FILE_BYTES) throw repositoryError('too-large', 'Files larger than 5 MB cannot be saved.');
	if (bytes.includes(0)) throw repositoryError('unsupported-file', 'Binary files are not supported.');

	const resolved = await resolveWritableFile(cwd, path);
	if (options.createOnly && resolved.exists) {
		throw repositoryError('conflict', 'A file with this name already exists.');
	}
	if (options.expectedVersion !== undefined) {
		if (!resolved.exists) throw repositoryError('conflict', 'This file was removed before it could be saved.');
		const current = await readWorkspaceFile(cwd, resolved.normalizedPath);
		if (current.version !== options.expectedVersion) {
			throw repositoryError('conflict', 'This file changed elsewhere. Reload it before saving.');
		}
	}

	try {
		await writeFile(resolved.target, bytes);
	} catch {
		throw repositoryError('command-failed', 'The file could not be saved.');
	}
	return readWorkspaceFile(cwd, resolved.normalizedPath);
}

/**
 * @param {string} cwd
 * @param {string} path
 */
export async function createWorkspaceDirectory(cwd, path) {
	const root = await workspaceRoot(cwd);
	const normalizedPath = normalizeRelativePath(path);
	const target = resolve(root, normalizedPath);
	if (!staysInside(root, target)) {
		throw repositoryError('invalid-path', 'Folder path must stay inside the workspace.');
	}

	try {
		await mkdir(dirname(target), { recursive: true });
		const parent = await realpath(dirname(target));
		if (!staysInside(root, parent)) {
			throw repositoryError('invalid-path', 'Folder path must stay inside the workspace.');
		}
	} catch (cause) {
		if (cause instanceof RepositoryReadError) throw cause;
		throw repositoryError('command-failed', 'The folder directory could not be created.');
	}

	try {
		await lstat(target);
		throw repositoryError('conflict', 'A file or folder with this name already exists.');
	} catch (cause) {
		if (cause instanceof RepositoryReadError) throw cause;
		if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
			throw repositoryError('command-failed', 'The folder could not be inspected.');
		}
	}

	try {
		await mkdir(target);
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST') {
			throw repositoryError('conflict', 'A file or folder with this name already exists.');
		}
		throw repositoryError('command-failed', 'The folder could not be created.');
	}
	return { path: normalizedPath };
}

/**
 * @param {string} cwd
 * @param {string} path
 * @param {'file' | 'directory'} kind
 */
export async function deleteWorkspaceEntry(cwd, path, kind) {
	const root = await workspaceRoot(cwd);
	const normalizedPath = normalizeRelativePath(path);
	const target = resolve(root, normalizedPath);
	if (!staysInside(root, target) || target === root) {
		throw repositoryError('invalid-path', 'Only entries inside the workspace can be deleted.');
	}
	let parent;
	try {
		parent = await realpath(dirname(target));
	} catch {
		throw repositoryError('not-found', 'The entry is no longer available.');
	}
	if (!staysInside(root, parent)) {
		throw repositoryError('invalid-path', 'Linked entries outside the workspace cannot be deleted.');
	}

	let details;
	try {
		details = await lstat(target);
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
			throw repositoryError('not-found', 'The entry is no longer available.');
		}
		throw repositoryError('command-failed', 'The entry could not be inspected.');
	}

	if (details.isSymbolicLink()) {
		throw repositoryError('invalid-path', 'Linked entries cannot be deleted from the workspace.');
	}
	if (kind === 'file' && !details.isFile()) throw repositoryError('unsupported-file', 'Only files can be deleted from this action.');
	if (kind === 'directory' && !details.isDirectory()) throw repositoryError('unsupported-file', 'Only folders can be deleted from this action.');

	try {
		if (kind === 'directory') await rm(target, { recursive: true, force: false });
		else await unlink(target);
	} catch {
		throw repositoryError('command-failed', `The ${kind === 'directory' ? 'folder' : 'file'} could not be deleted.`);
	}
	return { path: normalizedPath };
}

/**
 * @param {string} cwd
 * @param {string} path
 */
export async function readRepositoryDiff(cwd, path) {
	const root = await workspaceRoot(cwd);
	const normalizedPath = normalizeRelativePath(path);
	if (!(await isGitRepository(root))) {
		throw repositoryError('not-git', 'This workspace is not a Git repository.');
	}

	const changes = await readGitChanges(root);
	const change = changes.find((candidate) => candidate.path === normalizedPath);
	if (!change) return { path: normalizedPath, sections: [] };

	const commonDiffArguments = ['--no-ext-diff', '--no-textconv', '--no-color', '--unified=3'];
	const sections = [];
	if (change.status === '??') {
		const { stdout } = await runGit(root, [
			'diff',
			'--no-index',
			...commonDiffArguments,
			'--',
			'/dev/null',
			normalizedPath
		], { acceptedExitCodes: [0, 1], maxBuffer: MAX_DIFF_OUTPUT_BYTES });
		if (stdout) sections.push({ kind: 'untracked', patch: stdout });
		return { path: normalizedPath, sections };
	}

	if (change.status[0] !== ' ' && change.status[0] !== '?') {
		const { stdout } = await runGit(root, [
			'diff',
			'--cached',
			...commonDiffArguments,
			'--',
			normalizedPath
		], { maxBuffer: MAX_DIFF_OUTPUT_BYTES });
		if (stdout) sections.push({ kind: 'staged', patch: stdout });
	}
	if (change.status[1] !== ' ' && change.status[1] !== '?') {
		const { stdout } = await runGit(root, [
			'diff',
			...commonDiffArguments,
			'--',
			normalizedPath
		], { maxBuffer: MAX_DIFF_OUTPUT_BYTES });
		if (stdout) sections.push({ kind: 'working', patch: stdout });
	}
	return { path: normalizedPath, sections };
}
