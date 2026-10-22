// Workflow hygiene (architecture §8) and the contract between the workflows and their composite
// actions, checked on the files themselves. actionlint (CI) checks the expressions.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseYaml } from './lib/yaml.mjs';
import { repo } from './helpers.mjs';

const read = (rel) => readFileSync(path.join(repo, rel), 'utf8');
const workflowFiles = readdirSync(path.join(repo, '.github/workflows')).map((f) => `.github/workflows/${f}`);
const actionFiles = readdirSync(path.join(repo, '.github/actions')).map((d) => `.github/actions/${d}/action.yml`);
const workflows = Object.fromEntries(workflowFiles.map((f) => [f, parseYaml(read(f))]));
const actions = Object.fromEntries(actionFiles.map((f) => [f, parseYaml(read(f))]));
const module = workflows['.github/workflows/module.yml'];
const core = workflows['.github/workflows/core.yml'];

/** Every step of every job and composite action, with where it is. */
function allSteps() {
	const steps = [];
	for (const [file, wf] of Object.entries(workflows)) {
		for (const [job, def] of Object.entries(wf.jobs)) for (const s of def.steps ?? []) steps.push({ where: `${file} ${job}`, ...s });
	}
	for (const [file, action] of Object.entries(actions)) for (const s of action.runs.steps) steps.push({ where: file, ...s });
	return steps;
}

test('the files parse and there are the expected workflows and actions', () => {
	assert.deepEqual(Object.keys(workflows).sort(), ['.github/workflows/ci.yml', '.github/workflows/core.yml', '.github/workflows/module.yml']);
	assert.deepEqual(Object.keys(actions).sort(), [
		'.github/actions/images/action.yml',
		'.github/actions/lint/action.yml',
		'.github/actions/publish/action.yml',
		'.github/actions/stack-bundle/action.yml',
	]);
});

test('third-party actions are pinned by full commit SHA with the version in a comment', () => {
	const text = [...workflowFiles, ...actionFiles].map((f) => [f, read(f)]);
	for (const [file, content] of text) {
		for (const line of content.split('\n')) {
			const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
			if (!m) continue;
			const [, ref, comment] = m;
			if (ref.startsWith('./.release/.github/actions/')) continue;
			if (ref.startsWith('docker://')) {
				assert.match(ref, /^docker:\/\/[^@]+@sha256:[0-9a-f]{64}$/, `${file}: ${ref}`);
				continue;
			}
			assert.match(ref, /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/, `${file}: ${ref}`);
			assert.match(comment, /^ # v\d+\.\d+\.\d+$/, `${file}: ${ref} needs "# vX.Y.Z"`);
		}
	}
});

test('the images that build the images are pinned by digest and never come from the cache', () => {
	const steps = actions['.github/actions/images/action.yml'].runs.steps;
	const qemu = steps.find((s) => s.uses?.startsWith('docker/setup-qemu-action@'));
	assert.match(qemu.with?.image ?? '', /^docker\.io\/tonistiigi\/binfmt:qemu-v[\d.]+@sha256:[0-9a-f]{64}$/);
	assert.equal(qemu.with['cache-image'], 'false');
	assert.equal(qemu.with.platforms, 'arm64');
	const buildx = steps.find((s) => s.uses?.startsWith('docker/setup-buildx-action@'));
	assert.match(buildx.with?.['driver-opts'] ?? '', /^image=moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}$/);
});

test('one version of each third-party action across all files', () => {
	const pins = new Map();
	for (const s of allSteps()) {
		if (!s.uses || s.uses.startsWith('./')) continue;
		const [name, sha] = s.uses.split('@');
		assert.equal(pins.get(name) ?? sha, sha, `${name} is pinned to two commits`);
		pins.set(name, sha);
	}
});

test('never pull_request_target; runners are ubuntu-24.04', () => {
	for (const [file, wf] of Object.entries(workflows)) {
		assert.ok(!read(file).includes('pull_request_target'), file);
		for (const [job, def] of Object.entries(wf.jobs)) assert.equal(def['runs-on'], 'ubuntu-24.04', `${file} ${job}`);
	}
});

test('every job declares its permissions; id-token only to publish jobs, packages only to the image push', () => {
	for (const [file, wf] of Object.entries(workflows)) {
		for (const [job, def] of Object.entries(wf.jobs)) {
			assert.ok(def.permissions, `${file} ${job} declares permissions`);
			const perms = def.permissions;
			assert.equal(perms['id-token'] === 'write', job === 'publish' || job === 'publish-staging', `${file} ${job} id-token`);
			assert.equal(perms.packages === 'write', job === 'images', `${file} ${job} packages`);
			for (const [scope, level] of Object.entries(perms)) {
				if (scope !== 'id-token' && scope !== 'packages') assert.equal(level, 'read', `${file} ${job} ${scope}`);
			}
		}
	}
});

