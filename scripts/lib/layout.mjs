// The image layout convention of a release repo (README, "Image layout"):
//   image/Dockerfile              → the image <base>               (most repos: one image)
//   images/<suffix>/Dockerfile    → the image <base>-<suffix>      (further images)
// where <base> is the repo's name without `module-`. Each directory is the build context.
// A repo with neither builds no image (the host stack, or a module of third-party images only).

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ReleaseError } from './actions.mjs';

const SUFFIX = /^[a-z0-9][a-z0-9-]{0,30}$/;

function isFile(file) {
	return existsSync(file) && statSync(file).isFile();
}

/** The images a repo checked out at `root` builds, sorted by name. */
export function findImages(root, base) {
	const images = [];
	if (existsSync(path.join(root, 'image'))) {
		if (!isFile(path.join(root, 'image', 'Dockerfile'))) {
			throw new ReleaseError('image/ has no Dockerfile');
		}
		images.push({ name: base, context: 'image' });
	}
	const extra = path.join(root, 'images');
	if (existsSync(extra)) {
		for (const entry of readdirSync(extra, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const context = `images/${entry.name}`;
			if (!SUFFIX.test(entry.name)) {
				throw new ReleaseError(`${context}: image directories are named ^[a-z0-9][a-z0-9-]{0,30}$`);
			}
			if (!isFile(path.join(root, context, 'Dockerfile'))) {
				throw new ReleaseError(`${context} has no Dockerfile`);
			}
			images.push({ name: `${base}-${entry.name}`, context });
		}
	}
	return images.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Where an image is pushed: `ghcr.io/<owner>/<name>`, lowercase as the registry requires. */
export function imageRepository(owner, name) {
	return `ghcr.io/${owner.toLowerCase()}/${name}`;
}
