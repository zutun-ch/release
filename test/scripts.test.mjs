// The command-line scripts as the workflows run them: plan.mjs, stack-bundle.mjs,
// agent-release.mjs, require-vars.mjs and lint-bundle.sh (with stand-in agents).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { PLACEHOLDER_DIGEST } from '../scripts/lib/compose.mjs';
import { repo, scratch } from './helpers.mjs';

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const D = `sha256:${'5'.repeat(64)}`;

/** Runs a script with a clean GitHub-like environment; returns status, output and step outputs. */
function runScript(script, args, { cwd, env = {} } = {}) {
	const out = scratch({ 'output.txt': '', 'summary.md': '' });
	const result = spawnSync(script.endsWith('.sh') ? 'sh' : process.execPath, [path.join(repo, 'scripts', script), ...args], {
		cwd,
		encoding: 'utf8',
		env: {
			PATH: process.env.PATH,
			GITHUB_ACTIONS: 'true',
			GITHUB_OUTPUT: path.join(out, 'output.txt'),
			GITHUB_STEP_SUMMARY: path.join(out, 'summary.md'),
			GITHUB_SHA: COMMIT,
			...env,
		},
	});
	const outputs = {};
	const text = readFileSync(path.join(out, 'output.txt'), 'utf8');
	for (const m of text.matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
	return { ...result, outputs, summary: readFileSync(path.join(out, 'summary.md'), 'utf8') };
}

const moduleRepo = () =>
	scratch({
		'manifest.yaml': 'schema: 1\nkind: stack\nname: mail\nversion: 1  # set by the pipeline\ntitle: Mail\nrequirements: { arch: [amd64, arm64], memory_mb: 64, disk_gb: 1 }\n',
		'compose.yaml': `services:\n  app:\n    image: ghcr.io/zutun-ch/mail@${PLACEHOLDER_DIGEST}\n`,
		'image/Dockerfile': 'FROM scratch\n',
		'scripts/hello.sh': 'echo hello\n',
	});

/**
 * `dir` as a git repo the way the plan job's checkout leaves it (fetch-depth: 0): its files
 * committed on main, known as origin/main, plus a commit on a side branch that isn't on main.
 */
function asCheckout(dir) {
	const git = (...args) => {
		const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr);
		return r.stdout.trim();
	};
	git('init', '--quiet', '--initial-branch=main');
	git('add', '-A');
	git('commit', '--quiet', '--allow-empty', '-m', 'main');
	const main = git('rev-parse', 'HEAD');
	git('update-ref', 'refs/remotes/origin/main', main);
	git('checkout', '--quiet', '-b', 'side');
	writeFileSync(path.join(dir, 'unreviewed.txt'), 'x');
	git('add', '-A');
	git('commit', '--quiet', '-m', 'side');
	const side = git('rev-parse', 'HEAD');
	git('checkout', '--quiet', main);
	return { main, side };
}

test('plan.mjs: a tag of a module repo releases its stack and lists its images', () => {
	const dir = moduleRepo();
	const { main } = asCheckout(dir);
	const r = runScript('plan.mjs', ['--workflow', 'module'], {
		cwd: dir,
		env: { GITHUB_REPOSITORY: 'zutun-ch/module-mail', GITHUB_REF: 'refs/tags/v7', GITHUB_SHA: main },
	});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.outputs, {
		kind: 'stack',
		name: 'mail',
		version: '7',
		publish: 'true',
		production: 'true',
		images: JSON.stringify([{ name: 'mail', context: 'image', repository: 'ghcr.io/zutun-ch/mail' }]),
	});
});

