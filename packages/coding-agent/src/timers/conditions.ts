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

/** `gh pr view` exits 0 whatever the checks say; pending = a check run not completed or a status still pending. */
const PR_PENDING_JQ =
	'[.statusCheckRollup[] | select(((.status // "COMPLETED") != "COMPLETED") or ((.state // "") == "PENDING") or ((.state // "") == "EXPECTED"))] | length';
const PR_SUMMARY_JQ = '.statusCheckRollup[] | "\\(.name // .context): \\(.conclusion // .state // .status)"';

function compileCi(ref: string): CompiledCondition {
	const pr = PR_SHORT.exec(ref) ?? PR_URL.exec(ref);
	if (pr) {
		const [, repo, number] = pr;
		const view = `gh pr view ${number} --repo ${repo} --json statusCheckRollup`;
		return {
			until: `n=$(${view} --jq '${PR_PENDING_JQ}') || exit 2; [ "$n" = 0 ] || exit 1; ${view} --jq '${PR_SUMMARY_JQ}'`,
			text: `CI on ${repo}#${number} finished`,
		};
	}
	const commit = COMMIT.exec(ref);
	if (commit) {
		const [, repo, sha] = commit;
		const api = `gh api repos/${repo}/commits/${sha}/check-runs`;
		return {
			until: `n=$(${api} --jq '[.check_runs[] | select(.status != "completed")] | length') || exit 2; [ "$n" = 0 ] || exit 1; ${api} --jq '.check_runs[] | "\\(.name): \\(.conclusion)"'`,
			text: `CI on ${repo}@${sha.slice(0, 12)} finished`,
		};
	}
	throw new Error(`Invalid when.ci "${ref}": use owner/repo#123, a PR URL, or owner/repo@<sha>`);
}

export function compileCondition(condition: TimerCondition): CompiledCondition {
	const given = [condition.cmd, condition.ci, condition.pid].filter(value => value !== undefined && value !== "");
	if (given.length !== 1) throw new Error("when: set exactly one of cmd, ci, pid");
	if (condition.cmd) return { until: condition.cmd.trim(), text: `\`${condition.cmd.trim()}\` exits 0` };
	if (condition.ci) return compileCi(condition.ci.trim());
	const pid = condition.pid;
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) throw new Error("when.pid must be a positive integer");
	return { until: `ps -p ${pid} >/dev/null 2>&1 && exit 1; exit 0`, text: `process ${pid} exited` };
}