test('no expression is interpolated into a shell script: values go through env', () => {
	for (const s of allSteps()) if (s.run) assert.ok(!s.run.includes('${{'), `${s.where}: ${s.name ?? s.run}`);
});

test('publish jobs: environment release in production, one release at a time per repository', () => {
	for (const wf of [module, core]) {
		assert.equal(wf.jobs.publish.environment, 'release');
		assert.equal(wf.jobs['publish-staging'].environment, undefined, 'staging needs no approval');
		assert.equal(wf.jobs.publish.concurrency.group, 'zutun-publish-${{ github.repository }}');
		assert.equal(wf.jobs.publish.concurrency['cancel-in-progress'], 'false');
		assert.match(wf.jobs['publish-staging'].if, /vars\.ZUTUN_STAGING_CONTROL_PLANE_ORIGIN != ''/);
	}
	// Modules released to staging only (architecture §9) never reach the release key.
	assert.match(module.jobs.publish.if, /needs\.plan\.outputs\.production == 'true'/);
	assert.equal(module.jobs.plan.outputs.production, '${{ steps.plan.outputs.production }}');
	assert.equal(module.jobs.publish.with?.['key-family'], undefined);
	const family = (wf, job) => wf.jobs[job].steps.find((s) => s.uses?.endsWith('/actions/publish')).with['key-family'];
	assert.equal(family(module, 'publish'), 'release-modules');
	assert.equal(family(core, 'publish'), 'release-core');
	assert.equal(family(module, 'publish-staging'), 'staging');
	assert.equal(family(core, 'publish-staging'), 'staging');
});

test('the publish jobs never check out or run the repository being released', () => {
	for (const wf of [module, core]) {
		for (const job of ['publish', 'publish-staging', 'lint']) {
			for (const s of wf.jobs[job].steps) {
				if (s.uses?.startsWith('actions/checkout@')) assert.equal(s.with.path, '.release', `${job}: only the tooling is checked out`);
			}
		}
	}
});

test('every job checks that its tooling is this workflow’s own commit before using it', () => {
	for (const wf of [module, core]) {
		for (const [job, def] of Object.entries(wf.jobs)) {
			const steps = def.steps;
			const checkout = steps.findIndex((s) => s.with?.path === '.release');
			assert.ok(checkout >= 0, `${job} checks out the tooling`);
			assert.equal(steps[checkout].with.repository, '${{ job.workflow_repository }}');
			assert.equal(steps[checkout].with.ref, '${{ job.workflow_sha }}');
			const check = steps[checkout + 1];
			assert.equal(check.name, 'Check the tooling commit', job);
			assert.equal(check.env.WORKFLOW_SHA, '${{ job.workflow_sha }}');
			const firstUse = steps.findIndex((s) => s.uses?.startsWith('./.release/') || s.run?.includes('.release/'));
			assert.ok(firstUse > checkout + 1, `${job}: nothing from .release runs before the check`);
		}
	}
});

test('the plan job sees main, to check that a release tag points at a commit on it', () => {
	for (const wf of [module, core]) {
		const checkout = wf.jobs.plan.steps.find((s) => s.uses?.startsWith('actions/checkout@') && !s.with.path);
		assert.equal(checkout.with['fetch-depth'], '0');
	}
});

test('publish jobs sign what the plan and the build job reported, as job outputs', () => {
	// The artifact alone proves nothing: any job of the caller's workflow can upload one.
	for (const [wf, kind, sha] of [
		[module, 'stack', '${{ needs.bundle.outputs.release-sha256 }}'],
		[core, '${{ needs.plan.outputs.kind }}', '${{ needs.bundle.outputs.release-sha256 || needs.agent.outputs.release-sha256 }}'],
	]) {
		for (const job of ['publish', 'publish-staging']) {
			const def = wf.jobs[job];
			const step = def.steps.find((s) => s.uses === './.release/.github/actions/publish');
			assert.equal(step.with.kind, kind, job);
			assert.equal(step.with.name, '${{ needs.plan.outputs.name }}', job);
			assert.equal(step.with.version, '${{ needs.plan.outputs.version }}', job);
			assert.equal(step.with['release-sha256'], sha, job);
			for (const need of sha.match(/needs\.(\w+)\./g).map((n) => n.split('.')[1])) assert.ok(def.needs.includes(need), `${job} needs ${need}`);
		}
	}
	assert.equal(module.jobs.bundle.outputs['release-sha256'], '${{ steps.bundle.outputs.release-sha256 }}');
	assert.equal(core.jobs.bundle.outputs['release-sha256'], '${{ steps.bundle.outputs.release-sha256 }}');
	assert.equal(core.jobs.agent.outputs['release-sha256'], '${{ steps.describe.outputs.release-sha256 }}');
	assert.equal(actions['.github/actions/stack-bundle/action.yml'].outputs['release-sha256'].value, '${{ steps.pack.outputs.release-sha256 }}');
});

