// Release notes: the message of the release tag (an annotated tag's text, or the tagged commit's
// message for a lightweight one, without a tag signature), sent with the upload (CONTROL-PLANE §7, at most 2000 bytes).

import { execFileSync } from 'node:child_process';
import { truncateUtf8 } from './upload.mjs';

/** The notes of `tag` in the repo at `cwd`, or null when git has none. */
export function tagNotes(tag, cwd = process.cwd()) {
	try {
		const text = execFileSync('git', ['for-each-ref', '--format=%(contents:subject)%0a%0a%(contents:body)', `refs/tags/${tag}`], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		return text ? truncateUtf8(text) : null;
	} catch {
		return null;
	}
}