test('plan.mjs: a tag of the reference module releases to staging only', () => {
	const dir = scratch({
		'manifest.yaml': 'schema: 1\nkind: stack\nname: example\nversion: 1\n',
		'compose.yaml': `services:\n  app:\n    image: ghcr.io/zutun-ch/example@${PLACEHOLDER_DIGEST}\n`,
		'image/Dockerfile': 'FROM scratch\n',
	});
	const { main } = asCheckout(dir);
	const r = runScript('plan.mjs', ['--workflow', 'module'], {
		cwd: dir,
		env: { GITHUB_REPOSITORY: 'zutun-ch/module-example', GITHUB_REF: 'refs/tags/v3', GITHUB_SHA: main },
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.outputs.publish, 'true');
	assert.equal(r.outputs.production, 'false');
	assert.match(r.stdout, /staging only/);
});

test('plan.mjs: main checks only; the agent has no images; mistakes are annotations', () => {
	const main = runScript('plan.mjs', ['--workflow', 'core'], { cwd: scratch(), env: { GITHUB_REPOSITORY: 'zutun-ch/agent', GITHUB_REF: 'refs/heads/main' } });
	assert.equal(main.status, 0, main.stderr);
	assert.equal(main.outputs.publish, 'false');
	assert.equal(main.outputs.version, '');
	assert.equal(main.outputs.images, '[]');
	const wrong = runScript('plan.mjs', ['--workflow', 'module'], { cwd: scratch(), env: { GITHUB_REPOSITORY: 'zutun-ch/caddy', GITHUB_REF: 'refs/tags/v1' } });
	assert.equal(wrong.status, 1);
	assert.match(wrong.stderr, /^::error::module.yml releases repositories named module-<name>/);
});

test('plan.mjs: a tag on a commit that is not on main releases nothing', () => {
	const dir = moduleRepo();
	const { side } = asCheckout(dir);
	const r = runScript('plan.mjs', ['--workflow', 'module'], {
		cwd: dir,
		env: { GITHUB_REPOSITORY: 'zutun-ch/module-mail', GITHUB_REF: 'refs/tags/v7', GITHUB_SHA: side },
	});
	assert.equal(r.status, 1);
	assert.match(r.stderr, new RegExp(`^::error::the release tag points at ${side}, which isn't on main`));
	assert.match(r.stderr, /tag the merged commit on main with a new version \(release tags can't be moved or deleted/);
	assert.deepEqual(r.outputs, {});
});

test('plan.mjs: a tag is refused when the checkout has no origin/main to compare with', () => {
	const r = runScript('plan.mjs', ['--workflow', 'module'], {
		cwd: moduleRepo(),
		env: { GITHUB_REPOSITORY: 'zutun-ch/module-mail', GITHUB_REF: 'refs/tags/v7' },
	});
	assert.equal(r.status, 1);
	assert.match(r.stderr, /origin\/main isn't in the checkout; the plan job checks the repository out with fetch-depth: 0/);
});

test('stack-bundle.mjs: a release sets the version and pins digests in the bundle, not in the checkout', () => {
	const dir = moduleRepo();
	const before = readFileSync(path.join(dir, 'compose.yaml'), 'utf8');
	const r = runScript('stack-bundle.mjs', ['--name', 'mail', '--version', '7', '--digests', JSON.stringify({ 'ghcr.io/zutun-ch/mail': D }), '--out', 'dist'], { cwd: dir });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(readFileSync(path.join(dir, 'compose.yaml'), 'utf8'), before);
	const release = JSON.parse(readFileSync(path.join(dir, 'dist/release.json'), 'utf8'));
	assert.equal(release.commit, COMMIT);
	assert.deepEqual(release.artifacts.map((a) => [a.kind, a.name, a.version, a.file]), [['stack', 'mail', 7, 'mail.tar.gz']]);
	assert.equal(r.outputs.sha256, release.artifacts[0].sha256);
	assert.equal(r.outputs['release-sha256'], createHash('sha256').update(readFileSync(path.join(dir, 'dist/release.json'))).digest('hex'));
	const tarText = gunzipSync(readFileSync(path.join(dir, 'dist/mail.tar.gz'))).toString('latin1');
	assert.ok(tarText.includes('version: 7  # set by the pipeline'));
	assert.ok(tarText.includes(`ghcr.io/zutun-ch/mail@${D}`));
	assert.ok(!tarText.includes(PLACEHOLDER_DIGEST));
	assert.match(r.summary, /\| stack \| `mail` \| 7 \| `[0-9a-f]{64}` \|/);
	// Twice in a row: the same bytes.
	const again = runScript('stack-bundle.mjs', ['--name', 'mail', '--version', '7', '--digests', JSON.stringify({ 'ghcr.io/zutun-ch/mail': D }), '--out', 'dist2'], { cwd: dir });
	assert.equal(again.outputs.sha256, r.outputs.sha256);
});

test('stack-bundle.mjs: main keeps the placeholders but checks them against the images', () => {
	const dir = moduleRepo();
	const ok = runScript('stack-bundle.mjs', ['--name', 'mail', '--version', '', '--digests', JSON.stringify({ 'ghcr.io/zutun-ch/mail': null }), '--out', 'dist'], { cwd: dir });
	assert.equal(ok.status, 0, ok.stderr);
	const missing = runScript('stack-bundle.mjs', ['--name', 'mail', '--version', '', '--digests', '{}', '--out', 'dist'], { cwd: dir });
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /::error::compose.yaml line 3: ghcr.io\/zutun-ch\/mail carries the placeholder digest, but this repo builds no image/);
});

test('agent-release.mjs describes both architectures as one release', () => {
	const dir = scratch({ 'zutun-agent-linux-amd64': 'a', 'zutun-agent-linux-arm64': 'bb' });
	const r = runScript('agent-release.mjs', ['--dir', dir, '--version', '42'], { cwd: dir });
	assert.equal(r.status, 0, r.stderr);
	const release = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8'));
	assert.deepEqual(release.artifacts.map((a) => [a.kind, a.name, a.version, a.size]), [
		['agent', 'zutun-agent-linux-amd64', 42, 1],
		['agent', 'zutun-agent-linux-arm64', 42, 2],
	]);
	assert.equal(r.outputs['release-sha256'], createHash('sha256').update(readFileSync(path.join(dir, 'release.json'))).digest('hex'));
});

test('require-vars.mjs names every missing variable', () => {
	const r = runScript('require-vars.mjs', ['ZUTUN_A', 'ZUTUN_B', 'ZUTUN_C'], { env: { ZUTUN_B: 'set', ZUTUN_C: '' } });
	assert.equal(r.status, 1);
	assert.deepEqual(r.stderr.trim().split('\n').map((l) => /variable (\w+)/.exec(l)[1]), ['ZUTUN_A', 'ZUTUN_C']);
	assert.equal(runScript('require-vars.mjs', ['ZUTUN_B'], { env: { ZUTUN_B: 'set' } }).status, 0);
});

/** A stand-in for zutun-agent that prints `stdout` and exits with `status`, recording its args. */
function fakeAgent(status, stdout = '') {
	const dir = scratch({ 'zutun-agent': `#!/bin/sh\nprintf '%s\\n' "$@" > "$(dirname "$0")/args"\nprintf '%s' '${stdout}'\nexit ${status}\n` });
	chmodSync(path.join(dir, 'zutun-agent'), 0o755);
	return path.join(dir, 'zutun-agent');
}

test('lint-bundle.sh calls the agent as the lint contract says and passes a clean bundle', () => {
	const agent = fakeAgent(0);
	const r = runScript('lint-bundle.sh', [agent, 'mail', '/tmp/bundle']);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(readFileSync(path.join(path.dirname(agent), 'args'), 'utf8').trim().split('\n'), ['lint', '--kind', 'stack', '--name', 'mail', '/tmp/bundle']);
});

test('lint-bundle.sh turns each finding into an error annotation', () => {
	const r = runScript('lint-bundle.sh', [fakeAgent(1, 'image_digest: services.app.image has no digest\nport_undeclared: 100% sure 8080\n'), 'mail', '/tmp/b']);
	assert.equal(r.status, 1);
	assert.deepEqual(r.stdout.trim().split('\n'), [
		'::error title=zutun-agent lint::image_digest: services.app.image has no digest',
		'::error title=zutun-agent lint::port_undeclared: 100%25 sure 8080',
	]);
	assert.match(r.stderr, /2 finding\(s\) in mail; nothing is signed/);
});

test('lint-bundle.sh: a usage error means the pinned agent has no lint yet', () => {
	const r = runScript('lint-bundle.sh', [fakeAgent(2), 'mail', '/tmp/b']);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /usage error \(exit 2\).*raise the agent-commit input/);
	assert.match(runScript('lint-bundle.sh', [fakeAgent(3), 'mail', '/tmp/b']).stdout, /exit code 3/);
});
