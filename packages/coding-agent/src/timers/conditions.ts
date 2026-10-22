/**
 * Typed conditions compile to a gate shell command with the same exit
 * contract as a hand-written `cmd` (0 fire, 1 not yet, anything else broken),
 * so the ticker has exactly one gate mechanism. Typed forms exist because
 * agents write inverted or always-true shell checks; these are correct by
 * construction.
 */

export interface TimerCondition {
	/** Shell check: exit 0 = fire, 1 = not yet, else failure. */
	cmd?: string;
	/** PR (`owner/repo#123`, PR URL) or commit (`owner/repo@sha`): fires once every check has finished. */
	ci?: string;
	/** Fires once this process has exited. */
	pid?: number;
}

export interface CompiledCondition {
	/** Gate command stored as the spec's `until`. */
	until: string;
	/** Human/model-readable form, stored as `condition`. */
	text: string;
}

const REPO = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
const PR_SHORT = new RegExp(`^(${REPO})#(\\d+)$`);
const PR_URL = new RegExp(`^https://github\\.com/(${REPO})/pull/(\\d+)`);
const COMMIT = new RegExp(`^(${REPO})@([0-9a-f]{7,40})$`);

/** A commit's CI rollup: per-state counts over all its check runs and status contexts, and the first 100 to name. */
const ROLLUP =
	"statusCheckRollup { contexts(first: 100) { checkRunCountsByState { state count } statusContextCountsByState { state count } nodes { ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } }";

/** One line per check, then the number of check runs and status contexts still running as the last line. */
function rollupJq(commit: string, missing: string): string {
	const running =
		'[($c.checkRunCountsByState // [])[] | select(.state == "QUEUED" or .state == "IN_PROGRESS" or .state == "PENDING" or .state == "WAITING") | .count]' +
		' + [($c.statusContextCountsByState // [])[] | select(.state == "PENDING" or .state == "EXPECTED") | .count] | add // 0';
	return `(${commit} // error("${missing}")).statusCheckRollup.contexts as $c | (($c.nodes // [])[] | "\\(.name // .context): \\(.conclusion // .state // .status)"), (${running})`;
}

/**
 * Read the rollup once, so the verdict and the summary handed to the run come
 * from one snapshot; a request or parse failure exits 2 (broken), never 1.
 */
function rollupGate(query: string, jq: string): string {
	return `out=$(gh api graphql -f query='${query}' --jq '${jq}') || exit 2; n=\${out##*[!0-9]}; [ -n "$n" ] || exit 2; [ "$n" = 0 ] || exit 1; printf '%s\\n' "\${out%"$n"}"`;
}

function compileCi(ref: string): CompiledCondition {
	const pr = PR_SHORT.exec(ref) ?? PR_URL.exec(ref);
	if (pr) {
		const [, repo, number] = pr;
		const [owner, name] = repo.split("/");
		const query = `{ repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { commits(last: 1) { nodes { commit { ${ROLLUP} } } } } } }`;
		return {
			until: rollupGate(
				query,
				rollupJq(".data.repository.pullRequest.commits.nodes[0].commit", "PR has no commits"),
			),
			text: `CI on ${repo}#${number} finished`,
		};
	}
	const commit = COMMIT.exec(ref);
	if (commit) {
		const [, repo, sha] = commit;
		const [owner, name] = repo.split("/");
		const query = `{ repository(owner: "${owner}", name: "${name}") { object(expression: "${sha}") { ... on Commit { ${ROLLUP} } } } }`;
		return {
			until: rollupGate(query, rollupJq(".data.repository.object", "no such commit")),
			text: `CI on ${repo}@${sha.slice(0, 12)} finished`,
		};
	}
	throw new Error(`Invalid when.ci "${ref}": use owner/repo#123, a PR URL, or owner/repo@<sha>`);
}

/**
 * `kill -0` is a shell builtin, so the probe needs nothing on PATH. Only "No
 * such process" means exited; "not permitted" is a live process of another
 * user; any other answer is a broken probe, never a met condition.
 */
function pidGate(pid: number): string {
	return `e=$(kill -0 ${pid} 2>&1) && exit 1; case $e in *"No such process"*) exit 0;; *"not permitted"*) exit 1;; esac; echo "$e" >&2; exit 2`;
}

export function compileCondition(condition: TimerCondition): CompiledCondition {
	const given = [condition.cmd, condition.ci, condition.pid].filter(value => value !== undefined && value !== "");
	if (given.length !== 1) throw new Error("when: set exactly one of cmd, ci, pid");
	if (condition.cmd) return { until: condition.cmd.trim(), text: `\`${condition.cmd.trim()}\` exits 0` };
	if (condition.ci) return compileCi(condition.ci.trim());
	const pid = condition.pid;
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) throw new Error("when.pid must be a positive integer");
	return { until: pidGate(pid), text: `process ${pid} exited` };
}

/** Where `compileCondition` puts each typed form's inputs; captures only what it accepts, so recompiling cannot throw. */
const TYPED_SOURCES: ReadonlyArray<[RegExp, (match: RegExpExecArray) => TimerCondition]> = [
	[/^e=\$\(kill -0 ([1-9]\d*) /, ([, pid]) => ({ pid: Number(pid) })],
	[
		/repository\(owner: "([A-Za-z0-9_.-]+)", name: "([A-Za-z0-9_.-]+)"\) \{ pullRequest\(number: (\d+)\)/,
		([, owner, name, pr]) => ({ ci: `${owner}/${name}#${pr}` }),
	],
	[
		/repository\(owner: "([A-Za-z0-9_.-]+)", name: "([A-Za-z0-9_.-]+)"\) \{ object\(expression: "([0-9a-f]{7,40})"\)/,
		([, owner, name, sha]) => ({ ci: `${owner}/${name}@${sha}` }),
	],
];

/**
 * The typed `ci`/`pid` condition a stored gate was compiled from, or undefined
 * for any other shell (a hand-written `cmd`, or an edited spec). Only a gate
 * that recompiles to exactly the same command counts.
 */
export function typedCondition(until: string): TimerCondition | undefined {
	for (const [pattern, condition] of TYPED_SOURCES) {
		const match = pattern.exec(until);
		if (!match) continue;
		const typed = condition(match);
		return compileCondition(typed).until === until.trim() ? typed : undefined;
	}
	return undefined;
}
