// The small part of the GitHub Actions runner interface the scripts use: step outputs, the job
// summary and annotations. Outside a runner (tests, a laptop) outputs go nowhere and annotations
// are plain lines on stderr.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** A failure the person running the pipeline can act on: printed as an error, no stack trace. */
export class ReleaseError extends Error {
	name = 'ReleaseError';
}

/** Annotation text: GitHub's workflow-command escaping, so a message can't end the command. */
export function escapeData(text) {
	return String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export function error(message, env = process.env) {
	process.stderr.write(env.GITHUB_ACTIONS ? `::error::${escapeData(message)}\n` : `error: ${message}\n`);
}

export function notice(message, env = process.env) {
	process.stdout.write(env.GITHUB_ACTIONS ? `::notice::${escapeData(message)}\n` : `${message}\n`);
}

/** Sets a step output; multi-line safe (GitHub's heredoc syntax with a random delimiter). */
export function setOutput(name, value, env = process.env) {
	if (!env.GITHUB_OUTPUT) return;
	const delimiter = `zutun_${randomUUID()}`;
	appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Appends Markdown to the job summary, which reviewers see on the run page. */
export function summary(markdown, env = process.env) {
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/**
 * Runs a script's main function: a ReleaseError becomes an error annotation and exit code 1,
 * anything else is a bug and keeps its stack trace.
 */
export async function run(main) {
	try {
		await main();
	} catch (err) {
		if (err instanceof ReleaseError) {
			error(err.message);
			process.exit(1);
		}
		throw err;
	}
}

/** `--key value` pairs from argv; every flag takes a value. */
export function parseArgs(argv, allowed) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const key = flag?.startsWith('--') ? flag.slice(2) : null;
		if (!key || !allowed.includes(key) || i + 1 >= argv.length) {
			throw new ReleaseError(`usage: ${allowed.map((k) => `--${k} <value>`).join(' ')}`);
		}
		args[key] = argv[i + 1];
	}
	return args;
}