test('lint checks the bundle against the sha256 the bundle job reported', () => {
	for (const wf of [module, core]) {
		assert.equal(wf.jobs.bundle.outputs.sha256, '${{ steps.bundle.outputs.sha256 }}');
		assert.ok(wf.jobs.lint.needs.includes('bundle'));
		const step = wf.jobs.lint.steps.find((s) => s.uses === './.release/.github/actions/lint');
		assert.equal(step.with['bundle-sha256'], '${{ needs.bundle.outputs.sha256 }}');
	}
	const unpack = actions['.github/actions/lint/action.yml'].runs.steps.find((s) => s.name === 'Unpack the bundle');
	assert.equal(unpack.env.SHA256, '${{ inputs.bundle-sha256 }}');
	assert.match(unpack.run, /sha256sum "\$RUNNER_TEMP\/release\/\$NAME\.tar\.gz"[\s\S]*\[ "\$actual" != "\$SHA256" \][\s\S]*exit 1[\s\S]*tar -xzf/);
});

test('every variable a publish job reads is checked first, by name', () => {
	for (const wf of [module, core]) {
		for (const job of ['publish', 'publish-staging']) {
			const def = wf.jobs[job];
			const names = Object.keys(def.env);
			for (const name of names) assert.equal(def.env[name], `\${{ vars.${name} }}`, `${job}: ${name} comes from the variable of the same name`);
			const check = def.steps.find((s) => s.run?.includes('require-vars.mjs'));
			assert.deepEqual(check.run.trim().split(/\s+/).slice(2), names, job);
		}
	}
});

test('local composite actions get exactly the inputs they declare, and every required one', () => {
	for (const s of allSteps()) {
		const local = /^\.\/\.release\/(\.github\/actions\/[\w-]+)$/.exec(s.uses ?? '')?.[1];
		if (!local) continue;
		const declared = actions[`${local}/action.yml`].inputs;
		for (const key of Object.keys(s.with ?? {})) assert.ok(declared[key], `${s.where}: ${local} has no input ${key}`);
		for (const [key, def] of Object.entries(declared)) {
			if (def.required === 'true') assert.ok(s.with?.[key] !== undefined, `${s.where}: ${local} needs ${key}`);
		}
	}
});

test('composite run steps declare their shell and reach scripts relative to the action', () => {
	for (const [file, action] of Object.entries(actions)) {
		assert.equal(action.runs.using, 'composite');
		for (const s of action.runs.steps) {
			if (!s.run) continue;
			assert.equal(s.shell, 'bash', `${file}: ${s.name}`);
			for (const script of s.run.match(/\S*scripts\/[\w-]+\.(?:mjs|sh)/g) ?? []) {
				assert.match(script, /^"?\$GITHUB_ACTION_PATH\/\.\.\/\.\.\/\.\.\/scripts\//, `${file}: ${script}`);
			}
		}
	}
});

test('both workflows build lint from the same agent commit, a full SHA', () => {
	const a = module.on.workflow_call.inputs['agent-commit'].default;
	const b = core.on.workflow_call.inputs['agent-commit'].default;
	assert.match(a, /^[0-9a-f]{40}$/);
	assert.equal(a, b);
});

test("module.yml and core.yml share their jobs' shape: same steps apart from the agent build", () => {
	for (const job of ['plan', 'images', 'bundle', 'lint', 'publish-staging', 'publish']) {
		const names = (wf) => wf.jobs[job].steps.map((s) => s.name ?? s.uses.split('@')[0]);
		assert.deepEqual(names(core).map((n) => n.replace('repository', 'module')), names(module), job);
	}
});

test('no deployment values in workflow code or scripts (CONTROL-PLANE §9)', () => {
	const files = [...workflowFiles, ...actionFiles, ...readdirSync(path.join(repo, 'scripts')).filter((f) => /\.(mjs|sh)$/.test(f)).map((f) => `scripts/${f}`),
		...readdirSync(path.join(repo, 'scripts/lib')).map((f) => `scripts/lib/${f}`)];
	for (const file of files) {
		const content = read(file);
		for (const literal of ['zutun.ch', 'zutun-ch', 'europe-west6', 'zutun-release']) {
			assert.ok(!content.includes(literal), `${file} contains "${literal}"`);
		}
	}
});
